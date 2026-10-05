/** Клиенты используют встроенный API; общая MariaDB/MySQL настраивается через Electron. */
import { maskSecrets } from '../lib/serverUrl';
import { failureText } from '../lib/failureText';
import { diagnosticFetch } from '../lib/diagnostics';

// Миграция: старый адрес не должен получить пароль или сессию после обновления.
try { localStorage.removeItem('flux_server_url'); } catch (_) {}
export let serverUrlWarning = '';
export function getConfiguredServerUrl(): string { return ''; }
export function getServerBaseUrl(): string {
  return typeof window !== 'undefined' && window.location.protocol === 'file:' ? 'http://localhost:3000' : '';
}
export async function setConfiguredServerUrl(url: string): Promise<void> {
  if (url.trim()) throw new Error('Flux подключается к общей MariaDB/MySQL через настройки базы.');
  try { localStorage.removeItem('flux_server_url'); } catch (_) {}
}

// Browser sessions live in HttpOnly cookies; Electron keeps the encrypted token
// in the main process. A cross-origin browser connection uses memory only.
try { localStorage.removeItem('flux_auth_token'); } catch (_) {}
let authToken = '';
let sessionEstablished = false;
const LOGGED_OUT_KEY = 'flux_local_logged_out';
function locallyLoggedOut(): boolean {
  try { return localStorage.getItem(LOGGED_OUT_KEY) === '1'; } catch { return false; }
}
export function getAuthToken(): string { return authToken; }
export async function setAuthToken(token: string): Promise<void> {
  const nextToken = token || '';
  try { localStorage.removeItem('flux_auth_token'); } catch (_) {}
  const bridge = typeof window !== 'undefined' ? (window as any).electron?.ipcRenderer : null;
  if (bridge?.invoke) await bridge.invoke('auth:write-session', nextToken, new URL(SERVER_BASE_URL || window.location.origin).origin);
  authToken = nextToken;
  sessionEstablished = !!nextToken;
}
export async function initializeAuthToken(): Promise<void> {
  // Old unencrypted sessions are deliberately not trusted or migrated.
  try { localStorage.removeItem('flux_auth_token'); } catch (_) {}
  if (locallyLoggedOut()) { authToken = ''; return; }
  const bridge = typeof window !== 'undefined' ? (window as any).electron?.ipcRenderer : null;
  if (bridge?.invoke) authToken = await bridge.invoke('auth:read-session', new URL(SERVER_BASE_URL || window.location.origin).origin) || '';
}
export function markSessionEstablished(): void {
  sessionEstablished = true;
  try { localStorage.removeItem(LOGGED_OUT_KEY); } catch (_) {}
  try { window.dispatchEvent(new Event('flux:session-changed')); } catch (_) {}
}
export function getAuthSessionKey(): string { return locallyLoggedOut() ? '' : authToken || (usesCookieTransport() ? csrfCookie() : ''); }
export function usesCookieTransport(): boolean {
  return typeof window !== 'undefined' && window.location.protocol !== 'file:' && (!SERVER_BASE_URL || new URL(SERVER_BASE_URL).origin === window.location.origin);
}
export async function logoutSession(): Promise<{ remoteRevoked: boolean }> {
  let remoteRevoked = false;
  try {
    const response = await fetch('/api/logout', { method: 'POST', signal: AbortSignal.timeout(8000) });
    remoteRevoked = response.ok || response.status === 401;
  } catch { /* Local logout must remain available when the database/network is down. */ }
  // Prevent an old HttpOnly cookie or failed IPC deletion from restoring the profile.
  try { localStorage.setItem(LOGGED_OUT_KEY, '1'); } catch (_) {}
  authToken = '';
  sessionEstablished = false;
  await setAuthToken('');
  return { remoteRevoked };
}
function csrfCookie(): string {
  try {
    const part = document.cookie.split(';').find(value => value.trim().startsWith('flux_csrf='));
    return part ? decodeURIComponent(part.trim().slice('flux_csrf='.length)) : '';
  } catch (_) { return ''; }
}

// Адрес зафиксирован на момент загрузки: смена сервера = перезагрузка окна,
// чтобы не жить в состоянии «половина запросов туда, половина сюда»
export const SERVER_BASE_URL = getServerBaseUrl();

export const ENV_CONFIG = {
  // '' + '/api' = относительный '/api' — работает в браузере, открытом с сервера
  apiUrl: `${SERVER_BASE_URL}/api`,
  // socket.io сам поднимает websocket поверх http(s)-адреса
  socketUrl: SERVER_BASE_URL ||
    (typeof window !== 'undefined' && window.location.protocol !== 'file:'
      ? window.location.origin
      : 'http://localhost:3000'),
};

