/**
 * Защитные правила сервера, которым не место внутри обработчиков.
 *
 * Собраны в одном модуле, а не разнесены по server.ts, по двум причинам.
 * Первая: server.ts упирается в храповик размера, и каждое новое правило в нём
 * вытесняло бы что-то другое. Вторая важнее: у этих правил правильный ответ
 * проверяется без поднятого сервера (scripts/test-security.ts), а внутри
 * промежуточного слоя server.ts их можно проверить только живым запросом.
 */
import crypto from 'crypto';
import path from 'node:path';
import { authTokenFromRequest } from './authCookies.js';
import type { Request, Response, NextFunction } from 'express';

// ── Откуда можно звать API из браузера (CORS) ───────────────────────────────
//
// Раньше отвечали «*» — любой сайт, открытый у сотрудника, мог обращаться к
// серверу из его браузера. Токен в заголовке сам по себе чужому сайту не
// достаётся, но открытые маршруты (вход, лицензия) становились доступны любой
// странице в интернете. Теперь разрешены только свои:
//  - без Origin — не браузер (curl, сам сервер, главный процесс Electron);
//  - «null» — страница программы, открытая из файла (Electron, file://). Убирать
//    нельзя: упакованный клиент грузит file://dist/index.html и ходит на сервер
//    компании, Origin у него именно «null». Вреда немного: ответ идёт без
//    Allow-Credentials, cookie чужой страницы не уходит, а вход по cookie при
//    чужом Origin отвечает 403 (authCookies.ts);
//  - тот же хост, что у сервера — окно, открытое с самого сервера;
//  - localhost — встроенный сервер и разработка.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function corsOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  if (origin === 'null') return true;
  let o: URL;
  try { o = new URL(origin); } catch (_) { return false; }
  if (!['http:', 'https:', 'file:'].includes(o.protocol)) return false;
  if (o.protocol === 'file:') return true;
  if (LOCAL_HOSTS.has(o.hostname)) return true;
  return !!host && o.host.toLowerCase() === String(host).toLowerCase();
}

const ALLOW_HEADERS = 'Content-Type, Authorization, Idempotency-Key, X-Requested-With, X-Flux-Trace, X-Flux-Interaction, X-Chunk-SHA256, X-Base-SHA256, X-Autosave, X-Office-Session, X-Flux-CSRF, X-Flux-Auth-Transport';

export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const origin = req.get('origin');
  if (corsOriginAllowed(origin, req.get('host'))) {
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    // X-Flux-Trace и X-Flux-Interaction связывают запрос окна с работой сервера,
    // X-Chunk-SHA256 несёт контрольную сумму куска файла. Без разрешения браузер
    // не пропустит их предварительным запросом, и сломается это только там, где
    // окно и сервер на разных машинах, — то есть у заказчика, а не на своей
    res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', 'X-Flux-Trace, X-Flux-Error, X-Collab-Required, X-Current-SHA256, X-Base-SHA256, X-File-Name');
  }
  // Чужому происхождению заголовков не даём — браузер сам не пустит ответ
  if (req.method === 'OPTIONS') return res.sendStatus(corsOriginAllowed(origin, req.get('host')) ? 200 : 403);
  next();
}

/**
 * Socket.io спрашивает то же правило. Его настройка cors не знает хоста
 * запроса, поэтому решение принимает allowRequest — там запрос виден целиком.
 */
export const socketAllowRequest = (req: { headers: Record<string, any> }, cb: (err: string | null | undefined, ok: boolean) => void) =>
  cb(null, corsOriginAllowed(req.headers.origin, req.headers.host));

