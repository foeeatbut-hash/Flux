import type { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getPrisma, sendError } from '../context.js';
import { seal, unseal, publicAccount, keySource } from '../mail/secret.js';
import * as imap from '../mail/imap.js';
import { syncAccount, isSyncing, loadBody, credsOf, searchTextOf } from '../mail/sync.js';
import {
  readableAccount, readableAccounts, isShared, msgKeyOf,
  seenKeys, setSeenLocal, unreadByFolder, threadStates,
} from '../mail/access.js';
import { watchAccount, stopWatch, restartWatch } from '../mail/idle.js';
import { verifySmtp } from '../mail/send.js';
import { discover } from '../mail/discover.js';

/**
 * Маршруты раздела «Почта».
 *
 * Ящики двух родов. Личный видит только владелец — чужую переписку не должен
 * видеть никто, включая администратора; это строже, чем в остальных разделах.
 * Общий ящик компании видят все сотрудники, а настраивает тот, кому выдано
 * право `mail.shared.manage`. Правила собраны в ../mail/access.ts и проверяются на
 * каждом маршруте.
 *
 * Пароль наружу не отдаётся ни при каких условиях: ответы собираются только
 * через publicAccount().
 */

// ── Известные почтовые службы ────────────────────────────────────────────────
//
// Человек знает свой адрес и пароль, а адреса серверов и номера портов — нет.
// Подставляем их сами: это разница между «подключилось за минуту» и «пошёл
// искать в интернете, как настроить IMAP».

interface Preset {
  title: string;
  imapHost: string; imapPort: number;
  smtpHost: string; smtpPort: number;
  /** Что сказать человеку про пароль — у большинства нужен отдельный */
  hint: string;
  help: string;
}

const PRESETS: Record<string, Preset> = {
  'gmail.com': {
    title: 'Gmail',
    imapHost: 'imap.gmail.com', imapPort: 993,
    smtpHost: 'smtp.gmail.com', smtpPort: 465,
    hint: 'Нужен пароль приложения: обычный пароль Google не подойдёт. Включите двухэтапную проверку и создайте пароль приложения.',
    help: 'https://support.google.com/accounts/answer/185833',
  },
  'yandex.ru': {
    title: 'Яндекс Почта',
    imapHost: 'imap.yandex.ru', imapPort: 993,
    smtpHost: 'smtp.yandex.ru', smtpPort: 465,
    hint: 'Нужен пароль приложения из настроек Яндекс ID, а не пароль от учётной записи.',
    help: 'https://yandex.ru/support/id/authorization/app-passwords.html',
  },
  'mail.ru': {
    title: 'Mail.ru',
    imapHost: 'imap.mail.ru', imapPort: 993,
    smtpHost: 'smtp.mail.ru', smtpPort: 465,
    hint: 'Нужен пароль для внешнего приложения из настроек безопасности почты.',
    help: 'https://help.mail.ru/mail/security/protection/external',
  },
  'outlook.com': {
    title: 'Outlook',
    imapHost: 'outlook.office365.com', imapPort: 993,
    smtpHost: 'smtp.office365.com', smtpPort: 587,
    hint: 'Для рабочих учётных записей доступ по паролю может быть закрыт политикой организации.',
    help: '',
  },
};

// Один и тот же ящик встречается под разными доменами
const ALIASES: Record<string, string> = {
  'ya.ru': 'yandex.ru', 'yandex.com': 'yandex.ru', 'yandex.by': 'yandex.ru', 'yandex.kz': 'yandex.ru',
  'googlemail.com': 'gmail.com',
  'bk.ru': 'mail.ru', 'inbox.ru': 'mail.ru', 'list.ru': 'mail.ru', 'internet.ru': 'mail.ru',
  'hotmail.com': 'outlook.com', 'live.com': 'outlook.com', 'msn.com': 'outlook.com',
};

function presetFor(email: string): (Preset & { domain: string }) | null {
  const at = String(email || '').lastIndexOf('@');
  if (at < 0) return null;
  const raw = email.slice(at + 1).toLowerCase().trim();
  const domain = ALIASES[raw] || raw;
  const p = PRESETS[domain];
  if (p) return { ...p, domain };
  // Неизвестный домен: почти всегда работает imap.<домен> и smtp.<домен>
  if (!raw.includes('.')) return null;
  return {
    domain: raw,
    title: raw,
    imapHost: `imap.${raw}`, imapPort: 993,
    smtpHost: `smtp.${raw}`, smtpPort: 465,
    hint: 'Настройки подставлены по домену — проверьте их у своего почтового администратора, если связь не установится.',
    help: '',
  };
}

