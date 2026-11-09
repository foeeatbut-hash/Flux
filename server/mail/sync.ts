import { getPrisma } from '../context.js';
import { unseal, keyProblem } from './secret.js';
import * as imap from './imap.js';
import { assignThreadKeys } from '../../src/lib/mailThread.js';

/**
 * Синхронизация ящика с базой.
 *
 * Скачиваются заголовки: отправитель, тема, фрагмент, флаги. Тело и вложения
 * тянутся при открытии письма — иначе первая синхронизация ящика на десять
 * тысяч писем заняла бы часы и гигабайты.
 *
 * Одновременно один ящик синхронизируется только в одном месте: щелчок по
 * «Обновить» во время фоновой синхронизации иначе завёл бы вторую, и обе
 * писали бы одни и те же письма.
 */

const running = new Set<string>();

/** Сколько заголовков берём за раз. Больше — дольше первый показ списка. */
const BATCH = 400;

export interface SyncReport {
  folders: number;
  added: number;
  updated: number;
  resynced: string[];
  error: string;
}

function credsOf(acc: any): imap.MailCreds {
  return {
    id: acc.id,
    imapHost: acc.imapHost,
    imapPort: acc.imapPort,
    imapSecure: acc.imapSecure,
    login: acc.login,
    password: unseal(acc.secret, acc.secretNonce),
  };
}

/**
 * Строка для поиска: тема, отправитель и фрагмент разом, в нижнем регистре.
 * Считается один раз при сохранении — искать приведением на лету значит
 * перебирать всю папку на каждое нажатие клавиши.
 */
export function searchTextOf(subject: string, fromName: string, fromAddr: string, snippet: string): string {
  return [subject, fromName, fromAddr, snippet].filter(Boolean).join(' ').toLowerCase().slice(0, 1000);
}