// ── Что из папки сборки не раздаётся ────────────────────────────────────────
//
// Сервер раздаёт папку dist как статику, а сборка кладёт туда и сам сервер
// (server.cjs) с картой исходников. Выходило, что полный текст сервера с
// комментариями лежал по адресу, открытому без входа, любому в сети.
export function isPrivateBuildFile(pathname: string): boolean {
  // Битая запись вида %E0%A4%A меняет смысл пути только для того, кто её
  // декодирует; сравниваем тогда как есть, а ответ 400 даёт blockPrivateBuildFiles
  let p: string;
  try { p = decodeURIComponent(String(pathname || '')).toLowerCase(); } catch (_) { p = String(pathname || '').toLowerCase(); }
  // Скрытые файлы express.static не раздаёт и сам (dotfiles: ignore), а
  // запрет «всего, что с точкой» ломал разработку: Vite отдаёт зависимости из
  // /node_modules/.vite/
  return /(^|\/)server\.c?js(\.map)?$/.test(p) || /\.map$/.test(p);
}

export function blockPrivateBuildFiles(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api/')) {
    try { decodeURIComponent(req.path); } catch (_) { return res.status(400).end(); }
    if (isPrivateBuildFile(req.path)) return res.status(404).end();
  }
  next();
}

// ── Файлы, которые люди присылают друг другу ────────────────────────────────
//
// SVG и HTML — не картинка и не текст, а документ со скриптами. Открытые с
// адреса сервера, они выполнялись бы с его правами: тот же адрес, тот же
// localStorage с токеном. Такие файлы отдаются в песочнице и не угадываются
// браузером как «что-то исполняемое».
const ACTIVE_TYPES = /^(image\/svg\+xml|text\/html|application\/xhtml\+xml|text\/xml|application\/xml)/i;

export function hardenFileResponse(res: Response, contentType?: string) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const type = contentType || String(res.getHeader('Content-Type') || '');
  if (ACTIVE_TYPES.test(type)) {
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  }
}

/**
 * Песочница — только для активных типов: PDF в песочнице Chromium не
 * показывает вовсе, а картинке и тексту она не нужна.
 */
export const staticUploadOptions = {
  setHeaders: (res: Response, filePath: string) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (/\.(svgz?|html?|xhtml|xml)$/i.test(filePath)) {
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    }
  },
};

// ── Подписанные ссылки на файлы ─────────────────────────────────────────────
//
// Вложение чата открывается во внешнем браузере — туда токен входа не
// передать. Раньше адрес вложения был открыт всем, кто его знал, навсегда.
// Теперь сервер выдаёт ссылку на несколько минут, и только участнику
// переписки. Подпись — HMAC тем же секретом сервера, что и у токена сессии.
let linkSecret = '';
export function setLinkSecret(secret: string) { linkSecret = String(secret || ''); }

const LINK_TTL_MS = 10 * 60 * 1000;

const linkMac = (pathname: string, exp: number) =>
  crypto.createHmac('sha256', linkSecret).update(`link|${pathname}|${exp}`).digest('base64url');

export function signLink(pathname: string, now = Date.now()): string {
  if (!linkSecret) throw new Error('секрет подписи ссылок не задан');
  // Подпись берётся по пути без query, а проверка видит именно путь: подписанный
  // адрес с «?» никогда бы не прошёл проверку
  if (pathname.includes('?') || pathname.includes('#')) throw new Error('путь для подписи ссылки не должен содержать query');
  const exp = now + LINK_TTL_MS;
  return `${pathname}?s=${exp}.${linkMac(pathname, exp)}`;
}

