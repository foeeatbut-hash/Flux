import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/**
 * Работа с почтовым сервером по IMAP.
 *
 * Соединение держится открытым и переиспользуется: вход по TLS с проверкой
 * пароля занимает секунду-полторы, и открывать его на каждый щелчок по письму
 * означало бы раздел, который «думает» после каждого действия.
 *
 * Всё, что связано с сетью, живёт здесь. Маршруты работают с базой и зовут эти
 * функции — так почтовый протокол не растекается по разделу.
 */

export interface MailCreds {
  id: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  login: string;
  password: string;
}

/** Насколько подробно письмо разобрано. */
export interface ParsedBody {
  text: string;
  html: string;
  attachments: Array<{
    partId: string;
    fileName: string;
    size: number;
    mimeType: string;
    contentId: string;
    inline: boolean;
    /** Содержимое — только когда письмо разбиралось целиком */
    content?: Buffer;
  }>;
}

/**
 * Письма тяжелее этого разбираются по частям: тянем текст, а вложения
 * оставляем на сервере до того момента, когда их действительно попросят.
 * Иначе открытие письма с чертежом на 40 МБ вешает раздел на минуту.
 */
const FULL_PARSE_LIMIT = 2 * 1024 * 1024;

// ── Пул соединений ───────────────────────────────────────────────────────────

interface Pooled { client: ImapFlow; idleTimer: NodeJS.Timeout | null; busy: boolean }
const pool = new Map<string, Pooled>();

/** Через сколько простоя закрываем соединение, чтобы не держать его вечно. */
const IDLE_CLOSE_MS = 5 * 60 * 1000;

function scheduleClose(key: string) {
  const p = pool.get(key);
  if (!p) return;
  if (p.idleTimer) clearTimeout(p.idleTimer);
  p.idleTimer = setTimeout(() => { void closeConnection(key); }, IDLE_CLOSE_MS);
}

export async function closeConnection(key: string): Promise<void> {
  const p = pool.get(key);
  if (!p) return;
  pool.delete(key);
  if (p.idleTimer) clearTimeout(p.idleTimer);
  try { await p.client.logout(); } catch (_) { try { p.client.close(); } catch (_) { /* уже мёртв */ } }
}

/** Закрыть все соединения — при остановке сервера и при смене базы. */
export async function closeAll(): Promise<void> {
  await Promise.all([...pool.keys()].map((k) => closeConnection(k)));
}

function makeClient(c: MailCreds): ImapFlow {
  const client = new ImapFlow({
    host: c.imapHost,
    port: c.imapPort || 993,
    secure: c.imapSecure !== false,
    // Без неявного TLS шифрование через STARTTLS обязательно: ImapFlow иначе
    // продолжил бы без него и отправил пароль открытым текстом
    doSTARTTLS: c.imapSecure === false && !/^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(c.imapHost) ? true : undefined,
    auth: { user: c.login, pass: c.password },
    // Своего журнала не ведём: в него попал бы пароль
    logger: false,
    // Сроки ожидания обязательны все три, и по разным причинам.
    // connectionTimeout — на само соединение: когда порт 993 закрыт межсетевым
    // экраном, пакеты просто пропадают, и без этого срока раздел ждёт вечно.
    // Проверено: без него подключение к закрытому порту висело больше минуты
    // и не отвалилось само.
    connectionTimeout: 15000,
    // greetingTimeout — сервер соединение принял, но не представился
    greetingTimeout: 15000,
    // socketTimeout — на длинную выборку заголовков; короче ставить нельзя,
    // тысяча писем на медленном канале идёт дольше минуты
    socketTimeout: 120000,
  });
  // Событие 'error' без слушателя в Node роняет весь процесс. Ошибку соединения
  // получает тот, кто ждёт connect() или очередную команду, а обрыв посреди
  // простоя (сервер закрыл сокет, пока ящик никто не трогал) — никто, поэтому
  // слушатель ставим сразу, а не после успешного входа
  client.on('error', () => { /* разбор — у вызвавшего команду */ });
  return client;
}

/**
 * Соединения, которые ещё устанавливаются. Список писем и открытое письмо
 * просят соединение одновременно; без общего ожидания каждый заводил своё,
 * второе затирало первое в пуле, и первое оставалось висеть открытым без
 * владельца до перезапуска сервера.
 */
const connecting = new Map<string, Promise<ImapFlow>>();

