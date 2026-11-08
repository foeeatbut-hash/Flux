/** Реальные SQLite/MariaDB/PostgreSQL: схема и проектный план классификации. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { setDialect } from '../server/ddl.js';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { ensureRemoteSchema } from '../server/schema-sync.js';
import { setPrisma, setBroadcaster } from '../server/context.js';
import { registerEquipmentClassRoutes } from '../server/routes/equipmentClasses.js';
import { registerDocflowKitRoutes } from '../server/routes/docflowKits.js';
import { registerDocflowCreateFileRoutes } from '../server/routes/docflowCreateFiles.js';
import { registerDocflowIssueRoutes } from '../server/routes/docflowIssue.js';
import { registerProjectFolderBindingRoutes } from '../server/routes/projectFolderBindings.js';
import { planProjectFamily, applyProjectFamily, undoProjectFamily } from '../server/projectCatalogPlans.js';
import { familyDocument, projectFamilyRevision } from '../server/projectCatalogData.js';

const require = createRequire(import.meta.url);
assert.equal(process.env.FLUX_TEST_FIXTURE_DOCFLOW_STAGE2, '1', 'нужен marker одноразовой fixture');
const provider = process.env.FLUX_DOCFLOW_STAGE2_PROVIDER || 'sqlite';
assert.ok(['sqlite', 'mysql', 'postgresql'].includes(provider));
const local = provider === 'sqlite';
const tmp = local ? fs.mkdtempSync(path.join(os.tmpdir(), 'flux-stage2-db-')) : '';
const file = path.join(tmp, 'fixture.sqlite');
const endpoint = local ? `file:${file}` : String(process.env.FLUX_DOCFLOW_STAGE2_FIXTURE_URL || '');
if (!local) {
  const url = new URL(endpoint);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'только локальная fixture');
  assert.match(url.pathname, /^\/flux_docflow_stage2_fixture(?:_[a-z0-9]+)?$/);
}
const clientPath = local ? '../prisma-clients/client-sqlite' : provider === 'mysql' ? '../prisma-clients/client-mysql' : '../prisma-clients/client-pg';
const { PrismaClient } = require(clientPath);
const adapter = local ? new (require('@prisma/adapter-better-sqlite3').PrismaBetterSqlite3)({ url: endpoint })
  : provider === 'mysql' ? new (require('@prisma/adapter-mariadb').PrismaMariaDb)(endpoint)
  : new (require('@prisma/adapter-pg').PrismaPg)({ connectionString: endpoint });
const db = new PrismaClient({ adapter });

async function main() {
  setDialect(provider as 'sqlite' | 'mysql' | 'postgresql');
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.authUser = req.headers['x-denied'] ? { id: 'denied', role: 'USER' } : { id: String(req.headers['x-actor'] || 'admin'), role: 'ADMIN' }; next(); });
  registerEquipmentClassRoutes(app);
  registerDocflowKitRoutes(app);
  registerDocflowCreateFileRoutes(app);
  registerDocflowIssueRoutes(app);
  registerProjectFolderBindingRoutes(app, { mayManage: async () => true });
  const server = await new Promise<any>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/equipment/projects`;
  const call = async (project: string, action: string, body?: any, denied = false) => {
    const r = await fetch(`${base}/${project}/catalog-classes/${action}`, { method: action === 'last' ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(denied ? { 'x-denied': '1' } : {}) }, ...(action === 'last' ? {} : { body: JSON.stringify(body || {}) }) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    const schemaName = local ? 'schema.prisma' : provider === 'mysql' ? 'schema.mariadb.prisma' : 'schema.postgresql.prisma';
    const schema = fs.readFileSync(path.join('prisma', schemaName), 'utf8');
    if (local) await bootstrapLocalDatabase(file, db, schema, () => {});
    else {
      const existing = await db.$queryRawUnsafe(provider === 'mysql' ? 'SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE()' : "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'");
      assert.equal(existing.length, 0, 'нужна новая пустая fixture');
      const logs: string[] = [];
      await ensureRemoteSchema(db, provider as 'mysql' | 'postgresql', schema, x => logs.push(x));
      assert.deepEqual(logs.filter(x => /Не удалось|Пропуск|Ошибка при/.test(x)), [], 'ошибка подготовки схемы');
    }
    setPrisma(db); setBroadcaster(() => {});
    await db.project.createMany({ data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
    await db.projectMember.createMany({ data: [{ projectId: 'a', userId: 'denied' }, { projectId: 'b', userId: 'other' }] });
    await db.catalogClass.create({ data: { id: 'class', code: 'CLASS' } });
    await db.docflowSettings.create({ data: { projectId: 'a', config: JSON.stringify({ equipmentClasses: [{ type: 'FAN', classId: 'class' }] }) } });
    await db.equipment.create({ data: { id: 'shared', type: 'FAN', description: 'fixture' } });
    await db.tag.createMany({ data: [{ id: 'local', identifier: 'L', projectId: 'a', equipmentId: 'shared' }, { id: 'foreign', identifier: 'F', projectId: 'b', equipmentId: 'shared' }] });
    for (const action of ['plan', 'apply', 'undo', 'last']) assert.equal((await call('a', action, { planId: 'none' }, true)).status, 403, `право ${action}`);
    const first = await call('a', 'plan', { tagIds: ['local'] });
    const second = await call('a', 'plan', { tagIds: ['local'] });
    assert.equal(first.status, 200); assert.equal(first.body.rows[0].classId, 'class');
    assert.equal((await db.tag.findUnique({ where: { id: 'local' } })).equipmentId, 'shared', 'предпросмотр не записывает');
    const applied = await call('a', 'apply', { planId: first.body.id });
    assert.equal(applied.status, 200); assert.equal(applied.body.count, 1);
    assert.equal((await call('a', 'apply', { planId: second.body.id })).status, 409, 'устаревший план блокируется');
    assert.equal((await db.equipment.findUnique({ where: { id: 'shared' } })).catalogClassId, null, 'общая запись сохранена');
    assert.equal((await db.tag.findUnique({ where: { id: 'foreign' } })).equipmentId, 'shared', 'чужой тег сохранён');
    const localTag = await db.tag.findUnique({ where: { id: 'local' }, include: { equipment: true } });
    assert.equal(localTag.equipment.catalogClassId, 'class', 'класс записан в проектную копию');
    assert.equal((await call('a', 'last')).body.id, first.body.id);
    assert.equal((await call('a', 'undo', { planId: first.body.id })).status, 200);
    assert.equal((await db.tag.findUnique({ where: { id: 'local' } })).equipmentId, 'shared');
    assert.equal((await db.docflowPlan.findUnique({ where: { id: first.body.id } })).state, 'undone');
    console.log(`✓ ${provider}: схема, права, план, CAS, общая запись и отмена`);
    const kitBase = `http://127.0.0.1:${server.address().port}/api/docflow/kits`;
    const kitCall = async (action: string, body: any, actor = 'admin') => {
      const r = await fetch(`${kitBase}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-actor': actor }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() as any };
    };
    await db.docRegister.create({ data: { id: 'reg-a', projectId: 'a', name: 'Реестр', poNumber: 'PO' } });
    await db.tag.create({ data: { id: 'local2', identifier: 'L2', projectId: 'a', equipmentId: 'shared' } });
    await db.equipmentSystem.create({ data: { id: 'sys', projectId: 'a', name: 'S' } });
    await db.monoblock.create({ data: { id: 'mono', systemId: 'sys', name: 'M' } });
    for (const id of ['local', 'local2']) await db.componentElement.create({ data: { id: `element-${id}`, name: id, itemCode: id, monoblockId: 'mono', equipType: 'FAN', tags: { connect: { id } } } });
    const kitItem = (docType: string, unit: string) => ({ docType, stage: 'Р', unit, necessity: 'required', responsibleRole: '', milestone: '', workdays: 0, condition: null });
    await db.docflowSettings.update({ where: { projectId: 'a' }, data: { config: JSON.stringify({ equipmentClasses: [{ type: 'FAN', classId: 'class' }], vdrTypes: [{ code: 'E02', titleRu: 'Группа', titleEn: '' }, { code: 'C32', titleRu: 'Проект', titleEn: '' }], kits: [{ classId: 'class', items: [kitItem('E02', 'group'), kitItem('C32', 'project')] }] }) } });
    const kitRequest = { projectId: 'a', registerId: 'reg-a', tagIds: ['local', 'local2'], stage: 'Р', fields: { установка: 'UNIT' } };
    const kit1 = await kitCall('plan', kitRequest, 'admin');
    const kit2 = await kitCall('plan', kitRequest, 'admin2');
    assert.equal(kit1.status, 200); assert.equal(kit2.status, 200);
    assert.equal(kit1.body.rows.length, 2); assert.ok(kit1.body.rows.every((row: any) => row.action === 'create' && row.tagIds.length === 2));
    assert.equal(await db.docRegisterItem.count(), 0, 'предпросмотр строк не пишет');
    const results = await Promise.all([kitCall('apply', { projectId: 'a', planId: kit1.body.id }, 'admin'), kitCall('apply', { projectId: 'a', planId: kit2.body.id }, 'admin2')]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409], 'конкуренция создаёт комплект один раз');
    assert.equal(await db.docflowKitRow.count(), 2); assert.equal(await db.docRegisterItemTag.count(), 4);
    const winning = results[0].status === 200 ? { plan: kit1, actor: 'admin' } : { plan: kit2, actor: 'admin2' };
    assert.equal((await kitCall('apply', { projectId: 'a', planId: winning.plan.body.id }, winning.actor)).status, 200, 'повтор идемпотентен');
    assert.equal(await db.docflowKitRow.count(), 2);
    const reserve = await db.docflowKitRow.findFirst({ where: { unit: 'group' } });
    await db.docRegisterItem.create({ data: { id: 'duplicate-probe', projectId: 'a', registerId: 'reg-a' } });
    await assert.rejects(db.docflowKitRow.create({ data: { projectId: 'a', unit: reserve.unit, scopeId: reserve.scopeId, docType: reserve.docType, itemId: 'duplicate-probe', cipher: 'other' } }), 'уникальность scope/type');
    await assert.rejects(db.docflowKitRow.create({ data: { projectId: 'a', unit: 'tag', scopeId: 'other', docType: 'other', itemId: 'duplicate-probe', cipher: reserve.cipher } }), 'уникальность шифра');
    await db.docRegisterItem.delete({ where: { id: 'duplicate-probe' } });
    assert.equal((await kitCall('undo', { projectId: 'a', planId: winning.plan.body.id }, winning.actor)).status, 200);
    assert.equal(await db.docflowKitRow.count(), 0); assert.equal(await db.docRegisterItemTag.count(), 0);
    console.log(`✓ ${provider}: строки группы и проекта, конкуренция, уникальность, повтор и отмена`);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const folderKey = 'a'.repeat(64);
    const bindingResponse = await fetch(`${origin}/api/explorer/project-bindings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0, operation: { kind: 'upsert', binding: { projectId: 'a', locationKey: folderKey, label: 'Рабочая', purpose: 'work', locator: { folderKey, anchors: [{ key: folderKey, relativePath: '' }] } } } }) });
    assert.equal(bindingResponse.status, 200, 'штатное назначение рабочей папки');
    await db.docRegisterItem.create({ data: { id: 'file-item', projectId: 'a', registerId: 'reg-a', contractorNo: 'PO-UNIT-E02-099', vdrCode: 'E02', revision: 'A' } });
    const fileCall = async (action: string, body: any, actor = 'admin') => {
      const r = await fetch(`${origin}/api/docflow/create-files/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-actor': actor }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() as any };
    };
    const fileRequest = { projectId: 'a', itemIds: ['file-item'], format: 'docx', useTemplates: false };
    const filePlan1 = await fileCall('plan', fileRequest, 'admin');
    const filePlan2 = await fileCall('plan', fileRequest, 'admin2');
    assert.equal(filePlan1.status, 200); assert.equal(filePlan2.status, 200);
    assert.equal(filePlan1.body.rows[0].action, 'create'); assert.equal(await db.docFileLink.count(), 0);
    const contents = [{ itemId: 'file-item', sha256: 'c'.repeat(64), size: 120 }];
    const fileResults = await Promise.all([
      fileCall('claim', { projectId: 'a', planId: filePlan1.body.id, files: contents }, 'admin'),
      fileCall('claim', { projectId: 'a', planId: filePlan2.body.id, files: contents }, 'admin2'),
    ]);
    assert.deepEqual(fileResults.map(result => result.status).sort(), [200, 409], 'два автора не резервируют одну ревизию');
    assert.equal(await db.docflowPlan.count({ where: { kind: 'file-create-claim' } }), 2);
    assert.equal(await db.docFileLink.count(), 0, 'резерв не создаёт ссылку');
    const fileWinner = fileResults[0].status === 200 ? { plan: filePlan1, actor: 'admin' } : { plan: filePlan2, actor: 'admin2' };
    const complete = await fileCall('complete', { projectId: 'a', planId: fileWinner.plan.body.id }, fileWinner.actor);
    assert.equal(complete.status, 200); assert.equal(complete.body.count, 1);
    assert.equal((await fileCall('complete', { projectId: 'a', planId: fileWinner.plan.body.id }, fileWinner.actor)).status, 200);
    assert.equal(await db.docFileLink.count({ where: { unlinkedAt: null } }), 1); assert.equal(await db.docflowPlan.count({ where: { kind: 'file-create-claim' } }), 0);
    assert.equal((await fileCall('undo', { projectId: 'a', planId: fileWinner.plan.body.id }, fileWinner.actor)).status, 200);
    assert.equal(await db.docFileLink.count({ where: { unlinkedAt: null } }), 0); assert.equal(await db.docFileLink.count(), 1);
    console.log(`✓ ${provider}: создание файла, конкурентный резерв, повтор и отмена`);

    // Шаг 5: выпуск пачкой. Уникальный ключ «строка + ревизия», один план — одна запись, второй одновременный выпуск — 409
    await db.docRegisterItem.update({ where: { id: 'file-item' }, data: { status: 'READY' } });
    const issueFile = 'PO-UNIT-E02-099_A.pdf';
    const issueLink = await db.docFileLink.create({ data: { itemId: 'file-item', projectId: 'a', revision: 'A', role: 'file', folderKey, relativePath: `E02/${issueFile}`, fileName: issueFile, sha256: 'd'.repeat(64), size: 5, pathKey: `issue-${provider}`.padEnd(64, '0') } });
    const issueCall = async (action: string, body: any, actor = 'admin', denied = false) => {
      const r = await fetch(`${origin}/api/docflow/issue/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-actor': actor, ...(denied ? { 'x-denied': '1' } : {}) }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() as any };
    };
    const issueRows = [{ itemId: 'file-item', linkId: issueLink.id, reason: 'IFR', date: new Date().toISOString().slice(0, 10), sha256: 'd'.repeat(64) }];
    const issuePlan1 = await issueCall('plan', { projectId: 'a', rows: issueRows }, 'admin');
    const issuePlan2 = await issueCall('plan', { projectId: 'a', rows: issueRows }, 'admin2');
    assert.equal(issuePlan1.status, 200, JSON.stringify(issuePlan1.body)); assert.equal(issuePlan1.body.ok, true, JSON.stringify(issuePlan1.body.rows));
    assert.equal(await db.docRegisterItemRevision.count({ where: { itemId: 'file-item' } }), 0, 'предпросмотр выпуска не пишет');
    assert.equal((await issueCall('plan', { projectId: 'a', rows: issueRows }, 'admin', true)).status, 403, 'без доступа к проекту — отказ');
    const issueHashes = { 'file-item': 'd'.repeat(64) };
    const issueResults = await Promise.all([
      issueCall('apply', { projectId: 'a', planId: issuePlan1.body.id, hashes: issueHashes }, 'admin'),
      issueCall('apply', { projectId: 'a', planId: issuePlan2.body.id, hashes: issueHashes }, 'admin2'),
    ]);
    assert.deepEqual(issueResults.map(result => result.status).sort(), [200, 409], 'два одновременных выпуска одной ревизии: 200 и 409');
    assert.equal(await db.docRegisterItemRevision.count({ where: { itemId: 'file-item', issuedKey: { not: null } } }), 1, 'одна действующая ревизия');
    const issueWinner = issueResults[0].status === 200 ? { plan: issuePlan1, actor: 'admin' } : { plan: issuePlan2, actor: 'admin2' };
    const repeated = await issueCall('apply', { projectId: 'a', planId: issueWinner.plan.body.id, hashes: issueHashes }, issueWinner.actor);
    assert.equal(repeated.status, 200); assert.equal(repeated.body.repeated, true);
    assert.equal(await db.docRegisterItemRevision.count({ where: { itemId: 'file-item' } }), 1, 'повтор не плодит ревизий');
    const recorded = await db.docRegisterItemRevision.findFirst({ where: { itemId: 'file-item' } });
    await assert.rejects(db.docRegisterItemRevision.create({ data: { itemId: 'file-item', revision: 'A', issuedKey: recorded.issuedKey } }), 'SQL уникальность ключа выпуска');
    assert.equal((await issueCall('undo', { projectId: 'a', planId: issueWinner.plan.body.id }, issueWinner.actor)).status, 200);
    assert.equal(await db.docRegisterItemRevision.count({ where: { itemId: 'file-item', issuedKey: { not: null } } }), 0, 'отмена освобождает ключ');
    assert.equal((await db.docRegisterItemRevision.findFirst({ where: { itemId: 'file-item' } })).sha256, 'd'.repeat(64), 'история и отпечаток сохраняются');
    await db.docFileLink.delete({ where: { id: issueLink.id } });
    await db.docRegisterItemRevision.deleteMany({ where: { itemId: 'file-item' } });
    console.log(`✓ ${provider}: выпуск пачкой, уникальный ключ, конкуренция, повтор и отмена`);

    // Все действия проходят через те же планы и транзакции, что HTTP-маршрут.
    await db.catalogManufacturer.create({ data: { id: 'maker', name: 'Изготовитель' } });
    const commonDocument = { id: 'common-family', classId: 'class', manufacturerId: 'maker', code: 'COMMON', title: { ru: 'Модель' }, typeLabel: { ru: 'Тип' }, kind: 'fan', shapes: [], match: { kinds: [] }, status: 'partial', designationMode: 'free', params: [], positions: [], specs: [], rules: [] };
    const common = await db.catalogFamily.create({ data: { id: commonDocument.id, classId: 'class', manufacturerId: 'maker', code: commonDocument.code, status: commonDocument.status, dataJson: JSON.stringify(commonDocument) } });
    const scope = { prisma: db, projectId: 'a', actorId: 'admin' };
    const snapshot = (id: string) => db.catalogFamily.findUnique({ where: { id } });
    const preview = (input: any) => planProjectFamily(scope, input);
    const take = await preview({ operation: 'take', familyId: common.id });
    const familyId = take.rows[0].id;
    assert.equal(await snapshot(familyId), null, 'предпросмотр не создаёт позицию');
    await applyProjectFamily(scope, take.id);
    let project = await snapshot(familyId);
    assert.equal(project.basedOnRevision, projectFamilyRevision(common));
    assert.equal(project.baseDataJson, JSON.stringify(familyDocument(project)), 'зафиксирован исходный документ');
    const duplicate = { ...project, id: 'duplicate-project-family' };
    delete duplicate.createdAt; delete duplicate.updatedAt;
    await assert.rejects(db.catalogFamily.create({ data: duplicate }), 'SQL уникальность проекта и общей позиции');
    const localDocument = { ...familyDocument(project), code: 'PROJECT-OVERRIDE' };
    const edit = await preview({ operation: 'edit', familyId, expectedRevision: projectFamilyRevision(project), document: localDocument });
    await applyProjectFamily(scope, edit.id);
    project = await snapshot(familyId);
    assert.equal(familyDocument(project).code, 'PROJECT-OVERRIDE');
    const pinned = project.baseDataJson;
    const modifiedCommon = { ...familyDocument(common), code: 'COMMON-CHANGED' };
    await db.catalogFamily.update({ where: { id: common.id }, data: { code: modifiedCommon.code, dataJson: JSON.stringify(modifiedCommon), updatedAt: new Date(common.updatedAt.getTime() + 1000) } });
    const changedCommon = await snapshot(common.id);
    project = await snapshot(familyId);
    assert.equal(project.baseDataJson, pinned, 'общая правка не меняет закреплённую основу');
    assert.equal(familyDocument(project).code, 'PROJECT-OVERRIDE');
    assert.notEqual(project.basedOnRevision, projectFamilyRevision(changedCommon));
    const update = await preview({ operation: 'update', familyId, expectedRevision: projectFamilyRevision(project) });
    assert.ok(update.rows[0].conflicts.some((x: any) => x.path.join('.') === 'code'), 'показан конфликт изменений');
    await applyProjectFamily(scope, update.id);
    project = await snapshot(familyId);
    assert.equal(project.basedOnRevision, projectFamilyRevision(changedCommon));
    assert.equal(familyDocument(project).code, 'PROJECT-OVERRIDE', 'переопределение сохранено');
    const reset = await preview({ operation: 'reset', familyId, expectedRevision: projectFamilyRevision(project) });
    await applyProjectFamily(scope, reset.id);
    project = await snapshot(familyId);
    assert.equal(familyDocument(project).code, 'COMMON-CHANGED', 'сброс к закреплённой основе');
    await assert.rejects(undoProjectFamily(scope, update.id), 'отмена не затирает последующий сброс');
    await undoProjectFamily(scope, reset.id);
    project = await snapshot(familyId);
    assert.equal(familyDocument(project).code, 'PROJECT-OVERRIDE', 'отмена восстанавливает локальную правку');
    await assert.rejects(planProjectFamily({ ...scope, projectId: 'b' }, { operation: 'take', familyId }), 'проектная позиция не может быть общей основой');
    await assert.rejects(planProjectFamily({ ...scope, projectId: 'b' }, { operation: 'edit', familyId, expectedRevision: projectFamilyRevision(project), document: familyDocument(project) }), 'чужой проект не меняет позицию');
    assert.equal((await snapshot(common.id)).dataJson, JSON.stringify(modifiedCommon), 'проектные действия не изменили общий документ');
    console.log(`✓ ${provider}: каталог проекта, закрепление, обновление, SQL уникальность и безопасная отмена`);



  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.$disconnect(); if (local) fs.rmSync(tmp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