export function linkValid(pathname: string, s: unknown, now = Date.now()): boolean {
  if (!linkSecret) return false;
  const [expRaw, mac] = String(s || '').split('.');
  const exp = Number(expRaw);
  if (!mac || !Number.isFinite(exp) || exp < now || exp > now + LINK_TTL_MS + 60000) return false;
  const want = Buffer.from(linkMac(pathname, exp));
  const got = Buffer.from(mac);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/**
 * Вход к вложениям чата — только по подписанной ссылке.
 *
 * Токен входа сюда не годится: он говорит, КТО пришёл, но не что этот человек
 * участвует в переписке, — и с ним любой вошедший забирал чужое вложение по
 * номеру. Ссылку выдаёт /api/chat/file-link после проверки участия, и путь в
 * ней подписан целиком, с /chat_files.
 */
export function chatFileGate() {
  return (req: Request, res: Response, next: NextFunction) => {
    const pathname = (req.baseUrl || '') + req.path;
    if (linkValid(pathname, req.query.s)) return next();
    res.status(401).json({ error: 'Ссылка на файл устарела. Откройте вложение из чата заново.' });
  };
}

// ── Ограничение попыток входа ───────────────────────────────────────────────
//
// Без него пароль из четырёх цифр подбирался за минуты: десять тысяч запросов
// сервер отвечал без задержки. Счёт ведётся тремя ключами:
//  - ПАРА «адрес + логин» — основной: пять промахов с одной машины по одному
//    логину ставят паузу ЭТОЙ машине на ЭТОТ логин. Раньше счёт шёл по логину
//    вообще и по адресу вообще: один человек за прокси (где у всех клиентов
//    один адрес) или один злоумышленник, раз в минуту набирающий чужой логин,
//    запирал вход всем;
//  - логин вообще — высокий порог: перебор пароля одного человека с разных
//    машин не должен проходить безнаказанно, но и запереть его одним
//    промахом на каждое истечение паузы нельзя;
//  - адрес вообще — высокий порог: перебор многих логинов подряд с одной
//    машины («один пароль на всех»).
// Память процесса, а не база: при перезапуске счёт сбрасывается, но
// перезапуск сервера по желанию подбирающего не случается; встроенные серверы
// слушают только свою машину (listenHost), перебирать через них нечего.
interface Slot { fails: number; until: number; last: number }
const byPair = new Map<string, Slot>();
const byLogin = new Map<string, Slot>();
const byAddr = new Map<string, Slot>();

const PAIR_FREE = 5;        // попыток без задержки на пару «адрес + логин»
const LOGIN_FREE = 30;      // то же на логин с любых адресов вместе
const ADDR_FREE = 100;      // то же на адрес по любым логинам вместе
const BASE_LOCK_MS = 60 * 1000;
const MAX_LOCK_MS = 30 * 60 * 1000;
const FORGET_MS = 60 * 60 * 1000;

function lockFor(fails: number, free: number): number {
  if (fails < free) return 0;
  return Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** Math.min(fails - free, 20));
}

const loginKey = (symbol: string) => String(symbol || '').trim().toLowerCase();
/** IPv4-адрес в записи ::ffff:1.2.3.4 — тот же адрес: ключ не должен зависеть от формы записи */
const addrKey = (addr: string) => String(addr || '').replace(/^::ffff:/i, '');
const pairKey = (symbol: string, addr: string) => `${addrKey(addr)}|${loginKey(symbol)}`;

/** Сколько ещё ждать до следующей попытки, мс; 0 — можно пробовать */
export function loginWait(symbol: string, addr: string, now = Date.now()): number {
  const slots = [byPair.get(pairKey(symbol, addr)), byLogin.get(loginKey(symbol)), byAddr.get(addrKey(addr))];
  return Math.max(0, ...slots.map(slot => (slot?.until || 0) - now));
}

function bump(map: Map<string, Slot>, key: string, free: number, now: number) {
  const was = map.get(key);
  const fails = was && now - was.last < FORGET_MS ? was.fails + 1 : 1;
  map.set(key, { fails, last: now, until: now + lockFor(fails, free) });
  if (map.size > 5000) {
    for (const [k, v] of map) if (now - v.last > FORGET_MS) map.delete(k);
  }
}

export function loginFailed(symbol: string, addr: string, now = Date.now()) {
  bump(byPair, pairKey(symbol, addr), PAIR_FREE, now);
  bump(byLogin, loginKey(symbol), LOGIN_FREE, now);
  bump(byAddr, addrKey(addr), ADDR_FREE, now);
}

export function loginSucceeded(symbol: string, addr = '') {
  byPair.delete(pairKey(symbol, addr));
  byLogin.delete(loginKey(symbol));
}

/** Только для проверок: начать счёт заново */
export function resetLoginLimits() { byPair.clear(); byLogin.clear(); byAddr.clear(); }

/** Одно сообщение на «нет логина» и «не тот пароль»: иначе ответ выдаёт, какие логины есть */
export const LOGIN_REFUSED = 'Неверный логин или пароль.';

