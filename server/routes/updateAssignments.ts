/**
 * Обычное обновление выбранным: сотрудникам и подразделениям.
 *
 * Владелец в Studio называет выпуск и состав; сервер хранит правило и на каждую проверку
 * сотрудника отвечает, назначено ли ему обновление (`GET /api/updates/assigned`). Плашка у
 * человека зависит от этого ответа, а не от «последней версии»: невыбранному ничего не
 * предлагается, но в настройках поставить можно всегда (ответ владельца 15 ноября 2026).
 *
 * Выпуск подписан ключом владельца и проверяется на компьютере сотрудника при скачивании, поэтому
 * назначение «кому показать плашку» отдельной подписи не несёт: подделать им нечего, кроме списка
 * получателей. Обязательное обновление со сроком остаётся подписанным (routes/updateCampaigns.ts).
 */
import type { Express } from 'express';
import crypto from 'node:crypto';
import { readUpdateSignature } from '../../electron/updateSignature.js';
import { newestFirst } from '../updateOrder.js';
import { cleanAudience, coversUser, pickAssignment, type UpdateAssignment } from '../updateAudience.js';
import { ASSIGN_KEY, assignRowId, cancelAssignment, listAssignments } from '../updateAssignStore.js';

/** Коды отказов: отдельное поле ответа, человеку показывается только текст */
export const ASSIGN_REFUSALS = {
  OWNER_ONLY: 'UPDATE_OWNER_ONLY',
  BAD_AUDIENCE: 'UPDATE_BAD_AUDIENCE',
  RELEASE_GONE: 'UPDATE_RELEASE_UNAVAILABLE',
  AUDIENCE_CHANGED: 'UPDATE_AUDIENCE_CHANGED',
  NOT_FOUND: 'UPDATE_ASSIGNMENT_NOT_FOUND',
  CONFLICT: 'UPDATE_ASSIGNMENT_CONFLICT',
} as const;

export interface UpdateAssignDeps {
  getPrisma: () => any; updatePublicKeyHex?: string;
  broadcast: (event: string, payload: unknown) => void;
  /** Проверка выпуска из server/updates.ts: опубликован, подписан, файл в базе цел */
  availability: (db: any, release: any) => Promise<{ ok: boolean; size: number; why: string; signature?: string }>;
}
const validVersion = (v: unknown): string => typeof v === 'string' && v.length <= 40 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(v) ? v : '';
const refuse = (res: any, status: number, code: string, error: string) => res.status(status).json({ error, code });

const manager = (req: any, res: any, next: () => void) => {
  if (req.authUser?.role !== 'OWNER') return refuse(res, 403, ASSIGN_REFUSALS.OWNER_ONLY, 'Обновлениями Flux управляет только владелец.');
  next();
};

