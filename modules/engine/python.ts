/**
 * Общая среда Python для всех Python-подпрограмм Flux.
 *
 * Одна среда Pyodide (один Worker) обслуживает все подпрограммы: у каждой
 * своё пространство имён (modules/engine/pythonHarness.ts), интерпретатор и
 * стандартная библиотека общие. Так память Pyodide (~30 МиБ) платится один
 * раз, а не за каждую открытую подпрограмму.
 *
 * Этот файл не знает, где работает: Pyodide ему передают (в Worker — из
 * вкладки файлов Flux, в проверках — из node_modules). Без DOM и Node.
 */
import { ComputeError, LIMITS } from './types';
import { PYTHON_HARNESS } from './pythonHarness';

/** Часть API Pyodide, которой пользуется Flux */
export interface PyodideApi {
  runPython(code: string): unknown;
  globals: { get(name: string): any };
  loadPackage(names: string | string[]): Promise<unknown>;
}

/**
 * Не даёт Pyodide занять больше памяти, чем положено. Emscripten создаёт
 * `WebAssembly.Memory` с максимумом 4 ГиБ и ни одной настройки для него не
 * даёт, поэтому максимум подменяется на лету перед загрузкой. Дальше рост
 * сверх предела Python видит как нехватку памяти (MemoryError).
 * Возвращает функцию, снимающую подмену.
 */
export function clampWasmMemory(maxPages: number): () => void {
  const Original = WebAssembly.Memory;
  const Clamped = function (this: unknown, descriptor: WebAssembly.MemoryDescriptor) {
    const initial = Math.min(descriptor.initial, maxPages);
    return new Original({ ...descriptor, initial, maximum: Math.min(descriptor.maximum ?? maxPages, maxPages) });
  } as unknown as typeof WebAssembly.Memory;
  Clamped.prototype = Original.prototype;
  (WebAssembly as any).Memory = Clamped;
  return () => { (WebAssembly as any).Memory = Original; };
}

const NUMPY = /^\s*(?:import\s+numpy|from\s+numpy\b)/m;

export class PythonEnvironment {
  private loaded = new Map<string, string>();
  private packages = new Set<string>();

  constructor(private py: PyodideApi) {
    py.runPython(PYTHON_HARNESS);
  }

  /** Сколько подпрограмм сейчас держат пространство имён в среде */
  get namespaces() { return this.loaded.size; }

  private async prepare(key: string, source: string) {
    // Подпрограмма загружается один раз; изменившийся исходник (новая версия) перезагружается
    if (this.loaded.get(key) === source) return;
    if (NUMPY.test(source) && !this.packages.has('numpy')) {
      try { await this.py.loadPackage('numpy'); } catch { throw new ComputeError('UNAVAILABLE', 'numpy не загружен'); }
      this.packages.add('numpy');
    }
    try { this.py.globals.get('flux_load')(key, source); } catch (e: any) {
      throw new ComputeError('CRASH', `logic/main.py не загружается: ${firstLine(e)}`);
    }
    this.loaded.set(key, source);
  }

  /** Один расчёт: `key` — подпрограмма (ид и версия), `source` — её logic/main.py */
  async run(key: string, source: string, input: string, seed = 0): Promise<string> {
    if (input.length > LIMITS.inputBytes) throw new ComputeError('BAD_INPUT', 'вход больше предела');
    await this.prepare(key, source);
    try {
      const text = this.py.globals.get('flux_call')(key, input, seed);
      if (typeof text !== 'string') throw new ComputeError('BAD_OUTPUT', 'compute вернула не JSON');
      return text;
    } catch (e: any) {
      if (e instanceof ComputeError) throw e;
      const message = String(e?.message || e);
      if (message.includes('FLUX_NUMBER')) throw new ComputeError('NUMBER', 'NaN или бесконечность в результате');
      if (/MemoryError/.test(message)) throw new ComputeError('MEMORY', 'MemoryError');
      throw new ComputeError('CRASH', firstLine(e));
    }
  }

  drop(key: string) {
    this.loaded.delete(key);
    try { this.py.globals.get('flux_drop')(key); } catch { /* среда могла быть пересоздана */ }
  }
}

/** Последняя строка трассы — само исключение; остальное содержит чужой код и пути */
function firstLine(e: any): string {
  const lines = String(e?.message || e).trim().split('\n');
  return lines[lines.length - 1].slice(0, 200);
}
