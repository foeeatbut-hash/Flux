/**
 * Исполнение .wasm: один контракт для C, C++, Rust, Go (TinyGo) и C#.
 *
 * Модуль WebAssembly по построению не имеет доступа ни к чему, кроме того,
 * что ему передали в импортах. Здесь передаётся ровно:
 * - `flux.log`/`flux.abort` — API Flux (журнал расчёта и аварийная остановка);
 * - урезанный WASI: вывод в никуда, пустые аргументы и окружение, часы стоят
 *   на нуле, случайность — от зерна входа, файловой системы нет;
 * - при необходимости `env.memory` с ограниченным максимумом.
 * Любой другой импорт (сеть, часы, файлы, JS-обёртки) отклоняет проверка выпуска
 * (wasmInspect.ts) ещё до подписи, а здесь — повторно перед компиляцией.
 *
 * Контракт (WASM_ABI): `flux_alloc(n)` отдаёт буфер под вход, `flux_run(ptr, len)`
 * возвращает длину JSON-выхода (или отрицательный код ошибки), `flux_output()` —
 * его адрес. Реакторы WASI (`_initialize`) запускаются один раз на экземпляр.
 * Для языков без своих экспортов (C#/.NET) — «WASI-команда»: вход на stdin, выход на stdout.
 *
 * Каждый расчёт идёт в НОВОМ экземпляре из уже скомпилированного модуля: память чистая,
 * поэтому результат не зависит от прошлых вызовов, а аллокатор без освобождения
 * (leaking GC) не копит мусор. Компиляция при этом одна на выпуск.
 *
 * Без DOM и Node: работает одинаково в Worker, в проверках и в Electron.
 */
import { ComputeError, LIMITS } from './types';
import {
  FLUX_IMPORT_MODULE, FLUX_IMPORTS, WASI_MODULE, WASI_NAMES, WASM_ABI, inspectWasm, wasmAbi, wasmPageCap, wasmProblem,
  type WasmAbi, type WasmInfo,
} from './wasmInspect';

/** Кэш скомпилированных модулей по отпечатку выпуска: повторный запуск не компилирует заново */
export interface CompileCache {
  get(key: string): Promise<WebAssembly.Module | undefined>;
  put(key: string, module: WebAssembly.Module): Promise<void>;
  /** Оставить только перечисленные отпечатки: выпуски, которых больше нет, не копятся */
  keepOnly(keys: ReadonlySet<string>): Promise<void>;
}

/** Кэш в памяти процесса: на случай, когда диска нет (проверки, Worker без IndexedDB) */
export class MemoryCompileCache implements CompileCache {
  private items = new Map<string, WebAssembly.Module>();
  constructor(private max = 16) {}
  async get(key: string) {
    const found = this.items.get(key);
    if (found) { this.items.delete(key); this.items.set(key, found); }
    return found;
  }
  async put(key: string, module: WebAssembly.Module) {
    this.items.delete(key); this.items.set(key, module);
    // Старейший выходит первым: предел защищает память, пока открыто много подпрограмм
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value as string);
  }
  async keepOnly(keys: ReadonlySet<string>) { for (const k of [...this.items.keys()]) if (!keys.has(k)) this.items.delete(k); }
  get size() { return this.items.size; }
}

export interface LoadedWasm { module: WebAssembly.Module; info: WasmInfo; abi: WasmAbi; from: 'cache' | 'compiled' }

/**
 * Компиляция один раз на выпуск. `fingerprint` — SHA-256 байт .wasm из
 * подписанного пакета: другой файл не может занять чужое место в кэше.
 */
export async function loadWasm(bytes: Uint8Array, fingerprint: string, cache?: CompileCache): Promise<LoadedWasm> {
  const problem = wasmProblem(bytes);
  if (problem) throw new ComputeError('ABI', problem);
  const info = inspectWasm(bytes);
  const abi = wasmAbi(info)!;
  const cached = await cache?.get(fingerprint).catch(() => undefined);
  if (cached) return { module: cached, info, abi, from: 'cache' };
  let module: WebAssembly.Module;
  try { module = await WebAssembly.compile(bytes as BufferSource); } catch (e: any) { throw new ComputeError('ABI', `не компилируется: ${e?.message || e}`); }
  await cache?.put(fingerprint, module).catch(() => undefined);
  return { module, info, abi, from: 'compiled' };
}

