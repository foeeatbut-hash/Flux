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
} as const;
export type StudioRoute = keyof typeof ROUTES;

/** Ответ сервера Studio короткий; больше мегабайта — признак чужого или сломанного ответа */
const MAX_RESPONSE_BYTES = 1024 * 1024;
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

export interface RequestOptions { token?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number }

export async function studioRequest<T = any>(origin: string, route: StudioRoute, options: RequestOptions = {}): Promise<T> {
  const target = ROUTES[route];
  if (!target) throw new StudioFailure('Маршрут недоступен оболочке Studio.');
  const base = loopbackOrigin(origin);
  const signals = [AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  let response: Response;
  try {
    response = await fetch(base + target.path, {
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
    const said = typeof json?.error === 'string' ? json.error : typeof json?.message === 'string' ? json.message : '';
    throw new StudioFailure(said.slice(0, 400) || `Flux ответил ошибкой ${response.status}.`, response.status);
  }
  if (json === null || typeof json !== 'object') throw new StudioFailure('Flux вернул непонятный ответ.', response.status);
  return json as T;
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
