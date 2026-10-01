import assert from 'node:assert/strict';
import express from 'express';
import { planCatalogSpreadsheet } from '../catalog/spreadsheet.ts';
import type { Catalog } from '../catalog/model.ts';
import { registerCatalogSpreadsheetRoutes } from '../server/routes/catalogSpreadsheet.ts';
import { setPrisma, setBroadcaster } from '../server/context.ts';

type State = { components: any[]; manufacturers: any[]; families: any[]; settings: any[]; revisions: any[] };
const clone = <T,>(x: T): T => structuredClone(x);

function mockPrisma() {
  let state: State = { components: [], manufacturers: [], families: [], settings: [], revisions: [] };
  let nextId = 0;
  let failNextComponentCreate = false;
  const database = (read: () => State) => {
    const delegate = (key: keyof State) => ({
      findUnique: async ({ where }: any) => read()[key].find((r: any) => r.id === where.id) || null,
      findFirst: async ({ where }: any = {}) => read()[key].find((r: any) => Object.entries(where || {}).every(([k, v]) => (r as any)[k] === v)) || null,
      findMany: async ({ where }: any = {}) => read()[key].filter((r: any) => Object.entries(where || {}).every(([k, v]) => (r as any)[k] === v)),
      create: async ({ data }: any) => {
        if (key === 'components' && failNextComponentCreate) { failNextComponentCreate = false; throw new Error('forced component insert failure'); }
        if (key === 'components' && read()[key].some((r: any) => r.id === data.id)) throw Object.assign(new Error('duplicate component'), { code: 'P2002' });
        if (key === 'manufacturers' && read()[key].some((r: any) => r.id === data.id)) throw Object.assign(new Error('duplicate manufacturer'), { code: 'P2002' });
        const row = { id: `mock-${++nextId}`, createdAt: new Date(0), updatedAt: new Date(0), ...clone(data) };
        (read()[key] as any[]).push(row); return clone(row);
      },
      update: async ({ where, data }: any) => {
        const row = read()[key].find((r: any) => r.id === where.id) as any;
        if (!row) throw new Error(`missing ${String(key)} ${where.id}`);
        Object.assign(row, clone(data)); return clone(row);
      },
      updateMany: async ({ where, data }: any) => {
        const rows = read()[key].filter((r: any) => Object.entries(where).every(([k, v]) => r[k] === v));
        for (const r of rows as any[]) Object.assign(r, clone(data));
        return { count: rows.length };
      },
      delete: async ({ where }: any) => {
        const arr = read()[key] as any[]; const i = arr.findIndex(r => r.id === where.id);
        if (i < 0) throw new Error(`missing ${String(key)} ${where.id}`);
        return arr.splice(i, 1)[0];
      },
    });
    return {
      catalogComponent: delegate('components'), catalogManufacturer: delegate('manufacturers'),
      catalogFamily: delegate('families'), appSetting: delegate('settings'), catalogRevision: delegate('revisions'),
    };
  };
  const root = database(() => state) as any;
  root.$transaction = async (fn: (db: any) => Promise<any>) => {
    const working = clone(state);
    const result = await fn(database(() => working));
    state = working;
    return result;
  };
  return { prisma: root, state: () => state, setState: (next: State) => { state = clone(next); }, failNextComponentCreate: () => { failNextComponentCreate = true; } };
}

const catalog: Catalog = {
  classes: [{ id: 'class-fan', code: 'fan', title: { ru: 'Вентиляторы' }, itemName: { ru: 'вентилятор' }, facts: [] }],
  manufacturers: [], families: [{ id: 'family-fan', classId: 'class-fan', manufacturerId: 'mf-seed', code: 'F1', title: { ru: 'Семейство' }, params: [], positions: [], shapes: [], kind: 'fan', typeLabel: { ru: 'Вентилятор' }, rules: [], match: { kinds: [] }, specs: [], status: 'full' }],
  components: [], tagRules: [],
};
let liveCatalog: Catalog = catalog;
const deps = { ensure: async () => undefined, readCatalog: async () => liveCatalog };
const baseSheets = [
  { name: 'Модели', rows: [
    ['Ключ модели', 'Тип', 'Изготовитель', 'Модель', 'Наименование', 'Источник', 'Редакция'],
    ['external-model-key', 'Привод', 'ООО «Тест»', 'A-42', 'Привод A-42', 'book.pdf', '2026'],
  ] },
  { name: 'Характеристики', rows: [
    ['Ключ модели', 'Параметр', 'Значение', 'Единица'], ['external-model-key', 'Ток', '2.4', 'А'],
  ] },
  { name: 'Применяемость', rows: [
    ['Ключ комплектующего', 'Класс оборудования', 'Семейство'], ['external-model-key', 'class-fan', 'family-fan'],
  ] },
];

