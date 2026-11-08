import type { Express, Request, Response } from 'express';
import { getPrisma, sendError, broadcast } from '../context.js';
import { actorMay, isAdminActor, isRealProjectId } from '../projectAccess.js';
import { canSeeProject, roleGrantsOf } from './members.js';
import { ensureCatalog } from './catalog.js';
import { DocflowPlanError } from '../docflowPlans.js';
import { catalogForProject, projectFamilyRevision, projectFamilyRows } from '../projectCatalogData.js';
import { planProjectFamily, applyProjectFamily, undoProjectFamily, type ProjectCatalogScope } from '../projectCatalogPlans.js';
import { readInBatches } from '../batchRead.js';

async function projectScope(req: Request, write = false): Promise<ProjectCatalogScope> {
  const actor = (req as any).authUser;
  if (!actor?.id) throw new DocflowPlanError('Нужно войти в программу', 401);
  if (write && !await actorMay(actor, roleGrantsOf, 'catalog.project')) throw new DocflowPlanError('Нужно право «Каталог проекта», которое выдаёт администратор в Сотрудниках', 403);
  const projectId = req.method === 'GET' ? req.query.projectId : req.body?.projectId;
  if (!isRealProjectId(projectId) || projectId.length > 100) throw new DocflowPlanError('Выберите проект', 400);
  const prisma = getPrisma();
  if (!await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })) throw new DocflowPlanError('Проект не найден', 404);
  if (!await canSeeProject(actor.id, projectId, isAdminActor(actor))) throw new DocflowPlanError('Проект недоступен', 403);
  await ensureCatalog(prisma);
  return { prisma, projectId, actorId: actor.id };
}

async function viewOf(scope: ProjectCatalogScope, actor: any, source: any = 'project') {
  const { prisma, projectId, actorId } = scope;
  if (!['project', 'common', 'effective'].includes(source)) throw new DocflowPlanError('Неизвестный источник каталога', 400);
  const catalog = await catalogForProject(prisma, projectId, source);
  const rows = await projectFamilyRows(prisma, projectId);
  const bases = rows.filter((row: any) => row.basedOnFamilyId).map((row: any) => row.basedOnFamilyId);
  const common = await readInBatches<any>(bases, ids => prisma.catalogFamily.findMany({ where: { id: { in: ids }, projectId: null, deletedAt: null } }));
  const byId = new Map(common.map((row: any) => [row.id, row]));
  const last = await prisma.docflowPlan.findFirst({ where: { projectId, actorId, kind: 'project-catalog', state: 'applied', expiresAt: { gt: new Date() } }, orderBy: { updatedAt: 'desc' }, select: { id: true } });
  return { ...catalog, canEdit: await actorMay(actor, roleGrantsOf, 'catalog.project'), lastPlanId: last?.id || null,
    rows: rows.map((row: any) => ({ id: row.id, code: row.code, basedOnFamilyId: row.basedOnFamilyId, basedOnRevision: row.basedOnRevision,
      revision: projectFamilyRevision(row), overrides: JSON.parse(row.overridesJson),
      updateAvailable: !!row.basedOnFamilyId && !!byId.get(row.basedOnFamilyId) && projectFamilyRevision(byId.get(row.basedOnFamilyId)) !== row.basedOnRevision })) };
}

export function registerProjectCatalogRoutes(app: Express) {
  const handle = (write: boolean, fn: (req: Request, res: Response, scope: ProjectCatalogScope) => Promise<any>) => async (req: Request, res: Response) => {
    try { await fn(req, res, await projectScope(req, write)); }
    catch (err: any) {
      if (['P2002', 'P2034'].includes(err.code)) return res.status(409).json({ error: 'Каталог проекта одновременно изменён коллегой. Обновите список и проверьте новый план.' });
      sendError(res, err, err.status || 500);
    }
  };
  app.get('/api/catalog/project', handle(false, async (req, res, scope) => res.json(await viewOf(scope, (req as any).authUser, req.query.source || 'project'))));
  app.post('/api/catalog/project/plan', handle(true, async (req, res, scope) => res.json(await planProjectFamily(scope, req.body))));
  app.post('/api/catalog/project/apply', handle(true, async (req, res, scope) => {
    await applyProjectFamily(scope, req.body?.planId); broadcast('catalog:changed', { projectId: scope.projectId });
    res.json(await viewOf(scope, (req as any).authUser));
  }));
  app.post('/api/catalog/project/undo', handle(true, async (req, res, scope) => {
    await undoProjectFamily(scope, req.body?.planId); broadcast('catalog:changed', { projectId: scope.projectId });
    res.json(await viewOf(scope, (req as any).authUser));
  }));
}