/** Короткий пересказ письма для списка: без разметки и без переносов. */
function snippetOf(text: string, html: string): string {
  const src = text || String(html || '').replace(/<[^>]+>/g, ' ');
  return src.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Обновить список папок. Папки, исчезнувшие на сервере, удаляем вместе с
 * письмами: держать их значило бы показывать переписку, которой уже нет.
 */
export async function syncFolders(acc: any): Promise<number> {
  const prisma = getPrisma();
  const remote = await imap.listFolders(credsOf(acc));
  const seen: string[] = [];

  for (const f of remote) {
    seen.push(f.path);
    const existing = await prisma.mailFolder.findFirst({ where: { accountId: acc.id, path: f.path } });
    if (existing) {
      if (existing.name !== f.name || existing.kind !== f.kind || existing.sortOrder !== f.sortOrder) {
        await prisma.mailFolder.update({
          where: { id: existing.id },
          data: { name: f.name, kind: f.kind, sortOrder: f.sortOrder },
        });
      }
    } else {
      await prisma.mailFolder.create({
        data: { accountId: acc.id, path: f.path, name: f.name, kind: f.kind, sortOrder: f.sortOrder },
      });
    }
  }

  // Папки, которых на сервере больше нет, убираем вместе с их письмами.
  //
  // Но только если сервер вообще что-то отдал. Пустой список — это не «папок
  // не осталось», а «связь оборвалась посреди обхода», и `notIn: []` совпал бы
  // со всеми папками разом: один сбой сети стёр бы весь скачанный ящик.
  if (seen.length) {
    const gone = await prisma.mailFolder.findMany({
      where: { accountId: acc.id, path: { notIn: seen } },
    });
    for (const g of gone) {
      await prisma.mailMessage.deleteMany({ where: { folderId: g.id } });
      await prisma.mailFolder.delete({ where: { id: g.id } });
    }
  }
  return remote.length;
}

/** Сколько пачек за один проход: 25 по BATCH — это десять тысяч новых писем. */
const MAX_ROUNDS = 25;

/** Сколько последних скачанных писем сверяем с сервером по флагам. */
const FLAG_CHECK = 500;

/**
 * Папка синхронизируется в одном месте за раз.
 *
 * Слежение (IDLE) дочитывает «Входящие» на каждое событие сервера, а человек в
 * это же время жмёт «Проверить». Две одновременные синхронизации одной папки
 * обе не находили письмо в базе и обе его создавали; вторая падала на уникальном
 * ключе (папка, uid), и ящик показывал ошибку там, где ошибки не было. Поэтому
 * вызовы встают в очередь: второй дочитывает то, что не успел первый.
 */
const folderQueue = new Map<string, Promise<unknown>>();

export function syncFolder(acc: any, folder: any, deep = false): Promise<{ added: number; updated: number; resynced: boolean }> {
  const prev = folderQueue.get(folder.id) || Promise.resolve();
  const run = prev.catch(() => null).then(() => syncFolderNow(acc, folder, deep));
  folderQueue.set(folder.id, run);
  const release = () => { if (folderQueue.get(folder.id) === run) folderQueue.delete(folder.id); };
  run.then(release, release);
  return run;
}

/** Записать пачку заголовков в базу; флаги уже известных писем обновить. */
async function storeRows(acc: any, folder: any, rows: imap.HeaderRow[]): Promise<{ added: number; updated: number }> {
  const prisma = getPrisma();
  let added = 0;
  let updated = 0;
  if (!rows.length) return { added, updated };

  // Ключи цепочек считаем на пачке целиком: письмо-предок может прийти
  // позже ответа, и поштучно цепочка рассыпалась бы
  const withKeys = assignThreadKeys(rows.map((r) => ({
    ...r,
    messageId: r.messageId,
    inReplyTo: r.inReplyTo,
    refs: r.refs,
    subject: r.subject,
    sentAt: r.sentAt,
  })));

  for (const r of withKeys) {
    const existing = await prisma.mailMessage.findFirst({
      where: { folderId: folder.id, uid: r.uid },
      select: { id: true, seen: true, flagged: true, answered: true },
    });
    if (existing) {
      // Флаги могли поменять в телефоне — подтягиваем их и здесь
      if (existing.seen !== r.seen || existing.flagged !== r.flagged || existing.answered !== r.answered) {
        await prisma.mailMessage.update({
          where: { id: existing.id },
          data: { seen: r.seen, flagged: r.flagged, answered: r.answered },
        });
        updated++;
      }
      continue;
    }
    await prisma.mailMessage.create({
      data: {
        accountId: acc.id,
        folderId: folder.id,
        uid: r.uid,
        messageId: r.messageId,
        inReplyTo: r.inReplyTo,
        refs: r.refs,
        threadKey: r.threadKey,
        fromName: r.fromName,
        fromAddr: r.fromAddr,
        toAddrs: r.toAddrs,
        ccAddrs: r.ccAddrs,
        subject: r.subject,
        snippet: '',
        sentAt: r.sentAt,
        size: r.size,
        seen: r.seen,
        flagged: r.flagged,
        answered: r.answered,
        draft: r.draft,
        hasFiles: r.hasFiles,
        searchText: searchTextOf(r.subject, r.fromName, r.fromAddr, ''),
      },
    });
    added++;
  }
  return { added, updated };
}

/**
 * Синхронизировать одну папку.
 *
 * Ключевая проверка здесь — uidValidity. Это метка поколения папки: сервер
 * вправе её сменить, и тогда все сохранённые uid указывают уже на другие
 * письма. Без перечитывания папки целиком раздел показал бы чужие темы у
 * чужих отправителей — и выглядело бы это как порча данных, а не как ошибка
 * синхронизации.
 */
async function syncFolderNow(acc: any, startFolder: any, deep: boolean): Promise<{ added: number; updated: number; resynced: boolean }> {
  const prisma = getPrisma();
  const creds = credsOf(acc);
  // Пока вызов стоял в очереди, предыдущий проход мог сдвинуть метки папки
  const folder = (await prisma.mailFolder.findUnique({ where: { id: startFolder.id } })) || startFolder;

  const state = await imap.folderState(creds, folder.path);
  let resynced = false;
  let minUid = folder.lastUid || 0;

  if (folder.uidValidity && state.uidValidity && folder.uidValidity !== state.uidValidity) {
    await prisma.mailMessage.deleteMany({ where: { folderId: folder.id } });
    minUid = 0;
    resynced = true;
  }
  if (deep) minUid = 0;

  const since = minUid ? undefined : new Date(Date.now() - (acc.syncDays || 90) * 24 * 60 * 60 * 1000);

  let added = 0;
  let updated = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { rows, more } = await imap.fetchHeaders(creds, folder.path, { since, minUid, limit: BATCH });
    const r = await storeRows(acc, folder, rows);
    added += r.added;
    updated += r.updated;
    if (!more || !rows.length) break;
    // Пачка была неполной: продолжаем с самого нового из скачанного
    minUid = Math.max(...rows.map((x) => x.uid));
  }

  // Новые письма дозагрузка видит, а отметки на старых — нет: прочитали в
  // телефоне — и здесь письмо оставалось бы жирным до полной пересинхронизации
  try {
    const known = await prisma.mailMessage.findMany({
      where: { folderId: folder.id },
      orderBy: { uid: 'desc' },
      take: FLAG_CHECK,
      select: { id: true, uid: true, seen: true, flagged: true, answered: true },
    });
    const remote = await imap.fetchFlags(creds, folder.path, known.map((m: any) => m.uid));
    for (const m of known as any[]) {
      const f = remote.get(m.uid);
      if (!f) continue;
      if (f.seen !== m.seen || f.flagged !== m.flagged || f.answered !== m.answered) {
        await prisma.mailMessage.update({ where: { id: m.id }, data: f });
        updated++;
      }
    }
  } catch (_) { /* сверка флагов не должна ронять синхронизацию писем */ }

  const unread = await prisma.mailMessage.count({ where: { folderId: folder.id, seen: false } });
  const total = await prisma.mailMessage.count({ where: { folderId: folder.id } });
  const maxUid = await prisma.mailMessage.findFirst({
    where: { folderId: folder.id }, orderBy: { uid: 'desc' }, select: { uid: true },
  });

  await prisma.mailFolder.update({
    where: { id: folder.id },
    data: {
      uidValidity: state.uidValidity,
      lastUid: maxUid?.uid || 0,
      unread,
      total,
      syncedAt: new Date(),
    },
  });

  return { added, updated, resynced };
}