// ── Вспомогательное ──────────────────────────────────────────────────────────

/** Ящик, доступный на чтение: свой личный или общий. Чужой — «не найден». */
async function ownedAccount(req: Request, id: string) {
  const access = await readableAccount(req, id);
  return access ? access.acc : null;
}

/** Письмо через доступный ящик. */
async function ownedMessage(req: Request, id: string) {
  const prisma = getPrisma();
  const msg = await prisma.mailMessage.findUnique({ where: { id } });
  if (!msg) return null;
  const access = await readableAccount(req, msg.accountId);
  if (!access) return null;
  return { msg, acc: access.acc };
}

const str = (v: any, max = 300) => String(v ?? '').trim().slice(0, max);
const num = (v: any, def: number) => (Number.isFinite(Number(v)) ? Number(v) : def);

export interface MailDeps {
  userDataPath: string;
  /** Проверка выданного права; отвечает клиенту сама, если права нет */
  enforce: (req: Request, res: Response, feature: string) => Promise<boolean>;
  /** Тот же вопрос молча — когда право лишь меняет вид ответа */
  mayFeature: (req: Request, feature: string) => Promise<boolean>;
}

/** Каталог для вложений — рядом с файлами Чата. */
function mailDir(userDataPath: string, accountId: string, messageId: string): string {
  return path.join(userDataPath, 'mail_files', accountId, messageId);
}