async function connect(c: MailCreds): Promise<ImapFlow> {
  const existing = pool.get(c.id);
  if (existing && existing.client.usable) {
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    return existing.client;
  }
  const pending = connecting.get(c.id);
  if (pending) return pending;

  const attempt = (async () => {
    if (existing) await closeConnection(c.id);
    const client = makeClient(c);
    await client.connect();
    pool.set(c.id, { client, idleTimer: null, busy: false });
    // Обрыв связи не должен оставлять в пуле мёртвое соединение: следующий
    // запрос иначе упадёт на нём, а не переподключится. Но убирать из пула
    // можно только своё: закрывающееся старое соединение не должно выбросить
    // новое, уже занявшее его место
    const drop = () => { if (pool.get(c.id)?.client === client) pool.delete(c.id); };
    client.on('close', drop);
    client.on('error', drop);
    return client;
  })().finally(() => { connecting.delete(c.id); });
  connecting.set(c.id, attempt);
  return attempt;
}

/** Выполнить работу в папке, освободив её в любом случае. */
async function inMailbox<T>(c: MailCreds, path: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = await connect(c);
  const lock = await client.getMailboxLock(path);
  try {
    return await fn(client);
  } finally {
    lock.release();
    scheduleClose(c.id);
  }
}

// ── Понятные ошибки ──────────────────────────────────────────────────────────

/**
 * Почтовые серверы отвечают на отказ по-разному и по-английски. Человеку нужно
 * знать не текст сервера, а что делать: сменить пароль, включить пароль
 * приложения или проверить адрес сервера.
 */
export function explainError(err: any): string {
  const raw = String(err?.responseText || err?.message || err || '');
  const low = raw.toLowerCase();

  if (low.includes('application-specific password') || low.includes('application password')) {
    return 'Нужен пароль приложения. Обычный пароль от учётной записи почтовый сервер не принимает — заведите отдельный пароль в настройках безопасности своей почты.';
  }
  if (low.includes('invalid credentials') || low.includes('authenticationfailed')
      || low.includes('authentication failed') || low.includes('login failed')
      || low.includes('[authenticationfailed]') || err?.authenticationFailed) {
    return 'Логин или пароль не подошли. У Gmail, Яндекса и Mail.ru для сторонних программ нужен отдельный пароль приложения, а не обычный пароль.';
  }
  if (low.includes('imap access is disabled') || low.includes('imap disabled')) {
    return 'В настройках ящика выключен доступ по IMAP. Включите его на сайте своей почты.';
  }
  if (low.includes('enotfound') || low.includes('eai_again') || low.includes('getaddrinfo')) {
    return 'Адрес сервера не найден. Проверьте, правильно ли написан адрес IMAP.';
  }
  if (low.includes('econnrefused')) {
    return 'Сервер отказал в соединении. Проверьте порт: обычно 993 с шифрованием.';
  }
  if (low.includes('certificate') || low.includes('self-signed') || low.includes('altnames')) {
    return 'Не сошёлся сертификат сервера. Проверьте адрес — возможно, указан не тот узел.';
  }
  // Порт и шифрование не совпали: SSL на порту 143 или без SSL на 993. Сервер в
  // ответ молчит или рвёт связь, и по тексту это не отличить от закрытого порта —
  // поэтому подсказка про пару «порт — шифрование» нужна в обоих случаях
  if (low.includes('wrong version number') || low.includes('ssl routines')
      || low.includes('econnreset') || low.includes('unexpected close')
      || low.includes('connection not available') || low.includes('socket hang up')) {
    return 'Сервер оборвал соединение. Проверьте порт и шифрование: 993 — с SSL, 143 — без SSL (STARTTLS).';
  }
  if (low.includes('etimedout') || low.includes('timeout')
      || low.includes('failed to establish connection')) {
    return 'Сервер не ответил вовремя. Проверьте сеть, порт и шифрование (993 — с SSL, 143 — STARTTLS) и не закрыт ли порт межсетевым экраном.';
  }
  return raw || 'Не удалось соединиться с почтовым сервером.';
}

// ── Проверка связи ───────────────────────────────────────────────────────────

export interface VerifyResult { ok: boolean; error: string; folders: number }

