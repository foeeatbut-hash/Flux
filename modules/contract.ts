import type { ConnectCall, ConnectErrorCode, ConnectionDecl, HttpMethod } from './connections/model';
import type { ProgramCallErrorCode } from './programs/model';
import type { ModuleLanguage, ModulePlatform, SourceLanguage, ComputeErrorCode } from './engine/types';
/**
 * v2 добавляет страницу (`ui: 'page'`), v3 — разделы `permissions` (интернет, локальная сеть, обращение к программам) и `exports` манифеста. Сообщения моста
 * остаются v1: добавляются только новые виды, смысл прежних не меняется. Выпуск с `permissions` — v3, и старый Flux
 * (его схема манифеста строгая) показывает «обновите Flux», а не запускает программу без права, о котором не знает.
 */
export const CONTRACT_VERSION = 3 as const;
export const resources = ['project', 'equipment', 'tag', 'specification', 'catalog'] as const;
export type Resource = typeof resources[number];
export interface LaunchContext {
  projectId: string | null;
  entry: 'start' | 'equipment' | 'tag';
  entityId: string | null;
}
/** Разрешение сети из раздела `permissions` манифеста (modules/permissions/registry.ts): `does` — что программа делает, текстом для человека */
export type ModulePermission =
  | { kind: 'internet' | 'lan'; does: string }
  /** Обращение к другой программе (`flux.programs.call`): `program` — её идентификатор, метод должен быть в её `exports` */
  | { kind: 'program'; program: string; does: string };
/** Метод, который программа отдаёт другим программам (modules/programs/model.ts): `does` — текст для человека */
export interface ModuleExport { method: string; does: string }
/** Витрина Flux Store (modules/store/model.ts): необязательна, без неё программа попадает в «Прочее» */
export interface ModuleStoreBlock {
  category: 'calc' | 'link' | 'docs' | 'reports' | 'other';
  summary: string;
  description?: string;
  /** Цвет значка и подложки, #rrggbb */
  color?: string;
  requires?: { flux?: string; platform?: 'any' | 'windows'; external?: string[] };
  /** Идентификаторы программ, без которых эта не работает */
  dependsOn?: string[];
  /** Для каких должностей (коды Role) */
  roles?: string[];
  /** Снимки экрана внутри пакета: store/имя.png */
  screenshots?: string[];
}
export interface ModuleManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  contractVersion: number;
  entries: Array<'start' | 'equipment' | 'tag'>;
  reads: Resource[];
  logic: string;
  /** Язык логики; без поля — TypeScript. Python и WebAssembly: см. modules/engine */
  language?: ModuleLanguage;
  /** Для WebAssembly: на чём написан исходник (C, C++, Rust, Go, C#) */
  sourceLanguage?: SourceLanguage;
  /** Где выпуск работает; без поля — на любой ОС */
  platform?: ModulePlatform;
  store?: ModuleStoreBlock;
  /** Подключения к внешним программам (этап 3б): разрешение — само объявление в подписанном выпуске */
  connections?: ConnectionDecl[];
  /** Разрешения сети (договор v3): «любой адрес в интернете», «локальная сеть»; больше видов — записями реестра разрешений */
  permissions?: ModulePermission[];
  /** Методы, которые вызываются из других программ (договор v3): чистые функции «JSON → JSON» в логике на Python или WebAssembly */
  exports?: ModuleExport[];
  /** Вид интерфейса: без поля — форма (form.json); `page` — своя страница ui/index.html (договор v2) */
  ui?: 'page';
  /** Дополнительные страницы программы-приложения (пути внутри ui/, например `settings.html`); открываются как окна Flux через flux.windows.open. Главная — ui/index.html */
  pages?: string[];
}
export interface Parameter { group: string; key: string; value: string; unit: string }
export interface TagData { id: string; identifier: string; name: string; parentId: string | null }
export interface EquipmentData {
  id: string; name: string; itemCode: string; equipType: string; version: number;
  params: Parameter[]; tags: TagData[];
  composition: Array<{ id: string; name: string; itemCode: string; parentId: string | null }>;
}
export interface ReadData {
  project: { id: string; name: string; code: string } | null;
  equipment: EquipmentData | null;
  tag: TagData | null;
  specification: { rows: TagData[] };
  catalog: { families: Array<{ id: string; name: string; code: string; classId: string }> };
}
export interface ReadRequest {
  flux: 'module'; v: 1; session: string; id: string; type: 'read';
  resource: Resource; entityId?: string;
}
/** Ответ HTTP как есть: код, заголовки (без set-cookie) и тело текстом либо base64 */
export interface HttpReply { status: number; headers: Record<string, string>; body: string; encoding: 'utf8' | 'base64' }
/** Сообщение WebSocket из очереди; `closed` — сокет закрыт, больше сообщений не будет; `empty` — за время ожидания ничего не пришло */
export type WsReply = { data: string; encoding: 'utf8' | 'base64' } | { closed: true } | { empty: true };
export type ModuleFailureKind = 'crash' | 'timeout' | 'memory' | 'bridge' | 'controls' | 'connection';
/** Действия страницы (договор v2). Названия не похожи на запись: мост отвергает «set/save/…» как попытку записи в данные Flux */
export type PageOp =
  | { op: 'state-load' }
  | { op: 'state-keep'; state: Record<string, unknown> }
  | { op: 'file-offer'; name: string; mime?: string; data: string; encoding: 'utf8' | 'base64' }
  /** Файл пользователя (добавлено к v2): диалог показывает Flux, программа получает имя и содержимое только выбранного файла */
  | { op: 'file-pick'; accept?: string[] }
  | { op: 'beat' }
  /** `options` — добавлено к v2: заголовок и размер нового окна */
  | { op: 'window-open'; page: string; params?: Record<string, unknown>; options?: { title?: string; width?: number; height?: number } }
  /** Диалоги через Flux (добавлено к v2): рисует Flux, программа даёт только простой текст */
  | { op: 'dialog-confirm'; title: string; text: string; ok?: string; cancel?: string; danger?: boolean }
  | { op: 'dialog-alert'; title: string; text: string }
  | { op: 'dialog-prompt'; title: string; text?: string; label: string; value?: string; maxLength?: number }
  /** Заголовок своего окна и пометка «есть несохранённое» (добавлено к v2) */
  | { op: 'window-title'; text: string }
  | { op: 'window-unsaved'; unsaved: boolean; text?: string }
  | { op: 'params-load' }
  | { op: 'channel-send'; data: unknown };
