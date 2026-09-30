import type { Express, Request, Response } from 'express';
import { ensureTables as ensureDbTables } from '../ddl.js';
import { getPrisma, sendError, notifyUser } from '../context.js';
import {
  isAdminActor, visibleByMembers, hiddenProjectIds, projectIdsOfRequest, actorMay, judgeMembersChange,
} from '../projectAccess.js';

// ── Кто работает над проектом ───────────────────────────────────────────────
// Дизайн: docs/os-design.md §22.5.
//
// Единственное настоящее ограничение доступа в программе. Всё остальное —
// работа, и мешать ей не надо; а вот проект, к которому человек не причастен,
// он не должен видеть вовсе: ни файлов, ни тегов, ни писем.
//
// Два решения, без которых это превратилось бы в мучение:
//
//   1. ПРОЕКТ БЕЗ УЧАСТНИКОВ ВИДЯТ ВСЕ. База, заведённая до этой работы, не
//      знает ни о каких участниках, и включать ограничение задним числом —
//      значит в одно утро отобрать у отдела все проекты разом. Ограничение
//      начинает действовать с того момента, когда в проект позвали первого
//      человека.
//
//   2. АДМИНИСТРАТОР ВИДИТ ВСЁ. Иначе некому чинить.

let ensured = false;
// Подстраховка на случай, когда автомиграция не отработала. SQL собирается
// под движок базы (server/ddl.ts): написанный синтаксисом PostgreSQL, он на
// MariaDB падал всегда и молча — см. историю с календарём.
async function ensureTables(): Promise<string> {
  if (ensured) return '';
  const prisma = getPrisma();
  try {
    await prisma.projectMember.count();
    ensured = true;
    return '';
  } catch (_) {
    const why = await ensureDbTables(prisma, [{
      table: 'ProjectMember',
      cols: [
        { name: 'id', kind: 'text', pk: true },
        { name: 'projectId', kind: 'text', notNull: true, def: '', indexed: true },
        { name: 'userId', kind: 'text', notNull: true, def: '', indexed: true },
        { name: 'addedBy', kind: 'text', notNull: true, def: '' },
        { name: 'addedAt', kind: 'time', notNull: true, def: 'now' },
      ],
      indexes: [
        { name: 'ProjectMember_project_user_key', cols: ['projectId', 'userId'], unique: true },
        { name: 'ProjectMember_userId_idx', cols: ['userId'] },
      ],
    }], (m) => console.error('[Участники]', m));
    if (!why) ensured = true;
    return why;
  }
}

const meOf = (req: Request) => (req as any).authUser || null;

/**
 * Права роли по её коду — для проверки права «Управление проектами»: профиль
 * сессии несёт только личные права, права роли лежат в таблице ролей.
 */
export async function roleGrantsOf(code: string): Promise<string | null> {
  const role = await getPrisma().role.findUnique({ where: { code } });
  return role?.permissions || null;
}

/** Состав проекта; null — прочитать не удалось (проверка при этом отказывает, а не разрешает) */
async function memberIdsOf(projectId: string): Promise<string[] | null> {
  try {
    if (await ensureTables()) return null;
    const rows = await getPrisma().projectMember.findMany({ where: { projectId }, select: { userId: true } });
    return rows.map((r: any) => String(r.userId));
  } catch (_) {
    return null;
  }
}

/**
 * Видит ли человек этот проект.
 *
 * Экспортируется: тем же правилом пользуются маршруты, отдающие данные
 * проекта. Правило, размноженное по обработчикам, однажды разойдётся — и
 * разойдётся именно там, где это дороже всего.
 *
 * Ошибка проверки — отказ (раньше «таблицы нет» и любой сбой базы читались как
 * разрешение и открывали закрытый проект посторонним).
 */
export async function canSeeProject(userId: string, projectId: string, isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return true;
  if (!projectId) return true;
  return visibleByMembers(await memberIdsOf(projectId), userId, false);
}

/**
 * Проекты, скрытые от человека. Нужен запросам «по всем проектам» (теги без
 * названного проекта): без него они отдавали теги закрытых проектов.
 * Бросает при сбое — вызывающий отвечает ошибкой, а не всеми данными.
 */
export async function hiddenProjectsOf(userId: string, isAdmin: boolean): Promise<string[]> {
  if (isAdmin) return [];
  const why = await ensureTables();
  if (why) throw new Error('Не удалось проверить состав проектов');
  const rows = await getPrisma().projectMember.findMany({ select: { projectId: true, userId: true } });
  return hiddenProjectIds(rows as any[], userId);
}

/**
 * Общий страж: любой запрос, называющий проект (в адресе, в ?projectId= или в
 * теле), проходит проверку видимости. Ставится один раз до маршрутов данных, а
 * не в каждом обработчике: забытая проверка на новом маршруте — та самая дыра,
 * через которую читали теги закрытого проекта.
 * Состав и запрос доступа разбирают свои обработчики: посторонний обязан
 * иметь возможность попросить доступ, а управляющий — поправить состав.
 */
