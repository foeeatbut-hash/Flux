import assert from 'node:assert/strict';
import express from 'express';
import { registerCatalogSpreadsheetRoutes } from '../server/routes/catalogSpreadsheet.ts';
import { setPrisma, setBroadcaster } from '../server/context.ts';
import type { Catalog } from '../catalog/model.ts';
import { planCatalogSpreadsheet } from '../catalog/spreadsheet.ts';
import { stageCatalogDraft } from '../server/catalogWorkspace.ts';
import { putCatalogSetting } from '../server/catalogWorkspace.ts';

type State = { components: any[]; manufacturers: any[]; families: any[]; settings: any[]; revisions: any[] };
const clone = <T,>(x: T): T => structuredClone(x);
function match(row: any, where: any = {}) {
  return Object.entries(where).every(([key, value]: any) => value && typeof value === 'object' && 'startsWith' in value
    ? String(row[key] || '').startsWith(value.startsWith) : row[key] === value);
}

function mockPrisma() {
  let state: State = { components: [], manufacturers: [], families: [], settings: [], revisions: [] };
  let nextId = 0;
  const database = (read: () => State) => {
    const delegate = (key: keyof State): any => ({
      findUnique: async ({ where }: any) => read()[key].find((row: any) => row.id === where.id) || null,
      findFirst: async ({ where }: any = {}) => read()[key].find(row => match(row, where)) || null,
      findMany: async ({ where }: any = {}) => read()[key].filter(row => match(row, where)),
      create: async ({ data }: any) => {
        if (data.id && read()[key].some((row: any) => row.id === data.id)) throw Object.assign(new Error('duplicate row'), { code: 'P2002' });
        const row = { id: `mock-${++nextId}`, createdAt: new Date(0), updatedAt: new Date(0), ...clone(data) };
        (read()[key] as any[]).push(row); return clone(row);
      },
      update: async ({ where, data }: any) => {
        const row = read()[key].find((item: any) => item.id === where.id) as any;
        if (!row) throw new Error(`missing ${String(key)} ${where.id}`);
        Object.assign(row, clone(data)); return clone(row);
      },
      updateMany: async ({ where, data }: any) => {
        const rows = read()[key].filter((row: any) => match(row, where));
        for (const row of rows as any[]) Object.assign(row, clone(data));
        return { count: rows.length };
      },
      deleteMany: async ({ where }: any) => {
        const rows = read()[key] as any[]; const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], where)) rows.splice(i, 1);
        return { count: before - rows.length };
      },
      delete: async ({ where }: any) => {
        const rows = read()[key] as any[]; const i = rows.findIndex(row => row.id === where.id);
        if (i < 0) throw new Error(`missing ${String(key)} ${where.id}`);
        return rows.splice(i, 1)[0];
      },
      upsert: async ({ where, create, update }: any) => {
        const row = read()[key].find((item: any) => item.id === where.id) as any;
        if (!row) return delegate(key).create({ data: create });
        Object.assign(row, clone(update)); return clone(row);
      },
    });
    return {
      catalogComponent: delegate('components'), catalogManufacturer: delegate('manufacturers'),
      catalogFamily: delegate('families'), appSetting: delegate('settings'), catalogRevision: delegate('revisions'),
    };
  };
  const root = database(() => state) as any;
  root.$transaction = async (fn: (db: any) => Promise<any>) => {
    const working = clone(state); const result = await fn(database(() => working)); state = working; return result;
  };
  return { prisma: root, state: () => state, setState: (next: State) => { state = clone(next); } };
}

