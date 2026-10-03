import type { Express, Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { getPrisma, sendError, broadcast } from '../context.js';
import type { Catalog, Component } from '../../catalog/model.js';
import { overlayCatalog } from '../../catalog/publication.js';
import { planCatalogSpreadsheet, type CatalogImportRow } from '../../catalog/spreadsheet.js';
import { manufacturerKey } from '../../catalog/componentCatalog.js';
import { catalogAllowed, hashCatalogRow, listCatalogDrafts, stageCatalogDraft } from '../catalogWorkspace.js';

interface Deps {
  ensure: (prisma: any) => Promise<void>;
  readCatalog: (prisma: any) => Promise<Catalog>;
  can: (user: any, permission: string) => boolean;
}
const userOf = (req: Request) => (req as any).authUser || null;
const actor = (req: Request) => String(userOf(req)?.id || '');
const json = (v: string) => JSON.parse(v);
const importedManufacturerId = (name: string) => `mf-import-${createHash('sha256').update(manufacturerKey(name), 'utf8').digest('hex').slice(0, 24)}`;
const errorStatus = (err: any) => err?.status || (err?.code === 'P2002' || err?.code === 'P2025' ? 409 : 500);
const planKey = (id: string) => `catalog_sheet_plan:${id}`;
const batchKey = (id: string) => `catalog_sheet_batch:${id}`;
const draftKey = (entity: string, id: string) => `catalog_draft:${entity}:${id}`;

async function readWorkspace(db: any, deps: Deps, user: any) {
  const allDrafts = await listCatalogDrafts(db);
  const visible = [];
  for (const draft of allDrafts) {
    if (draft.authorId === user.id || await catalogAllowed(db, user, 'import', draft.document, deps.can)) visible.push(draft);
  }
  return { catalog: overlayCatalog(await deps.readCatalog(db), visible), drafts: visible };
}

/** Проверяет все старые и новые области, включая дополнительные классы/семейства. */
async function canImportComponent(db: any, user: any, component: Component, catalog: Catalog, deps: Deps): Promise<boolean> {
  const contexts = new Map<string, { classId: string; manufacturerId?: string }>();
  const classIds = [...new Set([component.classId, ...(component.classIds || [])].filter(Boolean))];
  const makerIds = [...new Set([
    component.manufacturerId,
    ...(component.manufacturer ? catalog.manufacturers.filter(m => manufacturerKey(m.name) === manufacturerKey(component.manufacturer)).map(m => m.id) : []),
  ].filter(Boolean))] as string[];
  for (const classId of classIds) {
    if (makerIds.length) for (const manufacturerId of makerIds) contexts.set(`${classId}|${manufacturerId}`, { classId, manufacturerId });
    else contexts.set(`${classId}|`, { classId });
  }
  for (const familyId of component.familyIds || []) {
    const family = catalog.families.find(f => f.id === familyId);
    if (family) contexts.set(`${family.classId}|${family.manufacturerId}`, { classId: family.classId, manufacturerId: family.manufacturerId });
  }
  for (const document of contexts.values()) {
    if (!await catalogAllowed(db, user, 'import', document, deps.can)) return false;
  }
  return contexts.size > 0;
}

function publicRows(rows: CatalogImportRow[]) {
  return rows.map(({ component, before, ...row }) => row);
}
function counts(rows: CatalogImportRow[]) {
  return Object.fromEntries(['new', 'update', 'same', 'conflict', 'error'].map(action => [action, rows.filter(r => r.action === action).length]));
}

/** Import only creates editor drafts. Published catalog records are changed by workspace/publish. */
export function registerCatalogSpreadsheetRoutes(app: Express, deps: Deps): void {
  const handle = (fn: (req: Request, res: Response, db: any) => Promise<any>) => async (req: Request, res: Response) => {
    try {
      if (!userOf(req)?.id) return res.status(401).json({ error: 'Нужно войти в программу' });
      const db = getPrisma(); await deps.ensure(db); await fn(req, res, db);
    } catch (err: any) { sendError(res, err, errorStatus(err)); }
  };

  app.post('/api/catalog/spreadsheet/plan', handle(async (req, res, db) => {
    const user = userOf(req);
    const { catalog, drafts: visibleDrafts } = await readWorkspace(db, deps, user);
    const inputSize = JSON.stringify(req.body?.sheets || '').length;
    if (inputSize > 20_000_000) return res.status(413).json({ error: 'Данные таблицы превышают 20 МБ после разбора' });
    const rows = planCatalogSpreadsheet(req.body?.sheets, catalog, {
      classId: String(req.body?.classId || ''), policy: req.body?.policy || 'fill', mapping: req.body?.mapping,
    });
    const id = randomUUID(); const expiresAt = Date.now() + 60 * 60 * 1000;
    const manufacturerSnapshots = Object.fromEntries([...new Set(rows.filter(r => r.component).map(r => manufacturerKey(r.component!.manufacturer)))].map(key => {
      const maker = catalog.manufacturers.find(m => manufacturerKey(m.name) === key);
      const draft = maker && visibleDrafts.find(d => d.entity === 'manufacturer' && d.id === maker.id);
      return [key, { id: maker?.id || null, revision: draft?.revision || null }];
    }));
    const componentSnapshots: Record<string, string> = {};
    for (const row of rows) if (row.component && !(row.component.id in componentSnapshots)) {
      componentSnapshots[row.component.id] = hashCatalogRow(await db.catalogComponent.findUnique({ where: { id: row.component.id } }));
    }
    await db.appSetting.create({ data: { key: planKey(id), userId: user.id, value: JSON.stringify({ rows, classId: String(req.body?.classId || ''), expiresAt, manufacturerSnapshots, componentSnapshots }) } });
    res.json({ planId: id, expiresAt, rows: publicRows(rows), counts: counts(rows) });
  }));

  app.post('/api/catalog/spreadsheet/apply', handle(async (req, res, db) => {
    const user = userOf(req);
    const saved = await db.appSetting.findFirst({ where: { key: planKey(String(req.body?.planId || '')), userId: user.id } });
    if (!saved) return res.status(404).json({ error: 'План не найден. Создайте предпросмотр ещё раз' });
    const plan = json(saved.value);
    if (plan.batchId) return res.json({ batchId: plan.batchId, count: plan.count, draft: true });
    if (plan.expiresAt < Date.now()) return res.status(409).json({ error: 'Предпросмотр устарел. Разберите файл ещё раз' });
    const indices = req.body?.indices;
    if (!Array.isArray(indices) || indices.some((i: any) => !Number.isInteger(i) || i < 0 || i >= plan.rows.length)) return res.status(400).json({ error: 'Выберите строки предпросмотра' });
    const rows: CatalogImportRow[] = [...new Set<number>(indices)].map(i => plan.rows[i]).filter(r => r.component && ['new', 'update'].includes(r.action));
    if (!rows.length) return res.status(400).json({ error: 'Нет выбранных изменений' });

    const batchId = randomUUID();
    await db.$transaction(async (tx: any) => {
      const claim = await tx.appSetting.updateMany({ where: { id: saved.id, value: saved.value }, data: { value: JSON.stringify({ ...plan, batchId, count: rows.length }) } });
      if (claim.count !== 1) throw Object.assign(new Error('Эту партию уже записывают. Обновите каталог'), { status: 409 });

      const latestDrafts = await listCatalogDrafts(tx);
      const { catalog, drafts: visibleDrafts } = await readWorkspace(tx, deps, user);
      for (const [key, expected] of Object.entries(plan.manufacturerSnapshots || {}) as Array<[string, { id: string | null; revision: string | null }]>) {
        const maker = catalog.manufacturers.find(m => manufacturerKey(m.name) === key);
        const makerDraft = maker && latestDrafts.find(d => d.entity === 'manufacturer' && d.id === maker.id);
        if ((maker?.id || null) !== expected.id || (makerDraft?.revision || null) !== expected.revision) {
          throw Object.assign(new Error(`Изготовитель «${key}» изменён после предпросмотра. Сформируйте план ещё раз`), { status: 409 });
        }
      }
      const mutations: any[] = [];
      const manufacturerByKey = new Map<string, any>(catalog.manufacturers.map((m: any) => [manufacturerKey(m.name), m]));
      const stagedManufacturers = new Set<string>();
      const componentsToStage: Array<{ row: CatalogImportRow; component: Component; priorDraft: any }> = [];

      for (const row of rows) {
        const incoming = row.component!;
        const published = await tx.catalogComponent.findUnique({ where: { id: incoming.id } });
        if (hashCatalogRow(published) !== (plan.componentSnapshots?.[incoming.id] || '')) {
          throw Object.assign(new Error(`Модель ${incoming.code} изменена после предпросмотра. Сформируйте план ещё раз`), { status: 409 });
        }
        const current = catalog.components.find(c => c.id === incoming.id) || null;
        // Includes an optimistic check against both published data and any visible draft revision.
        if (JSON.stringify(current) !== JSON.stringify(row.before || null)) {
          throw Object.assign(new Error(current && !row.before
            ? `Ключ модели ${incoming.id} уже занят. Создайте новый предпросмотр`
            : `Модель ${incoming.code} или её черновик изменены после предпросмотра. Сформируйте план ещё раз`), { status: 409 });
        }
        const currentDraft = latestDrafts.find(d => d.entity === 'component' && d.id === incoming.id);
        const expected = (row.before as any)?._draftVersion;
        if ((currentDraft?.revision || undefined) !== expected) throw Object.assign(new Error(`Черновик модели ${incoming.code} изменён. Сформируйте план ещё раз`), { status: 409 });

        const makerName = String(incoming.manufacturer || '').trim();
        const makerKey = manufacturerKey(makerName);
        let manufacturer = manufacturerByKey.get(makerKey);
        if (!manufacturer) {
          const id = importedManufacturerId(makerName);
          const collision = catalog.manufacturers.find(m => m.id === id);
          if (collision && manufacturerKey(collision.name) !== makerKey) throw Object.assign(new Error(`Не удалось безопасно назначить идентификатор изготовителя «${makerName}»`), { status: 409 });
          manufacturer = collision || { id, name: makerName, shortName: makerName };
          manufacturerByKey.set(makerKey, manufacturer);
        }
        incoming.manufacturerId = manufacturer.id;

        if (!await canImportComponent(tx, user, incoming, catalog, deps) || (current && !await canImportComponent(tx, user, current, catalog, deps))) {
          throw Object.assign(new Error(`Нет права импорта для области модели «${incoming.code}»`), { status: 403 });
        }
        if (!catalog.manufacturers.some(m => m.id === manufacturer.id) && !stagedManufacturers.has(manufacturer.id)) {
          const vendorDocument = { id: manufacturer.id, name: makerName, shortName: makerName };
          const anyPriorDraft = latestDrafts.find(d => d.entity === 'manufacturer' && d.id === manufacturer.id) || null;
          const priorDraft = visibleDrafts.find(d => d.entity === 'manufacturer' && d.id === manufacturer.id) || null;
          if (anyPriorDraft && !priorDraft) throw Object.assign(new Error(`Нет права изменять черновик изготовителя «${makerName}»`), { status: 403 });
          const vendorExpected = priorDraft?.revision;
          // Component checks above validate the maker + every associated class grant.
          const staged = await stageCatalogDraft(tx, 'manufacturer', manufacturer.id, vendorDocument, user.id, 'save', vendorExpected);
          mutations.push({ entity: 'manufacturer', id: manufacturer.id, afterRevision: staged.revision, beforeDraft: priorDraft, document: vendorDocument, contexts: [] });
          stagedManufacturers.add(manufacturer.id);
          latestDrafts.push(staged);
        }
        if (stagedManufacturers.has(manufacturer.id)) {
          const mutation = mutations.find(item => item.entity === 'manufacturer' && item.id === manufacturer.id);
          const context = { classId: incoming.classId, manufacturerId: manufacturer.id };
          if (mutation && !mutation.contexts.some((item: any) => item.classId === context.classId)) mutation.contexts.push(context);
        }

        componentsToStage.push({ row, component: incoming, priorDraft: currentDraft || null });
      }

      for (const item of componentsToStage) {
        const { row, component, priorDraft } = item;
        const staged = await stageCatalogDraft(tx, 'component', component.id, component, user.id, 'save', priorDraft?.revision);
        mutations.push({ entity: 'component', id: component.id, afterRevision: staged.revision, beforeDraft: priorDraft, document: component });
      }
      await tx.appSetting.create({ data: { key: batchKey(batchId), userId: user.id, value: JSON.stringify({ mutations, undone: false, createdAt: new Date().toISOString() }) } });
    }, { timeout: 120000 });
    broadcast('catalog:changed', { entity: 'drafts', batchId, userId: user.id });
    res.json({ batchId, count: rows.length, draft: true });
  }));

  app.post('/api/catalog/spreadsheet/undo', handle(async (req, res, db) => {
    const user = userOf(req);
    const batch = await db.appSetting.findFirst({ where: { key: batchKey(String(req.body?.batchId || '')), userId: user.id } });
    if (!batch) return res.status(404).json({ error: 'Черновик импорта не найден' });
    const state = json(batch.value);
    if (state.undone) return res.json({ ok: true, alreadyUndone: true });
    await db.$transaction(async (tx: any) => {
      const latest = await listCatalogDrafts(tx);
      const { catalog } = await readWorkspace(tx, deps, user);
      const currentRows: Array<{ mutation: any; record: any; current: any }> = [];
      for (const mutation of state.mutations || []) {
        const draft = latest.find(d => d.entity === mutation.entity && d.id === mutation.id);
        if (!draft) throw Object.assign(new Error(`Черновик ${mutation.id} уже опубликован или отменён. Публикация останется без изменений`), { status: 409 });
        if (draft.revision !== mutation.afterRevision) throw Object.assign(new Error(`Черновик ${mutation.id} изменён после импорта. Отмена не затронула его`), { status: 409 });
        if (mutation.entity === 'manufacturer') {
          for (const context of mutation.contexts || []) if (!await catalogAllowed(tx, user, 'import', context, deps.can)) throw Object.assign(new Error(`Нет права отмены изготовителя ${mutation.id} в этом виде оборудования`), { status: 403 });
        } else if (!await canImportComponent(tx, user, draft.document, catalog, deps)) {
          throw Object.assign(new Error(`Нет права отмены черновика ${mutation.id}`), { status: 403 });
        }
        if (mutation.beforeDraft && mutation.entity === 'component' && !await canImportComponent(tx, user, mutation.beforeDraft.document, catalog, deps)) {
          throw Object.assign(new Error(`Нет права восстановления предыдущего черновика ${mutation.id}`), { status: 403 });
        }
        const record = await tx.appSetting.findFirst({ where: { key: draftKey(mutation.entity, mutation.id) } });
        if (!record || JSON.parse(record.value)?.revision !== mutation.afterRevision) throw Object.assign(new Error(`Черновик ${mutation.id} изменён коллегой`), { status: 409 });
        currentRows.push({ mutation, record, current: draft });
      }
      const claim = await tx.appSetting.updateMany({ where: { id: batch.id, value: batch.value }, data: { value: JSON.stringify({ ...state, undone: true, undoneAt: new Date().toISOString() }) } });
      if (claim.count !== 1) throw Object.assign(new Error('Отмену уже выполняет другое окно'), { status: 409 });
      for (const { mutation, record } of currentRows) {
        if (mutation.beforeDraft) {
          const restored = await tx.appSetting.updateMany({ where: { id: record.id, value: record.value }, data: { value: JSON.stringify(mutation.beforeDraft) } });
          if (restored.count !== 1) throw Object.assign(new Error(`Черновик ${mutation.id} изменён коллегой`), { status: 409 });
        } else {
          const removed = await tx.appSetting.deleteMany({ where: { id: record.id, value: record.value } });
          if (removed.count !== 1) throw Object.assign(new Error(`Черновик ${mutation.id} изменён коллегой`), { status: 409 });
        }
      }
    }, { timeout: 120000 });
    broadcast('catalog:changed', { entity: 'drafts', batchId: req.body?.batchId, userId: user.id });
    res.json({ ok: true, undoneDrafts: (state.mutations || []).length });
  }));
}