export async function verify(c: MailCreds): Promise<VerifyResult> {
  if (!c.imapHost) {
    return { ok: false, error: 'Не указан сервер входящей почты (IMAP)', folders: 0 };
  }
  let client: ImapFlow | null = null;
  try {
    client = makeClient(c);
    await client.connect();
    const list = await client.list();
    await client.logout();
    return { ok: true, error: '', folders: list.length };
  } catch (err) {
    try { client?.close(); } catch (_) { /* уже закрыт */ }
    return { ok: false, error: explainError(err), folders: 0 };
  }
}

// ── Папки ────────────────────────────────────────────────────────────────────

export interface FolderInfo {
  path: string;
  name: string;
  kind: string;
  sortOrder: number;
}

/**
 * Назначение папки определяем по флагам IMAP, а не по названию: название
 * зависит от языка ящика — «Отправленные», «Sent», «[Gmail]/Отправленные», —
 * и распознавать его по строке значит ошибаться на каждом втором сервере.
 */
const KIND_BY_USE: Record<string, { kind: string; name: string; sortOrder: number }> = {
  '\\Sent':    { kind: 'SENT',    name: 'Отправленные', sortOrder: 20 },
  '\\Drafts':  { kind: 'DRAFTS',  name: 'Черновики',    sortOrder: 30 },
  '\\Junk':    { kind: 'SPAM',    name: 'Спам',         sortOrder: 40 },
  '\\Trash':   { kind: 'TRASH',   name: 'Корзина',      sortOrder: 50 },
  '\\Archive': { kind: 'ARCHIVE', name: 'Архив',        sortOrder: 60 },
};

export async function listFolders(c: MailCreds): Promise<FolderInfo[]> {
  const client = await connect(c);
  try {
    const raw = await client.list();
    const out: FolderInfo[] = [];
    for (const f of raw) {
      // Папка-контейнер, в которой писем не бывает
      if ((f.flags as Set<string>)?.has('\\Noselect')) continue;

      if (f.path.toUpperCase() === 'INBOX') {
        out.push({ path: f.path, name: 'Входящие', kind: 'INBOX', sortOrder: 10 });
        continue;
      }
      const use = (f.specialUse || '') as string;
      const known = KIND_BY_USE[use];
      if (known) {
        out.push({ path: f.path, name: known.name, kind: known.kind, sortOrder: known.sortOrder });
        continue;
      }
      // Своя папка: показываем последнее звено пути — «Проекты/2026» это «2026»
      const leaf = f.path.split(f.delimiter || '/').filter(Boolean).pop() || f.path;
      out.push({ path: f.path, name: leaf, kind: 'CUSTOM', sortOrder: 100 });
    }
    return out.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ru'));
  } finally {
    scheduleClose(c.id);
  }
}

// ── Заголовки ────────────────────────────────────────────────────────────────

export interface FolderState { uidValidity: string; uidNext: number; total: number }

export interface HeaderRow {
  uid: number;
  messageId: string;
  inReplyTo: string;
  refs: string;
  fromName: string;
  fromAddr: string;
  toAddrs: string;
  ccAddrs: string;
  subject: string;
  sentAt: Date;
  size: number;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  hasFiles: boolean;
}

const addrLine = (list: any): string => (Array.isArray(list) ? list : [])
  .map((a: any) => (a?.name ? `${a.name} <${a.address || ''}>` : a?.address || ''))
  .filter(Boolean)
  .join(', ');

/** Есть ли в письме вложения — видно из структуры, качать письмо не нужно. */
function structureHasFiles(node: any): boolean {
  if (!node) return false;
  const disp = String(node.disposition || '').toLowerCase();
  if (disp === 'attachment') return true;
  if (Array.isArray(node.childNodes)) return node.childNodes.some(structureHasFiles);
  return false;
}

export async function folderState(c: MailCreds, path: string): Promise<FolderState> {
  return inMailbox(c, path, async (client) => {
    const mb: any = client.mailbox;
    return {
      uidValidity: String(mb?.uidValidity ?? ''),
      uidNext: Number(mb?.uidNext ?? 0),
      total: Number(mb?.exists ?? 0),
    };
  });
}

/**
 * Заголовки писем папки.
 *
 * `since` ограничивает первую синхронизацию по дате, `minUid` — последующие,
 * когда нужны только письма новее уже скачанных.
 */
