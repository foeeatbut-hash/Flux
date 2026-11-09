import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { getPrisma } from '../context.js';
import { unseal, keyProblem } from './secret.js';
import * as imap from './imap.js';
import { credsOf } from './sync.js';

/**
 * Отправка письма.
 *
 * Три вещи, без которых отправка выглядит работающей, но таковой не является:
 *
 *  1. Копия в «Отправленные». SMTP только передаёт письмо дальше и ничего не
 *     кладёт в ящик. Без отдельного APPEND по IMAP отправленное письмо не
 *     увидит ни телефон, ни веб-почта — человек решит, что письмо пропало.
 *
 *  2. Заголовки цепочки. In-Reply-To и References связывают ответ с исходным
 *     письмом. Без них ответ уедет отдельной веткой и у получателя, и у нас.
 *
 *  3. Картинки подписи частями письма. Ссылка на наш сервер снаружи не
 *     откроется, а картинку в data: почтовые службы вырезают как подозрительную.
 *     Поэтому логотип уходит вложением с Content-ID, а в разметке остаётся
 *     ссылка cid: — так делают все почтовые клиенты.
 */

export interface OutFile {
  fileName: string;
  filePath: string;
  mimeType?: string;
}

export interface SendInput {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  html: string;
  files?: OutFile[];
  /** Письмо, на которое отвечаем — из него берутся заголовки цепочки */
  replyTo?: { messageId: string; refs: string; subject: string } | null;
}

export interface SendResult {
  ok: boolean;
  error: string;
  messageId: string;
  /** Удалось ли положить копию в «Отправленные» */
  appended: boolean;
  /** Адреса, которые сервер не принял, хотя остальным письмо ушло */
  rejected: string[];
}

/**
 * Разбор строки адресов «Имя <адрес>, второй@адрес» в список для nodemailer.
 *
 * Разделитель считается разделителем только вне угловых скобок и вне кавычек.
 * Иначе `"Иванов, Иван" <i@x.ru>` разваливается по запятой внутри имени на два
 * куска, и письмо уходит на выдуманный адрес — а виден этот случай только на
 * живой переписке, где кто-то подписался фамилией с запятой.
 */
export function splitAddrs(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of String(raw || '')) {
    if (ch === '"') quoted = !quoted;
    if (!quoted) {
      if (ch === '<') depth++;
      if (ch === '>') depth = Math.max(0, depth - 1);
      if ((ch === ',' || ch === ';') && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((a) => a.includes('@'));
}

/**
 * Картинки подписи — во вложения с Content-ID.
 * Возвращает переписанную разметку и список частей письма.
 */
export function inlineImages(html: string, resolve: (id: string) => OutFile | null): {
  html: string; parts: Array<OutFile & { cid: string }>;
} {
  const parts: Array<OutFile & { cid: string }> = [];
  const seen = new Map<string, string>();
  // Наши картинки лежат по /mail_sig/<id>/<имя>; чужие ссылки не трогаем
  const out = String(html || '').replace(/src="\/mail_sig\/([0-9a-fA-F-]{6,})\/[^"]*"/g, (whole, id: string) => {
    let cid = seen.get(id) || '';
    if (!cid) {
      const file = resolve(id);
      if (!file) return whole;
      cid = `sig-${id}@flux`;
      seen.set(id, cid);
      parts.push({ ...file, cid });
    }
    return `src="cid:${cid}"`;
  });
  return { html: out, parts };
}

