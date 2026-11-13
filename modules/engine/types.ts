/**
 * Общие понятия исполнения логики модуля — для всех языков.
 *
 * Для оболочки расчёт — чёрный ящик: на вход JSON, на выход JSON по схеме
 * договора (`ModuleOutput`). Язык (TypeScript, Python, WebAssembly) — только
 * способ получить этот выход; всё остальное — пределы, проверка чисел,
 * контрольные примеры, счётчики сбоев — одно для всех (решение владельца
 * 7 ноября 2026: языки ровно эти).
 *
 * Без зависимостей: файл читают и Node (проверка выпуска), и окно, и изолированные
 * хосты исполнения.
 */
export const LANGUAGES = ['typescript', 'python', 'wasm'] as const;
export type ModuleLanguage = typeof LANGUAGES[number];
/** Исходный язык `.wasm`: Flux исполняет только байты, язык нужен человеку (Studio, Store, владелец при проверке) */
export const SOURCE_LANGUAGES = ['c', 'cpp', 'rust', 'go', 'csharp'] as const;
export type SourceLanguage = typeof SOURCE_LANGUAGES[number];
/** WebAssembly, Python и TS — одни на все ОС; `windows` оставлен для будущих исполняемых модулей */
export const PLATFORMS = ['any', 'windows'] as const;
export type ModulePlatform = typeof PLATFORMS[number];

export const LOGIC_FILES: Record<ModuleLanguage, string> = {
  typescript: 'logic/main.ts', python: 'logic/main.py', wasm: 'logic/main.wasm',
};
/** Контрольные примеры в пакете: обязательны для Python и WebAssembly и для TypeScript с методами для других программ (`exports`) */
export const CONTROLS_FILE = 'examples/controls.json';
/**
 * Собранный JavaScript логики TypeScript — лежит в пакете, только когда у программы непустой `exports`: Flux сам TypeScript не
 * компилирует, метод для других программ исполняет именно этот файл (его кладут сборка Flux и Studio). Формат: скрипт, который
 * кладёт функции логики в `globalThis.__fluxLogic` (modules/compute/tsWorker.ts вызывает `compute`).
 */
export const LOGIC_BUILD_FILE = 'build/logic.js';

export const languageOf = (m: { language?: ModuleLanguage }): ModuleLanguage => m.language ?? 'typescript';
export const platformOf = (m: { platform?: ModulePlatform }): ModulePlatform => m.platform ?? 'any';

/** Пределы одинаковы для всех механизмов: разработчик не выбирает язык ради обхода предела */
export const LIMITS = {
  /** Вход одного расчёта, байт: столько же, сколько допускает мост */
  inputBytes: 1024 * 1024,
  /** Выход: состояние и результаты вместе (modules/runtime/output.ts) */
  outputBytes: 256 * 1024,
  timeoutMs: 30_000,
  /** Страниц по 64 КиБ в WebAssembly.Memory: 64 МиБ */
  wasmMaxPages: 1024,
  /** Среде .NET (WASI-команда) нужно больше: 128 МиБ */
  wasmCommandMaxPages: 2048,
  /** Pyodide занимает ~30 МиБ (с numpy больше); 512 МиБ — потолок роста до MemoryError */
  pythonMaxPages: 8192,
  jsonDepth: 32,
  wasmFileBytes: 8 * 1024 * 1024,
  pythonFileBytes: 1024 * 1024,
  /** Собранный JS логики TypeScript (build/logic.js): тот же предел, что у файла Python */
  tsFileBytes: 1024 * 1024,
  controlsFileBytes: 64 * 1024,
  controlCases: 8,
} as const;

export type ComputeErrorCode =
  | 'TIMEOUT' | 'MEMORY' | 'CRASH' | 'BAD_INPUT' | 'BAD_OUTPUT' | 'NUMBER' | 'BUSY' | 'ABI' | 'UNAVAILABLE' | 'CONTROLS' | 'DENIED';
export const COMPUTE_ERROR_CODES: readonly ComputeErrorCode[] = [
  'TIMEOUT', 'MEMORY', 'CRASH', 'BAD_INPUT', 'BAD_OUTPUT', 'NUMBER', 'BUSY', 'ABI', 'UNAVAILABLE', 'CONTROLS', 'DENIED',
];
export class ComputeError extends Error {
  constructor(public code: ComputeErrorCode, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ComputeError';
  }
}
export const codeOf = (error: unknown): ComputeErrorCode => error instanceof ComputeError ? error.code : 'CRASH';
/** В счётчик сбоев уходит вид, а не текст ошибки: тексты могут содержать данные проекта */
export function failureKindOf(code: ComputeErrorCode): 'crash' | 'timeout' | 'memory' | 'controls' | null {
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'MEMORY') return 'memory';
  if (code === 'CONTROLS') return 'controls';
  if (code === 'CRASH' || code === 'ABI' || code === 'BAD_OUTPUT' || code === 'NUMBER') return 'crash';
  return null;
}

/** Вход расчёта, который оболочка собирает для любого языка */
export interface ComputeInput {
  v: 1;
  context: { projectId: string | null; entry: 'start' | 'equipment' | 'tag'; entityId: string | null };
  flux: Record<string, unknown>;
  state: Record<string, unknown>;
  /** Зерно случайности: без него случайности нет, с ним результат повторяется */
  seed?: number;
}