export async function fetchHeaders(
  c: MailCreds,
  path: string,
  opts: { since?: Date; minUid?: number; limit?: number },
): Promise<{ rows: HeaderRow[]; state: FolderState; more: boolean }> {
  return inMailbox(c, path, async (client) => {
    const mb: any = client.mailbox;
    const state: FolderState = {
      uidValidity: String(mb?.uidValidity ?? ''),
      uidNext: Number(mb?.uidNext ?? 0),
      total: Number(mb?.exists ?? 0),
    };
    if (!state.total) return { rows: [], state, more: false };

    // Ищем нужные uid, а не тянем всю папку: в ящике на 200 тысяч писем
    // перечисление «1:*» само по себе занимает минуты
    let uids: number[];
    if (opts.minUid && opts.minUid > 0) {
      // Диапазон «N:*» в IMAP всегда включает последнее письмо папки, даже если
      // его uid меньше N, — отсекаем его сами, иначе при отсутствии новых писем
      // каждая проверка принимала бы за новое одно и то же
      const min = opts.minUid;
      uids = (await client.search({ uid: `${min + 1}:*` }, { uid: true }) as number[]).filter((u) => u > min);
    } else if (opts.since) {
      uids = await client.search({ since: opts.since }, { uid: true }) as number[];
    } else {
      uids = await client.search({ all: true }, { uid: true }) as number[];
    }
    if (!uids?.length) return { rows: [], state, more: false };

    uids.sort((a, b) => a - b);
    const limit = opts.limit || 500;
    // Первая загрузка: свежие важнее, берём последние. Дозагрузка после
    // `minUid`: берём САМЫЕ СТАРЫЕ из новых и сообщаем, что остались ещё, —
    // иначе при пачке больше лимита метка «скачано до» перепрыгивала через
    // пропущенные письма, и они терялись навсегда
    const incremental = Boolean(opts.minUid && opts.minUid > 0);
    const take = uids.length > limit
      ? (incremental ? uids.slice(0, limit) : uids.slice(uids.length - limit))
      : uids;
    const more = incremental && uids.length > take.length;

    const rows: HeaderRow[] = [];
    for await (const msg of client.fetch(
      take.join(','),
      { envelope: true, flags: true, bodyStructure: true, size: true, uid: true },
      { uid: true },
    )) {
      const env: any = msg.envelope || {};
      const from = Array.isArray(env.from) && env.from.length ? env.from[0] : null;
      const flags: Set<string> = (msg.flags as Set<string>) || new Set();
      rows.push({
        uid: Number(msg.uid),
        messageId: String(env.messageId || ''),
        inReplyTo: String(env.inReplyTo || ''),
        // imapflow не отдаёт References в конверте — восстанавливаем цепочку
        // по In-Reply-To, а полный список берём при разборе тела
        refs: String(env.inReplyTo || ''),
        fromName: String(from?.name || ''),
        fromAddr: String(from?.address || '').toLowerCase(),
        toAddrs: addrLine(env.to),
        ccAddrs: addrLine(env.cc),
        subject: String(env.subject || ''),
        sentAt: env.date ? new Date(env.date) : new Date(),
        size: Number(msg.size || 0),
        seen: flags.has('\\Seen'),
        flagged: flags.has('\\Flagged'),
        answered: flags.has('\\Answered'),
        draft: flags.has('\\Draft'),
        hasFiles: structureHasFiles(msg.bodyStructure),
      });
    }
    return { rows, state, more };
  });
}

/**
 * Актуальные флаги уже известных писем. Нужны, чтобы подтянуть то, что человек
 * поменял в телефоне или веб-почте: дозагрузка берёт только новые письма и
 * чужих отметок «прочитано» не видит.
 */
export async function fetchFlags(
  c: MailCreds, path: string, uids: number[],
): Promise<Map<number, { seen: boolean; flagged: boolean; answered: boolean }>> {
  const out = new Map<number, { seen: boolean; flagged: boolean; answered: boolean }>();
  if (!uids.length) return out;
  return inMailbox(c, path, async (client) => {
    for await (const msg of client.fetch(uids.join(','), { flags: true, uid: true }, { uid: true })) {
      const flags: Set<string> = (msg.flags as Set<string>) || new Set();
      out.set(Number(msg.uid), {
        seen: flags.has('\\Seen'), flagged: flags.has('\\Flagged'), answered: flags.has('\\Answered'),
      });
    }
    return out;
  });
}

// ── Тело письма ──────────────────────────────────────────────────────────────

