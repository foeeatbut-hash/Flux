import type { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getPrisma, sendError, resolveProjectId } from '../context.js';
import { readableAccount, readableAccounts } from '../mail/access.js';
import * as imap from '../mail/imap.js';
import { credsOf, loadBody } from '../mail/sync.js';
import { codeCandidates, fileCandidates, caseVariants, namesInText } from '../mail/mentions.js';

/**
 * Письмо становится частью проекта.
 *
 * Ради этого почта и живёт внутри Flux, а не в соседнем окне браузера. Смета
 * приходит вложением — и должна лечь в Проводник проекта, а не остаться в
 * почте, откуда её потом никто не найдёт. Договорённость из переписки должна
 * оказаться в Блокноте рядом с остальными записями по проекту.
 *
 * Оба действия делают копию и ничего не удаляют: письмо остаётся письмом.
 */

const str = (v: any, max = 300) => String(v ?? '').trim().slice(0, max);

export interface MailLinkDeps { userDataPath: string }

/**
 * Проводник хранит содержимое файла строкой data: — так же, как при загрузке
 * файла человеком. Больше этого в строку класть нельзя: база раздувается, а
 * чертёж всё равно удобнее держать в почте и скачивать по требованию.
 */
const TO_EXPLORER_LIMIT = 25 * 1024 * 1024;

const mailDir = (base: string, accountId: string, messageId: string) =>
  path.join(base, 'mail_files', accountId, messageId);

/** Вложение с диска, а если его там ещё нет — с почтового сервера. */
async function attachmentBytes(deps: MailLinkDeps, att: any, msg: any, acc: any): Promise<Buffer | null> {
  if (att.filePath && fs.existsSync(att.filePath)) return fs.readFileSync(att.filePath);

  const prisma = getPrisma();
  const folder = await prisma.mailFolder.findUnique({ where: { id: msg.folderId } });
  if (!folder) return null;
  const buf = await imap.fetchAttachment(credsOf(acc), folder.path, msg.uid, att.partId);
  if (!buf) return null;

  const safeName = String(att.fileName || 'файл').replace(/[\\/:*?"<>|]/g, '_');
  const dir = mailDir(deps.userDataPath, acc.id, msg.id);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, safeName);
  fs.writeFileSync(full, buf);
  await prisma.mailAttachment.update({ where: { id: att.id }, data: { filePath: full, size: buf.length } });
  return buf;
}

/** Письмо и его ящик с проверкой доступа. */
async function letterOf(req: Request, messageId: string) {
  const prisma = getPrisma();
  const msg = await prisma.mailMessage.findUnique({ where: { id: messageId } });
  if (!msg) return null;
  const access = await readableAccount(req, msg.accountId);
  if (!access) return null;
  return { msg, acc: access.acc };
}

/** Имя, которого ещё нет в этой папке: «смета.pdf» → «смета (2).pdf». */
async function freeName(name: string, folderId: string | null): Promise<string> {
  const prisma = getPrisma();
  const siblings = await prisma.fileNode.findMany({
    where: { folderId: folderId || null, deletedAt: null }, select: { name: true },
  });
  const taken = new Set(siblings.map((f: any) => f.name));
  if (!taken.has(name)) return name;

  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 500; i++) {
    const next = `${base} (${i})${ext}`;
    if (!taken.has(next)) return next;
  }
  return `${base} (${Date.now()})${ext}`;
}