export function waitText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `Слишком много неудачных попыток входа. Повторите через ${s} с.`;
  return `Слишком много неудачных попыток входа. Повторите через ${Math.ceil(s / 60)} мин.`;
}

// ── Большие тела запросов — только после входа ──────────────────────────────
//
// Разбор JSON до 50 МБ стоял перед проверкой входа: кто угодно в сети мог
// заставлять сервер читать и разбирать мегабайты без логина. Этот слой стоит
// до разбора тела: запросу к API без действительного токена большое тело не
// положено, а открытым маршрутам (вход, лицензия) хватает мегабайта.
//
// Заголовку Content-Length верить нельзя: его можно не посылать вовсе
// (Transfer-Encoding: chunked) или занизить. Поэтому у запроса без права на
// большое тело байты считаются по факту чтения, и на мегабайте соединение
// обрывается ответом 413.
const OPEN_BODY_MAX = 1024 * 1024;

export function earlyBodyGate(isExempt: (route: string) => boolean, tokenValid: (token: string) => boolean, openMax = OPEN_BODY_MAX) {
  return (req: Request, res: Response, next: NextFunction) => {
    const route = req.path.toLowerCase().replace(/\/+$/, '');
    if (!route.startsWith('/api/')) return next();
    if (!isExempt(route) && tokenValid(authTokenFromRequest(req))) return next();
    if (Number(req.get('content-length') || 0) > openMax) return res.status(413).json({ error: 'Слишком большой запрос' });
    // Слушатель вешается в том же такте, что и разбор тела следующим слоем, и
    // потока не расходует: чтение начинается только когда есть потребитель.
    let read = 0;
    req.on('data', (chunk: Buffer) => {
      read += chunk.length;
      if (read <= openMax || res.headersSent) return;
      res.status(413).set('Connection', 'close').json({ error: 'Слишком большой запрос' });
      // Соединение рвём после ответа, иначе 413 не дойдёт до клиента
      res.once('finish', () => req.destroy());
    });
    next();
  };
}

// ── Пароли открытым текстом ─────────────────────────────────────────────────
//
// Прежние версии хранили пароль как есть и принимали такую запись при входе.
// Это значило, что вписать в базу «пароль» мог любой, кто до базы дотянулся, —
// и сразу войти с ним. Теперь вход принимает только хеш, а оставшиеся открытые
// записи переводятся в хеш один раз при старте сервера.
//
// «Один раз» — буквально: отметка лежит в базе, и после неё открытая запись
// больше не превращается в рабочий пароль даже при следующем старте.
const LEGACY_DONE_KEY = 'security.legacy_passwords_hashed';

export async function hashLegacyPasswords(prisma: any, hashPassword: (p: string) => string | Promise<string>, isLegacy: (s: string) => boolean): Promise<number> {
  const done = await prisma.appSetting.findFirst({ where: { key: LEGACY_DONE_KEY, userId: null } });
  if (done) return 0;
  const users = await prisma.user.findMany({ select: { id: true, password: true } });
  let n = 0;
  for (const u of users) {
    if (u.password && isLegacy(u.password)) {
      await prisma.user.update({ where: { id: u.id }, data: { password: await hashPassword(u.password) } });
      n++;
    }
  }
  // Два сервера на одной базе могут дойти сюда вместе: userId=NULL уникальным
  // индексом не защищён, а второй флаг безвреден — ошибку не поднимаем
  try { await prisma.appSetting.create({ data: { key: LEGACY_DONE_KEY, userId: null, value: JSON.stringify({ at: new Date().toISOString(), hashed: n }) } }); }
  catch (_) { /* отметка уже поставлена соседним сервером */ }
  return n;
}

// ── Пароль базы в ответах ───────────────────────────────────────────────────
//
// Настройки подключения отдавали адрес базы целиком, с паролем, — а к этому
// маршруту до входа можно было обратиться с самой машины сервера. Пароль
// базы — это ключ от всех данных мимо программы, поэтому наружу он уходит
// заменённым звёздочками. Окно настроек возвращает звёздочки обратно, и
// сервер подставляет сохранённый пароль, только если остальное в адресе не
// менялось: иначе звёздочки стали бы способом отправить сохранённый пароль
// на чужой адрес.
export const DB_PASSWORD_MASK = '••••••';

