import type { Express, Request, Response } from 'express';
import { administratorPermission } from '../accessPolicy.js';
import { broadcast, getPrisma } from '../context.js';
import { ensureDepartmentSchema } from '../departmentsSchema.js';
import {
  DepartmentError, applyAssign, archiveDepartment, countPeople, createDepartment, ensureRootDepartment,
  listDepartments, moveDepartment, planAssign, restoreDepartment, undoBatch, updateDepartment,
} from '../departments.js';
import { applyLegacy, planLegacy, type LegacyChoice } from '../departmentsMatch.js';

// Подразделения (docs/departments.md, этап 1): справочник, перевод людей, мастер
// переноса старых текстов. Читать дерево может любой вошедший (все видят всех),
// менять — владелец и администратор с правом «Управление сотрудниками»
// (администраторы подразделений — этап 3). Личность — только из сессии.

const actorOf = (req: Request) => (req as any).authUser as { id: string; role: string };

function fail(res: Response, error: any) {
  if (error instanceof DepartmentError) return res.status(error.status).json({ message: error.message, error: error.message, ...(error.extra || {}) });
  const conflict = ['P2002', 'P2034', 'P2028'].includes(error?.code);
  return res.status(conflict ? 409 : 500).json({
    message: conflict ? 'Данные изменились во время операции. Повторите.' : (error?.message || 'Не удалось выполнить операцию'),
  });
}

const idsOf = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length > 0 && v.length <= 5000 && v.every((x) => typeof x === 'string' && x.length <= 64) ? v as string[] : null;

export function registerDepartmentRoutes(app: Express): void {
  app.use('/api/departments', async (req, res, next) => {
    try {
      await ensureDepartmentSchema(getPrisma());
      const open = ['GET', 'HEAD'].includes(req.method) && !req.path.startsWith('/legacy');
      if (!open && !administratorPermission((req as any).authUser, 'admin.users.manage')) {
        return res.status(403).json({ message: 'Нет права управлять подразделениями', error: 'Нет права управлять подразделениями' });
      }
      next();
    } catch (error: any) { res.status(503).json({ message: error?.message || 'Не удалось подготовить таблицы подразделений' }); }
  });

  const changed = () => broadcast('departments:changed', { at: Date.now() });

  // Дерево одним плоским списком: экран и сервер строят его одной функцией (shared/departments.ts)
  app.get('/api/departments', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const root = await ensureRootDepartment(prisma);
      const all = await listDepartments(prisma);
      const counts = await countPeople(prisma, all);
      const withArchived = req.query.archived === '1';
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        rootId: root.id,
        unassigned: counts.unassigned,
        departments: all
          .filter((d: any) => withArchived || !d.archivedAt)
          .map((d: any) => ({ ...d, people: counts.own.get(d.id) || 0, total: counts.total.get(d.id) || 0 })),
      });
    } catch (error) { fail(res, error); }
  });

  app.post('/api/departments', async (req: Request, res: Response) => {
    try { const dept = await createDepartment(getPrisma(), actorOf(req).id, req.body || {}); changed(); res.json(dept); }
    catch (error) { fail(res, error); }
  });

  // История переводов человека: кто, откуда, куда и когда
  app.get('/api/departments/history/:userId', async (req: Request, res: Response) => {
    try {
      const rows = await getPrisma().userDepartmentHistory.findMany({ where: { userId: String(req.params.userId) }, orderBy: { at: 'desc' }, take: 200 });
      res.json(rows);
    } catch (error) { fail(res, error); }
  });

  // ── Перевод людей: предпросмотр → применение → отмена ─────────────────────
  app.post('/api/departments/assign/preview', async (req: Request, res: Response) => {
    try {
      const ids = idsOf(req.body?.userIds);
      if (!ids) return res.status(400).json({ message: 'Отметьте сотрудников (до 5000)' });
      res.json(await planAssign(getPrisma(), ids, String(req.body?.departmentId || ''), actorOf(req).role));
    } catch (error) { fail(res, error); }
  });

  app.post('/api/departments/assign', async (req: Request, res: Response) => {
    try {
      const ids = idsOf(req.body?.userIds);
      if (!ids) return res.status(400).json({ message: 'Отметьте сотрудников (до 5000)' });
      const result = await applyAssign(getPrisma(), actorOf(req), ids, String(req.body?.departmentId || ''), req.body?.reason);
      changed();
      res.json(result);
    } catch (error) { fail(res, error); }
  });

  // Одна отмена на все партии: перевод, архив с переводом, мастер переноса
  app.post('/api/departments/undo', async (req: Request, res: Response) => {
    try { const result = await undoBatch(getPrisma(), actorOf(req).id, String(req.body?.undoToken || '')); changed(); res.json({ success: true, ...result }); }
    catch (error) { fail(res, error); }
  });

  // ── Мастер переноса старых текстов ────────────────────────────────────────
  app.get('/api/departments/legacy/plan', async (req: Request, res: Response) => {
    try { res.json(await planLegacy(getPrisma(), String(req.query.parentId || '') || undefined)); }
    catch (error) { fail(res, error); }
  });

  app.post('/api/departments/legacy/apply', async (req: Request, res: Response) => {
    try {
      const raw = req.body?.choices;
      if (!Array.isArray(raw) || !raw.length || raw.length > 2000) return res.status(400).json({ message: 'Нет выбранных значений для переноса' });
      const choices: LegacyChoice[] = raw.map((c: any) => ({
        key: String(c?.key || ''), action: ['create', 'map', 'skip'].includes(c?.action) ? c.action : 'skip',
        departmentId: c?.departmentId ? String(c.departmentId) : undefined,
        parentId: c?.parentId ? String(c.parentId) : undefined, name: c?.name ? String(c.name).slice(0, 120) : undefined,
      })).filter((c) => c.key);
      const result = await applyLegacy(getPrisma(), actorOf(req), choices);
      changed();
      res.json(result);
    } catch (error) { fail(res, error); }
  });

  // ── Одно подразделение ────────────────────────────────────────────────────
  app.put('/api/departments/:id/move', async (req: Request, res: Response) => {
    try { const dept = await moveDepartment(getPrisma(), String(req.params.id), req.body?.parentId, req.body?.sortOrder); changed(); res.json(dept); }
    catch (error) { fail(res, error); }
  });

  app.post('/api/departments/:id/archive', async (req: Request, res: Response) => {
    try { const result = await archiveDepartment(getPrisma(), actorOf(req), String(req.params.id), req.body?.moveTo); changed(); res.json(result); }
    catch (error) { fail(res, error); }
  });

  app.post('/api/departments/:id/restore', async (req: Request, res: Response) => {
    try { const result = await restoreDepartment(getPrisma(), String(req.params.id)); changed(); res.json(result); }
    catch (error) { fail(res, error); }
  });

  app.put('/api/departments/:id', async (req: Request, res: Response) => {
    try { const dept = await updateDepartment(getPrisma(), String(req.params.id), req.body || {}); changed(); res.json(dept); }
    catch (error) { fail(res, error); }
  });
}