export function registerMailLinkRoutes(app: Express, deps: MailLinkDeps): void {
  /** Вложение → в Проводник. */
  app.post('/api/mail/attachments/:id/to-explorer', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ error: 'Требуется вход' });

      const att = await prisma.mailAttachment.findUnique({ where: { id: req.params.id } });
      if (!att) return res.status(404).json({ error: 'Вложение не найдено' });
      const letter = await letterOf(req, att.messageId);
      if (!letter) return res.status(404).json({ error: 'Вложение не найдено' });

      if (att.size > TO_EXPLORER_LIMIT) {
        return res.status(400).json({
          error: `Вложение больше ${Math.round(TO_EXPLORER_LIMIT / 1024 / 1024)} МБ. Такие лучше скачивать из письма, а не хранить в Проводнике.`,
        });
      }

      const buf = await attachmentBytes(deps, att, letter.msg, letter.acc);
      if (!buf) return res.status(502).json({ error: 'Не удалось получить вложение с почтового сервера' });

      const folderId = str(req.body?.folderId, 60) || null;
      // Папка задаёт раздел: личная папка — личный файл, общая — общий
      let scope = 'SHARED';
      let ownerId: string | null = null;
      if (folderId) {
        const parent = await prisma.folder.findUnique({ where: { id: folderId } });
        if (!parent) return res.status(404).json({ error: 'Папка не найдена' });
        scope = (parent as any).scope || 'SHARED';
        ownerId = (parent as any).ownerId || null;
      }

      const name = await freeName(String(att.fileName || 'файл').replace(/[\\/:*?"<>|]/g, '_'), folderId);
      const file = await prisma.fileNode.create({
        data: {
          name,
          folderId,
          filePath: `/${scope === 'PERSONAL' ? 'personal' : 'shared'}/${name}`,
          size: buf.length,
          type: 'FILE',
          department: 'Из почты',
          scope,
          ownerId,
          content: `data:${att.mimeType || 'application/octet-stream'};base64,${buf.toString('base64')}`,
          createdById: me.id,
          updatedById: me.id,
        },
      });

      // Кто и откуда положил файл — видно в Журнале
      await prisma.systemChangeLog.create({
        data: {
          userName: me.name || '', userSymbol: me.symbol || '',
          description: `Вложение «${name}» из письма «${letter.msg.subject || 'без темы'}» сохранено в Проводник`,
          targetRoute: '/explorer',
        },
      }).catch(() => null);

      res.json({ file: { id: file.id, name: file.name, folderId: file.folderId } });
    } catch (err) { sendError(res, err); }
  });

  /** Письмо → в Блокнот. */
  app.post('/api/mail/messages/:id/to-note', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ error: 'Требуется вход' });

      const letter = await letterOf(req, req.params.id);
      if (!letter) return res.status(404).json({ error: 'Письмо не найдено' });
      const { msg, acc } = letter;

      // Тело могло ещё не скачаться — тогда берём то, что есть в списке
      const body = msg.bodyHtml || (msg.bodyText ? `<p>${escapeHtml(msg.bodyText).replace(/\n/g, '<br>')}</p>` : '')
        || `<p>${escapeHtml(msg.snippet || '')}</p>`;

      const when = new Date(msg.sentAt).toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' });
      const from = msg.fromName ? `${escapeHtml(msg.fromName)} &lt;${escapeHtml(msg.fromAddr)}&gt;` : escapeHtml(msg.fromAddr);
      // Шапка нужна, чтобы через полгода было понятно, откуда взялась запись
      const head =
        `<p><b>Из письма</b><br>От: ${from}<br>Дата: ${when}<br>Ящик: ${escapeHtml(acc.email)}</p><hr>`;

      const note = await prisma.userNote.create({
        data: {
          ownerId: me.id,
          title: (msg.subject || 'Письмо без темы').slice(0, 120),
          content: head + body,
          groupName: str(req.body?.groupName, 80) || 'Из почты',
          ...(str(req.body?.equipmentId, 60) ? { equipmentId: str(req.body?.equipmentId, 60) } : {}),
        },
      });

      res.json({ note: { id: note.id, title: note.title } });
    } catch (err) { sendError(res, err); }
  });

  /** Папки Проводника, куда можно положить вложение. */
  app.get('/api/mail/link/folders', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.json({ folders: [] });
      const projectId = await resolveProjectId(str(req.query.projectId as string, 60));
      const folders = await prisma.folder.findMany({
        where: {
          projectId,
          deletedAt: null,
          // Личные папки видит только их владелец — здесь то же правило,
          // что и в самом Проводнике
          OR: [{ scope: 'SHARED' }, { scope: 'PERSONAL', ownerId: me.id }],
        },
        select: { id: true, name: true, scope: true, parentId: true },
        orderBy: { name: 'asc' },
        take: 300,
      });
      res.json({ folders });
    } catch (err) { sendError(res, err); }
  });

  registerMailFind(app);

  /**
   * Что из письма уже есть в программе: теги, документы Проводника, книги
   * Конструктора.
   *
   * Ищем по всем проектам сразу, а не только по открытому. Почта — общий
   * раздел: подрядчик пишет про объект, на котором вы сейчас не работаете, и
   * ответ «ничего не нашли» был бы неправдой. Чужой проект помечается в
   * ответе — открывать такое Flux предложит вместе с переключением
   * (см. src/lib/projectScope.ts).
   */
  app.get('/api/mail/messages/:id/mentions', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ error: 'Требуется вход' });

      const letter = await letterOf(req, req.params.id);
      if (!letter) return res.status(404).json({ error: 'Письмо не найдено' });
      const { msg } = letter;

      // Разбираем текст, а не разметку: в HTML между буквами обозначения
      // легко попадает <span>, и «20-PT-001» перестаёт быть одним словом.
      let text = String(msg.bodyText || '');
      if (!text) {
        const body = await loadBody(msg.id).catch(() => null);
        text = body?.text || stripTags(body?.html || msg.bodyHtml || '');
      }
      text = `${msg.subject || ''}\n${text}`.slice(0, 200_000);
      if (!text.trim()) return res.json({ tags: [], files: [], docs: [] });

      const projects = await prisma.project.findMany({ select: { id: true, name: true } });
      const projectName = new Map(projects.map((p: any) => [p.id, p.name]));

      // ── Теги ──
      const codes = caseVariants(codeCandidates(text));
      const tags = codes.length
        ? await prisma.tag.findMany({
            where: { identifier: { in: codes } },
            select: { id: true, identifier: true, projectId: true },
            take: 80,
          })
        : [];

      // ── Файлы Проводника ──
      // Личные файлы чужого сотрудника из письма не показываем: правило то же,
      // что и в самом Проводнике.
      const names = caseVariants(fileCandidates(text));
      const rawFiles = names.length
        ? await prisma.fileNode.findMany({
            where: {
              name: { in: names },
              deletedAt: null,
              type: { not: 'CHAT_FILE' },
              OR: [{ scope: { not: 'PERSONAL' } }, { ownerId: me.id }],
            },
            select: { id: true, name: true, folderId: true, folder: { select: { projectId: true } } },
            take: 60,
          })
        : [];

      // ── Документы Flux Office ──
      // У них нет ни расширения, ни дефисов, поэтому ищем наоборот: берём
      // список имён и смотрим, встречается ли имя в письме целиком.
      const allDocs = await prisma.constructorDoc.findMany({
        where: { deletedAt: null, OR: [{ scope: { not: 'PERSONAL' } }, { ownerId: me.id }] },
        select: { id: true, name: true, kind: true, projectId: true },
        take: 800,
      }).catch(() => [] as any[]);
      const docs = namesInText(text, allDocs as any).slice(0, 30);

      const withProject = (projectId: string | null | undefined) => ({
        projectId: projectId || null,
        projectName: projectId ? (projectName.get(projectId) || '') : '',
      });

      res.json({
        tags: dedupeBy(tags, (t: any) => `${t.identifier}|${t.projectId}`).map((t: any) => ({
          id: t.id, identifier: t.identifier, ...withProject(t.projectId),
        })),
        files: rawFiles.map((f: any) => ({
          id: f.id, name: f.name, folderId: f.folderId, ...withProject(f.folder?.projectId),
        })),
        // Вид документа нужен письму затем, чтобы ссылка открыла ту программу,
        // которой документ и правится: книгу — Таблицей, записку — Документом
        docs: (docs as any[]).map((d) => ({ id: d.id, name: d.name, kind: d.kind, ...withProject(d.projectId) })),
      });
    } catch (err) { sendError(res, err); }
  });
}

