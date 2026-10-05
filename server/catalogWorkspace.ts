/** Черновики, права и атомарные публикации в общей БД. AppSetting — существующее хранилище JSON. */
import { createHash, randomUUID } from 'node:crypto';
import { catalogDocumentProblem, type CatalogAction, type CatalogDraft, type CatalogEntity, type CatalogGrant } from '../catalog/publication.js';
export const CATALOG_ENTITIES: Record<CatalogEntity, { model: string; fields: (d: any) => any }> = {
  family: { model: 'catalogFamily', fields: d => ({ classId: d.classId, manufacturerId: d.manufacturerId, code: d.code, status: d.status || 'draft', sort: Number(d.sort) || 0, edited: true, deletedAt: null }) },
  component: { model: 'catalogComponent', fields: d => ({ classId: d.classId, kind: d.kind || 'other', code: d.code }) },
  tagRule: { model: 'catalogTagRule', fields: d => ({ classId: d.classId, code: d.code }) },
  class: { model: 'catalogClass', fields: d => ({ code: d.code, sort: Number(d.sort) || 0 }) },
  manufacturer: { model: 'catalogManufacturer', fields: d => ({ name: d.name }) },
};
const PREFIX = 'catalog_draft:';
const slot = (entity: string, id: string) => `${PREFIX}${entity}:${id}`;
const settingId = (key: string) => `cat-${createHash('sha256').update(key).digest('hex')}`;
export const hashCatalogRow = (row: any) => row ? createHash('sha256').update(JSON.stringify({ dataJson: row.dataJson, deletedAt: row.deletedAt || null })).digest('hex') : '';
export const catalogFailure = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
export async function catalogSetting(db: any, key: string, fallback: any): Promise<any> {
  const row = await db.appSetting.findUnique({ where: { id: settingId(key) } });
  return row ? JSON.parse(row.value) : fallback;
}
export async function putCatalogSetting(db: any, key: string, value: any) {
  return db.appSetting.upsert({ where: { id: settingId(key) }, create: { id: settingId(key), key, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } });
}
export async function catalogGrants(db: any): Promise<CatalogGrant[]> { return catalogSetting(db, 'catalog_grants', []); }
export async function catalogAllowed(db: any, user: any, action: CatalogAction, document: any, can: (u: any, p: string) => boolean, entity?: CatalogEntity): Promise<boolean> {
  if (!user?.id || user.isActive === false) return false;
  if (can(user, `catalog.${action}`) || can(user, 'catalog.manage')) return true;
  if (user.validUntil && new Date(user.validUntil).getTime() < Date.now()) return false;
  return (await catalogGrants(db)).some(g => g.userId === user.id && g.action === action &&
    (!g.classId || g.classId === document?.classId || (entity === 'class' && g.classId === document?.id)) &&
    (!g.manufacturerId || g.manufacturerId === document?.manufacturerId || (entity === 'manufacturer' && g.manufacturerId === document?.id)));
}
export async function listCatalogDrafts(db: any): Promise<CatalogDraft[]> {
  const rows = await db.appSetting.findMany({ where: { key: { startsWith: PREFIX } }, take: 5000 });
  return rows.map((r: any) => JSON.parse(r.value));
}
/** Ожидаемая версия защищает черновик, исходный хеш — опубликованную запись. */
export async function stageCatalogDraft(db: any, entity: CatalogEntity, id: string, body: any, actorId: string, operation: 'save' | 'archive' = 'save', expected?: string): Promise<CatalogDraft> {
  if (!CATALOG_ENTITIES[entity]) catalogFailure(404, 'Неизвестный вид записи');
  const document = { ...body, id }; delete document._draftVersion; delete document._publishedHash; delete document.publicationState;
  const problem = operation === 'save' ? catalogDocumentProblem(entity, document) : '';
  if (problem) catalogFailure(400, problem);
  const key = slot(entity, id); const rid = settingId(key);
  const existing = await db.appSetting.findUnique({ where: { id: rid } });
  const prior: CatalogDraft | null = existing ? JSON.parse(existing.value) : null;
  if (prior && expected !== prior.revision) catalogFailure(409, 'Черновик изменён коллегой. Обновите рабочую область');
  if (!prior && expected) catalogFailure(409, 'Черновик уже опубликован или отменён. Обновите рабочую область');
  const current = await db[CATALOG_ENTITIES[entity].model].findUnique({ where: { id } });
  if (body?._publishedHash !== undefined && body._publishedHash !== hashCatalogRow(current)) catalogFailure(409, 'Опубликованная запись изменена. Обновите рабочую область');
  const draft: CatalogDraft = { entity, id, document, operation, before: prior?.before ?? (current ? JSON.parse(current.dataJson) : null), baseHash: prior?.baseHash ?? hashCatalogRow(current), revision: randomUUID(), state: 'draft', authorId: actorId, updatedAt: new Date().toISOString() };
  if (existing) {
    const claim = await db.appSetting.updateMany({ where: { id: rid, value: existing.value }, data: { value: JSON.stringify(draft) } });
    if (claim.count !== 1) catalogFailure(409, 'Черновик уже изменяется');
  } else await db.appSetting.create({ data: { id: rid, key, value: JSON.stringify(draft) } });
  return draft;
}
/** Серийный общий номер: блокировка строки первой защищает весь пакет публикации. */
export async function publishCatalogDrafts(prisma: any, selections: Array<{ entity: CatalogEntity; id: string; revision: string }>, user: any, can: (u: any, p: string) => boolean, read: (db: any) => Promise<any>) {
  if (!Array.isArray(selections) || !selections.length || selections.length > 2000) catalogFailure(400, 'Выберите от 1 до 2000 черновиков');
  if (selections.some(s => !s || !CATALOG_ENTITIES[s.entity] || typeof s.id !== 'string' || typeof s.revision !== 'string') || new Set(selections.map(s => `${s.entity}:${s.id}`)).size !== selections.length) catalogFailure(400, 'Пакет содержит некорректные или повторяющиеся записи');
  await putCatalogSettingIfMissing(prisma, 'catalog_publication', { number: 0 });
  return prisma.$transaction(async (db: any) => {
    const headKey = settingId('catalog_publication');
    const head = await db.appSetting.findUnique({ where: { id: headKey } });
    const priorHead = JSON.parse(head.value); const number = Number(priorHead.number || 0) + 1;
    const claimed = await db.appSetting.updateMany({ where: { id: headKey, value: head.value }, data: { value: JSON.stringify({ number, token: randomUUID(), at: new Date().toISOString(), authorId: user.id }) } });
    if (claimed.count !== 1) catalogFailure(409, 'Каталог уже публикуется. Повторите после обновления');
    const policy = await catalogSetting(db, 'catalog_policy', { requireSecondReview: false });
    const drafts: CatalogDraft[] = [];
    for (const selection of selections) {
      const draft = await catalogSetting(db, slot(selection.entity, selection.id), null) as CatalogDraft | null;
      if (!draft || draft.revision !== selection.revision) catalogFailure(409, 'Черновик изменён или уже опубликован');
      if (!await catalogAllowed(db, user, 'publish', draft.document, can, draft.entity)) catalogFailure(403, 'Нет права публикации в этой области каталога');
      if (policy.requireSecondReview && ['family','component'].includes(draft.entity) && (!draft.reviewedById || draft.reviewedById === draft.authorId)) catalogFailure(409, 'Для модели нужна проверка другим сотрудником с правом публикации');
      const current = await db[CATALOG_ENTITIES[draft.entity].model].findUnique({ where: { id: draft.id } });
      if (current && !await catalogAllowed(db, user, 'publish', JSON.parse(current.dataJson), can, draft.entity)) catalogFailure(403, 'Нет права публикации исходной области записи');
      if (hashCatalogRow(current) !== draft.baseHash) catalogFailure(409, `Запись ${draft.document.code || draft.id} изменилась после начала правки. Сравните и пересоздайте черновик`);
      drafts.push(draft);
    }
    const catalog = await read(db);
    const sets: Record<string, Set<string>> = Object.fromEntries(['classes', 'manufacturers', 'families', 'components'].map(k => [k, new Set(catalog[k].map((r: any) => r.id))]));
    for (const d of drafts) {
      const key = { class: 'classes', manufacturer: 'manufacturers', family: 'families', component: 'components', tagRule: '' }[d.entity];
      if (key) d.operation === 'archive' ? sets[key].delete(d.id) : sets[key].add(d.id);
    }
    for (const d of drafts) if (d.operation === 'save') {
      const problem = catalogDocumentProblem(d.entity, d.document); if (problem) catalogFailure(400, problem);
      if (['family', 'component', 'tagRule'].includes(d.entity) && !sets.classes.has(d.document.classId)) catalogFailure(409, 'Сначала включите в публикацию вид оборудования');
      if (d.entity === 'family' && !sets.manufacturers.has(d.document.manufacturerId)) catalogFailure(409, 'В публикации отсутствует изготовитель');
      if (['family', 'component'].includes(d.entity)) {
        if (d.document.sections?.some((section: any) => section.source?.physicalPage && !section.source?.assetId)) catalogFailure(409, 'Иллюстрации справочника ещё не загружены. Завершите загрузку документации перед публикацией.');
        const refs = [d.document.catalog, ...(d.document.documents || []), ...(d.document.sections || []).map((s: any) => s.source), ...(d.document.tables || []).flatMap((t: any) => [t.source, ...t.rows.map((r: any) => r.source)])];
        for (const ref of refs) if (ref?.assetId) {
          const asset = await catalogSetting(db, `catalog_asset:${ref.assetId}`, null);
          if (!asset?.complete) catalogFailure(409, 'Исходный файл ещё не загружен полностью');
          if (!await catalogAllowed(db, user, 'publish', asset.scope, can)) catalogFailure(403, 'Нет права публикации этого исходника');
        }
      }

    }
    // Запрет архива справочника, на который остаются живые ссылки.
    const effective = new Map(catalog.families.map((f: any) => [f.id, f]));
    for (const d of drafts.filter(d => d.entity === 'family')) d.operation === 'archive' ? effective.delete(d.id) : effective.set(d.id, d.document);
    for (const f of effective.values() as Iterable<any>) if (!sets.classes.has(f.classId) || !sets.manufacturers.has(f.manufacturerId)) catalogFailure(409, 'Нельзя архивировать вид или изготовителя используемых моделей');
    const effectiveComponents = new Map<string, any>(catalog.components.map((c: any) => [c.id, c]));
    const effectiveRules = new Map<string, any>(catalog.tagRules.map((r: any) => [r.id, r]));
    for (const d of drafts) {
      const target = d.entity === 'component' ? effectiveComponents : d.entity === 'tagRule' ? effectiveRules : null;
      if (target) d.operation === 'archive' ? target.delete(d.id) : target.set(d.id, d.document);
    }
    for (const c of effectiveComponents.values()) {
      if (!sets.classes.has(c.classId) || (c.classIds || []).some((id: string) => !sets.classes.has(id)) || (c.manufacturerId && !sets.manufacturers.has(c.manufacturerId)) || (c.familyIds || []).some((id: string) => !sets.families.has(id))) catalogFailure(409, 'Архивирование нарушит применимость комплектующих');
    }
    for (const r of effectiveRules.values()) if (!sets.classes.has(r.classId)) catalogFailure(409, 'Сначала измените правила тегов этого вида');
    for (const t of await db.blankTemplate.findMany()) if (t.classId && !sets.classes.has(t.classId)) catalogFailure(409, 'Вид оборудования используется шаблоном бланка');
    for (const learned of await db.catalogLearn.findMany()) if (!sets.classes.has(learned.classId) || !sets.families.has(learned.familyId)) catalogFailure(409, 'Запись используется сохранённым правилом подбора; сначала отмените обучение');
    for (const d of drafts) {
      const model = db[CATALOG_ENTITIES[d.entity].model];
      const before = await model.findUnique({ where: { id: d.id } });
      if (before) await db.catalogRevision.create({ data: { entity: d.entity, entityId: d.id, action: 'before-publication', snapshotJson: JSON.stringify(before), userId: user.id } });
      if (d.operation === 'archive') {
        if (before && d.entity === 'family') await model.update({ where: { id: d.id }, data: { deletedAt: new Date(), edited: true } });
        else if (before) await model.update({ where: { id: d.id }, data: { dataJson: JSON.stringify({ ...JSON.parse(before.dataJson), publicationState: 'archived' }) } });
      } else {
        const data = { ...CATALOG_ENTITIES[d.entity].fields(d.document), dataJson: JSON.stringify(d.document), ...(d.entity === 'family' ? { updatedById: user.id } : {}) };
        await model.upsert({ where: { id: d.id }, create: { id: d.id, ...data }, update: data });
      }
      await db.catalogRevision.create({ data: { entity: d.entity, entityId: d.id, action: 'published', snapshotJson: JSON.stringify({ id: d.id, publication: number, operation: d.operation, dataJson: JSON.stringify(d.document) }), userId: user.id } });
      await db.appSetting.delete({ where: { id: settingId(slot(d.entity, d.id)) } });
    }
    return { ok: true, publication: number, count: drafts.length };
  }, { maxWait: 20000, timeout: 120000 });
}
async function putCatalogSettingIfMissing(db: any, key: string, value: any) {
  return db.appSetting.upsert({ where: { id: settingId(key) }, create: { id: settingId(key), key, value: JSON.stringify(value) }, update: {} });
}
export async function discardCatalogDraft(db: any, d: CatalogDraft) {
  const result = await db.appSetting.deleteMany({ where: { id: settingId(slot(d.entity, d.id)), value: JSON.stringify(d) } });
  if (result.count !== 1) catalogFailure(409, 'Черновик изменён коллегой');
}