export function registerProjectAccessGuard(app: Express): void {
  app.use('/api', async (req: Request, res: Response, next) => {
    try {
      const me = meOf(req);
      if (!me?.id || isAdminActor(me)) return next();
      const full = req.baseUrl + req.path;
      if (/\/(members|access-request)\/?$/i.test(full)) return next();
      for (const pid of projectIdsOfRequest(full, req.query, req.body)) {
        if (!(await canSeeProject(String(me.id), pid, false))) {
          return res.status(403).json({ error: 'Нет доступа к проекту. Попросите добавить вас в состав.' });
        }
      }
      next();
    } catch (err: any) { sendError(res, err); }
  });
}

export function registerMemberRoutes(app: Express): void {
  /** Состав проекта: кто в нём и кого можно позвать */
  app.get('/api/projects/:projectId/members', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const prisma = getPrisma();
      const projectId = String(req.params.projectId || '');
      const me = meOf(req);
      // Состав закрытого проекта — тоже сведения о проекте: смотрят его участники,
      // администратор и те, кто им управляет
      if (!(await canSeeProject(String(me?.id || ''), projectId, isAdminActor(me))) &&
          !(await actorMay(me, roleGrantsOf))) {
        return res.status(403).json({ error: 'Нет доступа к проекту' });
      }
      const rows = await prisma.projectMember.findMany({ where: { projectId } });
      const ids = rows.map((r: any) => r.userId);
      const users = ids.length
        ? await prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, symbol: true, role: true },
        })
        : [];
      const byId = new Map<string, any>(users.map((u: any) => [u.id, u]));
      res.json({
        items: rows.map((r: any) => ({
          userId: r.userId,
          name: byId.get(r.userId)?.name || 'Сотрудник',
          symbol: byId.get(r.userId)?.symbol || '',
          role: byId.get(r.userId)?.role || '',
          addedAt: r.addedAt,
        })),
        // Пока список пуст, проект виден всем: об этом надо сказать вслух, а не
        // оставлять человека гадать, почему ограничение не работает
        open: rows.length === 0,
      });
    } catch (err: any) { sendError(res, err); }
  });

  /** Позвать в проект (или заменить состав целиком) */
  app.post('/api/projects/:projectId/members', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const prisma = getPrisma();
      const me = meOf(req);
      const projectId = String(req.params.projectId || '');
      if (!me?.id) return res.status(401).json({ error: 'Требуется вход' });
      const asked: string[] = Array.isArray(req.body?.userIds)
        ? req.body.userIds.map((x: any) => String(x)).filter(Boolean)
        : [];

      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
      if (!project) return res.status(404).json({ error: 'Проект не найден' });
      // Звать можно только существующих сотрудников: мусорный id в составе
      // закрыл бы проект от всех, не пустив внутрь никого
      const known = asked.length
        ? await prisma.user.findMany({ where: { id: { in: asked } }, select: { id: true } })
        : [];
      const knownIds = new Set(known.map((u: any) => String(u.id)));
      const ids = [...new Set(asked)].filter((id) => knownIds.has(id));

      const before = await prisma.projectMember.findMany({ where: { projectId } });
      const had = new Set(before.map((r: any) => r.userId));

      // Раньше состав мог заменить или очистить любой вошедший — а пустой состав
      // значит «проект виден всем». Теперь состав меняет тот, кто проектом управляет
      const verdict = judgeMembersChange({
        isAdmin: isAdminActor(me),
        canManage: await actorMay(me, roleGrantsOf),
        actorId: String(me.id),
        before: [...had].map(String),
        next: asked,
      });
      if (verdict.ok === false) return res.status(403).json({ error: verdict.reason });

      await prisma.projectMember.deleteMany({
        where: { projectId, userId: { notIn: ids.length ? ids : ['-'] } },
      });
      for (const userId of ids) {
        if (had.has(userId)) continue;
        await prisma.projectMember.create({ data: { projectId, userId, addedBy: me?.id || '' } });
        // Позвали — сказали. Молча выданный доступ человек не заметит
        if (userId !== me?.id) {
          await notifyUser(
            userId, 'ПРОЕКТЫ', `Вас добавили в проект «${project?.name || ''}»`,
            `${me?.name || 'Коллега'} открыл вам доступ`, '/projects',
          );
        }
      }
      res.json({ ok: true, count: ids.length });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Запросить доступ.
   *
   * Тупик без выхода — не отказ, а издевательство: человек нажал ссылку,
   * увидел «нет доступа» и остался ни с чем. Запрос уходит уведомлением тем,
   * кто уже в проекте, — им и решать.
   */
  app.post('/api/projects/:projectId/access-request', async (req: Request, res: Response) => {
    try {
      await ensureTables();
      const prisma = getPrisma();
      const me = meOf(req);
      const projectId = String(req.params.projectId || '');
      if (!me?.id) return res.status(401).json({ error: 'Требуется вход' });

      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
      const members = await prisma.projectMember.findMany({ where: { projectId }, take: 20 });
      const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true }, take: 5 });
      const targets = new Set<string>([...members.map((m: any) => m.userId), ...admins.map((a: any) => a.id)]);
      targets.delete(me.id);

      for (const userId of targets) {
        await notifyUser(
          userId, 'ДОСТУП', `Просят доступ к проекту «${project?.name || ''}»`,
          `${me.name || 'Сотрудник'} — добавьте его в состав, если он в деле`, '/projects',
        );
      }
      res.json({ ok: true, asked: targets.size });
    } catch (err: any) { sendError(res, err); }
  });
}
