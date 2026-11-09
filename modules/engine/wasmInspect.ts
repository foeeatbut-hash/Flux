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
/**
 * Все имена WASI preview1: рантаймы (.NET, wasi-libc) импортируют их скопом, даже не пользуясь.
 * Работают только вывод/ввод стандартных потоков, аргументы и окружение (пустые), часы (стоят),
 * случайность (от зерна); остальное в wasm.ts отвечает «не поддерживается» и ничего не открывает.
 */
export const WASI_NAMES = [
  'args_get', 'args_sizes_get', 'environ_get', 'environ_sizes_get', 'clock_res_get', 'clock_time_get',
  'fd_advise', 'fd_allocate', 'fd_close', 'fd_datasync', 'fd_fdstat_get', 'fd_fdstat_set_flags', 'fd_fdstat_set_rights',
  'fd_filestat_get', 'fd_filestat_set_size', 'fd_filestat_set_times', 'fd_pread', 'fd_prestat_get', 'fd_prestat_dir_name',
  'fd_pwrite', 'fd_read', 'fd_readdir', 'fd_renumber', 'fd_seek', 'fd_sync', 'fd_tell', 'fd_write',
  'path_create_directory', 'path_filestat_get', 'path_filestat_set_times', 'path_link', 'path_open', 'path_readlink',
  'path_remove_directory', 'path_rename', 'path_symlink', 'path_unlink_file', 'poll_oneoff', 'proc_exit', 'proc_raise',
  'random_get', 'sched_yield', 'sock_accept', 'sock_recv', 'sock_send', 'sock_shutdown',
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
  const abi = wasmAbi(info);
  if (!abi) return 'Нет ни экспортов flux_alloc/flux_run/flux_output, ни _start: непонятно, как вызвать расчёт';
  const cap = wasmPageCap(abi);
  const memory = info.importedMemory || info.memory;
  if (!memory) return 'У модуля нет линейной памяти';
  if (memory.shared) return 'Общая (shared) память не поддерживается';
  if (info.memory && !info.importedMemory) {
    // Свою память модуль не даёт ограничить снаружи: предел должен быть записан в самом файле
    if (memory.max === null) return `У памяти не задан максимум: пересоберите с пределом не более ${cap * 64} КиБ`;
    if (memory.max > cap) return `Максимум памяти ${memory.max} страниц больше предела ${cap}`;
  }
  if (memory.min > cap) return `Начальная память ${memory.min} страниц больше предела ${cap}`;
  const exp = (name: string) => info.exports.find(e => e.name === name);
  if (!info.importedMemory && exp('memory')?.kind !== 'memory') return 'Нет экспорта memory';
  return '';
}

/**
 * Два способа вызова, один результат:
 * - `reactor` (C, C++, Rust, Go/TinyGo): экспорты flux_alloc / flux_run / flux_output, JSON в памяти модуля;
 * - `command` (C#/.NET и всё, что умеет только WASI): `_start`, вход на stdin, выход на stdout.
 */
export type WasmAbi = 'reactor' | 'command';
export function wasmAbi(info: WasmInfo): WasmAbi | null {
  const exp = (name: string) => info.exports.find(e => e.name === name);
  if (same(exp('flux_alloc')?.type, ['i32'], ['i32']) && same(exp('flux_run')?.type, ['i32', 'i32'], ['i32'])
    && same(exp('flux_output')?.type, [], ['i32'])) return 'reactor';
  if (exp('_start')?.kind === 'func' && same(exp('_start')?.type, [], [])) return 'command';
  return null;
}
/** .NET в памяти тяжелее: ему положен больший потолок, но тоже записанный в самом файле */
export const wasmPageCap = (abi: WasmAbi) => abi === 'command' ? LIMITS.wasmCommandMaxPages : LIMITS.wasmMaxPages;
