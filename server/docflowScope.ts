import type { Request } from 'express';
import { getPrisma } from './context.js';
import { actorMay, isAdminActor } from './projectAccess.js';
import { canSeeProject, roleGrantsOf } from './routes/members.js';
import { DocflowPlanError } from './docflowPlans.js';

/** Проверка в обработчике обязательна и при подключении маршрута без общего стража. */
export async function docflowScope(req: Request, right = 'docflow.view') {
  const actor = (req as any).authUser;
  for (const permission of new Set(['docflow.view', right])) {
    if (!await actorMay(actor, roleGrantsOf, permission)) throw new DocflowPlanError('Недостаточно прав для этого действия документооборота', 403);
  }
  const projectId = req.method === 'GET' ? req.query.projectId : req.body?.projectId;
  if (typeof projectId !== 'string' || !projectId || projectId.length > 100) throw new DocflowPlanError('Не указан проект', 400);
  const p = getPrisma();
  if (!await p.project.findUnique({ where: { id: projectId }, select: { id: true } })) throw new DocflowPlanError('Проект не найден', 404);
  if (!await canSeeProject(String(actor.id), projectId, isAdminActor(actor))) throw new DocflowPlanError('Проект недоступен', 403);
  return { projectId, actorId: String(actor.id), prisma: p };
}
