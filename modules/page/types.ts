/**
 * Типы `flux.*` для редактора кода (Studio): текст `types/flux.d.ts`, который собирается из договора, а не
 * пишется отдельно. Список ресурсов, токенов темы и кодов ошибок берётся из тех же констант, по которым
 * мост проверяет сообщения, поэтому типы не расходятся с поведением.
 */
import { resources, themeKeys } from '../contract';
import { COMPUTE_ERROR_CODES } from '../engine/types';
import { PROGRAM_ERROR_CODES, PROGRAM_LIMITS } from '../programs/model';
import { PAGE_ERROR_CODES, PAGE_LIMITS, WINDOW_LIMITS } from './model';

const union = (items: readonly string[]) => items.map(item => `'${item}'`).join(' | ');

export const FLUX_TYPES_FILE = 'types/flux.d.ts';

export function fluxPageTypes(): string {
  return `// Типы flux.* (договор v2). Файл создаёт Studio из договора Flux: править не нужно.
// Подключите клиент в странице: <script src="/_flux/flux.v1.js"></script>

type FluxResource = ${union(resources)};
type FluxErrorCode = ${union(['READ_ONLY', 'DENIED', 'NO_PROJECT', 'FAILED', 'LIMIT', 'TIMEOUT', 'CONTEXT_CHANGED', ...PROGRAM_ERROR_CODES, ...PAGE_ERROR_CODES, ...COMPUTE_ERROR_CODES])};

interface FluxParameter { group: string; key: string; value: string; unit: string }
interface FluxTag { id: string; identifier: string; name: string; parentId: string | null }
interface FluxEquipment {
  id: string; name: string; itemCode: string; equipType: string; version: number;
  params: FluxParameter[]; tags: FluxTag[];
  composition: Array<{ id: string; name: string; itemCode: string; parentId: string | null }>;
}
interface FluxReadData {
  project: { id: string; name: string; code: string } | null;
  equipment: FluxEquipment | null;
  tag: FluxTag | null;
  specification: { rows: FluxTag[] };
  catalog: { families: Array<{ id: string; name: string; code: string; classId: string }> };
}
interface FluxContext { projectId: string | null; entry: 'start' | 'equipment' | 'tag'; entityId: string | null }
type FluxThemeToken = ${union(themeKeys)};
interface FluxTheme { tokens: Record<FluxThemeToken, string>; mode: 'light' | 'dark' }
interface FluxSize { width: number; height: number }
interface FluxOutput { state: Record<string, unknown>; calc: { out: Record<string, unknown> } }
interface FluxFetchInit { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; body?: string }
interface FluxHttpReply { status: number; ok: boolean; headers: Record<string, string>; text(): string; json(): unknown; bytes(): Uint8Array }

declare class FluxError extends Error { code: FluxErrorCode }

declare const flux: {
  /** Готово, когда Flux прислал контекст и тему */
  readonly ready: Promise<{ context: FluxContext; theme: FluxTheme }>;
  readonly context: FluxContext;
  readonly theme: FluxTheme;
  readonly size: FluxSize;
  /** Только чтение; ресурс должен быть в reads манифеста */
  read<R extends FluxResource>(resource: R, entityId?: string): Promise<FluxReadData[R]>;
  /** Расчёт логики (Python, WebAssembly): вход JSON, выход state и calc.out */
  compute(input: Record<string, unknown>): Promise<FluxOutput>;
  /** Состояние хранит Flux в памяти (не на диске), общее для окон программы; до ${PAGE_LIMITS.stateBytes / 1024} КиБ */
  state: { get(): Promise<Record<string, unknown>>; set(state: Record<string, unknown>): Promise<null> };
  /** Подключение из manifest.json; первое обращение Flux подтверждает у человека */
  connect: { call(connection: string, call: Record<string, unknown>): Promise<unknown> };
  /**
   * Обращение к другой программе: flux.programs.call('rates', 'convert', { … }). Нужно разрешение { kind: 'program', program: 'rates', does: '…' }
   * в permissions manifest.json (формат contractVersion 3), а у вызываемой — метод в её exports. Исполняется логика вызываемой программы
   * (Python или WebAssembly: вход { export, data }, ответ — calc.out), окно она не открывает; данные и ответ до ${PROGRAM_LIMITS.bytes / 1024} КиБ,
   * не больше ${PROGRAM_LIMITS.inFlight} вызовов одновременно и ${PROGRAM_LIMITS.perSecond} в секунду. Ошибки (FluxError.code): NOT_ALLOWED, NOT_INSTALLED, NO_METHOD, LIMIT, TIMEOUT, FAILED.
   */
  programs: { call(program: string, method: string, data?: unknown): Promise<Record<string, unknown>> };
  /**
   * Сеть только через Flux; кадр сам в сеть не ходит. Две формы:
   * fetch(url, init) — полный адрес http(s)://…: нужно разрешение { kind: 'internet' } (публичные адреса) или { kind: 'lan' } (частная сеть) в permissions manifest.json
   * (формат contractVersion 3); петля, «этот компьютер» и метаданные облака закрыты всегда, редиректы не выполняются, cookie нет, ответ до 512 КиБ;
   * fetch(connection, path, init) — подключение kind http из manifest.json (локальный сервер, адрес объявлен в манифесте).
   */
  net: {
    fetch(url: string, init?: FluxFetchInit): Promise<FluxHttpReply>;
    fetch(connection: string, path: string, init?: FluxFetchInit): Promise<FluxHttpReply>;
  };
  /** Отдать файл пользователю: Flux спросит и сохранит через системный диалог (до ~500 КБ) */
  saveFile(name: string, data: string | Uint8Array, mime?: string): Promise<'saved'>;
  /** Попросить у пользователя файл: Flux покажет системный диалог; программа получает имя и содержимое только выбранного файла (до ${PAGE_LIMITS.openBytes / 1024} КиБ). Отказ человека — ошибка CANCELLED */
  openFile(options?: { accept?: string[] }): Promise<{ name: string; size: number; mime: string; bytes(): Uint8Array; text(): string }>;
  /** Свои окна программы (до ${WINDOW_LIMITS.windows}): страница index.html или объявленная в manifest.json pages */
  windows: {
    open(page: string, params?: Record<string, unknown>): Promise<null>;
    params(): Promise<Record<string, unknown>>;
    send(data: unknown): Promise<null>;
    onMessage(listener: (data: unknown) => void): () => void;
  };
  onChange(listener: (event: 'opened' | 'project-changed' | 'changed') => void): () => void;
  onTheme(listener: (theme: FluxTheme) => void): () => void;
  onResize(listener: (size: FluxSize) => void): () => void;
  log: { info(text: string): void; warn(text: string): void; error(text: string): void };
  FluxError: typeof FluxError;
  version: 1;
};
`;
}
