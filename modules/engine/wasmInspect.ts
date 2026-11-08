/**
 * Разбор двоичного .wasm ДО компиляции: что модуль импортирует, какая у него
 * память и какие функции он отдаёт.
 *
 * Зачем отдельно от WebAssembly.compile: проверка идёт там, где нельзя
 * подменить окно (проверка выпуска в главном процессе и на сервере, Studio
 * перед отправкой), а не в Chromium, и не требует компиляции. Модуль, который
 * просит что-то кроме API Flux, не доходит ни до подписи, ни до запуска.
 *
 * Без зависимостей: читает только разделы типов, импорта, функций, памяти и
 * экспорта; остальное (код, данные) проверяет сам движок при компиляции.
 */
import { LIMITS } from './types';

export interface WasmLimits { min: number; max: number | null; shared: boolean }
export interface WasmImport { module: string; name: string; kind: 'func' | 'table' | 'memory' | 'global' | 'tag'; type?: FuncType }
export interface FuncType { params: string[]; results: string[] }
export interface WasmInfo {
  imports: WasmImport[];
  /** Память, объявленная самим модулем (если не импортирует чужую) */
  memory: WasmLimits | null;
  importedMemory: WasmLimits | null;
  exports: Array<{ name: string; kind: 'func' | 'table' | 'memory' | 'global' | 'tag'; type?: FuncType }>;
}

/** Контракт guest ↔ Flux (одинаковый для C, C++, Rust, Go, C#) — см. modules/engine/wasm.ts */
export const WASM_ABI = {
  memory: 'memory',
  alloc: 'flux_alloc',
  run: 'flux_run',
  output: 'flux_output',
  /** Необязательные: инициализация реактора (WASI `_initialize` или `flux_init`) */
  init: ['flux_init', '_initialize'],
} as const;

/** Что модуль может импортировать: API Flux и урезанный WASI (для TinyGo/Go, C#, wasi-libc). Всё остальное — отказ */
export const FLUX_IMPORT_MODULE = 'flux';
export const FLUX_IMPORTS: Record<string, FuncType> = {
  log: { params: ['i32', 'i32'], results: [] },
  abort: { params: ['i32', 'i32'], results: [] },
};
export const WASI_MODULE = 'wasi_snapshot_preview1';
export const WASI_NAMES = [
  'fd_write', 'fd_read', 'fd_close', 'fd_seek', 'fd_fdstat_get', 'fd_fdstat_set_flags', 'fd_prestat_get', 'fd_prestat_dir_name',
  'fd_filestat_get', 'fd_tell', 'fd_sync', 'fd_advise', 'fd_allocate', 'fd_datasync', 'fd_pread', 'fd_pwrite', 'fd_readdir', 'fd_renumber',
  'environ_get', 'environ_sizes_get', 'args_get', 'args_sizes_get', 'clock_time_get', 'clock_res_get', 'random_get', 'proc_exit',
  'sched_yield', 'poll_oneoff', 'proc_raise',
] as const;

const VALTYPES: Record<number, string> = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128', 0x70: 'funcref', 0x6f: 'externref' };
const KINDS = ['func', 'table', 'memory', 'global', 'tag'] as const;

class Reader {
  constructor(private b: Uint8Array, public at = 0) {}
  eof() { return this.at >= this.b.length; }
  byte() { if (this.at >= this.b.length) throw new Error('обрыв файла'); return this.b[this.at++]; }
  u32() {
    let result = 0, shift = 0;
    for (;;) {
      const x = this.byte();
      result += (x & 0x7f) * 2 ** shift;
      if (!(x & 0x80)) break;
      shift += 7;
      if (shift > 35) throw new Error('слишком длинное число');
    }
    if (result > 0xffffffff) throw new Error('число больше 32 бит');
    return result;
  }
  name() {
    const n = this.u32();
    if (this.at + n > this.b.length) throw new Error('обрыв имени');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(this.b.subarray(this.at, this.at + n));
    this.at += n;
    return text;
  }
  limits(): WasmLimits {
    const flag = this.byte();
    // 0x04 и выше — память 64 бит и другие расширения: Flux их не поддерживает
    if (flag > 3) throw new Error('память wasm64 не поддерживается');
    const min = this.u32();
    return { min, max: flag & 1 ? this.u32() : null, shared: !!(flag & 2) };
  }
}