export function maskDbUrl(url: string): string {
  const raw = String(url || '');
  try {
    const u = new URL(raw);
    if (!u.password) return raw;
    u.password = encodeURIComponent(DB_PASSWORD_MASK);
    return u.toString();
  } catch (_) {
    return raw.replace(/(\/\/[^:/@]*:)[^@]*@/, `$1${DB_PASSWORD_MASK}@`);
  }
}

export function unmaskDbUrl(incoming: string, stored: string): string {
  const raw = String(incoming || '');
  try {
    const u = new URL(raw);
    if (decodeURIComponent(u.password) !== DB_PASSWORD_MASK) return raw;
    const s = new URL(String(stored || ''));
    // search и hash входят в сравнение: ?host=… меняет получателя соединения
    const same = u.protocol === s.protocol && u.hostname === s.hostname && u.port === s.port
      && u.username === s.username && u.pathname === s.pathname && u.search === s.search && u.hash === s.hash;
    if (!same) return raw.replace(u.password, '');
    u.password = s.password;
    return u.toString();
  } catch (_) {
    return raw;
  }
}

// ── На каком адресе слушать ─────────────────────────────────────────────────
//
// Встроенный сервер программы слушал всю сеть (0.0.0.0): на каждом компьютере
// отдела по порту 3000 был открыт полноценный сервер с базой этого человека,
// доступный с любой машины офиса. Окну он нужен только на этом же компьютере
// — сотрудники между собой связаны через общую базу, а не через серверы друг
// друга. Поэтому встроенный слушает только себя.
//
// Сервер компании (`node dist/server.cjs` на офисной машине) запускается без
// оболочки и по-прежнему слушает сеть — к нему ходят все. Явная настройка
// FLUX_LISTEN_HOST сильнее обоих правил.
export function listenHost(env: Record<string, string | undefined> = process.env): string {
  const explicit = String(env.FLUX_LISTEN_HOST || '').trim();
  if (explicit) return explicit;
  return env.FLUX_EMBEDDED === '1' ? '127.0.0.1' : '0.0.0.0';
}

// ── Сокеты: тот же пропуск, что и у HTTP ────────────────────────────────────
//
// Рукопожатие сокета проверяло только подпись токена. Отключённый или
// просроченный профиль продолжал получать чат, присутствие и правки документов
// до конца срока токена (восемь часов), — хотя любой HTTP-запрос ему уже отказывал.
export function accountRefusal(user: any, now = Date.now()): string {
  if (!user) return 'профиль удалён';
  if (user.isActive === false) return 'профиль отключён';
  if (user.role !== 'OWNER' && user.validUntil && new Date(user.validUntil).getTime() < now) return 'срок профиля истёк';
  return '';
}

/** Профиль изменили — если он больше не годен, его сокеты закрываются сразу */
export async function dropRevokedSockets(io: any, userId: string, getUser: (id: string) => Promise<any>) {
  try {
    if (accountRefusal(await getUser(userId))) io.in(`user:${userId}`).disconnectSockets(true);
  } catch (_) { /* база недоступна — проверит следующее рукопожатие */ }
}

// ── Раздача собранного окна ─────────────────────────────────────────────────

/**
 * Папка сборки — та, где лежит сам сервер (dist/server.cjs). Опора на рабочий
 * каталог ломалась у службы Windows, чей cwd — System32: окно отвечало 404.
 */
export function distDirectory(serverDir: string): string {
  return serverDir.includes('app.asar') || path.basename(serverDir) === 'dist' ? serverDir : path.join(serverDir, 'dist');
}

/**
 * Окну отдаётся только страница. Пропавший файл (/assets/old.js, /favicon.ico)
 * должен быть 404, а не index.html со статусом 200 под видом скрипта.
 */
export function spaFallbackAllowed(requestPath: string, accept: string | undefined): boolean {
  return !path.extname(requestPath || '') && String(accept || '').includes('text/html');
}
