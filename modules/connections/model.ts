/**
 * Подключения подпрограммы к внешним программам (этап 3б): что модуль
 * объявляет в `manifest.json`, как это описывается человеку и по каким
 * правилам вызов считается разрешённым.
 *
 * Чистый модуль без Node и React: одни и те же правила читают сборка и проверка
 * выпуска (схема манифеста), окно разрешений в Store, разница запросов владельца
 * и главный процесс, который открывает подключение. Разрешением считается
 * только объявление в манифесте выпуска, подписанного владельцем: то, что
 * модуль «просит» во время работы, сверяется с этим объявлением, а не с
 * его собственными словами.
 */

export type ConnectionKind = 'com' | 'http' | 'ws';
export const CONNECTION_KINDS: readonly ConnectionKind[] = ['com', 'http', 'ws'];
export const CONNECTIONS_MAX = 8;

export const ACCESS_KINDS = ['read', 'write', 'send'] as const;
export type AccessKind = typeof ACCESS_KINDS[number];
export const ACCESS_NAMES: Record<AccessKind, string> = { read: 'читать', write: 'изменять', send: 'отправлять данные' };
interface Base {
  /** Имя внутри манифеста: по нему подпрограмма просит подключение */
  id: string;
  /** Понятное имя программы или сервера для человека: «E3.series», «Сервер расчётов» */
  app: string;
  /** Что подпрограмма будет делать, простыми словами: человек решает по этой строке */
  does: string;
  /** Что именно разрешается: читать, изменять или отправлять данные; расширение (читать → изменять) спрашивается заново */
  access: AccessKind;
}
export interface ComConnection extends Base { kind: 'com'; progId: string }
export interface NetConnection extends Base {
  kind: 'http' | 'ws';
  /** Схема, адрес и порт без пути: `http://127.0.0.1:8123` */
  url: string;
  /** Подпрограмма ходит только по путям внутри префикса */
  pathPrefix: string;
  /** Имя во внутренней сети объявлено явно: без этого имя, которое разрешилось во внутренний адрес, отвергается */
  internal?: boolean;
}
export type ConnectionDecl = ComConnection | NetConnection;

/**
 * COM-объекты, через которые можно запустить программу или выйти в сеть в обход
 * объявленных адресов: решение владельца закрывает запуск exe и сеть на
 * неразрешённые адреса без отдельного решения. Список не заменяет проверку
 * владельцем (COM-объект может многое), а убирает очевидные обходы.
 */
export const COM_DENIED = [
  /^WScript\.(Shell|Network)$/i, /^Shell\.Application$/i, /^Schedule\.Service$/i, /^WbemScripting\./i,
  /^MSXML2\./i, /^Microsoft\.XMLHTTP$/i, /^WinHttp\./i, /^InternetExplorer\./i, /^htmlfile$/i,
  /^(MS)?ScriptControl$/i, /^MSScriptControl\./i, /^Excel\.Application$/i, /^Word\.Application$/i, /^Outlook\.Application$/i,
];
export const COM_PROGID = /^[A-Za-z][A-Za-z0-9_]{0,63}(?:\.[A-Za-z0-9_]{1,64}){1,3}$/;
export const comDenied = (progId: string) => COM_DENIED.some(rule => rule.test(progId));

const CONNECTION_ID = /^[a-z][a-z0-9-]{0,31}$/;
const PREFIX = /^\/[A-Za-z0-9._~\/-]{0,199}$/;

export interface NetTarget { scheme: 'http' | 'https' | 'ws' | 'wss'; host: string; port: number; origin: string }

/** Схема, имя и порт из объявления; null — адрес не годится (путь, учётные данные, чужая схема) */
export function parseOrigin(kind: 'http' | 'ws', raw: unknown): NetTarget | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const schemes = kind === 'http' ? ['http:', 'https:'] : ['ws:', 'wss:'];
  if (!schemes.includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
  const scheme = url.protocol.slice(0, -1) as NetTarget['scheme'];
  const port = url.port ? Number(url.port) : scheme === 'http' || scheme === 'ws' ? 80 : 443;
  // IPv6 в URL приходит в квадратных скобках; для проверки адреса и подключения нужен чистый адрес
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { scheme, host, port, origin: `${url.protocol}//${url.host}` };
}

/**
 * Путь «внутри префикса» после нормализации: точки-сегменты и закодированные
 * разделители не обойдут границу. Возвращает путь с запросом для отправки или null.
 */