/**
 * Синхронизировать ящик целиком. `deep` перечитывает папки с нуля — нужно
 * после смены глубины синхронизации.
 */
export async function syncAccount(accountId: string, opts: { deep?: boolean; only?: string } = {}): Promise<SyncReport> {
  const prisma = getPrisma();
  const report: SyncReport = { folders: 0, added: 0, updated: 0, resynced: [], error: '' };

  if (running.has(accountId)) {
    report.error = 'Синхронизация этого ящика уже идёт';
    return report;
  }
  running.add(accountId);

  try {
    const acc = await prisma.mailAccount.findUnique({ where: { id: accountId } });
    if (!acc) { report.error = 'Ящик не найден'; return report; }
    if (!unseal(acc.secret, acc.secretNonce)) {
      report.error = keyProblem() || 'Пароль ящика не читается — задайте его заново';
      return report;
    }

    report.folders = await syncFolders(acc);

    // Порядок важен: «Входящие» первыми, чтобы список появился раньше всего
    const folders = await prisma.mailFolder.findMany({
      where: { accountId: acc.id, ...(opts.only ? { id: opts.only } : {}) },
      orderBy: { sortOrder: 'asc' },
    });

    for (const f of folders) {
      try {
        const r = await syncFolder(acc, f, opts.deep);
        report.added += r.added;
        report.updated += r.updated;
        if (r.resynced) report.resynced.push(f.name);
      } catch (err: any) {
        // Одна недоступная папка не должна ронять синхронизацию остальных
        report.error = imap.explainError(err);
      }
    }

    await prisma.mailAccount.update({
      where: { id: acc.id },
      data: { lastSyncAt: new Date(), lastError: report.error },
    });
  } catch (err: any) {
    report.error = imap.explainError(err);
    await prisma.mailAccount.update({
      where: { id: accountId }, data: { lastError: report.error },
    }).catch(() => null);
  } finally {
    running.delete(accountId);
  }

  return report;
}

/** Идёт ли синхронизация — раздел показывает это в шапке. */
export function isSyncing(accountId: string): boolean {
  return running.has(accountId);
}

/**
 * Тело письма: из базы, если уже скачано, иначе с сервера. Скачанное
 * сохраняем — второй раз то же письмо открывается мгновенно.
 */
export async function loadBody(messageId: string): Promise<{ text: string; html: string; error: string }> {
  const prisma = getPrisma();
  const msg = await prisma.mailMessage.findUnique({ where: { id: messageId } });
  if (!msg) return { text: '', html: '', error: 'Письмо не найдено' };
  if (msg.bodyAt) return { text: msg.bodyText || '', html: msg.bodyHtml || '', error: '' };

  const acc = await prisma.mailAccount.findUnique({ where: { id: msg.accountId } });
  const folder = await prisma.mailFolder.findUnique({ where: { id: msg.folderId } });
  if (!acc || !folder) return { text: '', html: '', error: 'Ящик или папка не найдены' };

  try {
    const parsed = await imap.fetchBody(credsOf(acc), folder.path, msg.uid, msg.size);

    await prisma.mailMessage.update({
      where: { id: msg.id },
      data: {
        bodyText: parsed.text,
        bodyHtml: parsed.html,
        bodyAt: new Date(),
        snippet: msg.snippet || snippetOf(parsed.text, parsed.html),
        searchText: searchTextOf(msg.subject, msg.fromName, msg.fromAddr, snippetOf(parsed.text, parsed.html)),
        hasFiles: msg.hasFiles || parsed.attachments.some((a) => !a.inline),
      },
    });

    // Список вложений сохраняем один раз: сами файлы кладём на диск только
    // тогда, когда их попросят скачать
    const known = await prisma.mailAttachment.count({ where: { messageId: msg.id } });
    if (!known && parsed.attachments.length) {
      for (const a of parsed.attachments) {
        await prisma.mailAttachment.create({
          data: {
            messageId: msg.id,
            partId: a.partId,
            fileName: a.fileName,
            filePath: '',
            size: a.size,
            mimeType: a.mimeType,
            contentId: a.contentId,
            inline: a.inline,
          },
        });
      }
    }

    return { text: parsed.text, html: parsed.html, error: '' };
  } catch (err: any) {
    return { text: '', html: '', error: imap.explainError(err) };
  }
}

export { credsOf };
