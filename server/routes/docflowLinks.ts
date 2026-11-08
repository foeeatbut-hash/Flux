import type { Express, Request, Response } from 'express';
import { getPrisma, broadcast, notifyUser } from '../context.js';
import { isAdminActor } from '../projectAccess.js';
import { canSeeProject } from './members.js';
import { LinkError, createLink, itemContext, listLinks, planLink, setLinkLock, trackLink, unlinkLink } from '../docflowLinks.js';

// ── Документооборот: связь файлов папки проекта со строками ВДР ──
// Права — общая таблица server/vdrPermissions.ts: чтение — docflow.view,
// любая запись по /api/docflow/links — docflow.files. Проект строки из
// `itemId` проверяет общий страж; пачку из track проверяем здесь сами.

const actorOf = (req: Request) => (req as any).authUser || null;
const fail = (res: Response, err: any) => {
  if (err instanceof LinkError) return res.status(err.status).json({ error: err.message, ...err.extra });
  res.status(500).json({ error: err?.message || 'Ошибка связи файла со строкой' });
};
const text = (v: unknown) => (typeof v === 'string' ? v : '');

export function registerDocflowLinkRoutes(app: Express): void {
  const announce = (projectId: string) => broadcast('vdr:changed', { projectId });

  app.get('/api/docflow/links', async (req: Request, res: Response) => {
    try {
      res.json(await listLinks(getPrisma(), { projectId: text(req.query.projectId) || undefined, itemId: text(req.query.itemId) || undefined, history: req.query.history === '1' }));
    } catch (err) { fail(res, err); }
  });

  // Проверка имени без записи: окно показывает расхождения до нажатия кнопки
  app.post('/api/docflow/links/plan', async (req: Request, res: Response) => {
    try { res.json(await planLink(getPrisma(), { itemId: text(req.body?.itemId), fileName: text(req.body?.fileName) })); } catch (err) { fail(res, err); }
  });

  app.post('/api/docflow/links', async (req: Request, res: Response) => {
    try {
      const b = req.body || {};
      const result = await createLink(getPrisma(), {
        itemId: text(b.itemId), role: b.role === 'remarks' ? 'remarks' : 'file', toLinkId: text(b.toLinkId) || undefined, folderKey: text(b.folderKey),
        relativePath: text(b.relativePath), fileName: text(b.fileName), sha256: text(b.sha256), size: Number(b.size) || 0, reviewCode: text(b.reviewCode),
        receivedAt: text(b.receivedAt) || null, timeZone: text(b.timeZone), replace: b.replace === true,
      }, String(actorOf(req)?.id || ''));
      announce(result.link.projectId);
      // Замечания по коду рассмотрения возвращают исполнителю документ в работу — как раньше при правке строки
      const effect = result.effect;
      if (effect?.assigneeId && effect.status === 'REMARKS' && effect.previousStatus !== 'REMARKS') {
        const due = effect.dueDate ? ` · срок ${new Date(effect.dueDate).toLocaleDateString('ru-RU')}` : '';
        await notifyUser(effect.assigneeId, 'ДОКУМЕНТЫ', `Замечания (код ${effect.reviewCode}): ${effect.title}`, `Заказчик вернул замечания${due}`, `/docflow?tab=registry&item=${encodeURIComponent(result.link.itemId)}`).catch(() => undefined);
      }
      res.json(result);
    } catch (err) { fail(res, err); }
  });

  app.post('/api/docflow/links/unlink', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const itemId = text(req.body?.itemId);
      const { projectId } = await itemContext(prisma, itemId);
      const links = await unlinkLink(prisma, { itemId, linkId: text(req.body?.linkId), reason: text(req.body?.reason) }, String(actorOf(req)?.id || ''));
      announce(projectId);
      res.json({ links });
    } catch (err) { fail(res, err); }
  });

  // Замочек связанного файла: право docflow.files, как у назначения; проект строки сверяется здесь же
  app.post('/api/docflow/links/lock', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = actorOf(req);
      const itemId = text(req.body?.itemId);
      const { projectId } = await itemContext(prisma, itemId);
      if (!isAdminActor(me) && !(await canSeeProject(String(me?.id), projectId, false))) throw new LinkError('Нет доступа к данным проекта', 403);
      if (typeof req.body?.locked !== 'boolean') throw new LinkError('Не указано, ставить или снимать замок', 400);
      const link = await setLinkLock(prisma, { itemId, linkId: text(req.body?.linkId), locked: req.body.locked }, String(me?.id || ''));
      announce(projectId);
      res.json({ link });
    } catch (err) { fail(res, err); }
  });

  // Слежение: Проводник сообщает о переименовании, изменении и пропаже файлов. Пачка, поэтому доступ к проектам строк — здесь
  app.post('/api/docflow/links/track', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const updates: any[] = Array.isArray(req.body?.updates) ? req.body.updates.slice(0, 200) : [];
      const me = actorOf(req);
      const out = [];
      const projects = new Set<string>();
      for (const u of updates) {
        const { projectId } = await itemContext(prisma, text(u?.itemId));
        if (!isAdminActor(me) && !(await canSeeProject(String(me?.id), projectId, false))) throw new LinkError('Нет доступа к данным проекта', 403);
        out.push(await trackLink(prisma, {
          linkId: text(u.linkId), itemId: text(u.itemId), folderKey: text(u.folderKey) || undefined, relativePath: u.relativePath === undefined ? undefined : text(u.relativePath),
          fileName: u.fileName === undefined ? undefined : text(u.fileName), sha256: u.sha256 === undefined ? undefined : text(u.sha256), size: u.size === undefined ? undefined : Number(u.size), lost: u.lost === true,
        }));
        projects.add(projectId);
      }
      for (const projectId of projects) announce(projectId);
      res.json({ links: out });
    } catch (err) { fail(res, err); }
  });
}