/** Собрать список частей письма из структуры, не скачивая их. */
function collectParts(node: any, acc: ParsedBody['attachments'], textParts: Array<{ part: string; type: string }>) {
  if (!node) return;
  const type = String(node.type || '').toLowerCase();
  const disp = String(node.disposition || '').toLowerCase();
  const part = String(node.part || '');

  if (Array.isArray(node.childNodes) && node.childNodes.length) {
    for (const child of node.childNodes) collectParts(child, acc, textParts);
    return;
  }
  if ((type === 'text/plain' || type === 'text/html') && disp !== 'attachment') {
    if (part) textParts.push({ part, type });
    return;
  }
  if (part) {
    acc.push({
      partId: part,
      fileName: String(node.dispositionParameters?.filename || node.parameters?.name || 'файл'),
      size: Number(node.size || 0),
      mimeType: type,
      contentId: String(node.id || '').replace(/^<|>$/g, ''),
      inline: disp === 'inline',
    });
  }
}

async function streamToString(stream: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

export async function fetchBody(c: MailCreds, path: string, uid: number, size = 0): Promise<ParsedBody> {
  return inMailbox(c, path, async (client) => {
    // Небольшое письмо проще и надёжнее разобрать целиком: mailparser сам
    // разберётся с кодировками, вложенными письмами и картинками внутри
    if (!size || size <= FULL_PARSE_LIMIT) {
      const one: any = await client.fetchOne(String(uid), { source: true }, { uid: true });
      // Пустой ответ — не «письмо без текста»: такое письмо закрепилось бы в
      // базе пустым навсегда, и при следующем открытии сервер уже не спрашивали
      if (!one?.source) throw new Error('Письма нет на сервере — возможно, его удалили в другом приложении.');
      const parsed: any = await simpleParser(one.source);
      return {
        text: String(parsed.text || ''),
        html: typeof parsed.html === 'string' ? parsed.html : '',
        attachments: (parsed.attachments || []).map((a: any, i: number) => ({
          partId: String(a.partId || i + 1),
          fileName: String(a.filename || 'файл'),
          size: Number(a.size || 0),
          mimeType: String(a.contentType || ''),
          contentId: String(a.cid || ''),
          inline: a.contentDisposition === 'inline',
          content: a.content as Buffer,
        })),
      };
    }

    // Тяжёлое письмо: тянем только текст, вложения оставляем на сервере
    const one: any = await client.fetchOne(String(uid), { bodyStructure: true }, { uid: true });
    const files: ParsedBody['attachments'] = [];
    const textParts: Array<{ part: string; type: string }> = [];
    collectParts(one?.bodyStructure, files, textParts);

    let text = '';
    let html = '';
    for (const tp of textParts) {
      try {
        const dl: any = await client.download(String(uid), tp.part, { uid: true });
        const body = await streamToString(dl.content);
        if (tp.type === 'text/html') html = html || body;
        else text = text || body;
      } catch (_) { /* часть недоступна — покажем то, что есть */ }
    }
    return { text, html, attachments: files };
  });
}

/** Скачать одно вложение по требованию. */
export async function fetchAttachment(
  c: MailCreds, path: string, uid: number, partId: string,
): Promise<Buffer | null> {
  return inMailbox(c, path, async (client) => {
    try {
      const dl: any = await client.download(String(uid), partId, { uid: true });
      const chunks: Buffer[] = [];
      for await (const chunk of dl.content) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    } catch (_) {
      return null;
    }
  });
}

// ── Флаги и перемещение ──────────────────────────────────────────────────────

export async function setFlag(
  c: MailCreds, path: string, uids: number[], flag: string, on: boolean,
): Promise<void> {
  if (!uids.length) return;
  await inMailbox(c, path, async (client) => {
    const range = uids.join(',');
    if (on) await client.messageFlagsAdd(range, [flag], { uid: true });
    else await client.messageFlagsRemove(range, [flag], { uid: true });
  });
}

export async function moveMessages(
  c: MailCreds, from: string, uids: number[], to: string,
): Promise<void> {
  if (!uids.length) return;
  await inMailbox(c, from, async (client) => {
    await client.messageMove(uids.join(','), to, { uid: true });
  });
}

/**
 * Положить письмо в папку. Нужно для «Отправленных»: SMTP отправляет письмо,
 * но на сервере его не оставляет — без APPEND отправленного не видно ни в
 * телефоне, ни в веб-почте.
 */
export async function appendMessage(
  c: MailCreds, path: string, raw: Buffer, flags: string[] = ['\\Seen'],
): Promise<void> {
  const client = await connect(c);
  try {
    await client.append(path, raw, flags);
  } finally {
    scheduleClose(c.id);
  }
}