// Глобальная обёртка fetch: (1) переписывает корневые пути (/api/…, /chat_files/…)
// на адрес сервера, когда страница открыта не с него (Electron file:// или задан
// сервер компании); (2) подробно логирует запросы/ответы в журнал — чтобы в
// crash-логе было видно «что нажали → какой запрос → что ответил сервер».
if (typeof window !== 'undefined') {
  const needsRewrite = window.location.protocol === 'file:';
  const baseUrl = SERVER_BASE_URL || 'http://localhost:3000';
  // Диагностика встаёт ВНУТРЬ этой обёртки, а не поверх неё: так она видит уже
  // переписанный адрес и уже подставленный токен — то есть то, что
  // действительно ушло на сервер, а не то, что просил вызывающий код
  const originalFetch = diagnosticFetch(window.fetch.bind(window));

  /**
   * Запись в журнал. Пароли замазываются ВСЕГДА и на входе, а не там, где о них
   * вспомнили: строка подключения к базе однажды уже уехала в журнал открытым
   * текстом — вместе с паролем от общей базы отдела.
   */
  const logApi = (level: 'INFO' | 'ERROR', ctx: string, msg: string) => {
    try {
      // ленивый импорт, чтобы не создавать циклов на этапе модуля
      const store = (window as any).__pdmLogStore;
      if (store) store.getState().addLog(level, ctx, maskSecrets(msg));
    } catch (_) {}
  };

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let urlForLog = '';
    try {
      if (typeof input === 'string') {
        urlForLog = input;
        if (needsRewrite && input.startsWith('/')) input = baseUrl + input;
      } else if (input instanceof URL) {
        urlForLog = input.pathname + input.search;
        if (needsRewrite && input.protocol === 'file:') input = baseUrl + input.pathname + input.search;
      } else if (typeof Request !== 'undefined' && input instanceof Request) {
        urlForLog = input.url;
        if (needsRewrite && input.url.startsWith('file://')) {
          const u = new URL(input.url);
          input = new Request(baseUrl + u.pathname + u.search, input);
        }
      }
    } catch (e) {}

    const method = (init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    // Only the configured API origin may receive session credentials. A URL
    // containing /api/ on an unrelated service must never receive our bearer.
    let isApi = false;
    try {
      const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href);
      const apiOrigin = new URL(SERVER_BASE_URL || window.location.origin).origin;
      isApi = target.origin === apiOrigin && target.pathname.startsWith('/api/');
    } catch (_) {}
    const shortUrl = urlForLog.replace(/^https?:\/\/[^/]+/, '').replace(/^.*\/api\//, '/api/');
    let sentToken = false;
    if (isApi) {
      const token = getAuthToken();
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      const own = headers.get('Authorization') || '';
      if (token && (!own || /^Bearer\s*$/i.test(own))) headers.set('Authorization', `Bearer ${token}`);
      sentToken = !!headers.get('Authorization') || sessionEstablished;
      const electron = !!(window as any).electron?.ipcRenderer;
      const sameOrigin = !SERVER_BASE_URL || new URL(SERVER_BASE_URL).origin === window.location.origin;
      if (shortUrl === '/api/login' || shortUrl === '/api/owner/login') {
        headers.set('X-Flux-Auth-Transport', electron ? 'electron' : sameOrigin ? 'cookie' : 'memory');
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const csrf = csrfCookie();
        if (csrf && sameOrigin) headers.set('X-Flux-CSRF', csrf);
      }
      init = { ...(init || {}), headers, credentials: sameOrigin ? 'include' : 'omit' };
    }
    // Фоновые поллинги (уведомления, чат) идут каждые несколько секунд —
    // их успешные запросы не пишем, чтобы не забивать журнал шумом (ошибки пишем)
    const isBackgroundPoll = method === 'GET' && /\/api\/(notifications|chat\/(messages|group-messages|groups))/.test(shortUrl);
    if (isApi && !isBackgroundPoll) logApi('INFO', 'Запрос', `${method} ${shortUrl}`);

    try {
      const res = await originalFetch(input as any, init);
      if (isApi && (!isBackgroundPoll || !res.ok)) {
        logApi(res.ok ? 'INFO' : 'ERROR', 'Ответ', `${res.status} ${method} ${shortUrl}`);
        /**
         * У отказа читаем объяснение сервера.
         *
         * Раньше в журнале оставалось голое «500 GET /api/calendar/events», и
         * причина терялась насовсем: сервер её называл, но никто не слушал.
         * Именно поэтому поломка календаря на общей базе неделю выглядела как
         * «программа выкидывает из календаря» без единой зацепки.
         *
         * Тело читаем с копии ответа, чтобы не отобрать его у вызывающего кода.
         * Длинный дамп сохраняется с двух концов: причина у драйверов базы
         * стоит в конце, и обрезка по началу выбрасывала именно её
         * (правила — lib/failureText).
         */
        if (!res.ok) {
          res.clone().text()
            .then((body) => {
              const said = failureText(body);
              if (said) logApi('ERROR', 'Ответ', `${res.status} ${shortUrl} — ${said}`);
            })
            .catch(() => { /* тело уже прочитано или его нет */ });
        }
      }
      /**
       * Сессия недействительна → на экран входа. Но только если запрос
       * ДЕЙСТВИТЕЛЬНО нёс токен.
       *
       * Отказ на запрос без токена означает ошибку в коде, а не конец сессии,
       * и выбрасывать за неё человека из программы — худшее из возможных
       * решений: он теряет несохранённое и не понимает, за что.
       *
       * /api/login не считается: там 401 = просто неверный пароль.
       */
      if (res.status === 401 && isApi && sentToken && !shortUrl.startsWith('/api/login') && !shortUrl.startsWith('/api/owner/login')) {
        try { window.dispatchEvent(new CustomEvent('flux:auth-expired')); } catch (_) {}
      } else if (res.status === 401 && isApi && !sentToken && shortUrl !== '/api/auth/me') {
        logApi('ERROR', 'Ответ', `401 ${shortUrl} — запрос ушёл без токена (ошибка в коде, сессия цела)`);
      }
      return res;
    } catch (err: any) {
      if (isApi) logApi('ERROR', 'Сбой запроса', `${method} ${shortUrl}: ${err?.message || err}`);
      throw err;
    }
  }) as typeof window.fetch;
}