export function inspectWasm(bytes: Uint8Array): WasmInfo {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error('это не WebAssembly (нет сигнатуры \\0asm)');
  if (bytes[4] !== 1 || bytes[5] || bytes[6] || bytes[7]) throw new Error('версия WebAssembly не 1');
  const types: FuncType[] = [];
  const funcTypes: number[] = [];
  const info: WasmInfo = { imports: [], memory: null, importedMemory: null, exports: [] };
  const exportsRaw: Array<{ name: string; kind: number; index: number }> = [];
  let importedFuncs = 0;
  const r = new Reader(bytes, 8);
  try {
    while (!r.eof()) {
      const id = r.byte();
      const size = r.u32();
      const end = r.at + size;
      if (end > bytes.length) throw new Error('раздел длиннее файла');
      const s = new Reader(bytes, r.at);
      if (id === 1) {
        for (let n = s.u32(); n > 0; n--) {
          if (s.byte() !== 0x60) throw new Error('неизвестный тип');
          const read = () => { const out: string[] = []; for (let k = s.u32(); k > 0; k--) out.push(VALTYPES[s.byte()] || '?'); return out; };
          const params = read();
          types.push({ params, results: read() });
        }
      } else if (id === 2) {
        for (let n = s.u32(); n > 0; n--) {
          const module = s.name(), name = s.name(), kindByte = s.byte();
          if (kindByte > 4) throw new Error('неизвестный вид импорта');
          const kind = KINDS[kindByte];
          const item: WasmImport = { module, name, kind };
          if (kind === 'func') { item.type = types[s.u32()]; importedFuncs++; }
          else if (kind === 'table') { s.byte(); s.limits(); }
          else if (kind === 'memory') info.importedMemory = s.limits();
          else if (kind === 'global') { s.byte(); s.byte(); }
          else { s.byte(); s.u32(); }
          info.imports.push(item);
        }
      } else if (id === 3) {
        for (let n = s.u32(); n > 0; n--) funcTypes.push(s.u32());
      } else if (id === 5) {
        const count = s.u32();
        if (count > 1) throw new Error('несколько памятей не поддерживаются');
        if (count === 1) info.memory = s.limits();
      } else if (id === 7) {
        for (let n = s.u32(); n > 0; n--) exportsRaw.push({ name: s.name(), kind: s.byte(), index: s.u32() });
      }
      r.at = end;
    }
  } catch (e: any) { throw new Error(`повреждённый .wasm: ${e.message}`); }
  for (const e of exportsRaw) {
    if (e.kind > 4) throw new Error('повреждённый .wasm: неизвестный вид экспорта');
    info.exports.push({
      name: e.name, kind: KINDS[e.kind],
      ...(e.kind === 0 && e.index >= importedFuncs ? { type: types[funcTypes[e.index - importedFuncs]] } : {}),
    });
  }
  return info;
}

const same = (a: FuncType | undefined, params: string[], results: string[]) =>
  !!a && a.params.join() === params.join() && a.results.join() === results.join();

/**
 * Пригодность модуля для Flux. Возвращает причину словами или '' — её видит
 * разработчик в Studio и владелец в запросе.
 */
export function wasmProblem(bytes: Uint8Array): string {
  if (bytes.length > LIMITS.wasmFileBytes) return `Файл .wasm больше ${LIMITS.wasmFileBytes / 1024 / 1024} МиБ`;
  let info: WasmInfo;
  try { info = inspectWasm(bytes); } catch (e: any) { return e.message; }
  for (const imp of info.imports) {
    if (imp.module === FLUX_IMPORT_MODULE && imp.kind === 'func' && FLUX_IMPORTS[imp.name]) {
      if (!same(imp.type, FLUX_IMPORTS[imp.name].params, FLUX_IMPORTS[imp.name].results)) return `Импорт flux.${imp.name} объявлен с другой сигнатурой`;
      continue;
    }
    if (imp.module === WASI_MODULE && imp.kind === 'func' && (WASI_NAMES as readonly string[]).includes(imp.name)) continue;
    if (imp.module === 'env' && imp.name === 'memory' && imp.kind === 'memory') continue;
    return `Импорт ${imp.module}.${imp.name} недоступен: модулю разрешены только API Flux (flux.*) и урезанный WASI, без сети, часов, файлов и случайности вне зерна`;
  }
  const memory = info.importedMemory || info.memory;
  if (!memory) return 'У модуля нет линейной памяти';
  if (memory.shared) return 'Общая (shared) память не поддерживается';
  if (info.memory && !info.importedMemory) {
    // Свою память модуль не даёт ограничить снаружи: предел должен быть записан в самом файле
    if (memory.max === null) return `У памяти не задан максимум: пересоберите с пределом ${LIMITS.wasmMaxPages * 64} КиБ`;
    if (memory.max > LIMITS.wasmMaxPages) return `Максимум памяти ${memory.max} страниц больше предела ${LIMITS.wasmMaxPages}`;
  }
  if (memory.min > LIMITS.wasmMaxPages) return `Начальная память ${memory.min} страниц больше предела ${LIMITS.wasmMaxPages}`;
  const exp = (name: string) => info.exports.find(e => e.name === name);
  if (!info.importedMemory && exp('memory')?.kind !== 'memory') return 'Нет экспорта memory';
  if (!same(exp('flux_alloc')?.type, ['i32'], ['i32'])) return 'Нет экспорта flux_alloc(i32) -> i32';
  if (!same(exp('flux_run')?.type, ['i32', 'i32'], ['i32'])) return 'Нет экспорта flux_run(i32, i32) -> i32';
  if (!same(exp('flux_output')?.type, [], ['i32'])) return 'Нет экспорта flux_output() -> i32';
  return '';
}