const catalog: Catalog = {
  classes: [{ id: 'class-fan', code: 'fan', title: { ru: 'Вентиляторы' }, itemName: { ru: 'вентилятор' }, facts: [] }],
  manufacturers: [],
  families: [{ id: 'family-fan', classId: 'class-fan', manufacturerId: 'mf-seed', code: 'F1', title: { ru: 'Семейство' }, params: [], positions: [], shapes: [], kind: 'fan', typeLabel: { ru: 'Вентилятор' }, rules: [], match: { kinds: [] }, specs: [], status: 'full' }],
  components: [], tagRules: [],
};
const sheets = [{ name: 'Модели', rows: [
  ['Ключ модели', 'Тип', 'Изготовитель', 'Модель', 'Наименование', 'Источник', 'Редакция'],
  ['external-key', 'Привод', 'ООО «Тест»', 'A-42', 'Привод A-42', 'book.pdf', '2026'],
] }, { name: 'Характеристики', rows: [
  ['Ключ модели', 'Параметр', 'Значение', 'Единица'], ['external-key', 'Ток', '2.4', 'А'],
] }, { name: 'Применяемость', rows: [
  ['Ключ комплектующего', 'Класс оборудования', 'Семейство'], ['external-key', 'class-fan', 'family-fan'],
] }];
const mapping = { 'Ключ модели': 'key', 'Тип': 'type', 'Изготовитель': 'manufacturer', 'Модель': 'model', 'Наименование': 'name', 'Источник': 'source', 'Редакция': 'edition', 'Параметр': 'parameter', 'Значение': 'value', 'Единица': 'unit', 'Ключ комплектующего': 'key', 'Класс оборудования': 'class', 'Семейство': 'family' };
let liveCatalog = catalog;