export function registerMailRoutes(app: Express, deps: MailDeps): void {
  // ── Подсказка по адресу ───────────────────────────────────────────────────
  app.get('/api/mail/preset', (req: Request, res: Response) => {
    const p = presetFor(str(req.query.email as string, 200));
    if (!p) return res.json({ preset: null });
    res.json({ preset: p, known: Boolean(PRESETS[p.domain]) });
  });

  // ── Ящики ─────────────────────────────────────────────────────────────────
  app.get('/api/mail/accounts', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.json({ accounts: [], keyIn: 'file' });
      const list = await readableAccounts(req);
      const maySetup = await deps.mayFeature(req, 'mail.shared.manage');
      res.json({
        accounts: list.map((a: any) => ({
          ...publicAccount(a),
          syncing: isSyncing(a.id),
          // Настройки общего ящика правит не всякий, кто его видит
          canEdit: !isShared(a) || maySetup,
        })),
        keyIn: keySource(),
        mayShared: maySetup,
      });
    } catch (err) { sendError(res, err); }
  });

  /**
   * Найти сервер по адресу, если подсказка по домену не подошла.
   *
   * Подсказка угадывает «imap.<домен>», и для почты предприятия это почти
   * всегда мимо. Человек получал «Адрес сервера не найден» и упирался: свой
   * адрес он написал правильно, а про сервер не знает ничего и знать не должен.
   */
  app.get('/api/mail/discover', async (req: Request, res: Response) => {
    const email = str(req.query.email as string, 200).toLowerCase();
    if (!email.includes('@')) return res.status(400).json({ error: 'Укажите адрес почты' });
    try {
      const found = await discover(email);
      res.json(found);
    } catch (err) { sendError(res, err); }
  });

  app.post('/api/mail/accounts', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ error: 'Требуется вход' });

      const email = str(req.body?.email, 200).toLowerCase();
      if (!email.includes('@')) return res.status(400).json({ error: 'Укажите адрес почты' });
      const password = String(req.body?.password ?? '');
      if (!password) return res.status(400).json({ error: 'Укажите пароль' });

      // Общий ящик заводится один раз и виден всем — на это нужно право
      const shared = String(req.body?.scope || 'PERSONAL') === 'SHARED';
      if (shared && !(await deps.enforce(req, res, 'mail.shared.manage'))) return;
      if (shared) {
        const already = await prisma.mailAccount.findFirst({ where: { scope: 'SHARED', email } });
        if (already) return res.status(400).json({ error: 'Такой общий ящик уже подключён' });
      }

      const p = presetFor(email);
      const sealed = seal(password);
      const acc = await prisma.mailAccount.create({
        data: {
          scope: shared ? 'SHARED' : 'PERSONAL',
          // У общего ящика владельца нет: он переживает увольнение того,
          // кто его настроил
          ownerId: shared ? '' : me.id,
          label: str(req.body?.label, 80) || (shared ? 'Общая почта' : ''),
          sortOrder: shared ? 0 : num(req.body?.sortOrder, 100),
          email,
          displayName: str(req.body?.displayName, 120) || me.name || '',
          imapHost: str(req.body?.imapHost, 200) || p?.imapHost || '',
          imapPort: num(req.body?.imapPort, p?.imapPort || 993),
          imapSecure: req.body?.imapSecure !== false,
          smtpHost: str(req.body?.smtpHost, 200) || p?.smtpHost || '',
          smtpPort: num(req.body?.smtpPort, p?.smtpPort || 465),
          smtpSecure: req.body?.smtpSecure !== false,
          login: str(req.body?.login, 200) || email,
          secret: sealed.secret,
          secretNonce: sealed.nonce,
          syncDays: Math.max(1, Math.min(3650, num(req.body?.syncDays, 90))),
        },
      });
      // Ящик подключён — начинаем ждать письма, не дожидаясь «Проверить»
      watchAccount(acc.id);
      res.json({ account: publicAccount(acc) });
    } catch (err) { sendError(res, err); }
  });

  app.put('/api/mail/accounts/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const acc = await ownedAccount(req, req.params.id);
      if (!acc) return res.status(404).json({ error: 'Ящик не найден' });
      // Общий ящик видят все, но пароль и серверы правит только тот,
      // кому выдано право: иначе любой сотрудник выбил бы ящик из строя
      if (isShared(acc) && !(await deps.enforce(req, res, 'mail.shared.manage'))) return;

      const data: any = {};
      const b = req.body || {};
      if (b.label !== undefined) data.label = str(b.label, 80);
      if (b.sortOrder !== undefined) data.sortOrder = num(b.sortOrder, acc.sortOrder);
      if (b.displayName !== undefined) data.displayName = str(b.displayName, 120);
      if (b.imapHost !== undefined) data.imapHost = str(b.imapHost, 200);
      if (b.imapPort !== undefined) data.imapPort = num(b.imapPort, acc.imapPort);
      if (b.imapSecure !== undefined) data.imapSecure = b.imapSecure !== false;
      if (b.smtpHost !== undefined) data.smtpHost = str(b.smtpHost, 200);
      if (b.smtpPort !== undefined) data.smtpPort = num(b.smtpPort, acc.smtpPort);
      if (b.smtpSecure !== undefined) data.smtpSecure = b.smtpSecure !== false;
      if (b.login !== undefined) data.login = str(b.login, 200);
      if (b.active !== undefined) data.active = b.active !== false;
      if (b.syncDays !== undefined) data.syncDays = Math.max(1, Math.min(3650, num(b.syncDays, acc.syncDays)));
      // Пустой пароль в запросе — «не менять», а не «стереть»: иначе правка
      // подписи выбивала бы ящик из строя
      if (b.password) {
        const sealed = seal(String(b.password));
        data.secret = sealed.secret;
        data.secretNonce = sealed.nonce;
        data.lastError = '';
      }

      const next = await prisma.mailAccount.update({ where: { id: acc.id }, data });
      // Настройки соединения изменились — старое держать нельзя
      await imap.closeConnection(acc.id);
      if (next.active) restartWatch(acc.id); else stopWatch(acc.id);
      res.json({ account: publicAccount(next) });
    } catch (err) { sendError(res, err); }
  });

  app.delete('/api/mail/accounts/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const acc = await ownedAccount(req, req.params.id);
      if (!acc) return res.status(404).json({ error: 'Ящик не найден' });
      if (isShared(acc) && !(await deps.enforce(req, res, 'mail.shared.manage'))) return;

      stopWatch(acc.id);
      await imap.closeConnection(acc.id);
      const msgs = await prisma.mailMessage.findMany({ where: { accountId: acc.id }, select: { id: true } });
      const ids = msgs.map((m: any) => m.id);
      if (ids.length) await prisma.mailAttachment.deleteMany({ where: { messageId: { in: ids } } });
      await prisma.mailMessage.deleteMany({ where: { accountId: acc.id } });
      await prisma.mailFolder.deleteMany({ where: { accountId: acc.id } });
      await prisma.mailDraft.deleteMany({ where: { accountId: acc.id } });
      await prisma.mailSeenLocal.deleteMany({ where: { accountId: acc.id } }).catch(() => {});
      await prisma.mailThreadState.deleteMany({ where: { accountId: acc.id } }).catch(() => {});
      await prisma.mailActivity.deleteMany({ where: { accountId: acc.id } }).catch(() => {});
      await prisma.mailAccount.delete({ where: { id: acc.id } });

      // Скачанные вложения тоже убираем: переписки больше нет
      try { fs.rmSync(path.join(deps.userDataPath, 'mail_files', acc.id), { recursive: true, force: true }); } catch (_) { /* нечего удалять */ }
      res.json({ ok: true });
    } catch (err) { sendError(res, err); }
  });

  /** Проверка связи. Отвечает на два вопроса раздельно: IMAP и SMTP. */
  app.post('/api/mail/accounts/:id/verify', async (req: Request, res: Response) => {
    try {
      const acc = await ownedAccount(req, req.params.id);
      if (!acc) return res.status(404).json({ error: 'Ящик не найден' });
      const password = unseal(acc.secret, acc.secretNonce);
      if (!password) return res.json({ imap: { ok: false, error: 'Пароль не задан или не читается' } });
      const result = await imap.verify({ ...credsOf(acc), password });
      // Отправку проверяем тоже — раньше это было только обещано в пояснении, а
      // неверный сервер исходящих обнаруживался в момент, когда человек нажимал
      // «Отправить» на готовом письме и терял его
      const smtp = await verifySmtp({
        smtpHost: acc.smtpHost, smtpPort: acc.smtpPort, smtpSecure: acc.smtpSecure !== false,
        login: acc.login || acc.email, password,
      });
      const prisma = getPrisma();
      await prisma.mailAccount.update({
        where: { id: acc.id },
        data: { lastError: result.ok ? (smtp.ok ? '' : smtp.error) : result.error },
      });
      res.json({ imap: result, smtp });
    } catch (err) { sendError(res, err); }
  });

  // ── Синхронизация ─────────────────────────────────────────────────────────
  app.post('/api/mail/accounts/:id/sync', async (req: Request, res: Response) => {
    try {
      const acc = await ownedAccount(req, req.params.id);
      if (!acc) return res.status(404).json({ error: 'Ящик не найден' });
      const report = await syncAccount(acc.id, {
        deep: req.body?.deep === true,
        only: str(req.body?.folderId, 60) || undefined,
      });
      res.json({ report });
    } catch (err) { sendError(res, err); }
  });

  // ── Папки ─────────────────────────────────────────────────────────────────
  app.get('/api/mail/folders', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const acc = await ownedAccount(req, str(req.query.accountId as string, 60));
      if (!acc) return res.json({ folders: [] });
      const me = (req as any).authUser;
      const folders = await prisma.mailFolder.findMany({
        where: { accountId: acc.id }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      // В общем ящике «непрочитано» у каждого своё, поэтому счётчик считается
      // от лица спрашивающего, а не берётся из сохранённого поля папки
      const unread = await unreadByFolder(acc, me?.id || '');
      res.json({
        folders: folders.map((f: any) => ({ ...f, unread: unread[f.id] ?? (isShared(acc) ? 0 : f.unread) })),
        shared: isShared(acc),
      });
    } catch (err) { sendError(res, err); }
  });

  // ── Список писем цепочками ────────────────────────────────────────────────
  //
  // Список показывает переписки, а не отдельные письма: так устроен Gmail, и
  // так человек и думает о почте. Страницы считаем по цепочкам, иначе на
  // границе страницы переписка разрывалась бы пополам.
  app.get('/api/mail/threads', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const acc = await ownedAccount(req, str(req.query.accountId as string, 60));
      if (!acc) return res.json({ threads: [], total: 0 });

      const folderId = str(req.query.folderId as string, 60);
      const q = str(req.query.q as string, 200).toLowerCase();
      const onlyUnread = req.query.unread === '1';
      const onlyFlagged = req.query.flagged === '1';
      const take = Math.max(1, Math.min(100, num(req.query.limit, 40)));
      const skip = Math.max(0, num(req.query.skip, 0));

      const me = (req as any).authUser;
      const shared = isShared(acc);
      // Личные отметки прочтения нужны только общему ящику
      const mySeen = shared ? await seenKeys(acc.id, me?.id || '') : new Set<string>();

      const where: any = { accountId: acc.id };
      if (folderId) where.folderId = folderId;
      // Отбор «только непрочитанные» в общем ящике идёт по личным отметкам,
      // а их в запросе к базе не выразить — отбираем уже собранные цепочки
      if (onlyUnread && !shared) where.seen = false;
      if (onlyFlagged) where.flagged = true;
      if (q) where.searchText = { contains: q };

      // Сначала — какие переписки попадают на страницу
      const groups = await prisma.mailMessage.groupBy({
        by: ['threadKey'],
        where,
        _max: { sentAt: true },
        _count: { _all: true },
        orderBy: { _max: { sentAt: 'desc' } },
        take,
        skip,
      });
      if (!groups.length) return res.json({ threads: [], total: 0 });

      const keys = groups.map((g: any) => g.threadKey);
      // Затем — сами письма этих переписок
      const msgs = await prisma.mailMessage.findMany({
        where: { ...where, threadKey: { in: keys } },
        orderBy: { sentAt: 'asc' },
        select: {
          id: true, threadKey: true, folderId: true, uid: true, messageId: true, fromName: true,
          fromAddr: true, toAddrs: true, subject: true, snippet: true, sentAt: true, seen: true,
          flagged: true, answered: true, hasFiles: true, size: true,
        },
      });
      // Состояние работы с перепиской: кто взял, кто ответил
      const states = shared ? await threadStates(acc.id, keys) : new Map();
      const isSeen = (m: any) => (shared ? mySeen.has(msgKeyOf(m)) : m.seen);

      const byKey = new Map<string, any[]>();
      for (const m of msgs) {
        const arr = byKey.get(m.threadKey) || [];
        arr.push(m);
        byKey.set(m.threadKey, arr);
      }

      let threads = groups.map((g: any) => {
        const list = byKey.get(g.threadKey) || [];
        const last = list[list.length - 1];
        const st = states.get(g.threadKey) || null;
        return {
          threadKey: g.threadKey,
          count: list.length,
          // Непрочитанной считается вся переписка, если непрочитано хоть одно
          unread: list.some((m: any) => !isSeen(m)),
          flagged: list.some((m: any) => m.flagged),
          hasFiles: list.some((m: any) => m.hasFiles),
          answered: last?.answered || false,
          subject: list[0]?.subject || last?.subject || '',
          snippet: last?.snippet || '',
          sentAt: last?.sentAt || g._max?.sentAt,
          // Отправители в порядке появления — из них раздел соберёт подпись
          from: list.map((m: any) => ({ name: m.fromName, addr: m.fromAddr })),
          lastId: last?.id || '',
          ids: list.map((m: any) => m.id),
          keys: list.map((m: any) => msgKeyOf(m)),
          // Общий ящик: кто взял переписку в работу и кто на неё ответил
          state: st ? {
            status: st.status,
            claimedById: st.claimedById, claimedByName: st.claimedByName, claimedAt: st.claimedAt,
            repliedById: st.repliedById, repliedByName: st.repliedByName, repliedAt: st.repliedAt,
          } : null,
        };
      });

      if (shared && onlyUnread) threads = threads.filter((t: any) => t.unread);
      const total = await prisma.mailMessage.groupBy({ by: ['threadKey'], where, _count: { _all: true } });
      res.json({ threads, total: total.length, shared });
    } catch (err) { sendError(res, err); }
  });

  /** Письма одной переписки — целиком, с телами уже скачанных. */
  app.get('/api/mail/thread', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const acc = await ownedAccount(req, str(req.query.accountId as string, 60));
      if (!acc) return res.json({ messages: [] });
      const key = str(req.query.threadKey as string, 500);
      if (!key) return res.json({ messages: [] });

      const messages = await prisma.mailMessage.findMany({
        where: { accountId: acc.id, threadKey: key },
        orderBy: { sentAt: 'asc' },
        select: {
          id: true, folderId: true, uid: true, messageId: true, fromName: true, fromAddr: true,
          toAddrs: true, ccAddrs: true, subject: true, snippet: true, sentAt: true, size: true,
          seen: true, flagged: true, answered: true, hasFiles: true, bodyAt: true,
        },
      });
      const ids = messages.map((m: any) => m.id);
      const files = ids.length
        ? await prisma.mailAttachment.findMany({ where: { messageId: { in: ids } } })
        : [];

      const me = (req as any).authUser;
      const shared = isShared(acc);
      const mySeen = shared ? await seenKeys(acc.id, me?.id || '') : new Set<string>();
      const shown = messages.map((m: any) => ({
        ...m,
        msgKey: msgKeyOf(m),
        seen: shared ? mySeen.has(msgKeyOf(m)) : m.seen,
      }));

      // Лента общего ящика: что коллеги уже сделали с этой перепиской
      const [state, activity] = shared
        ? await Promise.all([
            prisma.mailThreadState.findFirst({ where: { accountId: acc.id, threadKey: key } }),
            prisma.mailActivity.findMany({
              where: { accountId: acc.id, threadKey: key },
              orderBy: { createdAt: 'asc' }, take: 50,
            }),
          ])
        : [null, []];

      res.json({ messages: shown, attachments: files, shared, state, activity });
    } catch (err) { sendError(res, err); }
  });

  /** Тело письма: из базы или с сервера. */
  app.get('/api/mail/messages/:id/body', async (req: Request, res: Response) => {
    try {
      const owned = await ownedMessage(req, req.params.id);
      if (!owned) return res.status(404).json({ error: 'Письмо не найдено' });
      const body = await loadBody(owned.msg.id);
      const prisma = getPrisma();
      const files = await prisma.mailAttachment.findMany({ where: { messageId: owned.msg.id } });
      res.json({ ...body, attachments: files });
    } catch (err) { sendError(res, err); }
  });

  // ── Флаги ─────────────────────────────────────────────────────────────────
  //
  // Пишем сразу в базу, а на почтовый сервер отправляем следом. Человек не
  // должен ждать сети, чтобы увидеть, что письмо отмечено прочитанным.
  app.post('/api/mail/flag', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ error: 'Требуется вход' });

      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 500).map((x: any) => String(x)) : [];
      const kind = str(req.body?.flag, 20); // seen | flagged
      const on = req.body?.on === true;
      if (!ids.length || !['seen', 'flagged'].includes(kind)) {
        return res.status(400).json({ error: 'Нечего отмечать' });
      }

      const msgs = await prisma.mailMessage.findMany({ where: { id: { in: ids } } });
      if (!msgs.length) return res.json({ ok: true, changed: 0 });

      const access = await readableAccount(req, msgs[0].accountId);
      if (!access) return res.status(404).json({ error: 'Письма не найдены' });
      const acc = access.acc;
      const shared = access.shared;
      const folderIds = [...new Set(msgs.map((m: any) => m.folderId))] as string[];

      if (shared && kind === 'seen') {
        // В общем ящике «прочитано» личное: отметка ложится только этому
        // сотруднику, у остальных девяти письмо остаётся непрочитанным
        await setSeenLocal(acc.id, me.id, msgs.map((m: any) => msgKeyOf(m)), on);
        return res.json({ ok: true, changed: msgs.length, local: true });
      }

      await prisma.mailMessage.updateMany({
        where: { id: { in: msgs.map((m: any) => m.id) } },
        data: kind === 'seen' ? { seen: on } : { flagged: on },
      });

      // Счётчики непрочитанного пересчитываем по затронутым папкам
      for (const fid of folderIds) {
        const unread = await prisma.mailMessage.count({ where: { folderId: fid, seen: false } });
        await prisma.mailFolder.update({ where: { id: fid }, data: { unread } });
      }

      res.json({ ok: true, changed: msgs.length });

      // На сервер — уже после ответа: раздел не ждёт сети
      const flag = kind === 'seen' ? '\\Seen' : '\\Flagged';
      for (const fid of folderIds) {
        const folder = await prisma.mailFolder.findUnique({ where: { id: fid } });
        if (!folder) continue;
        const uids = msgs.filter((m: any) => m.folderId === fid).map((m: any) => m.uid);
        imap.setFlag(credsOf(acc), folder.path, uids, flag, on).catch(async (err) => {
          await prisma.mailAccount.update({
            where: { id: acc.id }, data: { lastError: imap.explainError(err) },
          }).catch(() => null);
        });
      }
    } catch (err) { sendError(res, err); }
  });

  // ── Перемещение: в корзину, в архив, обратно ──────────────────────────────
  app.post('/api/mail/move', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ error: 'Требуется вход' });

      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 500).map((x: any) => String(x)) : [];
      const toKind = str(req.body?.to, 20).toUpperCase(); // TRASH | ARCHIVE | INBOX
      if (!ids.length) return res.status(400).json({ error: 'Нечего переносить' });

      const msgs = await prisma.mailMessage.findMany({ where: { id: { in: ids } } });
      if (!msgs.length) return res.json({ ok: true });

      const access = await readableAccount(req, msgs[0].accountId);
      if (!access) return res.status(404).json({ error: 'Письма не найдены' });
      const acc = access.acc;

      const target = await prisma.mailFolder.findFirst({ where: { accountId: acc.id, kind: toKind } });
      if (!target) {
        return res.status(400).json({ error: `На сервере нет папки «${toKind === 'TRASH' ? 'Корзина' : toKind === 'ARCHIVE' ? 'Архив' : 'Входящие'}»` });
      }

      const folderIds = [...new Set(msgs.map((m: any) => m.folderId))] as string[];
      for (const fid of folderIds) {
        if (fid === target.id) continue;
        const folder = await prisma.mailFolder.findUnique({ where: { id: fid } });
        if (!folder) continue;
        const group = msgs.filter((m: any) => m.folderId === fid);
        try {
          await imap.moveMessages(credsOf(acc), folder.path, group.map((m: any) => m.uid), target.path);
          // Письмо переехало — его uid в новой папке нам неизвестен. Убираем
          // запись: следующая синхронизация принесёт письмо с верным uid.
          await prisma.mailAttachment.deleteMany({ where: { messageId: { in: group.map((m: any) => m.id) } } });
          await prisma.mailMessage.deleteMany({ where: { id: { in: group.map((m: any) => m.id) } } });
        } catch (err: any) {
          return res.status(400).json({ error: imap.explainError(err) });
        }
        const unread = await prisma.mailMessage.count({ where: { folderId: fid, seen: false } });
        const total = await prisma.mailMessage.count({ where: { folderId: fid } });
        await prisma.mailFolder.update({ where: { id: fid }, data: { unread, total } });
      }
      res.json({ ok: true });
    } catch (err) { sendError(res, err); }
  });

  // ── Вложения ──────────────────────────────────────────────────────────────
  //
  // Файл скачивается с почтового сервера при первом обращении и остаётся на
  // диске: второй раз то же вложение открывается мгновенно.
  app.get('/api/mail/attachments/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ error: 'Требуется вход' });

      const att = await prisma.mailAttachment.findUnique({ where: { id: req.params.id } });
      if (!att) return res.status(404).json({ error: 'Вложение не найдено' });
      const owned = await ownedMessage(req, att.messageId);
      if (!owned) return res.status(404).json({ error: 'Вложение не найдено' });

      const safeName = att.fileName.replace(/[\\/:*?"<>|]/g, '_') || 'файл';

      if (att.filePath && fs.existsSync(att.filePath)) {
        return res.download(att.filePath, safeName);
      }

      const folder = await prisma.mailFolder.findUnique({ where: { id: owned.msg.folderId } });
      if (!folder) return res.status(404).json({ error: 'Папка письма не найдена' });

      const buf = await imap.fetchAttachment(credsOf(owned.acc), folder.path, owned.msg.uid, att.partId);
      if (!buf) return res.status(502).json({ error: 'Не удалось получить вложение с почтового сервера' });

      const dir = mailDir(deps.userDataPath, owned.acc.id, owned.msg.id);
      fs.mkdirSync(dir, { recursive: true });
      const full = path.join(dir, safeName);
      fs.writeFileSync(full, buf);
      await prisma.mailAttachment.update({ where: { id: att.id }, data: { filePath: full, size: buf.length } });
      res.download(full, safeName);
    } catch (err) { sendError(res, err); }
  });

  /** Пересчёт строки поиска — нужен после обновления программы. */
  app.post('/api/mail/reindex', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const acc = await ownedAccount(req, str(req.body?.accountId, 60));
      if (!acc) return res.status(404).json({ error: 'Ящик не найден' });
      const msgs = await prisma.mailMessage.findMany({ where: { accountId: acc.id } });
      for (const m of msgs) {
        await prisma.mailMessage.update({
          where: { id: m.id },
          data: { searchText: searchTextOf(m.subject, m.fromName, m.fromAddr, m.snippet) },
        });
      }
      res.json({ ok: true, count: msgs.length });
    } catch (err) { sendError(res, err); }
  });
}
