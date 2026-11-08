/** Проверка опубликованной ревизии при применении каталожного предпросмотра. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma } from '../server/context.js';
import { registerEquipmentCatalogRoutes } from '../server/routes/equipmentCatalog.js';
import { bindingKey, enrichEquipment } from '../server/equipmentCatalog.js';
import { ensureCatalog } from '../server/routes/catalog.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-equipment-catalog-revision-'));
const dbPath = path.join(root, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });

async function main() {
  let server: any;
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);
    await ensureCatalog(prisma);
    const valveClass = await prisma.catalogClass.findFirst({ where: { code: 'valve' } });
    assert.ok(valveClass, 'seed catalog contains the valve class');
    await prisma.project.create({ data: { id: 'catalog-revision-project', name: 'Catalog revision fixture' } });
    await prisma.equipmentSystem.create({ data: { id: 'catalog-revision-system', name: 'SYS-REV', projectId: 'catalog-revision-project' } });
    await prisma.monoblock.create({ data: { id: 'catalog-revision-mono', name: 'M-REV', systemId: 'catalog-revision-system' } });

    const family = {
      id: 'revision-race-family', classId: valveClass.id, manufacturerId: 'revision-race-maker', code: 'RR-1',
      title: { ru: 'Клапан для проверки ревизии' }, kind: 'air', typeLabel: { ru: 'Клапан' }, shapes: [],
      params: [{ key: 'drive', label: { ru: 'Привод' }, kind: 'choice', default: 'manual', values: [
        { code: 'manual', label: { ru: 'Ручной' } }, { code: 'electric', label: { ru: 'Электрический' } },
      ] }],
      positions: [], designationMode: 'article', rules: [], match: {},
      specs: [{ label: { ru: 'Номинальный диаметр' }, value: { ru: '20' }, unit: 'мм' }], tables: [], status: 'full',
    };
    await prisma.catalogManufacturer.create({ data: { id: 'revision-race-maker', name: 'Ревизия тест', dataJson: JSON.stringify({ id: 'revision-race-maker', name: 'Ревизия тест' }) } });
    const publishedAt = new Date('2026-10-09T00:00:00.000Z');
    await prisma.catalogFamily.create({ data: {
      id: family.id, classId: family.classId, manufacturerId: family.manufacturerId, code: family.code,
      dataJson: JSON.stringify(family), status: 'full', seedVersion: 1, edited: true, sort: 0, updatedAt: publishedAt,
    } });

    const overrides = JSON.stringify({ 'Параметры||Номинальный диаметр': 'ручное значение' });
    const specs = JSON.stringify({ groups: [{ title: 'Параметры', params: [{ key: 'Номинальный диаметр', value: '10', unit: 'мм' }] }] });
    await prisma.componentElement.create({ data: {
      id: 'catalog-revision-element', name: 'RR-1', itemCode: 'RR-1', monoblockId: 'catalog-revision-mono',
      equipType: 'Клапан', equipClass: 'Клапан', specs, overrides,
    } });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).authUser = req.headers['x-no-equipment'] ? { id: 'fixture-user', role: 'USER', isActive: true } : { id: 'fixture-admin', role: 'ADMIN', isActive: true }; next(); });
    registerEquipmentCatalogRoutes(app);
    server = await new Promise<any>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const previewUrl = `${origin}/api/equipment/component/catalog-revision-element/catalog-source/preview`;
    const denied = await fetch(previewUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-no-equipment': '1' }, body: JSON.stringify({ modelId: family.id, sourceType: 'family' }) });
    assert.equal(denied.status, 403, 'предпросмотр требует equipment.manage');

    await prisma.project.create({ data: { id: 'catalog-project-b', name: 'Project B' } });
    await prisma.equipmentSystem.create({ data: { id: 'catalog-system-b', name: 'SYS-B', projectId: 'catalog-project-b' } });
    await prisma.monoblock.create({ data: { id: 'catalog-mono-b', name: 'M-B', systemId: 'catalog-system-b' } });
    for (const [id, projectId, value] of [['family-project-a', 'catalog-revision-project', 'А'], ['family-project-b', 'catalog-project-b', 'Б']]) {
      const scopedFamily = { ...family, id, specs: [{ label: { ru: 'Номинальный диаметр' }, value: { ru: value }, unit: 'мм' }] };
      await prisma.catalogFamily.create({ data: { id, projectId, basedOnFamilyId: family.id, classId: family.classId, manufacturerId: family.manufacturerId, code: family.code, dataJson: JSON.stringify(scopedFamily), status: 'full', updatedAt: publishedAt } });
    }
    const foreign = await fetch(previewUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: 'family-project-b', sourceType: 'family', catalogueSource: 'project' }) });
    assert.equal(foreign.status, 400, 'администратор не выбирает семейство другого проекта');
    const foreignPut = await fetch(`${origin}/api/equipment/component/catalog-revision-element/catalog-source`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'catalog', modelId: 'family-project-b', sourceType: 'family', catalogueSource: 'project', expectedVersion: 1 }) });
    assert.equal(foreignPut.status, 400, 'чужой ID нельзя применить напрямую');
    const matchedSpecs = JSON.stringify({ groups: [{ title: 'Маркировка', params: [{ key: 'Марка', value: 'RR-1' }] }] });
    await prisma.componentElement.update({ where: { id: 'catalog-revision-element' }, data: { specs: matchedSpecs } });
    await prisma.componentElement.create({ data: { id: 'catalog-element-b', name: 'RR-1', itemCode: 'RR-1', monoblockId: 'catalog-mono-b', equipType: 'Клапан', equipClass: 'Клапан', specs: matchedSpecs } });
    const systems = await prisma.equipmentSystem.findMany({ where: { id: { in: ['catalog-revision-system', 'catalog-system-b'] } }, include: { monoblocks: { include: { components: true } } } });
    await enrichEquipment(systems);
    for (const system of systems) {
      const component = system.monoblocks[0].components[0] as any;
      assert.equal(component.catalogSource.binding?.modelId, system.projectId === 'catalog-project-b' ? 'family-project-b' : 'family-project-a', 'каждая система использует каталог своего проекта');
    }
    await prisma.appSetting.deleteMany({ where: { key: { in: [bindingKey('catalog-revision-element'), bindingKey('catalog-element-b')] } } });
    await prisma.componentElement.update({ where: { id: 'catalog-revision-element' }, data: { specs } });
    const scopedPreview = await fetch(previewUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: 'family-project-a', sourceType: 'family', catalogueSource: 'project', values: { drive: 'manual' } }) });
    assert.equal(scopedPreview.status, 200);
    const scopedRevision = (await scopedPreview.json() as any).sourceRevision;
    const originalTransaction = prisma.$transaction.bind(prisma);
    (prisma as any).$transaction = (work: any, options: any) => originalTransaction(async (tx: any) => {
      await tx.catalogFamily.update({ where: { id: 'family-project-a' }, data: { updatedAt: new Date('2026-11-01T00:00:00.000Z') } });
      return work(tx);
    }, options);
    const scopedRace = await fetch(`${origin}/api/equipment/component/catalog-revision-element/catalog-source`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'catalog', modelId: 'family-project-a', sourceType: 'family', catalogueSource: 'project', values: { drive: 'manual' }, expectedVersion: 1, expectedPublishedRevision: scopedRevision }) });
    (prisma as any).$transaction = originalTransaction;
    assert.equal(scopedRace.status, 409, 'изменение проектного каталога внутри транзакции отклоняет запись');
    assert.equal(await prisma.appSetting.findFirst({ where: { key: bindingKey('catalog-revision-element'), userId: null } }), null);
    const commonPreview = await fetch(previewUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: family.id, sourceType: 'family', catalogueSource: 'common', values: { drive: 'manual' } }) });
    assert.equal(commonPreview.status, 200, 'общая модель доступна даже при проектной замене');
    const commonRevision = (await commonPreview.json() as any).sourceRevision;
    const commonApply = await fetch(`${origin}/api/equipment/component/catalog-revision-element/catalog-source`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'hybrid', modelId: family.id, sourceType: 'family', catalogueSource: 'common', values: { drive: 'manual' }, expectedVersion: 1, expectedPublishedRevision: commonRevision }) });
    assert.equal(commonApply.status, 200);
    const reloaded = await (await fetch(`${origin}/api/equipment/component/catalog-revision-element/catalog-source`)).json() as any;
    assert.equal(reloaded.binding.modelId, family.id, 'перезагрузка сохраняет закреплённую общую модель');
    assert.equal(reloaded.binding.catalogueSource, 'common');
    assert.equal(reloaded.warnings.some((warning: string) => warning.includes('Модель удалена')), false);
    await prisma.appSetting.deleteMany({ where: { key: bindingKey('catalog-revision-element') } });
    await prisma.equipmentHistory.deleteMany({ where: { elementId: 'catalog-revision-element' } });
    await prisma.componentElement.update({ where: { id: 'catalog-revision-element' }, data: { version: 1, overrides } });
    await prisma.catalogFamily.deleteMany({ where: { id: { in: ['family-project-a', 'family-project-b'] } } });
    const put = (body: Record<string, unknown>) => fetch(`${origin}/api/equipment/component/catalog-revision-element/catalog-source`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const baseRequest = {
      mode: 'hybrid', modelId: family.id, sourceType: 'family', values: { drive: 'manual' },
      acceptedCatalogParams: ['Параметры||Номинальный диаметр'], expectedVersion: 1, expectedRevision: '',
    };
    const before = await prisma.componentElement.findUnique({ where: { id: 'catalog-revision-element' } });

    const missing = await put(baseRequest);
    assert.equal(missing.status, 409, `missing preview revision should conflict: ${await missing.text()}`);
    const afterMissing = await prisma.componentElement.findUnique({ where: { id: 'catalog-revision-element' } });
    assert.equal(afterMissing?.overrides, overrides, 'missing revision conflict preserves manual override');
    assert.equal(afterMissing?.version, before?.version, 'missing revision conflict preserves element version');
    assert.equal(await prisma.appSetting.findFirst({ where: { key: bindingKey('catalog-revision-element'), userId: null } }), null, 'missing revision conflict does not create a binding');

    const previewResponse = await fetch(`${origin}/api/equipment/component/catalog-revision-element/catalog-source/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: family.id, sourceType: 'family', values: { drive: 'manual' } }),
    });
    if (previewResponse.status !== 200) throw new Error(`preview failed: ${await previewResponse.text()}`);
    const preview = await previewResponse.json() as { sourceRevision?: string };
    assert.ok(preview.sourceRevision, 'preview must identify the published revision');

    const newerFamily = { ...family, specs: [{ label: { ru: 'Номинальный диаметр' }, value: { ru: '25' }, unit: 'мм' }] };
    await prisma.catalogFamily.update({ where: { id: family.id }, data: { dataJson: JSON.stringify(newerFamily), updatedAt: new Date('2026-10-10T00:00:00.000Z') } });
    const stale = await put({ ...baseRequest, expectedPublishedRevision: preview.sourceRevision });
    assert.equal(stale.status, 409, `stale preview revision should conflict: ${await stale.text()}`);
    const afterStale = await prisma.componentElement.findUnique({ where: { id: 'catalog-revision-element' } });
    assert.equal(afterStale?.overrides, overrides, 'stale revision conflict preserves manual override');
    assert.equal(afterStale?.version, before?.version, 'stale revision conflict preserves element version');
    assert.equal(await prisma.appSetting.findFirst({ where: { key: bindingKey('catalog-revision-element'), userId: null } }), null, 'stale revision conflict does not create a binding');

    const currentPreviewResponse = await fetch(`${origin}/api/equipment/component/catalog-revision-element/catalog-source/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: family.id, sourceType: 'family', values: { drive: 'manual' } }),
    });
    if (currentPreviewResponse.status !== 200) throw new Error(`current preview failed: ${await currentPreviewResponse.text()}`);
    const currentPreview = await currentPreviewResponse.json() as { sourceRevision?: string };
    assert.ok(currentPreview.sourceRevision);
    const realTransaction = prisma.$transaction.bind(prisma);
    let raceInjected = false;
    (prisma as any).$transaction = (work: any, options: any) => realTransaction(async (tx: any) => {
      if (!raceInjected) {
        raceInjected = true;
        const raceFamily = { ...newerFamily, specs: [{ label: { ru: 'Номинальный диаметр' }, value: { ru: '30' }, unit: 'мм' }] };
        await tx.catalogFamily.update({ where: { id: family.id }, data: { dataJson: JSON.stringify(raceFamily), updatedAt: new Date('2026-10-11T00:00:00.000Z') } });
      }
      return work(tx);
    }, options);
    const raced = await put({ ...baseRequest, expectedPublishedRevision: currentPreview.sourceRevision });
    (prisma as any).$transaction = realTransaction;
    assert.equal(raced.status, 409, `publication during transaction should conflict: ${await raced.text()}`);
    const afterRace = await prisma.componentElement.findUnique({ where: { id: 'catalog-revision-element' } });
    assert.ok(raceInjected, 'publication race was injected before transactional recheck');
    assert.equal(afterRace?.overrides, overrides, 'transaction-time publication conflict preserves manual override');
    assert.equal(afterRace?.version, before?.version, 'transaction-time publication conflict preserves element version');
    assert.equal(await prisma.appSetting.findFirst({ where: { key: bindingKey('catalog-revision-element'), userId: null } }), null, 'transaction-time conflict does not create a binding');

    const freshPreviewResponse = await fetch(`${origin}/api/equipment/component/catalog-revision-element/catalog-source/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: family.id, sourceType: 'family', values: { drive: 'manual' } }),
    });
    if (freshPreviewResponse.status !== 200) throw new Error(`fresh preview failed: ${await freshPreviewResponse.text()}`);
    const freshPreview = await freshPreviewResponse.json() as { sourceRevision?: string };
    const accepted = await put({ ...baseRequest, expectedPublishedRevision: freshPreview.sourceRevision });
    if (accepted.status !== 200) throw new Error(`current published revision should apply: ${await accepted.text()}`);
    const acceptedBody = await accepted.json() as { binding: { revision: string } };
    const afterAccepted = await prisma.componentElement.findUnique({ where: { id: 'catalog-revision-element' } });
    assert.equal(afterAccepted?.overrides, null, 'current revision can explicitly accept selected catalog value and clear its override');
    assert.equal(Number(afterAccepted?.version), Number(before?.version) + 1, 'current revision apply bumps the element version once');

    const xml = await put({ mode: 'xml', expectedVersion: Number(afterAccepted?.version), expectedRevision: acceptedBody.binding.revision });
    assert.equal(xml.status, 200, `XML mode must not require a catalog preview revision: ${await xml.text()}`);
    const afterXml = await prisma.componentElement.findUnique({ where: { id: 'catalog-revision-element' } });
    assert.equal(afterXml?.overrides, null, 'XML mode preserves the override state left by explicit catalog acceptance');
    assert.equal(JSON.parse((await prisma.appSetting.findFirstOrThrow({ where: { key: bindingKey('catalog-revision-element'), userId: null } })).value).mode, 'xml');
    console.log('Equipment catalog published-revision HTTP checks: missing, stale and transaction-time guards preserve overrides; current revision and XML mode apply.');
  } finally {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    setPrisma(null);
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
