/**
 * Конфигурация подключения клиента к серверу.
 *
 * Одна настройка — адрес сервера (localStorage `flux_server_url`):
 *  - пусто  → «встроенный» режим: в Electron это локальный Express на
 *    localhost:3000, в браузере — тот же origin, откуда открыта страница
 *    (сервер раздаёт фронтенд статикой). Так работает сегодняшний офлайн-тест.
 *  - задан  → «сервер компании»: ВСЕ запросы (fetch и socket.io) идут на него,
 *    встроенный сервер в Electron не запускается (см. electron/main.ts).
 *
 * Дублируется в config.json (remote_server_url) через IPC — чтобы главный
 * процесс Electron знал о выборе ещё до загрузки рендерера.
 */

import { checkServerUrl, useSaved, maskSecrets } from '../lib/serverUrl';
import { failureText } from '../lib/failureText';
import { diagnosticFetch } from '../lib/diagnostics';

const SERVER_URL_KEY = 'flux_server_url';

/**
 * Негодный сохранённый адрес — почему об этом надо сказать вслух.
 *
 * Однажды в это поле вписали строку подключения к базе. После этого КАЖДЫЙ
 * запрос строился от неё, браузер такие запросы не выполняет вовсе, и
 * программа перестала отвечать — вместе с экраном входа, с которого это можно
 * было бы исправить. Теперь негодный адрес просто не применяется: программа
 * работает на встроенном сервере и объясняет, почему (правила — lib/serverUrl).
 */
export let serverUrlWarning = '';

// Нормализованный адрес сервера компании ('' = встроенный режим)
export function getConfiguredServerUrl(): string {
  try {
    const saved = (localStorage.getItem(SERVER_URL_KEY) || '').trim();
    const { url, warn } = useSaved(saved);
    serverUrlWarning = warn;
    return url;
  } catch (_) {
    return '';
  }
}

// База для HTTP-запросов: '' означает «относительные пути от текущего origin»
export function getServerBaseUrl(): string {
  const configured = getConfiguredServerUrl();
  if (configured) return configured;
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
    return 'http://localhost:3000'; // Electron: встроенный сервер
  }
  return '';
}

// Сохраняет выбор сервера (пустая строка = встроенный) и синхронизирует
// config.json главного процесса Electron. Применяется после перезагрузки окна.
export async function setConfiguredServerUrl(url: string): Promise<void> {
  // Сохраняем только то, чем программа умеет пользоваться: пустое значение
  // (встроенный сервер) или разобранный http(s)-адрес
  const parsed = checkServerUrl(url);
  if (parsed.error) throw new Error(parsed.error);
  const clean = parsed.url;
  try {
    if (clean) localStorage.setItem(SERVER_URL_KEY, clean);
    else localStorage.removeItem(SERVER_URL_KEY);
  } catch (_) {}
  try {
    const win = window as any;
    if (win.electron?.ipcRenderer?.invoke) {
      await win.electron.ipcRenderer.invoke('app:set-server-url', clean);
    }
  } catch (_) {}
}

// ── Токен сессии ──
// Выдаётся сервером при входе; уходит в Authorization на каждом запросе к API
// (добавляет fetch-обёртка ниже) и в handshake socket.io. Ответ 401 означает
// «сессия недействительна» — приложение возвращает на экран входа.
const AUTH_TOKEN_KEY = 'flux_auth_token';

export function getAuthToken(): string {
  try { return localStorage.getItem(AUTH_TOKEN_KEY) || ''; } catch (_) { return ''; }
}
export function setAuthToken(token: string): void {
  try {
    if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch (_) {}
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
  const needsRewrite = window.location.protocol === 'file:' || !!getConfiguredServerUrl();
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
    const isApi = /\/api\//.test(urlForLog);
    const shortUrl = urlForLog.replace(/^https?:\/\/[^/]+/, '').replace(/^.*\/api\//, '/api/');

    // Токен сессии — на каждый запрос к API (кроме случая, когда вызывающий
    // код уже выставил Authorization сам)
    let sentToken = false;
    if (isApi) {
      const token = getAuthToken();
      try {
        const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
        const own = headers.get('Authorization') || '';
        /**
         * Свой пустой заголовок — не воля вызывающего, а ошибка.
         *
         * Один экран подставлял токен руками и брал его из неверного ключа
         * хранилища: заголовок уходил пустым, а обёртка его не трогала —
         * «раз задан, значит так и хотели». Сервер отвечал «требуется вход», и
         * человека выбрасывало на экран входа при открытии события календаря.
         * Пустой Authorization теперь заменяется настоящим.
         */
        if (token && (!own || /^Bearer\s*$/i.test(own))) headers.set('Authorization', `Bearer ${token}`);
        sentToken = !!(headers.get('Authorization') || '').replace(/^Bearer\s*/i, '');
        if (token) init = { ...(init || {}), headers };
      } catch (_) { sentToken = !!token; }
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
      if (res.status === 401 && isApi && sentToken && !shortUrl.startsWith('/api/login')) {
        try { window.dispatchEvent(new CustomEvent('flux:auth-expired')); } catch (_) {}
      } else if (res.status === 401 && isApi && !sentToken) {
        logApi('ERROR', 'Ответ', `401 ${shortUrl} — запрос ушёл без токена (ошибка в коде, сессия цела)`);
      }
      return res;
    } catch (err: any) {
      if (isApi) logApi('ERROR', 'Сбой запроса', `${method} ${shortUrl}: ${err?.message || err}`);
      throw err;
    }
  }) as typeof window.fetch;
}
