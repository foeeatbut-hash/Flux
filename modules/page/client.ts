/**
 * Клиент `flux.*` для страницы программы (договор v2). Собирается в `_flux/flux.v1.js` и подключается
 * тегом `<script src="/_flux/flux.v1.js">`; в пакет не копируется — его поставляет Flux.
 *
 * Страница не получает ничего, кроме сообщений моста: окно Flux проверяет и ограничивает каждое из них
 * (modules/bridge.ts). Запись в данные Flux здесь отсутствует: методов записи нет, а мост отвергает
 * их, даже если страница пришлёт сообщение в обход клиента.
 */
import type { LaunchContext, ModuleOutput, ReadData, Resource, ThemeTokens } from '../contract';
import { themeKeys } from '../contract';
import type { ConnectCall } from '../connections/model';
import { PAGE_LIMITS } from './model';

// Сессию Flux задаёт и в имени кадра: переход не по ссылке (location.href, свой #якорь) не теряет мост
const session = window.name || location.hash.slice(1);
let nextId = 0;
/** Диалог ждёт человека: ограничение — только чтобы запрос не висел вечно */
const DIALOG_WAIT_MS = 600_000;
type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; keep?: boolean };
const waiting = new Map<string, Waiter>();
const listeners = { message: new Set<(data: unknown) => void>(), change: new Set<(event: ChangeEvent) => void>(), theme: new Set<(theme: ThemeInfo) => void>(), resize: new Set<(size: SizeInfo) => void>() };
export interface ThemeInfo { tokens: ThemeTokens; mode: 'light' | 'dark' }
export interface SizeInfo { width: number; height: number }
/** Параметры flux.net.fetch */
export interface NetInit { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; body?: string }
export type ChangeEvent = 'opened' | 'project-changed' | 'changed';
export class FluxError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'FluxError'; }
}
const NOTES: Record<string, string> = {
  READ_ONLY: 'Flux не принимает записи от программы.',
  DENIED: 'Не разрешено: этого нет в манифесте программы или действие запрещено.',
  NO_PROJECT: 'Откройте проект во Flux.',
  FAILED: 'Не удалось выполнить.',
  LIMIT: 'Превышен предел (размер или частота запросов).',
  CANCELLED: 'Пользователь отказался.',
  TIMEOUT: 'Не дождались ответа.',
  BUSY: 'Сейчас идёт много расчётов. Повторите чуть позже.',
  UNAVAILABLE: 'Недоступно: у программы нет такого механизма.',
  MEMORY: 'Расчёту не хватило памяти.',
  CRASH: 'Расчёт завершился ошибкой.',
  NOT_ALLOWED: 'Не разрешено: нет разрешения в манифесте, отказ человека или администратора, вызов самой себя или вложенный вызов.',
  NOT_INSTALLED: 'Эта программа не установлена у пользователя или ему не допущена.',
  NO_METHOD: 'У программы нет такого метода для других программ.',
  CONTEXT_CHANGED: 'Проект или оформление изменились во время запроса.',
};
const fail = (code: string) => new FluxError(code, NOTES[code] || `Ошибка: ${code}`);

let current: { context: LaunchContext; theme: ThemeInfo } | null = null;
let resolveReady!: (value: { context: LaunchContext; theme: ThemeInfo }) => void;
const ready = new Promise<{ context: LaunchContext; theme: ThemeInfo }>(resolve => { resolveReady = resolve; });

