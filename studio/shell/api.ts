/**
 * Запросы Studio к локальному серверу Flux.
 *
 * Токен сессии живёт только в главном процессе, окно его не видит. Маршруты
 * перечислены явно: оболочка разработчика не может сходить на чужой адрес и не
 * вызывает ничего, кроме входа и двух маршрутов Studio. Сервер всё равно
 * проверяет право разработки сам (server/routes/studio.ts) — список здесь
 * нужен, чтобы ошибка в окне не превратилась в произвольный запрос.
 */
const ROUTES = {
  login: { method: 'POST', path: '/api/login' },
  session: { method: 'GET', path: '/api/studio/session' },
  modules: { method: 'GET', path: '/api/studio/modules' },
  /** Версия Flux в общей базе: для предупреждения «обновите Studio»; без входа */
  health: { method: 'GET', path: '/api/health' },
  certificate: { method: 'GET', path: '/api/studio/certificate' },
  requests: { method: 'GET', path: '/api/studio/requests' },
  requestBundle: { method: 'GET', path: '/api/studio/requests/:id/bundle' },
  releases: { method: 'GET', path: '/api/studio/releases' },
  /** Единственная запись Studio в рабочую базу при публикации: подписанный запрос (сервер проверяет подпись и право) */
  submit: { method: 'POST', path: '/api/modules/requests' },
  /** Ошибки: обращения по своим подпрограммам и счётчики сбоев — существующие маршруты Flux, сервер сам отбирает «свои» */
  reports: { method: 'GET', path: '/api/feedback/reports' },
  crashes: { method: 'GET', path: '/api/modules/crashes' },
  /** Отметка «исправлено в версии»: смена состояния обращения по подпрограмме, право проверяет сервер */
  transition: { method: 'POST', path: '/api/feedback/reports/:id/transition' },
} as const;
export type StudioRoute = keyof typeof ROUTES;

/** Ответ сервера Studio короткий; больше мегабайта — признак чужого или сломанного ответа. Пакет подпрограммы — отдельно */
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 40 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export class StudioFailure extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

/** Studio разговаривает только с локальным обработчиком на этом компьютере */
export function loopbackOrigin(input: string): string {
  let url: URL;
  try { url = new URL(String(input)); } catch { throw new StudioFailure('Подключение к Flux настроено некорректно. Подключитесь к базе заново.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local || url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new StudioFailure('Flux Studio работает только с локальным обработчиком на этом компьютере. Подключитесь к базе заново.');
  }
  return url.origin;
}

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0, text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new StudioFailure('Ответ Flux слишком большой.'); }
    text += decoder.decode(value, { stream: true });
  }
}

export interface RequestOptions {
  token?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number;
  /** Подстановки в путь (`:id`): только безопасные идентификаторы, иначе окно могло бы дописать путь */
  params?: Record<string, string>;
  query?: Record<string, string | number>;
}

function urlOf(base: string, path: string, options: RequestOptions): string {
  const filled = path.replace(/:([a-z]+)/g, (_m, name: string) => {
    const value = options.params?.[name];
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new StudioFailure('Некорректный идентификатор в запросе.');
    return value;
  });
  const query = Object.entries(options.query || {}).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
  return base + filled + (query ? `?${query}` : '');
}

export async function studioRequest<T = any>(origin: string, route: StudioRoute, options: RequestOptions = {}): Promise<T> {
  const target = ROUTES[route];
  if (!target) throw new StudioFailure('Маршрут недоступен оболочке Studio.');
  const base = loopbackOrigin(origin);
  const signals = [AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  const url = urlOf(base, target.path, options);
  let response: Response;
  try {
    response = await fetch(url, {
      method: target.method, signal: AbortSignal.any(signals), redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error: any) {
    if (options.signal?.aborted) throw new StudioFailure('Операция отменена.');
    throw new StudioFailure(error?.name === 'TimeoutError' ? 'Flux не ответил вовремя. Проверьте подключение к базе.' : 'Не удалось связаться с локальным обработчиком Flux.');
  }
  const text = await readLimited(response);
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* не JSON — сообщим общим текстом ниже */ }
  if (!response.ok) {
    // Тексты отказов пишет сервер по-русски и без секретов — показываем их как есть, но с пределом
    const said = typeof json?.error === 'string' ? json.error : typeof json?.error?.message === 'string' ? json.error.message : typeof json?.message === 'string' ? json.message : '';
    throw new StudioFailure(said.slice(0, 400) || `Flux ответил ошибкой ${response.status}.`, response.status);
  }
  if (json === null || typeof json !== 'object') throw new StudioFailure('Flux вернул непонятный ответ.', response.status);
  return json as T;
}

/** Пакет своего запроса: бинарный ответ, предел больше, чем у обычных */
export async function studioBinary(origin: string, route: StudioRoute, options: RequestOptions = {}): Promise<Uint8Array> {
  const target = ROUTES[route];
  const base = loopbackOrigin(origin);
  const url = urlOf(base, target.path, options);
  let response: Response;
  try {
    response = await fetch(url, {
      method: target.method, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
    });
  } catch { throw new StudioFailure('Не удалось связаться с локальным обработчиком Flux.'); }
  if (!response.ok) throw new StudioFailure(response.status === 404 ? 'Запрос не найден.' : `Flux ответил ошибкой ${response.status}.`, response.status);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_BUNDLE_BYTES) throw new StudioFailure('Пакет слишком большой.');
  return bytes;
}

export interface StudioUser { id: string; name: string }
export interface StudioModule { moduleId: string; version: string; state: string; createdAt: string; requests: number }

/** Вход: логин и пароль из Flux, затем проверка права на самом сервере */
export async function signIn(origin: string, symbol: string, password: string, signal?: AbortSignal): Promise<{ token: string; user: StudioUser }> {
  if (typeof symbol !== 'string' || !symbol.trim() || symbol.length > 200 || typeof password !== 'string' || password.length > 1024) {
    throw new StudioFailure('Введите логин и пароль Flux.');
  }
  const login = await studioRequest<{ token?: string }>(origin, 'login', { body: { symbol: symbol.trim(), password }, signal });
  if (typeof login.token !== 'string' || login.token.length < 8 || login.token.length > 10_000) throw new StudioFailure('Flux не выдал сессию. Повторите вход.');
  const session = await studioRequest<{ ok?: boolean; user?: StudioUser }>(origin, 'session', { token: login.token, signal });
  if (session.ok !== true || !session.user) throw new StudioFailure('Flux не подтвердил право входа в Studio.');
  return { token: login.token, user: { id: String(session.user.id), name: String(session.user.name || '') } };
}

export async function ownModules(origin: string, token: string, signal?: AbortSignal): Promise<StudioModule[]> {
  const result = await studioRequest<{ modules?: StudioModule[] }>(origin, 'modules', { token, signal });
  return Array.isArray(result.modules) ? result.modules.slice(0, 200) : [];
}
