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
import { bindingKey } from '../server/equipmentCatalog.js';
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
    app.use((req, _res, next) => { (req as any).authUser = { id: 'fixture-admin', role: 'ADMIN', isActive: true }; next(); });
    registerEquipmentCatalogRoutes(app);
    server = await new Promise<any>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
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