function request<T>(type: string, body: Record<string, unknown>, ms: number): Promise<T> {
  const id = `${type[0]}-${++nextId}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(fail('TIMEOUT')); }, ms);
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    parent.postMessage({ flux: 'module', v: 1, session, id, type, ...body }, '*');
  });
}
function settle(id: string, outcome: { value: unknown } | { code: string }) {
  const item = waiting.get(id);
  if (!item) return;
  waiting.delete(id);
  clearTimeout(item.timer);
  if ('code' in outcome) item.reject(fail(outcome.code)); else item.resolve(outcome.value);
}
/** Светлая или тёмная: тема Flux приходит только цветами, поэтому определяем по яркости фона */
function modeOf(tokens: ThemeTokens): 'light' | 'dark' {
  const m = /^#?([0-9a-f]{6})$/i.exec((tokens['--flux-surface'] || '').trim());
  if (!m) return 'light';
  const n = parseInt(m[1], 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) < 128 ? 'dark' : 'light';
}
function applyTheme(tokens: ThemeTokens): ThemeInfo {
  for (const key of themeKeys) document.documentElement.style.setProperty(key, tokens[key]);
  const info = { tokens, mode: modeOf(tokens) };
  document.documentElement.dataset.fluxTheme = info.mode;
  return info;
}
function size(): SizeInfo { return { width: window.innerWidth, height: window.innerHeight }; }
const emit = <T>(set: Set<(value: T) => void>, value: T) => {
  for (const listener of [...set]) { try { listener(value); } catch (e) { api.log.error(`Ошибка обработчика: ${(e as Error)?.message ?? e}`); } }
};

window.addEventListener('message', event => {
  const message = event.data;
  if (event.source !== parent || !message || message.flux !== 'module' || message.session !== session) return;
  switch (message.type) {
    case 'event': {
      const previous = current?.theme.tokens;
      const theme = applyTheme(message.theme);
      current = { context: message.context, theme };
      // Первый сигнал сразу: страница, зависшая раньше первого интервала, всё равно будет замечена
      if (message.event === 'opened') { resolveReady(current); request('page', { op: 'beat' }, 1000).catch(() => undefined); }
      emit(listeners.change, message.event as ChangeEvent);
      if (previous && themeKeys.some(key => previous[key] !== message.theme[key])) emit(listeners.theme, theme);
      return;
    }
    case 'page-message': emit(listeners.message, message.data); return;
    case 'result': settle(message.id, { value: message.data }); return;
    case 'error': case 'page-error': case 'connect-error': case 'compute-error': case 'program-error': settle(message.id, { code: message.code }); return;
    case 'compute-result': settle(message.id, { value: message.output }); return;
    case 'connect-result': case 'page-result': case 'program-result': settle(message.id, { value: message.data }); return;
  }
});
window.addEventListener('resize', () => emit(listeners.resize, size()));
// Сигнал «страница жива»: если главный поток страницы завис, Flux по тишине покажет «программа не отвечает»
setInterval(() => request('page', { op: 'beat' }, 1000).catch(() => undefined), PAGE_LIMITS.beatMs);
const subscribe = <T>(set: Set<(value: T) => void>, listener: (value: T) => void) => { set.add(listener); return () => { set.delete(listener); }; };

const api = {
  /** Готово, когда Flux прислал контекст и тему */
  ready,
  get context(): LaunchContext { return current?.context ?? { projectId: null, entry: 'start', entityId: null }; },
  get theme(): ThemeInfo { return current?.theme ?? { tokens: Object.fromEntries(themeKeys.map(k => [k, ''])) as ThemeTokens, mode: 'light' }; },
  get size(): SizeInfo { return size(); },
  /** Только чтение: ресурсы из `reads` манифеста */
  read<R extends Resource>(resource: R, entityId?: string): Promise<ReadData[R]> {
    return request('read', { resource, ...(entityId ? { entityId } : {}) }, 10_000);
  },
  /** Расчёт логики программы (Python, WebAssembly и языки, что в него собираются): вход JSON, выход состояние и результаты */
  compute(input: Record<string, unknown>): Promise<ModuleOutput> {
    return request('compute', { input }, 120_000);
  },
  /** Состояние: хранит Flux в памяти (общее для окон программы), переживает перезапуск страницы, но не закрытие Flux и не выход из профиля; до 256 КиБ */
  state: {
    get: () => request<Record<string, unknown>>('page', { op: 'state-load' }, 5000),
    set: (state: Record<string, unknown>) => request<null>('page', { op: 'state-keep', state }, 5000),
  },
  /** Подключение к внешней программе, объявленное в манифесте; при первом обращении Flux сам спросит разрешение */
  connect: {
    call: (connection: string, call: ConnectCall) => request<unknown>('connect', { connection, call }, 40_000),
  },
  /**
   * Обращение к другой программе: `flux.programs.call('rates', 'convert', { … })`. Нужно разрешение `program` на её идентификатор в
   * `permissions` манифеста, а у неё — метод в `exports`. Исполняется логика вызываемой программы (чистая функция «JSON → JSON»),
   * окно она не открывает; данные и ответ до 256 КиБ. Ошибки (`FluxError.code`): NOT_ALLOWED, NOT_INSTALLED, NO_METHOD, LIMIT, TIMEOUT, FAILED.
   */
  programs: {
    call: (program: string, method: string, data: unknown = {}) => request<unknown>('program', { call: { program, method, data } }, 45_000),
  },
  /**
   * Сеть — только через мост; кадр сам в сеть не ходит, а адрес, пределы, защиту и журнал держит главный процесс Flux.
   * Две формы:
   * - `fetch(connection, path, init)` — по подключению kind http, объявленному в manifest.json (локальные серверы, адрес в манифесте);
   * - `fetch(url, init)` — по полному адресу `http(s)://…`: нужно разрешение `internet` (публичные адреса) или `lan` (частная сеть)
   *   в `permissions` манифеста. Петля, адрес метаданных облака и «этот компьютер» закрыты всегда.
   */
  net: {
    async fetch(first: string, second?: string | NetInit, third?: NetInit) {
      const byUrl = /^https?:\/\//i.test(first);
      const init: NetInit = (byUrl ? second : third) as NetInit | undefined ?? {};
      const send = { method: init.method || 'GET', ...(init.headers ? { headers: init.headers } : {}), ...(init.body !== undefined ? { body: init.body, encoding: 'utf8' } : {}) };
      const reply = await request<{ status: number; headers: Record<string, string>; body: string; encoding: 'utf8' | 'base64' }>(
        byUrl ? 'net' : 'connect',
        byUrl ? { call: { url: first, ...send } } : { connection: first, call: { op: 'http', path: second as string, ...send } },
        40_000);
      const bytes = () => reply.encoding === 'base64' ? Uint8Array.from(atob(reply.body), c => c.charCodeAt(0)) : new TextEncoder().encode(reply.body);
      const text = () => reply.encoding === 'utf8' ? reply.body : new TextDecoder().decode(bytes());
      return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: reply.headers, text, json: () => JSON.parse(text()) as unknown, bytes };
    },
  },
  /** Предложить пользователю сохранить файл: Flux покажет диалог, страница на диск не пишет. До ~500 КБ */
  saveFile(name: string, data: string | Uint8Array, mime = 'application/octet-stream'): Promise<'saved'> {
    let text: string, encoding: 'utf8' | 'base64' = 'utf8';
    if (typeof data === 'string') text = data;
    else { let raw = ''; for (let i = 0; i < data.length; i += 0x8000) raw += String.fromCharCode(...data.subarray(i, i + 0x8000)); text = btoa(raw); encoding = 'base64'; }
    return request('page', { op: 'file-offer', name, mime, data: text, encoding }, 120_000);
  },
  /**
   * Попросить у пользователя файл (добавлено к v2): Flux покажет системный диалог, человек выберет файл сам,
   * программа получит только его имя и содержимое (до 512 КиБ). Отказ человека — ошибка CANCELLED.
   * `accept` — подсказка диалогу, например ['.csv', '.txt']; выбрать можно и другой файл, проверяйте содержимое.
   */
  async openFile(options: { accept?: string[] } = {}) {
    const reply = await request<{ name: string; size: number; mime: string; data: string; encoding: 'base64' }>('page', { op: 'file-pick', ...(options.accept ? { accept: options.accept } : {}) }, 300_000);
    const bytes = () => Uint8Array.from(atob(reply.data), c => c.charCodeAt(0));
    return { name: reply.name, size: reply.size, mime: reply.mime, bytes, text: () => new TextDecoder().decode(bytes()) };
  },
  /** Окна программы: каждое — обычное окно Flux с этой же страницей пакета либо другой, объявленной в manifest.json (pages) */
  windows: {
    /** `options` (добавлено к v2) — заголовок (до 80 знаков, виден после названия программы) и размер окна: не меньше 320×240, не больше рабочей области */
    open: (page: string, params: Record<string, unknown> = {}, options?: { title?: string; width?: number; height?: number }) =>
      request<null>('page', { op: 'window-open', page, params, ...(options ? { options } : {}) }, 5000),
    /** Параметры, с которыми открыто это окно */
    params: () => request<Record<string, unknown>>('page', { op: 'params-load' }, 5000),
    /** Сообщение всем остальным окнам этой программы (до 64 КБ) */
    send: (data: unknown) => request<null>('page', { op: 'channel-send', data }, 5000),
    onMessage: (listener: (data: unknown) => void) => subscribe(listeners.message, listener),
  },
  /** Своё окно (добавлено к v2) */
  window: {
    /** Заголовок окна: Flux показывает «Программа — заголовок»; пустая строка возвращает название программы. До 80 знаков */
    setTitle: (text: string) => request<null>('page', { op: 'window-title', text: String(text) }, 5000),
    /** В окне есть несохранённое: при закрытии Flux сам спросит «Закрыть без сохранения?» (с вашим текстом до 200 знаков). Закрытие программа не блокирует */
    setUnsaved: (unsaved: boolean, text?: string) => request<null>('page', { op: 'window-unsaved', unsaved: !!unsaved, ...(text ? { text: String(text) } : {}) }, 5000),
  },
  /**
   * Диалоги Flux (добавлено к v2): рисует Flux своим окном с названием программы, вы даёте простой текст (заголовок до 80 знаков, текст до 600, кнопки до 30).
   * Один диалог на окно за раз (второй — LIMIT), не чаще раза в секунду. Закрытие окна программы закрывает диалог без ответа.
   */
  dialogs: {
    confirm: (options: { title: string; text: string; ok?: string; cancel?: string; danger?: boolean }) =>
      request<boolean>('page', { op: 'dialog-confirm', title: options.title, text: options.text, ...(options.ok ? { ok: options.ok } : {}), ...(options.cancel ? { cancel: options.cancel } : {}), ...(options.danger ? { danger: true } : {}) }, DIALOG_WAIT_MS),
    alert: (options: { title: string; text: string }) => request<null>('page', { op: 'dialog-alert', title: options.title, text: options.text }, DIALOG_WAIT_MS),
    /** Строка или null, если человек отказался */
    prompt: (options: { title: string; text?: string; label: string; value?: string; maxLength?: number }) =>
      request<string | null>('page', { op: 'dialog-prompt', title: options.title, label: options.label, ...(options.text ? { text: options.text } : {}), ...(options.value !== undefined ? { value: options.value } : {}), ...(options.maxLength ? { maxLength: options.maxLength } : {}) }, DIALOG_WAIT_MS),
  },
  onChange: (listener: (event: ChangeEvent) => void) => subscribe(listeners.change, listener),
  onTheme: (listener: (theme: ThemeInfo) => void) => subscribe(listeners.theme, listener),
  onResize: (listener: (size: SizeInfo) => void) => subscribe(listeners.resize, listener),
  /** Журнал программы: строка до 200 знаков, не чаще 5 в секунду; данные проектов в него не пишутся */
  log: {
    info: (text: string) => parent.postMessage({ flux: 'module', v: 1, session, type: 'log', level: 'info', text: String(text).slice(0, 200) }, '*'),
    warn: (text: string) => parent.postMessage({ flux: 'module', v: 1, session, type: 'log', level: 'warn', text: String(text).slice(0, 200) }, '*'),
    error: (text: string) => parent.postMessage({ flux: 'module', v: 1, session, type: 'log', level: 'error', text: String(text).slice(0, 200) }, '*'),
  },
  FluxError,
  version: 1 as const,
};
export type FluxApi = typeof api;
(globalThis as unknown as { flux: FluxApi }).flux = Object.freeze(api);
parent.postMessage({ flux: 'module', v: 1, session, type: 'ready' }, '*');

// Переходы между страницами пакета по обычным ссылкам: сессию моста несёт адрес (#сессия), поэтому добавляем её сами
document.addEventListener('click', event => {
  const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (link && link.origin === location.origin && !link.hash && link.pathname !== location.pathname) link.hash = session;
}, true);
