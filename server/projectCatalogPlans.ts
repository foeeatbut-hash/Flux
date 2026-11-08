import { randomUUID } from 'node:crypto';
import { catalogDocumentProblem } from '../catalog/publication.js';
import { applyCatalogDifferences, catalogDifferences, type CatalogDifference } from '../shared/catalogProject.js';
import { familyDocument, projectFamilyRevision } from './projectCatalogData.js';
import { DocflowPlanError, saveDocflowPlan, loadDocflowPlan, parsedPlan, finishDocflowPlan } from './docflowPlans.js';

export interface ProjectCatalogScope { prisma: any; projectId: string; actorId: string }
interface FamilyChange {
  id: string; code: string; before: any; after: any; differences: CatalogDifference[];
  conflicts: CatalogDifference[]; action: string; sourceId?: string; sourceRevision?: string;
}
interface CatalogPlan { operation: string; rows: FamilyChange[] }
const stamp = (row: any) => row ? projectFamilyRevision(row) : null;
const parse = (s: string) => JSON.parse(s);

export async function validateProjectFamily(db: any, document: any) {
  const problem = catalogDocumentProblem('family', document);
  if (problem) throw new DocflowPlanError(problem, 400);
  if (Buffer.byteLength(JSON.stringify(document), 'utf8') > 512 * 1024) throw new DocflowPlanError('Позиция каталога слишком большая', 413);
  for (const param of document.params) {
    const value = param.default;
    if (value === undefined || value === '') continue;
    if (param.kind === 'number' && (!['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value)) || (param.min !== undefined && Number(value) < param.min) || (param.max !== undefined && Number(value) > param.max))) throw new DocflowPlanError(`Параметр «${param.label.ru}»: значение по умолчанию должно быть числом в допустимом диапазоне`, 400);
    if (param.kind === 'choice' && !(param.values || []).some((item: any) => item.code === value)) throw new DocflowPlanError(`Параметр «${param.label.ru}»: значение по умолчанию отсутствует среди вариантов`, 400);
  }
  const [cls, maker] = await Promise.all([
    db.catalogClass.findUnique({ where: { id: document.classId } }),
    db.catalogManufacturer.findUnique({ where: { id: document.manufacturerId } }),
  ]);
  if (!cls || !maker || [cls, maker].some(r => parse(r.dataJson || '{}').publicationState === 'archived')) throw new DocflowPlanError('Класс или изготовитель не найден в общем каталоге', 400);
}

function cleanDocument(document: any, id: string) {
  const value = { ...document, id };
  for (const key of Object.keys(value)) if (key.startsWith('_') || ['projectId', 'basedOnFamilyId', 'basedOnRevision', 'baseDataJson', 'overridesJson'].includes(key)) delete value[key];
  return value;
}

async function commonFamily(db: any, id: string) {
  const row = typeof id === 'string' ? await db.catalogFamily.findUnique({ where: { id } }) : null;
  if (!row || row.projectId !== null || row.deletedAt) throw new DocflowPlanError('Общая позиция не найдена', 404);
  return row;
}

/** План хранит закреплённую основу, а не ссылку на меняющийся общий документ. */
export async function planProjectFamily(scope: ProjectCatalogScope, input: any) {
  const { prisma: db, projectId, actorId } = scope;
  const operation = input.operation;
  if (!['take', 'create', 'edit', 'reset', 'update'].includes(operation)) throw new DocflowPlanError('Выберите действие каталога проекта', 400);
  let before: any = null, source: any = null;
  const id = ['take', 'create'].includes(operation) ? `pc-${randomUUID()}` : input.familyId;
  if (!id || typeof id !== 'string') throw new DocflowPlanError('Не указана позиция', 400);
  if (!['take', 'create'].includes(operation)) {
    before = await db.catalogFamily.findUnique({ where: { id } });
    if (!before || before.projectId !== projectId || before.deletedAt) throw new DocflowPlanError('Позиция недоступна в этом проекте', 403);
    if (input.expectedRevision !== stamp(before)) throw new DocflowPlanError('Позиция изменена коллегой. Перечитайте её перед предпросмотром.');
  }
  if (operation === 'take') {
    source = await commonFamily(db, input.familyId);
    if (await db.catalogFamily.findFirst({ where: { projectId, basedOnFamilyId: source.id } })) throw new DocflowPlanError('Эта общая позиция уже есть в каталоге проекта');
  } else if (['reset', 'update'].includes(operation)) {
    if (!before.basedOnFamilyId) throw new DocflowPlanError('У своей позиции нет общей основы', 400);
    source = await commonFamily(db, before.basedOnFamilyId);
  }
  const oldDocument = before ? familyDocument(before) : null;
  let base = operation === 'take' ? cleanDocument(familyDocument(source), id) : before?.basedOnFamilyId ? parse(before.baseDataJson) : {};
  let document: any;
  let conflicts: CatalogDifference[] = [];
  if (operation === 'take') document = base;
  else if (operation === 'reset') document = base;
  else if (operation === 'update') {
    const nextBase = cleanDocument(familyDocument(source), id);
    const changes = parse(before.overridesJson) as CatalogDifference[];
    const incoming = catalogDifferences(base, nextBase);
    conflicts = incoming.filter(change => changes.some(local => {
      const n = Math.min(local.path.length, change.path.length);
      return local.path.slice(0, n).join('\0') === change.path.slice(0, n).join('\0');
    }));
    document = applyCatalogDifferences(nextBase, changes);
    base = nextBase;
  } else document = cleanDocument(input.document, id);
  document = cleanDocument(document, id);
  if (before?.basedOnFamilyId || operation === 'take') base = cleanDocument(base, id);
  await validateProjectFamily(db, document);
  const after = {
    id, projectId, classId: document.classId, manufacturerId: document.manufacturerId,
    code: document.code, status: document.status || 'partial', dataJson: JSON.stringify(document),
    basedOnFamilyId: operation === 'take' ? source.id : before?.basedOnFamilyId || null,
    basedOnRevision: ['take', 'update'].includes(operation) ? stamp(source) : before?.basedOnRevision || null,
    baseDataJson: JSON.stringify(base), overridesJson: JSON.stringify(catalogDifferences(base, document)),
    edited: true, seedVersion: 0,
  };
  const change: FamilyChange = { id, code: document.code, before, after, differences: catalogDifferences(oldDocument, document), conflicts, action: operation,
    ...(source ? { sourceId: source.id, sourceRevision: stamp(source)! } : {}) };
  const payload: CatalogPlan = { operation, rows: [change] };
  const plan = await saveDocflowPlan(db, { projectId, actorId, kind: 'project-catalog', payload });
  return catalogPlanView(plan, payload);
}

function catalogPlanView(plan: any, payload: CatalogPlan) {
  return { id: plan.id, operation: payload.operation, expiresAt: plan.expiresAt,
    rows: payload.rows.map(row => ({ ...row, before: row.before ? familyDocument(row.before) : null, after: familyDocument(row.after) })) };
}

export async function applyProjectFamily(scope: ProjectCatalogScope, planId: string) {
  const { prisma: db, projectId, actorId } = scope;
  return db.$transaction(async (tx: any) => {
    const plan = await loadDocflowPlan(tx, planId, { projectId, actorId, kind: 'project-catalog' });
    if (plan.state === 'applied') return JSON.parse(plan.result);
    if (plan.state !== 'preview') throw new DocflowPlanError('План уже отменён');
    const payload = parsedPlan<CatalogPlan>(plan), changes = [];
    for (const change of payload.rows) {
      const current = await tx.catalogFamily.findUnique({ where: { id: change.id } });
      if (stamp(current) !== stamp(change.before)) throw new DocflowPlanError('Позиция изменена после предпросмотра. Постройте новый план.');
      if (current && current.projectId !== projectId) throw new DocflowPlanError('Позиция другого проекта недоступна', 403);
      if (change.sourceId && stamp(await commonFamily(tx, change.sourceId)) !== change.sourceRevision) throw new DocflowPlanError('Общий каталог изменился после предпросмотра. Проверьте различия снова.');
      await validateProjectFamily(tx, familyDocument(change.after));
      const now = new Date(Math.max(Date.now(), current ? new Date(current.updatedAt).getTime() + 1 : 0));
      const { id, ...data } = change.after;
      if (current) {
        const done = await tx.catalogFamily.updateMany({ where: { id, projectId, updatedAt: current.updatedAt }, data: { ...data, updatedById: actorId, updatedAt: now } });
        if (done.count !== 1) throw new DocflowPlanError('Позиция одновременно изменена коллегой');
      } else await tx.catalogFamily.create({ data: { id, ...data, updatedById: actorId, updatedAt: now } });
      changes.push({ id, afterVersion: stamp(await tx.catalogFamily.findUnique({ where: { id } })) });
    }
    const result = { changes };
    await finishDocflowPlan(tx, plan, 'applied', result);
    return result;
  }, { isolationLevel: 'Serializable' });
}

export async function projectFamilyUsed(db: any, id: string) {
  if (await db.selectionItem.count({ where: { familyId: id, deletedAt: null } })) return true;
  const bindings = await db.appSetting.findMany({ where: { key: { startsWith: 'equipment_catalog_binding:' } }, select: { value: true } });
  return bindings.some((row: any) => { try { return parse(row.value).modelId === id; } catch { return false; } });
}

export async function undoProjectFamily(scope: ProjectCatalogScope, planId: string) {
  const { prisma: db, projectId, actorId } = scope;
  await db.$transaction(async (tx: any) => {
    const plan = await loadDocflowPlan(tx, planId, { projectId, actorId, kind: 'project-catalog' });
    if (plan.state === 'undone') return;
    if (plan.state !== 'applied') throw new DocflowPlanError('Этот план ещё не применён');
    const payload = parsedPlan<CatalogPlan>(plan), result = parse(plan.result);
    for (const change of payload.rows) {
      const current = await tx.catalogFamily.findUnique({ where: { id: change.id } });
      const version = result.changes.find((x: any) => x.id === change.id)?.afterVersion;
      if (!current || current.projectId !== projectId || stamp(current) !== version) throw new DocflowPlanError('После применения позицию меняли. Отмена сохранит эти правки и потому недоступна.');
      if (!change.before && await projectFamilyUsed(tx, change.id)) throw new DocflowPlanError('Позиция уже используется в проекте. Отмена создания недоступна.');
      if (change.before) {
        const { id, createdAt, updatedAt, ...data } = change.before;
        const done = await tx.catalogFamily.updateMany({ where: { id, projectId, updatedAt: current.updatedAt }, data: { ...data, updatedAt: new Date(Math.max(Date.now(), new Date(current.updatedAt).getTime() + 1)) } });
        if (done.count !== 1) throw new DocflowPlanError('Позиция одновременно изменена');
      } else {
        const gone = await tx.catalogFamily.deleteMany({ where: { id: change.id, projectId, updatedAt: current.updatedAt } });
        if (gone.count !== 1) throw new DocflowPlanError('Позиция одновременно изменена');
      }
    }
    await finishDocflowPlan(tx, plan, 'undone', result);
  }, { isolationLevel: 'Serializable' });
}