async function main() {
  const m = mockPrisma(); setPrisma(m.prisma); setBroadcaster(() => undefined);
  const app = express(); registerCatalogSpreadsheetRoutes(app as any, deps);
  const post = async (path: string, body: unknown) => {
    const layer = (app as any)._router.stack.find((item: any) => item.route?.path === path);
    assert.ok(layer, `route registered: ${path}`);
    const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json(value: any) { this.body = value; return this; } };
    await layer.route.stack[0].handle({ body, authUser: { id: 'route-test-user' } }, res);
    return { status: res.statusCode, json: async () => res.body };
  };
  try {
    const mapping = { 'Ключ модели': 'key', 'Тип': 'type', 'Изготовитель': 'manufacturer', 'Модель': 'model', 'Наименование': 'name', 'Источник': 'source', 'Редакция': 'edition', 'Параметр': 'parameter', 'Значение': 'value', 'Единица': 'unit', 'Ключ комплектующего': 'key', 'Класс оборудования': 'class', 'Семейство': 'family' };
    const planned = await post('/api/catalog/spreadsheet/plan', { sheets: baseSheets, classId: 'class-fan', policy: 'update', mapping });
    assert.equal(planned.status, 200); const plan = await planned.json() as any;
    assert.equal(plan.rows.length, 1); assert.equal(plan.rows[0].action, 'new');
    const applied = await post('/api/catalog/spreadsheet/apply', { planId: plan.planId, indices: [0] });
    assert.equal(applied.status, 200); const batch = await applied.json() as any;
    assert.equal(batch.count, 1); assert.equal(m.state().components.length, 1);
    const saved = JSON.parse(m.state().components[0].dataJson);
    assert.deepEqual(saved.specs, [{ label: { ru: 'Ток' }, value: '2.4', unit: 'А' }]);
    assert.deepEqual(saved.classIds, ['class-fan']); assert.deepEqual(saved.familyIds, ['family-fan']);
    assert.equal(saved.manufacturerId, m.state().manufacturers[0].id);
    assert.equal(m.state().manufacturers.length, 1);
    const retried = await post('/api/catalog/spreadsheet/apply', { planId: plan.planId, indices: [] });
    assert.deepEqual(await retried.json(), batch); assert.equal(m.state().components.length, 1);

    // The exported key (component id) connects model, long parameters and use
    // rows on a later import; matching an existing catalog item is unchanged.
    liveCatalog = { ...catalog, manufacturers: [{ id: saved.manufacturerId, name: saved.manufacturer, shortName: saved.manufacturer }], components: [saved] };
    const roundtrip = await post('/api/catalog/spreadsheet/plan', { sheets: [
      { name: 'Модели', rows: [['Ключ модели', 'Тип', 'Изготовитель', 'Модель', 'Наименование', 'Источник', 'Редакция'], [saved.id, saved.equipmentType, saved.manufacturer, saved.code, saved.title.ru, saved.catalog.file, saved.catalog.edition]] },
      { name: 'Характеристики', rows: [['Ключ модели', 'Параметр', 'Значение', 'Единица'], [saved.id, 'Ток', '2.4', 'А']] },
      { name: 'Применяемость', rows: [['Ключ комплектующего', 'Класс оборудования', 'Семейство'], [saved.id, 'class-fan', 'family-fan']] },
    ], classId: 'class-fan', policy: 'update', mapping });
    assert.equal(roundtrip.status, 200);
    assert.equal(((await roundtrip.json() as any).rows[0]).action, 'same');
    assert.equal(m.state().components.length, 1);
    liveCatalog = catalog;
    const undone = await post('/api/catalog/spreadsheet/undo', { batchId: batch.batchId });
    assert.equal(undone.status, 200); assert.deepEqual((await undone.json() as any).retainedManufacturers, []);
    assert.equal(m.state().components.length, 0); assert.equal(m.state().manufacturers.length, 0);
    const undoneAgain = await post('/api/catalog/spreadsheet/undo', { batchId: batch.batchId });
    assert.equal((await undoneAgain.json() as any).alreadyUndone, true);

    // Existing maker names are compared by manufacturerKey, so case/legal
    // prefix variants do not create duplicate vendor rows.
    const seeded = m.state(); seeded.manufacturers.push({ id: 'mf-existing', name: 'Тест', dataJson: JSON.stringify({ id: 'mf-existing', name: 'Тест' }) }); m.setState(seeded);
    const normalizedPlan = await post('/api/catalog/spreadsheet/plan', { sheets: baseSheets, classId: 'class-fan', policy: 'update', mapping });
    const normalizedPlanBody = await normalizedPlan.json() as any;
    const normalizedApply = await post('/api/catalog/spreadsheet/apply', { planId: normalizedPlanBody.planId, indices: [0] });
    assert.equal(normalizedApply.status, 200); assert.equal(m.state().manufacturers.length, 1);
    assert.equal(JSON.parse(m.state().components[0].dataJson).manufacturerId, 'mf-existing');
    const normalizedBatch = await normalizedApply.json() as any;
    const edited = m.state(); edited.manufacturers[0].dataJson = JSON.stringify({ id: 'mf-existing', name: 'Тест', notes: 'edited later' }); m.setState(edited);
    const retained = await post('/api/catalog/spreadsheet/undo', { batchId: normalizedBatch.batchId });
    assert.deepEqual((await retained.json() as any).retainedManufacturers, []); // pre-existing metadata is outside the import's undo scope
    assert.equal(m.state().manufacturers.length, 1); assert.equal(m.state().components.length, 0);

    // Auto-created vendor metadata edited after import is retained and reported.
    const cleared = m.state(); cleared.manufacturers = []; m.setState(cleared);
    const newMakerSheets = clone(baseSheets); newMakerSheets[0].rows[1][2] = 'New Maker';
    const newMakerPlanRes = await post('/api/catalog/spreadsheet/plan', { sheets: newMakerSheets, classId: 'class-fan', policy: 'add', mapping });
    const newMakerPlan = await newMakerPlanRes.json() as any;
    const newMakerApply = await post('/api/catalog/spreadsheet/apply', { planId: newMakerPlan.planId, indices: [0] });
    const newMakerBatch = await newMakerApply.json() as any;
    const editedMaker = m.state(); editedMaker.manufacturers[0].dataJson = JSON.stringify({ id: editedMaker.manufacturers[0].id, name: 'New Maker', note: 'edited' }); m.setState(editedMaker);
    const retainedMaker = await post('/api/catalog/spreadsheet/undo', { batchId: newMakerBatch.batchId });
    assert.deepEqual((await retainedMaker.json() as any).retainedManufacturers, ['New Maker']);
    assert.equal(m.state().components.length, 0); assert.equal(m.state().manufacturers.length, 1);
    liveCatalog = catalog;

    // Wide columns preserve editable parameter labels and units using the same
    // role mapping the panel posts to the planner.
    const wide = planCatalogSpreadsheet([{ name: 'wide', rows: [
      ['Ключ', 'Изготовитель', 'Модель', 'Момент [Н·м]'], ['wide-key', 'Maker', 'B-2', '12'],
    ] }], catalog, { classId: 'class-fan', policy: 'add', mapping: { 'Ключ': 'key', 'Изготовитель': 'manufacturer', 'Модель': 'model', 'Момент [Н·м]': 'param' } });
    assert.equal(wide[0].component?.specs?.[0].label.ru, 'Момент'); assert.equal(wide[0].component?.specs?.[0].unit, 'Н·м');

    // If a colleague inserts the component after preview under the planned id,
    // apply must return 409 rather than silently overwrite it.
    const row = planCatalogSpreadsheet(baseSheets, catalog, { classId: 'class-fan', policy: 'update', mapping })[0];
    const state = m.state(); state.components.push({ id: row.component!.id, classId: row.component!.classId, kind: row.component!.kind, code: row.component!.code, dataJson: JSON.stringify(row.component) }); m.setState(state);
    const collisionPlanRes = await post('/api/catalog/spreadsheet/plan', { sheets: baseSheets, classId: 'class-fan', policy: 'update', mapping });
    const collisionPlan = await collisionPlanRes.json() as any;
    // The catalog reader intentionally omits this late database row, exercising
    // the apply-time guard independently of preview-time conflict detection.
    const collision = await post('/api/catalog/spreadsheet/apply', { planId: collisionPlan.planId, indices: [0] });
    assert.equal(collision.status, 409);

    const existing = { id: 'existing-component', classId: 'class-fan', kind: 'actuator', code: 'A-42', manufacturer: 'ООО «Тест»', equipmentType: 'Привод', title: { ru: 'Старое имя' }, specs: [], classIds: ['class-fan'], familyIds: [] };
    const existingState = m.state(); existingState.components.push({ id: existing.id, classId: existing.classId, kind: existing.kind, code: existing.code, dataJson: JSON.stringify(existing) }); m.setState(existingState);
    liveCatalog = { ...catalog, components: [existing as any] };
    const changedPlanRes = await post('/api/catalog/spreadsheet/plan', { sheets: baseSheets, classId: 'class-fan', policy: 'update', mapping });
    const changedPlan = await changedPlanRes.json() as any;
    assert.equal(changedPlan.rows[0].action, 'update');
    const changedState = m.state(); const changedRow = changedState.components.find((c) => c.id === existing.id);
    changedRow.dataJson = JSON.stringify({ ...existing, title: { ru: 'Правка коллеги' } }); m.setState(changedState);
    const staleApply = await post('/api/catalog/spreadsheet/apply', { planId: changedPlan.planId, indices: [0] });
    assert.equal(staleApply.status, 409);
    liveCatalog = catalog;
    const afterStale = m.state(); afterStale.components = afterStale.components.filter((c) => c.id !== existing.id); m.setState(afterStale);

    // An auto-created vendor still in use by a different component survives
    // undo even though its own import-created component is removed.
    const usedMakerSheets = clone(baseSheets); usedMakerSheets[0].rows[1][2] = 'Used Maker';
    const usedPlanRes = await post('/api/catalog/spreadsheet/plan', { sheets: usedMakerSheets, classId: 'class-fan', policy: 'add', mapping });
    const usedPlan = await usedPlanRes.json() as any;
    const usedApplyRes = await post('/api/catalog/spreadsheet/apply', { planId: usedPlan.planId, indices: [0] });
    const usedBatch = await usedApplyRes.json() as any;
    const withExternalUse = m.state();
    const usedVendorId = withExternalUse.manufacturers.find(v => v.name === 'Used Maker').id;
    withExternalUse.components.push({ id: 'other-model', classId: 'class-fan', kind: 'other', code: 'OTHER', dataJson: JSON.stringify({ manufacturer: 'Used Maker', manufacturerId: usedVendorId }) });
    m.setState(withExternalUse);
    const usedUndo = await post('/api/catalog/spreadsheet/undo', { batchId: usedBatch.batchId });
    assert.deepEqual((await usedUndo.json() as any).retainedManufacturers, ['Used Maker']);
    assert.ok(m.state().manufacturers.some(v => v.id === usedVendorId));

    // A failure after provisional vendor creation rolls the whole batch back.
    const atomicSheets = clone(baseSheets); atomicSheets[0].rows[1][2] = 'Atomic Maker';
    const atomicPlanRes = await post('/api/catalog/spreadsheet/plan', { sheets: atomicSheets, classId: 'class-fan', policy: 'add', mapping });
    const atomicPlan = await atomicPlanRes.json() as any; m.failNextComponentCreate();
    const atomicApply = await post('/api/catalog/spreadsheet/apply', { planId: atomicPlan.planId, indices: [0] });
    assert.equal(atomicApply.status, 500);
    assert.equal(m.state().manufacturers.some(v => v.name === 'Atomic Maker'), false);
    console.log('catalog spreadsheet route checks passed');
  } finally { /* Route handlers are invoked in-process; no listening socket. */ }
}

void main().catch(err => { console.error(err); process.exitCode = 1; });
