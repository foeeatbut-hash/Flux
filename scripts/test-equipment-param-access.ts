/** HTTP регрессия запрета правок полей, пришедших из снимка каталога. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma } from '../server/context.js';
import { registerEquipmentCoreRoutes } from '../server/routes/equipmentCore.js';
import { bindingKey } from '../server/equipmentCatalog.js';
import { ensureCatalog, readCatalog } from '../server/routes/catalog.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-equipment-param-access-'));
const dbPath = path.join(root, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
const check = (label: string, value: unknown) => { assert.ok(value, label); checks++; console.log(`✓ ${label}`); };
const snapshot = (keys: string[]) => ({
  id: 'fixture-catalog-snapshot', classId: 'fixture-class', kind: 'other', code: 'FIXTURE', manufacturer: 'Fixture',
  title: { ru: 'Fixture' }, familyIds: [],
  specs: keys.map(key => ({ label: { ru: key }, value: `catalog:${key}`, unit: 'В' })),
});
const binding = (keys: string[]) => JSON.stringify({
  mode: 'catalog', modelId: 'fixture-catalog-snapshot', sourceType: 'component', revision: 'fixture-revision',
  at: '2026-10-09T00:00:00.000Z', snapshot: snapshot(keys),
});

async function expectStatus(label: string, response: Response, status: number) {
  const body = await response.text();
  assert.equal(response.status, status, `${label}: HTTP ${response.status}; ${body.slice(0, 300)}`);
  checks++;
  console.log(`✓ ${label}`);
}

async function main() {
  let server: any;
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);
    await ensureCatalog(prisma);
    const globalCatalogBefore = JSON.stringify(await readCatalog(prisma));
    await prisma.project.create({ data: { id: 'param-access-project', name: 'Parameter access fixture' } });
    await prisma.equipmentSystem.create({ data: { id: 'param-access-system', name: 'SYS-1', projectId: 'param-access-project' } });
    await prisma.monoblock.create({ data: { id: 'param-access-mono', name: 'M1', systemId: 'param-access-system' } });

    const initialSpecs = JSON.stringify({ groups: [{ title: 'Параметры', params: [
      { key: 'Каталожное поле', value: 'XML-old', unit: 'В' },
      { key: 'XML поле', value: 'XML-value', unit: 'В' },
      { key: 'Ручное поле', value: 'Manual-value', unit: 'В' },
    ] }] });
    const initialOverrides = JSON.stringify({ 'Параметры||Ручное поле': 'Manual-value' });
    const initialConflicts = JSON.stringify([
      { group: 'Параметры', key: 'Каталожное поле', oldValue: 'XML-old', newValue: 'XML-new', unit: 'В' },
      { group: 'Параметры', key: 'XML поле', oldValue: 'XML-value', newValue: 'XML-new', unit: 'В' },
      { group: 'Параметры', key: 'Ручное поле', oldValue: 'Manual-value', newValue: 'Manual-next', unit: 'В' },
    ]);
    const initialConflictLog = JSON.stringify({
      'Каталожное поле': { old: 'XML-old', new: 'XML-new' },
      'XML поле': { old: 'XML-value', new: 'XML-next' },
      'Ручное поле': { old: 'Manual-value', new: 'Manual-next' },
    });
    for (const id of ['blocked', 'allowed', 'race']) {
      await prisma.componentElement.create({ data: {
        id: `param-access-${id}`, name: id, itemCode: id, monoblockId: 'param-access-mono', equipType: 'ПРОЧЕЕ',
        specs: initialSpecs, overrides: initialOverrides, paramConflicts: initialConflicts, conflictLog: initialConflictLog,
      } });
      await prisma.appSetting.create({ data: {
        id: `ecb-param-access-${id}`,
        key: bindingKey(`param-access-${id}`), userId: null,
        value: binding(id === 'race' ? ['Каталожное поле'] : ['Каталожное поле']),
      } });
    }

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).authUser = { id: 'fixture-user', role: 'ADMIN', isActive: true }; next(); });
    registerEquipmentCoreRoutes(app);
    server = await new Promise<any>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (id: string, route: string, body: unknown) => fetch(`${origin}${route.replace(':id', id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    const beforeBlocked = await prisma.componentElement.findUnique({ where: { id: 'param-access-blocked' } });
    const denied = [
      ['override', '/api/equipment/component/:id/override', { group: 'Параметры', key: 'Каталожное поле', value: 'overwrite' }],
      ['resolve', '/api/equipment/component/:id/resolve', { group: 'Параметры', key: 'Каталожное поле', action: 'accept' }],
      ['manual-edit-field', '/api/components/:id/manual-edit-field', { fieldName: 'Каталожное поле', newValue: 'overwrite' }],
      ['accept-field', '/api/components/:id/accept-field', { fieldName: 'Каталожное поле' }],
    ] as const;
    for (const [label, route, body] of denied) await expectStatus(`${label}: поле из catalog snapshot запрещено`, await request('param-access-blocked', route, body), 403);
    const afterBlocked = await prisma.componentElement.findUnique({ where: { id: 'param-access-blocked' } });
    check('четыре запрета не изменяют specs, overrides или version',
      afterBlocked?.specs === beforeBlocked?.specs && afterBlocked?.overrides === beforeBlocked?.overrides && afterBlocked?.version === beforeBlocked?.version);

    const allowedRequests = [
      ['override XML', '/api/equipment/component/:id/override', { group: 'Параметры', key: 'XML поле', value: 'XML-edited' }],
      ['override manual', '/api/equipment/component/:id/override', { group: 'Параметры', key: 'Ручное поле', value: 'Manual-edited' }],
      ['resolve XML', '/api/equipment/component/:id/resolve', { group: 'Параметры', key: 'XML поле', action: 'accept' }],
      ['resolve manual', '/api/equipment/component/:id/resolve', { group: 'Параметры', key: 'Ручное поле', action: 'manual', value: 'Manual-resolved' }],
      ['accept-field XML', '/api/components/:id/accept-field', { fieldName: 'XML поле' }],
      ['manual-edit-field XML', '/api/components/:id/manual-edit-field', { fieldName: 'XML поле', newValue: 'XML-manual-edit' }],
    ] as const;
    for (const [label, route, body] of allowedRequests) await expectStatus(`${label}: XML/manual поле остаётся редактируемым`, await request('param-access-allowed', route, body), 200);
    const afterAllowed = await prisma.componentElement.findUnique({ where: { id: 'param-access-allowed' } });
    check('разрешённые XML/manual правки увеличили версию', Number(afterAllowed?.version) > 1);

    // Между проверкой sourceInfo и записью привязка превращает разрешённое XML
    // поле в каталоговое. Это реальная правка строки AppSetting на той же БД.
    const realTransaction = prisma.$transaction.bind(prisma);
    let raceInjected = false;
    prisma.$transaction = async (work: any, options: any) => {
      if (!raceInjected && typeof work === 'function') {
        raceInjected = true;
        await prisma.appSetting.update({
          where: { id: 'ecb-param-access-race' },
          data: { value: binding(['Каталожное поле', 'XML поле']) },
        });
      }
      return realTransaction(work, options);
    };
    const beforeRace = await prisma.componentElement.findUnique({ where: { id: 'param-access-race' } });
    await expectStatus('изменившаяся между проверкой и записью привязка даёт CAS-конфликт',
      await request('param-access-race', '/api/equipment/component/:id/override', { group: 'Параметры', key: 'XML поле', value: 'race-write' }), 409);
    const afterRace = await prisma.componentElement.findUnique({ where: { id: 'param-access-race' } });
    check('CAS-конфликт сохраняет исходные характеристики и версию',
      raceInjected && afterRace?.specs === beforeRace?.specs && afterRace?.overrides === beforeRace?.overrides && afterRace?.version === beforeRace?.version);
    const [blockedSnapshot, allowedSnapshot] = await Promise.all([
      prisma.appSetting.findFirst({ where: { key: bindingKey('param-access-blocked'), userId: null } }),
      prisma.appSetting.findFirst({ where: { key: bindingKey('param-access-allowed'), userId: null } }),
    ]);
    check('редактирование не меняет сохранённые catalog snapshots',
      blockedSnapshot?.value === binding(['Каталожное поле']) && allowedSnapshot?.value === binding(['Каталожное поле']));
    check('маршруты не изменили сохранённые глобальные данные каталога',
      JSON.stringify(await readCatalog(prisma)) === globalCatalogBefore);

    console.log(`Equipment parameter access HTTP checks: ${checks} passed.`);
  } finally {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    setPrisma(null);
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