export function registerUpdateAssignmentRoutes(app: any | Express, deps: UpdateAssignDeps) {
  /** Люди и подразделения для выбора, назначения и сколько человек каждое охватывает сейчас */
  app.get('/api/updates/audience', manager, async (_req: any, res: any) => {
    try {
      const db = deps.getPrisma();
      const [users, departments, assignments, published] = await Promise.all([
        db.user.findMany({ where: { role: { not: 'SERVICE' } }, select: { id: true, name: true, symbol: true, isActive: true, departmentId: true }, take: 10001 }),
        db.department.findMany({ where: { archivedAt: null }, select: { id: true, name: true, parentId: true, kind: true, sortOrder: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
        listAssignments(db),
        db.appUpdate.findMany({ where: { state: 'published' } }),
      ]);
      if (users.length > 10000) throw new Error('Список сотрудников требует обслуживания.');
      const releases = newestFirst(published as any[]).slice(0, 30).filter((r: any) => readUpdateSignature(r.signature, deps.updatePublicKeyHex))
        .map((r: any) => ({ version: r.version, generation: r.generation, signature: r.signature, sha256: r.sha256 }));
      const shown = [...assignments].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(a => ({
        ...a, covered: users.filter((u: any) => coversUser(a, u, departments)).length,
        people: users.filter((u: any) => a.userIds.includes(u.id)).map((u: any) => u.name),
        units: departments.filter((d: any) => a.departmentIds.includes(d.id)).map((d: any) => d.name),
      }));
      res.json({ users, departments, assignments: shown, releases });
    } catch { res.status(503).json({ error: 'Список сотрудников и подразделений недоступен. Повторите позже.' }); }
  });

  app.post('/api/updates/assignments', manager, async (req: any, res: any) => {
    try {
      const db = deps.getPrisma(), version = validVersion(req.body?.version);
      const audience = cleanAudience(req.body);
      if (typeof audience === 'string') return refuse(res, 400, ASSIGN_REFUSALS.BAD_AUDIENCE, audience);
      const release = version ? await db.appUpdate.findUnique({ where: { version } }) : null;
      const state = release ? await deps.availability(db, release) : null;
      if (!release || !state?.ok) return refuse(res, 409, ASSIGN_REFUSALS.RELEASE_GONE, 'Выпуск недоступен или отозван. Обновите список.');
      const [people, units] = await Promise.all([
        audience.userIds.length ? db.user.findMany({ where: { id: { in: audience.userIds }, role: { not: 'SERVICE' } }, select: { id: true } }) : [],
        audience.departmentIds.length ? db.department.findMany({ where: { id: { in: audience.departmentIds }, archivedAt: null }, select: { id: true } }) : [],
      ]);
      // Сотрудника удалили или подразделение ушло в архив, пока владелец выбирал: назначение молча не сужается
      if (people.length !== audience.userIds.length || units.length !== audience.departmentIds.length) {
        return refuse(res, 409, ASSIGN_REFUSALS.AUDIENCE_CHANGED, 'Состав изменился: сотрудник или подразделение больше недоступны. Обновите список.');
      }
      const a: UpdateAssignment = { v: 1, id: crypto.randomUUID(), version, generation: release.generation || '', ...audience, createdAt: Date.now(), createdBy: req.authUser.id };
      await db.appSetting.create({ data: { id: assignRowId(a.id), key: ASSIGN_KEY, userId: null, value: JSON.stringify(a) } });
      deps.broadcast('app:update-assigned', { id: a.id });
      res.json({ success: true, id: a.id });
    } catch { res.status(503).json({ error: 'Назначение не сохранено. Обновите список перед повтором.' }); }
  });

  app.post('/api/updates/assignments/:id/cancel', manager, async (req: any, res: any) => {
    try {
      const done = await cancelAssignment(deps.getPrisma(), String(req.params.id), req.authUser.id, Date.now());
      if (done === 'missing') return refuse(res, 404, ASSIGN_REFUSALS.NOT_FOUND, 'Назначение не найдено.');
      if (done === 'conflict') return refuse(res, 409, ASSIGN_REFUSALS.CONFLICT, 'Назначение уже изменилось. Обновите список.');
      if (done === 'done') deps.broadcast('app:update-assigned', { id: String(req.params.id) });
      res.json({ success: true });
    } catch { res.status(503).json({ error: 'Назначение не отменено. Повторите позже.' }); }
  });

  /**
   * Что предложить этому сотруднику. Версию, которая у него стоит, присылает программа: сервер её
   * не знает (у одного человека бывает несколько компьютеров). Ответ без выпуска — «ничего не назначено
   * или уже установлено»: плашки нет.
   */
  app.get('/api/updates/assigned', async (req: any, res: any) => {
    const userId = req.authUser?.id;
    if (!userId) return refuse(res, 401, 'AUTH_REQUIRED', 'Войдите в программу.');
    const current = validVersion(req.query?.current);
    if (!current) return refuse(res, 400, ASSIGN_REFUSALS.BAD_AUDIENCE, 'Укажите установленную версию.');
    try {
      const db = deps.getPrisma();
      res.setHeader('Cache-Control', 'no-store');
      let left = (await listAssignments(db)).filter(a => !a.cancelledAt);
      if (!left.length) return res.json({ release: null });
      const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, departmentId: true, isActive: true } });
      const departments = left.some(a => a.departmentIds.length) && user?.departmentId ? await db.department.findMany({ select: { id: true, parentId: true } }) : [];
      while (user) {
        const a = pickAssignment(left, user, departments, current);
        if (!a) break;
        const r = await db.appUpdate.findUnique({ where: { version: a.version } });
        const state = r && (r.generation || '') === a.generation ? await deps.availability(db, r) : null;
        if (r && state?.ok) {
          return res.json({ release: { assignmentId: a.id, version: r.version, changelog: r.changelog || '',
            fileUrl: `/api/updates/download/${r.version}`, size: state.size, signature: state.signature || '', createdAt: a.createdAt } });
        }
        // Выпуск отозван или повреждён: предлагаем следующее по порядку назначение, а не молчим
        left = left.filter(x => x !== a);
      }
      res.json({ release: null });
    } catch { res.status(503).json({ error: 'Не удалось проверить назначенное обновление.' }); }
  });
}
