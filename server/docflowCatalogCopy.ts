import { createHash } from 'node:crypto';
import { catalogDifferences } from '../shared/catalogProject.js';
import { familyDocument, projectFamilyRows } from './projectCatalogData.js';
import { DocflowSettingsConflict } from './docflowSettings.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ownId = (projectId: string, sourceId: string) => `pc-${hash([projectId, sourceId]).slice(0, 40)}`;
const state = (r: any) => r && ({ id: r.id, projectId: r.projectId, basedOnFamilyId: r.basedOnFamilyId, basedOnRevision: r.basedOnRevision, baseDataJson: r.baseDataJson, overridesJson: r.overridesJson, classId: r.classId, manufacturerId: r.manufacturerId, code: r.code, dataJson: r.dataJson, status: r.status, sort: r.sort, seedVersion: r.seedVersion, edited: r.edited, updatedById: r.updatedById, deletedAt: r.deletedAt, updatedAt: r.updatedAt });
const remap = (value: any, ids: Map<string, string>, key = ''): any => {
  if (typeof value === 'string' && (key === 'familyId' || key === 'familyIds')) return ids.get(value) || value;
  if (Array.isArray(value)) return value.map(v => remap(v, ids, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, ids, k)]));
  return value;
};
export async function planCatalogCopy(db: any, sourceId: string, targetId: string) {
  if (!sourceId || sourceId === targetId) throw new DocflowSettingsConflict('Выберите другой проект-источник', 400);
  const [source, target] = await Promise.all([projectFamilyRows(db, sourceId), projectFamilyRows(db, targetId)]);
  if (source.length > 1000 || target.length > 1000) throw new DocflowSettingsConflict('Слишком много позиций каталога для переноса', 413);
  const ids = new Map<string, string>();
  for (const row of source) {
    const matched = row.basedOnFamilyId && target.find((r: any) => r.basedOnFamilyId === row.basedOnFamilyId);
    ids.set(row.id, matched?.id || ownId(targetId, row.id));
  }
  const sourceIds = new Set(source.map((r: any) => r.id));
  const global = await db.catalogFamily.findMany({ where: { projectId: null }, select: { id: true } });
  const globals = new Set(global.map((r: any) => r.id));
  const changes: any[] = [];
  for (const row of source) {
    if (row.basedOnFamilyId && (!globals.has(row.basedOnFamilyId) || !row.basedOnRevision)) throw new DocflowSettingsConflict('Общая основа модели недоступна', 409);
    const id = ids.get(row.id)!; const before = target.find((r: any) => r.id === id) || null;
    const collision = await db.catalogFamily.findUnique({ where: { id } });
    if (collision && (!before || collision.projectId !== targetId)) throw new DocflowSettingsConflict('Идентификатор модели уже занят', 409);
    const doc = remap(familyDocument(row), ids); doc.id = id;
    const inspect = (v: any, key = '') => {
      if (typeof v === 'string' && (key === 'familyId' || key === 'familyIds') && !sourceIds.has(v) && !globals.has(v) && ![...ids.values()].includes(v)) throw new DocflowSettingsConflict('Модель ссылается на недоступную позицию каталога', 409);
      if (Array.isArray(v)) v.forEach(x => inspect(x, key)); else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => inspect(x, k));
    }; inspect(doc);
    let base: any = {}; try { base = remap(JSON.parse(row.baseDataJson || '{}'), ids); if (row.basedOnFamilyId) base.id = id; inspect(base); } catch { throw new DocflowSettingsConflict('Снимок основы повреждён', 409); }
    const data = { projectId: targetId, basedOnFamilyId: row.basedOnFamilyId, basedOnRevision: row.basedOnRevision, baseDataJson: JSON.stringify(base), overridesJson: JSON.stringify(catalogDifferences(base, doc)), classId: row.classId, manufacturerId: row.manufacturerId, code: row.code, dataJson: JSON.stringify(doc), status: row.status, sort: row.sort, seedVersion: 0, edited: true, deletedAt: null };
    const comparable = (r: any) => r && Object.fromEntries(Object.keys(data).map(k => [k, r[k]]));
    if (JSON.stringify(comparable(before)) !== JSON.stringify(data)) changes.push({ id, before: state(before), data });
  }
  return { changes, token: hash({ source: source.map(state), target: target.map(state), globals: [...globals].sort() }) };
}
export async function applyCatalogCopy(tx: any, plan: Awaited<ReturnType<typeof planCatalogCopy>>, actorId: string) {
  const undo = [];
  for (const change of plan.changes) {
    if (change.before) {
      const claim = await tx.catalogFamily.updateMany({ where: { id: change.id, projectId: change.data.projectId, updatedAt: new Date(change.before.updatedAt) }, data: { ...change.data, updatedById: actorId, updatedAt: new Date(Math.max(Date.now(), new Date(change.before.updatedAt).getTime() + 1)) } });
      if (claim.count !== 1) throw new DocflowSettingsConflict('Каталог изменился после предпросмотра');
    } else {
      try { await tx.catalogFamily.create({ data: { id: change.id, ...change.data, updatedById: actorId } }); }
      catch (e: any) { if (e.code === 'P2002') throw new DocflowSettingsConflict('Каталог изменился после предпросмотра'); throw e; }
    }
    const row = await tx.catalogFamily.findUnique({ where: { id: change.id } });
    undo.push({ id: row.id, before: change.before, after: hash(state(row)) });
  }
  return undo;
}
export async function undoCatalogCopy(tx: any, projectId: string, entries: any[]) {
  for (const entry of entries) {
    const row = await tx.catalogFamily.findUnique({ where: { id: entry.id } });
    if (!row || row.projectId !== projectId || hash(state(row)) !== entry.after) throw new DocflowSettingsConflict('Каталог проекта изменён после переноса; отмена закрыта');
    if (!entry.before) {
      const used = await tx.selectionItem.findFirst({ where: { familyId: entry.id, deletedAt: null }, select: { id: true } });
      const bindings = await tx.appSetting.findMany({ where: { key: { startsWith: 'equipment_catalog_binding:' }, value: { contains: entry.id } }, select: { value: true } });
      if (used || bindings.some((b: any) => { try { return JSON.parse(b.value).modelId === entry.id; } catch { return true; } })) throw new DocflowSettingsConflict('Перенесённая модель уже используется; отмена закрыта');
    }
  }
  for (const entry of entries) {
    const current = await tx.catalogFamily.findUnique({ where: { id: entry.id } });
    if (!current || hash(state(current)) !== entry.after) throw new DocflowSettingsConflict('Каталог проекта изменён после переноса');
    if (!entry.before) { const result = await tx.catalogFamily.deleteMany({ where: { id: entry.id, projectId, updatedAt: current.updatedAt } }); if (result.count !== 1) throw new DocflowSettingsConflict('Каталог проекта изменён после переноса'); }
    else { const { id, ...data } = entry.before; const result = await tx.catalogFamily.updateMany({ where: { id, projectId, updatedAt: current.updatedAt }, data: { ...data, updatedAt: new Date(Math.max(Date.now(), new Date(current.updatedAt).getTime() + 1)), deletedAt: data.deletedAt ? new Date(data.deletedAt) : null } }); if (result.count !== 1) throw new DocflowSettingsConflict('Каталог проекта изменён после переноса'); }
  }
}