/** Детерминированный генератор для random_get: одно зерно — одна последовательность */
function splitmix32(seed: number) {
  let a = (seed | 0) >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15; t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

const ENOSYS = 52, EBADF = 8, ESPIPE = 70;
const PROGRAM_NAME = new TextEncoder().encode('main.wasm\0');

/** proc_exit(0) — нормальное завершение WASI-команды, а не сбой */
class ExitSignal { constructor(public code: number) {} }

export interface WasmRunOptions { seed?: number }

export class WasmInstance {
  private memory!: WebAssembly.Memory;
  private exports!: Record<string, any>;
  private rng: () => number;
  private stdin = new Uint8Array(0);
  private stdinAt = 0;
  private stdout: number[] = [];
  readonly maxBytes: number;
  logs: string[] = [];

  private constructor(private loaded: LoadedWasm, seed: number) {
    const declared = (loaded.info.importedMemory || loaded.info.memory)!;
    this.maxBytes = Math.min(declared.max ?? wasmPageCap(loaded.abi), wasmPageCap(loaded.abi)) * 65536;
    this.rng = splitmix32(seed);
  }

  /** Новый экземпляр. Для WASI-команды вход расчёта передаётся в `run` и читается модулем со stdin */
  static async create(loaded: LoadedWasm, options: WasmRunOptions = {}): Promise<WasmInstance> {
    const self = new WasmInstance(loaded, options.seed ?? 0);
    const view = () => new DataView(self.memory.buffer);
    const wasi: Record<string, (...a: any[]) => any> = {};
    for (const name of WASI_NAMES) wasi[name] = () => ENOSYS;
    Object.assign(wasi, {
      // Вывод программы (printf, println) не нужен и не сохраняется: результат отдаёт flux_run или stdout команды
      fd_write: (fd: number, iovs: number, count: number, written: number) => {
        if (fd !== 1 && fd !== 2) return EBADF;
        const v = view(); let total = 0;
        for (let i = 0; i < count; i++) {
          const at = v.getUint32(iovs + i * 8, true), n = v.getUint32(iovs + i * 8 + 4, true);
          total += n;
          if (fd === 1 && loaded.abi === 'command') {
            // Выход команды ограничен: бесконечный println не должен съесть память окна
            if (self.stdout.length + n > LIMITS.outputBytes) throw new ComputeError('BAD_OUTPUT', 'результат больше предела');
            const chunk = new Uint8Array(self.memory.buffer, at, n);
            for (let k = 0; k < n; k++) self.stdout.push(chunk[k]);
          }
        }
        v.setUint32(written, total, true);
        return 0;
      },
      fd_read: (fd: number, iovs: number, count: number, nread: number) => {
        if (fd !== 0) return EBADF;
        const v = view(); let total = 0;
        for (let i = 0; i < count; i++) {
          const at = v.getUint32(iovs + i * 8, true), n = v.getUint32(iovs + i * 8 + 4, true);
          const take = Math.min(n, self.stdin.length - self.stdinAt);
          new Uint8Array(self.memory.buffer, at, take).set(self.stdin.subarray(self.stdinAt, self.stdinAt + take));
          self.stdinAt += take; total += take;
          if (take < n) break;
        }
        v.setUint32(nread, total, true);
        return 0;
      },
      fd_close: () => 0, fd_sync: () => 0, fd_seek: () => ESPIPE, fd_tell: () => ESPIPE,
      fd_fdstat_get: (fd: number, buf: number) => {
        if (fd > 2) return EBADF;
        const bytes = new Uint8Array(self.memory.buffer, buf, 24); bytes.fill(0); bytes[0] = 2; // символьное устройство
        return 0;
      },
      fd_prestat_get: () => EBADF, fd_prestat_dir_name: () => EBADF,
      environ_sizes_get: (count: number, size: number) => { const v = view(); v.setUint32(count, 0, true); v.setUint32(size, 0, true); return 0; },
      environ_get: () => 0,
      // Один аргумент — имя программы: рантаймы (Mono/.NET, wasi-libc) ждут argv[0] и без него ругаются в вывод
      args_sizes_get: (count: number, size: number) => { const v = view(); v.setUint32(count, 1, true); v.setUint32(size, PROGRAM_NAME.length, true); return 0; },
      args_get: (argv: number, buf: number) => {
        const v = view(); v.setUint32(argv, buf, true);
        new Uint8Array(self.memory.buffer, buf, PROGRAM_NAME.length).set(PROGRAM_NAME);
        return 0;
      },
      // Часы стоят: расчёт не может зависеть от времени запуска
      clock_time_get: (_id: number, _precision: bigint, out: number) => { view().setBigUint64(out, 0n, true); return 0; },
      clock_res_get: (_id: number, out: number) => { view().setBigUint64(out, 1_000_000n, true); return 0; },
      random_get: (buf: number, len: number) => {
        const bytes = new Uint8Array(self.memory.buffer, buf, len);
        for (let i = 0; i < len; i++) bytes[i] = self.rng() & 0xff;
        return 0;
      },
      sched_yield: () => 0,
      proc_exit: (code: number) => { throw new ExitSignal(code); },
    });
    const flux: Record<string, (...a: any[]) => void> = {
      log: (ptr: number, len: number) => {
        // Журнал для разработчика, не канал данных: короткий и только в памяти расчёта
        if (self.logs.length < 32) self.logs.push(new TextDecoder().decode(new Uint8Array(self.memory.buffer, ptr, Math.min(len, 512))));
      },
      abort: () => { throw new ComputeError('CRASH', 'flux.abort'); },
    };
    for (const name of Object.keys(FLUX_IMPORTS)) if (!(name in flux)) throw new ComputeError('ABI', `нет реализации flux.${name}`);
    const imports: WebAssembly.Imports = { [FLUX_IMPORT_MODULE]: flux, [WASI_MODULE]: wasi };
    if (loaded.info.importedMemory) {
      const m = loaded.info.importedMemory;
      // Максимум задаёт Flux, а не модуль: так память нельзя раздуть сверх предела
      self.memory = new WebAssembly.Memory({ initial: m.min, maximum: self.maxBytes / 65536 });
      imports.env = { memory: self.memory };
    }
    let instance: WebAssembly.Instance;
    try { instance = await WebAssembly.instantiate(loaded.module, imports); } catch (e: any) {
      throw new ComputeError(e instanceof WebAssembly.LinkError ? 'ABI' : 'CRASH', e?.message || String(e));
    }
    self.exports = instance.exports as Record<string, any>;
    if (!loaded.info.importedMemory) self.memory = self.exports[WASM_ABI.memory];
    if (loaded.abi === 'reactor') {
      const init = WASM_ABI.init.find(name => typeof self.exports[name] === 'function');
      if (init) self.guard(() => self.exports[init]());
    }
    return self;
  }

  /** Ловушки модуля (unreachable, выход за память, переполнение стека) — сбой расчёта, а не Flux */
  private guard<T>(fn: () => T): T {
    try { return fn(); } catch (e: any) {
      if (e instanceof ComputeError || e instanceof ExitSignal) throw e;
      // Память упёрлась в максимум: так выглядит и «malloc вернул 0», и выход за границу — называем причину
      if (this.memory.buffer.byteLength >= this.maxBytes) throw new ComputeError('MEMORY', 'память достигла предела');
      throw new ComputeError('CRASH', e?.message || String(e));
    }
  }

  get memoryBytes() { return this.memory.buffer.byteLength; }

  /** Один расчёт: текст JSON на входе, текст JSON на выходе */
  run(input: string): string {
    this.logs = [];
    const bytes = new TextEncoder().encode(input);
    if (this.loaded.abi === 'command') return this.runCommand(bytes);
    const e = this.exports;
    const ptr: number = this.guard(() => e[WASM_ABI.alloc](bytes.length));
    if (!Number.isInteger(ptr) || ptr <= 0 || ptr + bytes.length > this.memory.buffer.byteLength) throw new ComputeError('ABI', 'flux_alloc вернул адрес вне памяти');
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
    const length: number = this.guard(() => e[WASM_ABI.run](ptr, bytes.length));
    if (!Number.isInteger(length) || length < 0) throw new ComputeError('CRASH', `flux_run вернул код ${length}`);
    if (length > LIMITS.outputBytes) throw new ComputeError('BAD_OUTPUT', 'результат больше предела');
    const out: number = this.guard(() => e[WASM_ABI.output]());
    if (!Number.isInteger(out) || out < 0 || out + length > this.memory.buffer.byteLength) throw new ComputeError('ABI', 'flux_output вернул адрес вне памяти');
    return decode(new Uint8Array(this.memory.buffer, out, length));
  }

  private runCommand(bytes: Uint8Array): string {
    this.stdin = bytes; this.stdinAt = 0; this.stdout = [];
    try { this.guard(() => this.exports._start()); } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
      if (e.code !== 0) throw new ComputeError('CRASH', `завершился с кодом ${e.code}`);
    }
    return decode(Uint8Array.from(this.stdout));
  }
}

function decode(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
    throw new ComputeError('BAD_OUTPUT', 'результат не в UTF-8');
  }
}

/** Один расчёт от начала до конца: новый экземпляр, вход, выход. Это и есть единый вход для оболочки */
export async function runWasm(loaded: LoadedWasm, input: string, options: WasmRunOptions = {}): Promise<string> {
  const instance = await WasmInstance.create(loaded, options);
  return instance.run(input);
}