/** Простой текстовый вариант письма: без него часть служб метит письмо как спам. */
export function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Тема ответа: «Re:» добавляем один раз, а не по разу на каждый ответ. */
export function replySubject(subject: string): string {
  const s = String(subject || '').trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

export function forwardSubject(subject: string): string {
  const s = String(subject || '').trim();
  return /^(fwd|fw):/i.test(s) ? s : `Fwd: ${s}`;
}

/** Сведения о сервере исходящих — всё, что нужно для соединения. */
export interface SmtpConn {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  login: string;
  password: string;
}

/**
 * Параметры соединения с SMTP.
 *
 * На порту 587 шифрование включается командой STARTTLS уже после приветствия.
 * Без `requireTLS` nodemailer при отказе сервера от STARTTLS молча продолжил
 * бы и отправил логин с паролем открытым текстом; здесь он вместо этого
 * остановится с понятной ошибкой.
 */
export function smtpTransportOptions(c: SmtpConn, timeouts: { connection: number; socket: number }) {
  const secure = c.smtpSecure !== false;
  const port = c.smtpPort || (secure ? 465 : 587);
  return {
    host: c.smtpHost,
    port,
    secure,
    requireTLS: !secure && port === 587,
    auth: { user: c.login, pass: c.password },
    connectionTimeout: timeouts.connection,
    greetingTimeout: 15000,
    socketTimeout: timeouts.socket,
  };
}

/**
 * Проверка отправки: сервер SMTP отвечает и пускает с этим паролем.
 *
 * Раньше проверка связи спрашивала только IMAP, хотя обещала оба — так и было
 * написано в её пояснении. Из-за этого неверный сервер исходящих обнаруживался
 * не при подключении ящика, а в тот момент, когда человек нажимал «Отправить»
 * на готовом письме и терял его.
 */
export async function verifySmtp(c: SmtpConn): Promise<{ ok: boolean; error: string }> {
  if (!c.smtpHost) return { ok: false, error: 'Не указан сервер исходящей почты (SMTP)' };
  const transport = nodemailer.createTransport(
    smtpTransportOptions(c, { connection: 15000, socket: 20000 }),
  );
  try {
    await transport.verify();
    return { ok: true, error: '' };
  } catch (err: any) {
    return { ok: false, error: explainSmtp(err) };
  } finally {
    try { transport.close(); } catch (_) { /* уже закрыт */ }
  }
}

export async function sendMail(accountId: string, input: SendInput, sigDir: string): Promise<SendResult> {
  const prisma = getPrisma();
  const acc = await prisma.mailAccount.findUnique({ where: { id: accountId } });
  if (!acc) return { ok: false, error: 'Ящик не найден', messageId: '', appended: false, rejected: [] };

  const password = unseal(acc.secret, acc.secretNonce);
  if (!password) return { ok: false, error: keyProblem() || 'Пароль ящика не читается — задайте его заново', messageId: '', appended: false, rejected: [] };

  const to = splitAddrs(input.to);
  if (!to.length) return { ok: false, error: 'Укажите хотя бы одного получателя', messageId: '', appended: false, rejected: [] };

  // Картинки подписи забираем с диска и вкладываем в письмо
  const images = await prisma.mailSignatureImage.findMany({ where: {} }).catch(() => [] as any[]);
  const byId = new Map((images as any[]).map((i) => [i.id, i]));
  const { html, parts } = inlineImages(input.html, (id) => {
    const img = byId.get(id);
    if (!img) return null;
    const p = path.isAbsolute(img.filePath) ? img.filePath : path.join(sigDir, img.filePath);
    if (!fs.existsSync(p)) return null;
    return { fileName: img.fileName, filePath: p, mimeType: img.mimeType };
  });

  const attachments = [
    ...parts.map((p) => ({ filename: p.fileName, path: p.filePath, cid: p.cid, contentType: p.mimeType })),
    ...(input.files || []).map((f) => ({ filename: f.fileName, path: f.filePath, contentType: f.mimeType })),
  ];

  const headers: Record<string, string> = {};
  if (input.replyTo?.messageId) {
    headers['In-Reply-To'] = input.replyTo.messageId;
    // References — вся цепочка: к прежним добавляем то, на что отвечаем
    const chain = `${input.replyTo.refs || ''} ${input.replyTo.messageId}`.trim().split(/\s+/).filter(Boolean);
    headers.References = Array.from(new Set(chain)).join(' ');
  }

  let sent: Delivered;
  try {
    sent = await deliver(
      // Дальше ждать бесполезно: человеку нужен внятный отказ, а не «крутится»
      { smtpHost: acc.smtpHost, smtpPort: acc.smtpPort, smtpSecure: acc.smtpSecure, login: acc.login, password },
      {
        from: acc.displayName ? { name: acc.displayName, address: acc.email } : acc.email,
        to,
        cc: splitAddrs(input.cc || ''),
        bcc: splitAddrs(input.bcc || ''),
        subject: input.subject || '(без темы)',
        html,
        text: htmlToText(html),
        attachments,
        headers,
      },
    );
  } catch (err: any) {
    return { ok: false, error: explainSmtp(err), messageId: '', appended: false, rejected: [] };
  }

  // Копия в «Отправленные». Отказ здесь не отменяет отправки: письмо уже ушло,
  // и говорить «не отправилось» было бы неправдой
  let appended = false;
  try {
    const sentFolder = await prisma.mailFolder.findFirst({ where: { accountId: acc.id, kind: 'SENT' } });
    if (sentFolder) {
      await imap.appendMessage({ ...credsOf(acc), password }, sentFolder.path, sent.raw, ['\\Seen']);
      appended = true;
    }
  } catch (_) { /* письмо ушло, копия не легла — скажем об этом отдельно */ }

  return { ok: true, error: '', messageId: sent.messageId, appended, rejected: sent.rejected };
}

export interface OutMail {
  from: string | { name: string; address: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  attachments: Array<{ filename: string; path: string; cid?: string; contentType?: string }>;
  headers: Record<string, string>;
}

export interface Delivered {
  /** Письмо ровно в том виде, в каком оно ушло, — его же кладём в «Отправленные» */
  raw: Buffer;
  messageId: string;
  rejected: string[];
}

/**
 * Собрать письмо и передать его серверу SMTP.
 *
 * Письмо собирается ОДИН раз, до отправки, и в таком виде уходит. Раньше копию
 * для «Отправленных» брали из ответа nodemailer (`info.message`), но у
 * SMTP-транспорта такого поля нет — оно бывает только у потокового. Копия
 * поэтому не клалась никогда, а человеку при каждой отправке писали, что она
 * «не сохранилась». Скрытые получатели в собранный текст не попадают: в
 * конверт они идут отдельно, как и положено.
 */
export async function deliver(conn: SmtpConn, mail: OutMail): Promise<Delivered> {
  const node = new MailComposer(mail as any).compile();
  const envelope = node.getEnvelope();
  const messageId = node.messageId();
  const raw: Buffer = await new Promise((resolve, reject) => {
    node.build((err: Error | null, buf: Buffer) => (err ? reject(err) : resolve(buf)));
  });

  const transport = nodemailer.createTransport(
    smtpTransportOptions(conn, { connection: 20000, socket: 40000 }),
  );
  try {
    const info: any = await transport.sendMail({ envelope, raw });
    return { raw, messageId, rejected: (info?.rejected || []).map((a: any) => String(a?.address || a)) };
  } finally {
    try { transport.close(); } catch (_) { /* соединение уже закрыто */ }
  }
}

/**
 * Отказ SMTP по-русски: человеку нужно понять, что делать.
 *
 * Самая частая причина «не отвечает» — не закрытый порт, а несовпадение порта
 * и шифрования: SSL на 587 или STARTTLS на 465. Сервер при этом молчит или
 * обрывает связь, и по тексту ошибки это не отличить от закрытого порта, —
 * поэтому подсказка про порты стоит в каждом таком сообщении.
 */
export function explainSmtp(err: any): string {
  const code = String(err?.code || '');
  const text = String(err?.response || err?.message || err || '');
  if (code === 'EAUTH' || /\b53[45]\b|invalid login|authentication/i.test(text)) {
    return 'Сервер не принял логин или пароль. Для Gmail, Яндекса и Mail.ru нужен пароль приложения, а не обычный.';
  }
  if (code === 'EDNS' || /enotfound|getaddrinfo|eai_again/i.test(text)) {
    return 'Сервер исходящей почты не найден. Проверьте адрес SMTP.';
  }
  if (code === 'ECONNREFUSED') return 'Сервер отправки отказал в соединении — проверьте адрес и порт SMTP: обычно 465 (SSL) или 587 (STARTTLS).';
  if (/certificate|self-signed|altnames|cert_/i.test(text)) {
    return 'Не сошёлся сертификат сервера исходящей почты — проверьте адрес.';
  }
  if (/starttls/i.test(text)) {
    return 'Сервер исходящей почты не включил шифрование (STARTTLS), а без него пароль отправлять нельзя. Попробуйте порт 465.';
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION' || code === 'ECONNRESET'
      || /timeout|timed out|wrong version number|ssl routines|greeting never received|socket close/i.test(text)) {
    return 'Сервер отправки не отвечает. Проверьте порт и шифрование: 465 — SSL, 587 — STARTTLS. Часто порт закрыт брандмауэром или сетью конторы.';
  }
  if (/\b552\b|too large|size limit|message size|exceeds/i.test(text)) {
    return 'Письмо слишком большое для сервера — уберите вложения или сожмите их.';
  }
  if (/5\.7\.\d+|not allowed|spam/i.test(text)) return 'Сервер отклонил письмо: адрес отправителя не разрешён или письмо принято за спам.';
  if (/no recipients|\b55[03]\b/i.test(text)) return 'Сервер не принял адрес получателя — проверьте, нет ли опечатки.';
  return text.slice(0, 300) || 'Не удалось отправить письмо';
}