export function pathAllowed(prefix: string, rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 2048 || rawPath[0] !== '/' || rawPath[1] === '/' || /[\u0000- \\#]/.test(rawPath)) return null;
  if (/%2f|%5c|%00|%2e%2e/i.test(rawPath.split('?')[0])) return null;
  let url: URL;
  try { url = new URL(rawPath, 'http://x.invalid'); } catch { return null; }
  if (url.host !== 'x.invalid') return null;
  const clean = prefix.replace(/\/+$/, '');
  const inside = clean === '' || url.pathname === clean || url.pathname.startsWith(`${clean}/`);
  return inside ? `${url.pathname}${url.search}` : null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * Текст для человека, а не для специалиста: есть слова, нет адресов, имён COM-объектов и разметки.
 * Пустые и технические тексты проверка перед отправкой и при выпуске не пропускает.
 */
export function humanText(raw: string, min: number, max: number, words: number): boolean {
  const text = raw.trim();
  if (text.length < min || text.length > max || text.split(/\s+/).length < words) return false;
  if (/:\/\/|[{}<>\\]|\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*\.[A-Za-z]+\b/.test(text)) return false;
  return /[A-Za-zА-Яа-яЁё]{2}/.test(text);
}
const keysOnly = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));

/** Разбор раздела `connections`: любое лишнее или неверное поле — отказ целиком, как у остальных подписанных данных */
export function parseConnections(raw: unknown): ConnectionDecl[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > CONNECTIONS_MAX) return null;
  const out: ConnectionDecl[] = [];
  for (const item of raw) {
    if (!isObject(item) || typeof item.id !== 'string' || !CONNECTION_ID.test(item.id) || out.some(c => c.id === item.id)
      || typeof item.app !== 'string' || !humanText(item.app, 2, 60, 1) || typeof item.does !== 'string' || !humanText(item.does, 12, 240, 3)
      || !ACCESS_KINDS.includes(item.access as AccessKind)) return null;
    const base = { id: item.id, app: item.app.trim(), does: item.does.trim(), access: item.access as AccessKind };
    if (item.kind === 'com') {
      if (!keysOnly(item, ['id', 'kind', 'progId', 'app', 'does', 'access']) || typeof item.progId !== 'string' || !COM_PROGID.test(item.progId) || comDenied(item.progId)) return null;
      out.push({ ...base, kind: 'com', progId: item.progId });
    } else if (item.kind === 'http' || item.kind === 'ws') {
      if (!keysOnly(item, ['id', 'kind', 'url', 'pathPrefix', 'internal', 'app', 'does', 'access'])) return null;
      const target = parseOrigin(item.kind, item.url);
      const prefix = item.pathPrefix === undefined ? '/' : item.pathPrefix;
      if (!target || typeof prefix !== 'string' || !PREFIX.test(prefix) || prefix.includes('//') || prefix.split('/').some(s => s === '.' || s === '..')) return null;
      if (item.internal !== undefined && typeof item.internal !== 'boolean') return null;
      out.push({ ...base, kind: item.kind, url: target.origin, pathPrefix: prefix, ...(item.internal ? { internal: true } : {}) });
    } else return null;
  }
  return out;
}

/** Адрес объявлен явно как внутренний: литерал IP, localhost или флаг `internal` — тогда внутренний адрес не отвергается */
export function explicitInternal(decl: NetConnection): boolean {
  const target = parseOrigin(decl.kind, decl.url);
  if (!target) return false;
  return !!decl.internal || target.host === 'localhost' || /^[0-9.]+$/.test(target.host) || target.host.includes(':');
}

const KIND_NAMES: Record<ConnectionKind, string> = { com: 'COM', http: 'HTTP', ws: 'WebSocket' };
/** Одна строка для человека; одинакова в окне разрешений, разнице запроса и журнале */
export function describeConnection(c: ConnectionDecl): string {
  if (c.kind === 'com') return `COM-объект ${c.progId}`;
  const prefix = c.pathPrefix === '/' ? '' : c.pathPrefix;
  return `${KIND_NAMES[c.kind]} ${c.url}${prefix}${explicitInternal(c) ? ' (внутренняя сеть)' : ''}`;
}
/**
 * Для сравнения версий и «новое: подключение к …»: техническое описание плюс вид доступа. Расширение доступа
 * (читать → изменять) меняет строку, поэтому считается новым подключением и спрашивается заново.
 */
export const grantKey = (c: ConnectionDecl) => `${describeConnection(c)} — ${ACCESS_NAMES[c.access]}`;
/** Строка для человека: понятное имя программы, вид доступа и что будет делать */
export const describeForHuman = (c: ConnectionDecl) => `${c.app}: ${ACCESS_NAMES[c.access]}. ${c.does}`;

/** Объявления из манифеста; в проверенном манифесте они уже прошли схему, повторный разбор нужен главному процессу как защита */
export function connectionsOf(manifest: { connections?: unknown } | null | undefined): ConnectionDecl[] {
  return parseConnections(manifest?.connections) || [];
}

// ── Вызовы подпрограммы ─────────────────────────────────────────────────────

