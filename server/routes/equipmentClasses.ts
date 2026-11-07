import type { Express, Request } from 'express';
import { getPrisma, sendError } from '../context.js';
import { actorMay, isAdminActor } from '../projectAccess.js';
import { canSeeProject, roleGrantsOf } from './members.js';
import { emitEntitiesChanged } from '../entityChanged.js';
import { planEquipmentClasses, applyEquipmentClasses, undoEquipmentClasses, lastEquipmentClassPlan } from '../equipmentClasses.js';
import { DocflowPlanError } from '../docflowPlans.js';

/** Все адреса проверяют проект и право сами: общий страж не распознаёт этот префикс. */
async function scope(req: Request) {
  const actor = (req as any).authUser;
  if (!(await actorMay(actor, roleGrantsOf, 'equipment.manage'))) throw new DocflowPlanError('Нужно право «Правка характеристик оборудования»', 403);
  const projectId = String(req.params.projectId);
  if (!(await getPrisma().project.findUnique({ where: { id: projectId }, select: { id: true } }))) throw new DocflowPlanError('Проект не найден', 404);
  if (!(await canSeeProject(actor.id, projectId, isAdminActor(actor)))) throw new DocflowPlanError('Проект недоступен', 403);
  return { projectId, actorId: String(actor.id) };
}

export function registerEquipmentClassRoutes(app: Express) {
  const base = '/api/equipment/projects/:projectId/catalog-classes';
  for (const action of ['plan', 'apply', 'undo', 'last'] as const) {
    const handler = async (req: Request, res: any) => {
      try {
        const { projectId, actorId } = await scope(req);
        const p = getPrisma();
        const answer = action === 'plan' ? await planEquipmentClasses(p, projectId, actorId, req.body)
          : action === 'apply' ? await applyEquipmentClasses(p, projectId, actorId, req.body?.planId)
          : action === 'undo' ? await undoEquipmentClasses(p, projectId, actorId, req.body?.planId)
          : await lastEquipmentClassPlan(p, projectId, actorId);
        if (action === 'apply' || action === 'undo') {
          const plan = await p.docflowPlan.findUnique({ where: { id: req.body.planId } });
          const ids = JSON.parse(plan.result).changes.map((r: any) => r.tagId);
          emitEntitiesChanged('tag', ids, req);
        }
        res.json(answer);
      } catch (err: any) {
        if (['P2002', 'P2034', 'P1008', 'P2028'].includes(err?.code)) return res.status(409).json({ error: 'Данные изменились одновременно с планом. Обновите предпросмотр.' });
        sendError(res, err, err.status || 500);
      }
    };
    if (action === 'last') app.get(`${base}/${action}`, handler);
    else app.post(`${base}/${action}`, handler);
  }
}