async function main() {
  const mock = mockPrisma(); setPrisma(mock.prisma); setBroadcaster(() => undefined);
  let mayImport = true;
  const app = express();
  registerCatalogSpreadsheetRoutes(app as any, { ensure: async () => undefined, readCatalog: async () => liveCatalog, can: () => mayImport });
  const post = async (path: string, body: unknown) => {
    const layer = (app as any)._router.stack.find((item: any) => item.route?.path === path);
    assert.ok(layer, `route registered: ${path}`);
    const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json(value: any) { this.body = value; return this; } };
    await layer.route.stack[0].handle({ body, authUser: { id: 'route-test-user' } }, res);
    return { status: res.statusCode, body: res.body };
  };
  const drafts = () => mock.state().settings.filter(row => String(row.key).startsWith('catalog_draft:')).map(row => JSON.parse(row.value));

  const planned = await post('/api/catalog/spreadsheet/plan', { sheets, classId: 'class-fan', policy: 'update', mapping });
  assert.equal(planned.status, 200); assert.equal(planned.body.rows.length, 1); assert.equal(planned.body.rows[0].action, 'new');
  assert.equal(mock.state().components.length, 0); assert.equal(mock.state().manufacturers.length, 0); assert.equal(drafts().length, 0);

  const applied = await post('/api/catalog/spreadsheet/apply', { planId: planned.body.planId, indices: [0] });
  assert.equal(applied.status, 200); assert.equal(applied.body.draft, true); assert.equal(applied.body.count, 1);
  assert.equal(mock.state().components.length, 0, 'apply must not touch published components');
  assert.equal(mock.state().manufacturers.length, 0, 'apply must not touch published manufacturers');
  const currentDrafts = drafts(); assert.equal(currentDrafts.length, 2);
  const componentDraft = currentDrafts.find(draft => draft.entity === 'component');
  assert.deepEqual(componentDraft.document.specs, [{ label: { ru: 'Ток' }, value: '2.4', unit: 'А' }]);
  assert.deepEqual(componentDraft.document.classIds, ['class-fan']);
  assert.deepEqual(componentDraft.document.familyIds, ['family-fan']);
  assert.ok(componentDraft.document.manufacturerId);

  const repeated = await post('/api/catalog/spreadsheet/apply', { planId: planned.body.planId, indices: [] });
  assert.deepEqual(repeated.body, applied.body, 'repeat of a staged plan is idempotent');
  const roundtrip = await post('/api/catalog/spreadsheet/plan', { sheets, classId: 'class-fan', policy: 'update', mapping });
  assert.equal(roundtrip.status, 200); assert.equal(roundtrip.body.rows[0].action, 'same', 'preview reads the import draft overlay');

  const undone = await post('/api/catalog/spreadsheet/undo', { batchId: applied.body.batchId });
  assert.equal(undone.status, 200); assert.equal(undone.body.undoneDrafts, 2); assert.equal(drafts().length, 0);
  assert.equal(mock.state().components.length, 0); assert.equal(mock.state().manufacturers.length, 0);
  assert.equal((await post('/api/catalog/spreadsheet/undo', { batchId: applied.body.batchId })).body.alreadyUndone, true);

  // Import updates an existing draft in place; undo restores that exact draft revision.
  const priorModel = planCatalogSpreadsheet(sheets as any, catalog, { classId: 'class-fan', policy: 'add', mapping })[0].component!;
  const priorDoc = { ...priorModel, title: { ru: 'Ручная черновая правка' }, specs: [{ label: { ru: 'Ток' }, value: '1.8', unit: 'А' }] };
  const prior = await stageCatalogDraft(mock.prisma, 'component', priorDoc.id, priorDoc, 'route-test-user');
  const priorState = mock.state();
  const priorSetting = priorState.settings.find(row => String(row.key).startsWith('catalog_draft:component:'));
  const updatePreview = await post('/api/catalog/spreadsheet/plan', { sheets, classId: 'class-fan', policy: 'update', mapping });
  assert.equal(updatePreview.body.rows[0].action, 'update');
  const updateApply = await post('/api/catalog/spreadsheet/apply', { planId: updatePreview.body.planId, indices: [0] });
  assert.equal(updateApply.status, 200);
  assert.notEqual(drafts().find(draft => draft.entity === 'component')?.revision, prior.revision);
  assert.equal((await post('/api/catalog/spreadsheet/undo', { batchId: updateApply.body.batchId })).status, 200);
  assert.equal(mock.state().settings.find(row => row.id === priorSetting.id)?.value, priorSetting.value, 'undo restores exact prior draft state');
  assert.deepEqual(drafts().map(draft => [draft.entity, draft.id, draft.revision]), [['component', prior.id, prior.revision]]);
  mock.setState({ ...mock.state(), settings: [] });

  const stalePlan = await post('/api/catalog/spreadsheet/plan', { sheets, classId: 'class-fan', policy: 'add', mapping });
  const nextRows = planCatalogSpreadsheet(sheets as any, catalog, { classId: 'class-fan', policy: 'add', mapping });
  const next = nextRows[0].component!;
  mock.setState({ ...mock.state(), components: [{ id: next.id, classId: next.classId, kind: next.kind, code: next.code, dataJson: JSON.stringify(next) }] });
  const stale = await post('/api/catalog/spreadsheet/apply', { planId: stalePlan.body.planId, indices: [0] });
  assert.equal(stale.status, 409, 'published row inserted after preview fails hash/CAS');
  assert.equal(drafts().length, 0);

  // A draft already published after staging is never deleted by undo.
  mock.setState({ ...mock.state(), components: [], settings: [] });
  const finalPlan = await post('/api/catalog/spreadsheet/plan', { sheets, classId: 'class-fan', policy: 'add', mapping });
  const finalApply = await post('/api/catalog/spreadsheet/apply', { planId: finalPlan.body.planId, indices: [0] });
  const afterStage = mock.state();
  const stagedComponent = drafts().find(draft => draft.entity === 'component')!;
  afterStage.components.push({ id: stagedComponent.id, classId: stagedComponent.document.classId, kind: stagedComponent.document.kind, code: stagedComponent.document.code, dataJson: JSON.stringify(stagedComponent.document) });
  afterStage.settings = afterStage.settings.filter(row => !String(row.key).startsWith('catalog_draft:'));
  mock.setState(afterStage);
  const publishedUndo = await post('/api/catalog/spreadsheet/undo', { batchId: finalApply.body.batchId });
  assert.equal(publishedUndo.status, 409); assert.equal(mock.state().components.length, 1, 'published row remains intact');

  mayImport = false;
  mock.setState({ ...mock.state(), components: [], settings: [] });
  await putCatalogSetting(mock.prisma, 'catalog_grants', [{ userId: 'route-test-user', action: 'import', classId: 'class-fan' }]);
  liveCatalog = { ...catalog, components: [{ id: 'old-area-model', classId: 'class-old', kind: 'actuator', code: 'A-42', manufacturer: 'ООО «Тест»', equipmentType: 'Привод', title: { ru: 'Старое' }, specs: [], classIds: ['class-old'], familyIds: [] }] as any };
  const deniedPlan = await post('/api/catalog/spreadsheet/plan', { sheets, classId: 'class-fan', policy: 'update', mapping });
  const denied = await post('/api/catalog/spreadsheet/apply', { planId: deniedPlan.body.planId, indices: [0] });
  assert.equal(denied.status, 403, 'permission for the incoming class cannot overwrite an item from an unauthorized old class');
  assert.equal(drafts().length, 0);
  console.log('catalog spreadsheet draft route checks passed');
}

void main().catch(err => { console.error(err); process.exitCode = 1; });