/** Пределы одного модуля (главный процесс следит за ними, а не окно) */
export const CONNECTION_LIMITS = {
  /** Вызовов в секунду на модуль */
  callsPerSecond: 20,
  /** Вызовов одновременно на модуль */
  inFlight: 4,
  /** Открытых подключений (сокеты WebSocket и группы COM-объектов) на модуль */
  open: 4,
  /** Живых COM-объектов на одно подключение */
  comHandles: 64,
  /** Время одного вызова, мс */
  callMs: 15_000,
  /** Ожидание сообщения WebSocket, мс */
  recvMs: 25_000,
  /** Размер тела запроса и ответа, байт: ответ вместе с обёрткой должен влезть в сообщение моста (1 МиБ) */
  bodyBytes: 512 * 1024,
  /** Сообщений в очереди одного сокета и байт в ней */
  wsQueue: 100,
  wsQueueBytes: 512 * 1024,
} as const;

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export type HttpMethod = typeof HTTP_METHODS[number];

/** Заголовки, которые Flux ставит сам или которые нарушают границу: cookie Flux и управление соединением */
const FORBIDDEN_HEADER = /^(?:cookie2?|host|content-length|connection|keep-alive|transfer-encoding|upgrade|te|trailer|expect|origin|referer|proxy-.*|sec-.*|set-cookie2?)$/i;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/** Заголовки запроса: имя из набора token, значение без переводов строки; запрещённые — отказ, а не молчаливое отбрасывание */
export function checkHeaders(raw: unknown): Record<string, string> | null {
  if (raw === undefined) return {};
  if (!isObject(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > 32) return null;
  const out: Record<string, string> = {};
  let total = 0;
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name) || FORBIDDEN_HEADER.test(name) || typeof value !== 'string' || /[\r\n\u0000]/.test(value)) return null;
    total += name.length + value.length;
    if (total > 8192) return null;
    out[name.toLowerCase()] = value;
  }
  return out;
}

/** Описание вызова в сообщении модуля: ровно эти формы, остальное отбрасывает схема моста */
export type ConnectCall =
  | { op: 'http'; method: HttpMethod; path: string; headers?: Record<string, string>; body?: string; encoding?: 'utf8' | 'base64' }
  | { op: 'ws-open'; path: string }
  | { op: 'ws-send'; socket: string; data: string; encoding?: 'utf8' | 'base64' }
  | { op: 'ws-recv'; socket: string; timeoutMs?: number }
  | { op: 'ws-close'; socket: string }
  | { op: 'com-open' }
  | { op: 'com-call'; handle: number; name: string; args?: unknown[] }
  | { op: 'com-get'; handle: number; name: string; args?: unknown[] }
  | { op: 'com-set'; handle: number; name: string; value: unknown; args?: unknown[] }
  | { op: 'com-release'; handle: number };
/** NOT_ALLOWED — человек (или политика администратора) не разрешил подключение: подпрограмма продолжает без него */
export type ConnectErrorCode = 'DENIED' | 'NOT_ALLOWED' | 'LIMIT' | 'TIMEOUT' | 'TARGET' | 'UNAVAILABLE' | 'FAILED';
export const CONNECT_ERROR_CODES: readonly ConnectErrorCode[] = ['DENIED', 'NOT_ALLOWED', 'LIMIT', 'TIMEOUT', 'TARGET', 'UNAVAILABLE', 'FAILED'];
/** Что видит человек в окне запроса: тексты из проверенного манифеста и сведения о выпуске */
export interface GrantAsk {
  moduleId: string; moduleName: string; version: string; connection: string;
  app: string; does: string; access: AccessKind; technical: string; author: string; verifiedAt: number;
  /** Сколько разрешено: адрес мелко и что подпрограмма не получает — окно строит из этого */
  kind: ConnectionKind;
}
export type ConnectReply =
  | { ok: true; data: unknown }
  | { ok: false; code: ConnectErrorCode }
  | { ok: false; code: 'ASK'; ask: GrantAsk };
export const CONNECT_OPS = ['http', 'ws-open', 'ws-send', 'ws-recv', 'ws-close', 'com-open', 'com-call', 'com-get', 'com-set', 'com-release'] as const;

/** Подключение, которое нужно виду вызова: http — к HTTP-объявлению, ws-* — к WebSocket, com-* — к COM */
export const kindOfOp = (op: ConnectCall['op']): ConnectionKind => op === 'http' ? 'http' : op.startsWith('ws-') ? 'ws' : 'com';

/** Отказ вызова с кодом, который увидит подпрограмма; текст — для журнала и отладки, в подпрограмму не уходит */
export class ConnectError extends Error {
  constructor(public code: ConnectErrorCode, message: string = code) { super(message); }
}