/**
 * Поиск писем по всем ящикам сразу.
 *
 * Отличается от поиска в самом разделе тем, что не привязан к открытому ящику:
 * человек спрашивает у помощника «все письма про 20-PT-001», а в каком из
 * четырёх ящиков они лежат — вопрос не к нему. Поэтому смотрим во всех,
 * до которых у него есть доступ.
 *
 * Ищем по заранее сложенной строке (тема, отправитель, начало письма) — в
 * SQLite сравнение без учёта регистра работает только для латиницы, поэтому
 * строка складывается заранее в нижнем регистре.
 */
export function registerMailFind(app: Express): void {
  app.get('/api/mail/find', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ error: 'Требуется вход' });

      const q = str(req.query.q as string, 120).toLowerCase();
      const from = str(req.query.from as string, 120).toLowerCase();
      const take = Math.max(1, Math.min(50, Number(req.query.limit) || 12));
      if (!q && !from) return res.json({ messages: [], total: 0 });

      const accounts = await readableAccounts(req);
      if (!accounts.length) return res.json({ messages: [], total: 0 });
      const byId = new Map(accounts.map((a: any) => [a.id, a]));

      const where: any = { accountId: { in: accounts.map((a: any) => a.id) } };
      const and: any[] = [];
      if (q) {
        // Ищем и по сложенной строке (тема, отправитель, начало письма), и по
        // самому тексту письма. Только по первой было мало: тег из середины
        // длинного согласования в неё не попадает, а спрашивают как раз о нём.
        //
        // Текст письма хранится как есть, поэтому регистр перебираем руками:
        // сравнение без учёта регистра в SQLite работает только для латиницы,
        // а обозначения в письмах пишут и «20-PT-001», и «20-pt-001».
        const forms = [...new Set([q, q.toUpperCase(), str(req.query.q as string, 120)])];
        and.push({
          OR: [
            { searchText: { contains: q } },
            ...forms.map((f) => ({ bodyText: { contains: f } })),
          ],
        });
      }
      // Отправителя ищем отдельно: «письма от Иванова» не должны находить
      // письма, где Иванов лишь упомянут в теме.
      //
      // Имя хранится как пришло — «Пётр Петров», — а ищем мы по основе в
      // нижнем регистре. Для кириллицы сравнение без учёта регистра в SQLite
      // не работает, поэтому большую букву подставляем сами.
      if (from) {
        const cap = from.charAt(0).toUpperCase() + from.slice(1);
        const forms = [...new Set([from, cap, from.toUpperCase()])];
        and.push({
          OR: forms.flatMap((f) => [{ fromName: { contains: f } }, { fromAddr: { contains: f } }]),
        });
      }
      if (and.length) where.AND = and;

      const total = await prisma.mailMessage.count({ where });
      const rows = await prisma.mailMessage.findMany({
        where,
        orderBy: { sentAt: 'desc' },
        take,
        select: {
          id: true, accountId: true, threadKey: true, subject: true,
          fromName: true, fromAddr: true, snippet: true, sentAt: true, seen: true,
        },
      });

      res.json({
        total,
        messages: rows.map((m: any) => ({
          ...m,
          accountLabel: (byId.get(m.accountId) as any)?.label || (byId.get(m.accountId) as any)?.email || '',
        })),
      });
    } catch (err) { sendError(res, err); }
  });
}

/** Разметка → текст. Без DOM: на сервере он не нужен ради одного письма. */
function stripTags(html: string): string {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"');
}

function dedupeBy<T>(list: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
