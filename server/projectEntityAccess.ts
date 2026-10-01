import type { Express } from 'express';
import { getPrisma } from './context.js';
import { canSeeProject } from './routes/members.js';
import { isAdminActor, projectIdsOfRequest } from './projectAccess.js';

/** Проект определяется серверной записью, а не присланным рядом projectId. */
export type ProjectEntity = 'tag' | 'component' | 'system' | 'monoblock' | 'folder' | 'file' | 'formula' | 'constructor' | 'importBatch' | 'historyBatch' | 'chatGroup';
export interface EntityRef { kind: ProjectEntity; id: string }
const SAFE_ID = (id: unknown): id is string => typeof id === 'string' && !!id.trim() && id.length <= 200;

/** Ссылки в маршрутах и массовых операциях. Одновременно проверяется источник и цель. */
export function entityRefsOfRequest(path: string, body: any = {}, query: any = {}): EntityRef[] {
  const refs: EntityRef[] = [];
  const add = (kind: ProjectEntity, id: unknown) => { if (SAFE_ID(id)) refs.push({ kind, id }); };
  const route = path.replace(/\/+$/, '');
  const paths: [RegExp, ProjectEntity][] = [
    [/^\/api\/tags\/([^/]+)(?:\/|$)/i, 'tag'],
    [/^\/api\/(?:components|equipment\/component)\/([^/]+)(?:\/|$)/i, 'component'],
    [/^\/api\/systems\/([^/]+)(?:\/|$)/i, 'system'],
    [/^\/api\/equipment\/monoblock\/([^/]+)(?:\/|$)/i, 'monoblock'],
    [/^\/api\/folders\/([^/]+)(?:\/|$)/i, 'folder'],
    [/^\/api\/(?:office\/files|files|project-data\/files)\/([^/]+)(?:\/|$)/i, 'file'],
    [/^\/api\/formulas\/([^/]+)(?:\/|$)/i, 'formula'],
    [/^\/api\/constructor\/docs\/([^/]+)(?:\/|$)/i, 'constructor'],
    [/^\/api\/import-jobs\/([^/]+)\/cancel$/i, 'importBatch'],
    [/^\/api\/equipment\/import-undo\/([^/]+)$/i, 'historyBatch'],
    [/^\/api\/chat\/groups\/([^/]+)(?:\/|$)/i, 'chatGroup'],
  ];
  const reserved = new Set(['new', 'copy', 'chunk-size', 'bulk-metadata', 'generate']);
  for (const [pattern, kind] of paths) {
    const m = pattern.exec(route);
    if (m && !reserved.has(m[1].toLowerCase())) add(kind, decodeURIComponent(m[1]));
  }
  const pair = /^\/api\/components\/[^/]+\/tags\/([^/]+)$/i.exec(route);
  if (pair) add('tag', decodeURIComponent(pair[1]));
  // Ссылки на данные проектов также бывают в составе импорта, копирования и чата.
  for (const source of [body, query]) {
    for (const [key, kind] of Object.entries({ tagId: 'tag', componentId: 'component', elementId: 'component', linkedElementId: 'component', parentElementId: 'component', systemId: 'system', monoblockId: 'monoblock', folderId: 'folder', targetFolderId: 'folder', fileId: 'file', sourceFileId: 'file', formulaId: 'formula', groupId: 'chatGroup', toGroupId: 'chatGroup' }) as [string, ProjectEntity][]) add(kind, source?.[key]);
  }
  if (/^\/api\/tags\/bulk-metadata$/i.test(route) && Array.isArray(body.updates)) for (const u of body.updates.slice(0, 2000)) add('tag', u?.id);
  if (/^\/api\/files\/copy$/i.test(route) && Array.isArray(body.ids)) for (const id of body.ids) add('file', id);
  // Архивы и фоновые импорты несут ID внутри массивов: без этого общий слой
  // проверял только выбранный проект и пропускал связанный исходный объект.
  for (const id of Array.isArray(body.fileIds) ? body.fileIds : []) add('file', id);
  for (const id of Array.isArray(body.folderIds) ? body.folderIds : []) add('folder', id);
  if (/^\/api\/import-jobs\/?$/i.test(route) && Array.isArray(body.files)) {
    for (const file of body.files.slice(0, 100)) {
      add('file', file?.fileId);
      if (Array.isArray(file?.tagLinks)) for (const link of file.tagLinks.slice(0, 2000)) add('tag', link?.existingTagId);
    }
  }
  if (/^\/api\/equipment\/import-undo$/i.test(route)) add('historyBatch', body.batchId);
  for (const key of ['mainTagIds', 'additionalTagIds', 'tagIds']) if (Array.isArray(body[key])) for (const id of body[key]) add('tag', id);
  if (refs.length > 10000) throw new Error('Слишком много связанных записей');
  return [...new Map(refs.map(r => [`${r.kind}:${r.id}`, r])).values()];
}

export async function projectsOfEntity(prisma: any, ref: EntityRef): Promise<string[]> {
  const where = { id: ref.id };
  let rows: any[] = [];
  switch (ref.kind) {
    case 'tag': case 'folder': case 'formula': case 'constructor': case 'importBatch': case 'chatGroup': {
      const table = { tag: 'tag', folder: 'folder', formula: 'docFormula', constructor: 'constructorDoc', importBatch: 'importBatch', chatGroup: 'chatGroup' }[ref.kind];
      const row = await prisma[table].findUnique({ where, select: { projectId: true } });
      rows = row ? [row.projectId] : []; break;
    }
    case 'system': { const row = await prisma.equipmentSystem.findUnique({ where, select: { projectId: true } }); rows = row ? [row.projectId] : []; break; }
    case 'component': { const row = await prisma.componentElement.findUnique({ where, select: { monoblock: { select: { system: { select: { projectId: true } } } } } }); rows = row ? [row.monoblock.system.projectId] : []; break; }
    case 'monoblock': { const row = await prisma.monoblock.findUnique({ where, select: { system: { select: { projectId: true } } } }); rows = row ? [row.system.projectId] : []; break; }
    case 'file': { const row = await prisma.fileNode.findUnique({ where, select: { folder: { select: { projectId: true } } } }); rows = row?.folder ? [row.folder.projectId] : []; break; }
    case 'historyBatch': {
      const history = await prisma.equipmentHistory.findMany({ where: { batchId: ref.id }, select: { element: { select: { monoblock: { select: { system: { select: { projectId: true } } } } } } } });
      rows = history.map((h: any) => h.element.monoblock.system.projectId); break;
    }
  }
  return [...new Set<string>(rows.filter((id): id is string => typeof id === 'string' && !!id))];
}

/** Ставится после аутентификации, ДО всех обработчиков, в том числе ранних Office. */
export function registerProjectEntityGuard(app: Express): void {
  app.use('/api', async (req: any, res, next) => {
    const actor = req.authUser;
    if (!actor?.id || isAdminActor(actor)) return next();
    const path = req.baseUrl + req.path;
    if (/^\/api\/projects\/[^/]+\/(?:members|access-request)\/?$/i.test(path)) return next();
    try {
      const projectIds = new Set(projectIdsOfRequest(path, req.query, req.body));
      for (const ref of entityRefsOfRequest(path, req.body, req.query)) for (const pid of await projectsOfEntity(getPrisma(), ref)) projectIds.add(pid);
      for (const pid of projectIds) if (!(await canSeeProject(actor.id, pid, false))) return res.status(403).json({ error: 'Нет доступа к данным проекта. Попросите добавить вас в состав.' });
      next();
    } catch (_) { res.status(403).json({ error: 'Не удалось проверить доступ к данным проекта' }); }
  });
}
