/**
 * Общая среда Python для всех Python-программ Flux.
 *
 * Одна среда Pyodide (один Worker) обслуживает все программы: у каждой
 * своё пространство имён (modules/engine/pythonHarness.ts), интерпретатор и
 * стандартная библиотека общие. Так память Pyodide (~30 МиБ) платится один
 * раз, а не за каждую открытую программу.
 *
 * Этот файл не знает, где работает: Pyodide ему передают (в Worker — из
 * вкладки файлов Flux, в проверках — из node_modules). Без DOM и Node.
 */
import { ComputeError, LIMITS } from './types';
import { PYTHON_HARNESS } from './pythonHarness';
import { SerialLane } from './serial';

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
  private numpy = false;
  /** Два расчёта в одной среде не идут одновременно, даже между await'ами загрузки пакетов */
  private lane = new SerialLane();

  constructor(private py: PyodideApi) {
    py.runPython(PYTHON_HARNESS);
  }

  /** Сколько программ сейчас держат пространство имён в среде */
  get namespaces() { return this.loaded.size; }
  get queued() { return this.lane.pending; }

  private async prepare(key: string, source: string) {
    // Программа загружается один раз; изменившийся исходник (новая версия) перезагружается
    if (this.loaded.get(key) === source) return;
    // numpy грузится лениво, только когда программа его импортирует; колесо лежит рядом с Pyodide, сеть не нужна
    if (NUMPY.test(source) && !this.numpy) {
      // loadPackage не бросает, если колеса нет, — поэтому после него numpy импортируется по-настоящему
      try { await this.py.loadPackage('numpy'); this.py.runPython("__import__('numpy')"); } catch { throw new ComputeError('UNAVAILABLE', 'numpy не загружен'); }
      this.numpy = true;
    }
    try { this.py.globals.get('flux_load')(key, source); } catch (e: any) {
      throw new ComputeError('CRASH', `logic/main.py не загружается: ${firstLine(e)}`);
    }
    this.loaded.set(key, source);
  }

  /** Один расчёт: `key` — программа (ид и версия), `source` — её logic/main.py */
  run(key: string, source: string, input: string, seed = 0): Promise<string> {
    return this.lane.run(() => this.runNow(key, source, input, seed));
  }

  private async runNow(key: string, source: string, input: string, seed: number): Promise<string> {
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