export type PageHostMessage =
  | { flux: 'module'; v: 1; session: string; type: 'page-result'; id: string; data: unknown }
  | { flux: 'module'; v: 1; session: string; type: 'page-message'; data: unknown }
  | { flux: 'module'; v: 1; session: string; type: 'page-error'; id: string; code: 'DENIED' | 'LIMIT' | 'FAILED' | 'CANCELLED' };
export type BridgeError = 'READ_ONLY' | 'DENIED' | 'NO_PROJECT' | 'FAILED' | 'LIMIT';
export type HostMessage =
  | { flux: 'module'; v: 1; session: string; type: 'event'; event: 'opened' | 'project-changed' | 'changed'; context: LaunchContext; theme: ThemeTokens }
  | { flux: 'module'; v: 1; session: string; type: 'result'; id: string; resource: Resource; data: ReadData[Resource] }
  | { flux: 'module'; v: 1; session: string; type: 'error'; id: string; code: BridgeError };
/** Расчёт на любом языке (modules/engine): модуль присылает вход, оболочка отвечает выходом или кодом ошибки */
export type ComputeHostMessage =
  | { flux: 'module'; v: 1; session: string; type: 'compute-result'; id: string; output: ModuleOutput }
  | { flux: 'module'; v: 1; session: string; type: 'compute-error'; id: string; code: ComputeErrorCode };
/** Ответы на сквозные вызовы подключений (этап 3б): данные внешней программы как есть либо код отказа */
export type ConnectHostMessage =
  | { flux: 'module'; v: 1; session: string; type: 'connect-result'; id: string; data: unknown }
  | { flux: 'module'; v: 1; session: string; type: 'connect-error'; id: string; code: ConnectErrorCode };
/** Ответы на обращение к другой программе (flux.programs.call): данные метода как есть либо код отказа */
export type ProgramHostMessage =
  | { flux: 'module'; v: 1; session: string; type: 'program-result'; id: string; data: unknown }
  | { flux: 'module'; v: 1; session: string; type: 'program-error'; id: string; code: ProgramCallErrorCode };
export type ThemeTokens = Record<
  '--flux-surface' | '--flux-bg' | '--flux-hover' | '--flux-sel' | '--flux-line' | '--flux-text' | '--flux-text-muted' | '--flux-accent',
  string
>;
export const themeKeys: Array<keyof ThemeTokens> = [
  '--flux-surface', '--flux-bg', '--flux-hover', '--flux-sel', '--flux-line', '--flux-text', '--flux-text-muted', '--flux-accent',
];
export interface ModuleApi {
  flux: {
    read<R extends Resource>(resource: R, entityId?: string): Promise<ReadData[R]>;
    on(event: 'changed', listener: () => void | Promise<void>): () => void;
  };
  /** Журнал программы: строка до 200 знаков, не чаще 5 в секунду; данные проектов в него не пишутся */
  log: { info(text: string): void; warn(text: string): void; error(text: string): void };
  /**
   * Подключения к внешним программам, объявленные в manifest.json. Вызов идёт как есть: Flux проверяет
   * только разрешение, адрес в пределах объявленного и пишет журнал. Доступно в логике на TypeScript.
   */
  connect: {
    /** Любой вызов в «сырой» форме: то, что ниже, — короткие обёртки над ним */
    call(connection: string, call: ConnectCall): Promise<any>;
    http(connection: string, request: { method: HttpMethod; path: string; headers?: Record<string, string>; body?: string; encoding?: 'utf8' | 'base64' }): Promise<HttpReply>;
    ws: {
      open(connection: string, path: string): Promise<string>;
      send(connection: string, socket: string, data: string, encoding?: 'utf8' | 'base64'): Promise<void>;
      recv(connection: string, socket: string, timeoutMs?: number): Promise<WsReply>;
      close(connection: string, socket: string): Promise<void>;
    };
    com: {
      open(connection: string): Promise<number>;
      call(connection: string, handle: number, name: string, args?: unknown[]): Promise<unknown>;
      get(connection: string, handle: number, name: string, args?: unknown[]): Promise<unknown>;
      set(connection: string, handle: number, name: string, value: unknown, args?: unknown[]): Promise<void>;
      release(connection: string, handle: number): Promise<void>;
    };
  };
  state: Record<string, unknown>;
  calc: { out: Record<string, unknown> };
}
export type ModuleReader = <R extends Resource>(resource: R, entityId?: string) => Promise<ReadData[R]>;
export interface ModuleOutput {
  state: ModuleApi['state'];
  calc: ModuleApi['calc'];
}
