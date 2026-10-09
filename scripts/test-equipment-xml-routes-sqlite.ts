/** Интеграционная проверка XML-маршрутов на отдельной временной SQLite-базе. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { registerEquipmentXmlSourceRoutes } from '../server/routes/equipmentXmlSources.js';
import { setPrisma } from '../server/context.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const dir = mkdtempSync(join(tmpdir(), 'flux-eqxml-'));
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: join(dir, 'fixture.sqlite') }) });
let checks = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks++; console.log(`✓ ${label}`); };

const ddl = [
  `CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL DEFAULT '', customer TEXT NOT NULL DEFAULT '', contractor TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', info TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ACTIVE', system BOOLEAN NOT NULL DEFAULT 0, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE Tag (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, brand TEXT, department TEXT, wbs TEXT, fluid TEXT, projectId TEXT NOT NULL, equipmentId TEXT, metadata TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME)`,
  `CREATE TABLE EquipmentSystem (id TEXT PRIMARY KEY, name TEXT NOT NULL, projectId TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'AHU', fileName TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE Monoblock (id TEXT PRIMARY KEY, name TEXT NOT NULL, systemId TEXT NOT NULL, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE ComponentElement (id TEXT PRIMARY KEY, name TEXT NOT NULL, itemCode TEXT NOT NULL, monoblockId TEXT NOT NULL, specs TEXT, equipType TEXT NOT NULL DEFAULT 'ПРОЧЕЕ', overrides TEXT, paramConflicts TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL DEFAULT 'OK', hasConflict BOOLEAN NOT NULL DEFAULT 0, conflictType TEXT, conflictLog TEXT, version INTEGER NOT NULL DEFAULT 1, parentElementId TEXT, role TEXT NOT NULL DEFAULT 'БЛОК', sourceKind TEXT, instanceNo INTEGER, instanceCount INTEGER, sourceOrder INTEGER NOT NULL DEFAULT 0, manual BOOLEAN NOT NULL DEFAULT 0, createdById TEXT, tagNotes TEXT, equipClass TEXT, equipKind TEXT)`,
  `CREATE TABLE _ComponentElementToTag (A TEXT NOT NULL, B TEXT NOT NULL, UNIQUE(A,B))`,
  `CREATE TABLE ProjectMember (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, userId TEXT NOT NULL)`,
  `CREATE TABLE AppSetting (id TEXT PRIMARY KEY, key TEXT NOT NULL, userId TEXT, value TEXT NOT NULL, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(key,userId))`,
  `CREATE TABLE EquipmentHistory (id TEXT PRIMARY KEY, elementId TEXT NOT NULL, version INTEGER NOT NULL, changedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, oldSpecs TEXT, newSpecs TEXT, changeType TEXT NOT NULL, batchId TEXT)`,
  `CREATE TABLE EquipmentXmlSource (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, tagId TEXT NOT NULL, targetType TEXT NOT NULL, systemId TEXT, elementId TEXT NOT NULL, tagIdentifier TEXT NOT NULL, revisionOrder TEXT NOT NULL DEFAULT 'alphabetical', selectedRule TEXT NOT NULL DEFAULT 'exact-tag', lastImportedRevision TEXT, lastImportedSha256 TEXT, lastImportedAt DATETIME, lastReviewedRevision TEXT, lastReviewedSha256 TEXT, lastReviewedAt DATETIME, createdById TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, deletedAt DATETIME)`,
  `CREATE TABLE EquipmentXmlCandidate (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, projectId TEXT NOT NULL, revision TEXT NOT NULL, fileName TEXT NOT NULL, sha256 TEXT NOT NULL, parsedSpecs TEXT NOT NULL, changes TEXT NOT NULL, decisions TEXT NOT NULL DEFAULT '{}', decisionHistory TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', expectedVersion INTEGER NOT NULL, expectedVersions TEXT NOT NULL DEFAULT '{}', uploadedById TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(sourceId,sha256))`,
  `CREATE TABLE EquipmentXmlApplication (id TEXT PRIMARY KEY, batchId TEXT NOT NULL UNIQUE, candidateId TEXT NOT NULL, sourceId TEXT NOT NULL, elementId TEXT NOT NULL, oldSpecs TEXT, newSpecs TEXT, oldOverrides TEXT, newOverrides TEXT, oldVersion INTEGER NOT NULL, newVersion INTEGER NOT NULL, targetSnapshots TEXT NOT NULL DEFAULT '[]', beforeDecisions TEXT NOT NULL, afterDecisions TEXT NOT NULL, beforeStatus TEXT NOT NULL, afterStatus TEXT NOT NULL, oldImportedRevision TEXT, oldImportedSha256 TEXT, oldImportedAt DATETIME, newImportedRevision TEXT, newImportedSha256 TEXT, newImportedAt DATETIME, oldReviewedRevision TEXT, oldReviewedSha256 TEXT, oldReviewedAt DATETIME, newReviewedRevision TEXT, newReviewedSha256 TEXT, newReviewedAt DATETIME, actorId TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
];

const xml = (value: string) => `<project><system name="SYS-1"><monoblock name="M1"><block name="FAN-1"><group title="Параметры"><param name="Давление" unit="Па">${value}</param></group></block></monoblock></system></project>`;
function rawSource(text: string, revision: string, fileName = 'FAN-1.xml') {
  const bytes = Buffer.from(text, 'utf8');
  return { fileName, revision, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, base64: bytes.toString('base64'), selectedRule: { kind: 'exact-tag' } };
}
const routes = new Map<string, Function>();
const app: any = { get: (p: string, f: Function) => routes.set(`GET ${p}`, f), post: (p: string, f: Function) => routes.set(`POST ${p}`, f), put: (p: string, f: Function) => routes.set(`PUT ${p}`, f), delete: (p: string, f: Function) => routes.set(`DELETE ${p}`, f) };
registerEquipmentXmlSourceRoutes(app);
async function call(method: string, path: string, params: Record<string, string>, body: any = {}, actor: any = { id: 'fixture-admin', role: 'ADMIN', isActive: true }) {
  const handler = routes.get(`${method} ${path}`);
  assert.ok(handler, `missing route ${method} ${path}`);
  const result: any = { statusCode: 200, body: null };
  const res: any = { status(code: number) { result.statusCode = code; return this; }, json(value: any) { result.body = value; return this; } };
  await handler({ params, body, authUser: actor } as any, res);
  return result;
}

async function main() {
try {
  for (const sql of ddl) await prisma.$executeRawUnsafe(sql);
  setPrisma(prisma);
  await prisma.$executeRawUnsafe(`INSERT INTO Project(id,name) VALUES ('project-a','Project A'),('project-b','Project B')`);
  await prisma.$executeRawUnsafe(`INSERT INTO ProjectMember(id,projectId,userId) VALUES ('member-a','project-a','fixture-admin')`);
  await prisma.$executeRawUnsafe(`INSERT INTO Tag(id,identifier,projectId) VALUES ('tag-a','FAN-1','project-a'),('tag-b','FAN-1','project-b')`);
  await prisma.$executeRawUnsafe(`INSERT INTO Tag(id,identifier,projectId) VALUES ('tag-root','SYS-1','project-a')`);
  await prisma.$executeRawUnsafe(`INSERT INTO EquipmentSystem(id,name,projectId) VALUES ('sys-a','SYS-1','project-a')`);
  await prisma.$executeRawUnsafe(`INSERT INTO Monoblock(id,name,systemId) VALUES ('mono-a','M1','sys-a')`);
  await prisma.$executeRawUnsafe(`INSERT INTO ComponentElement(id,name,itemCode,monoblockId,specs) VALUES ('unit-root','Установка','__unit__','mono-a',?)`, JSON.stringify({ groups: [{ title: 'Установка', params: [{ key: 'Расход', value: '1', unit: 'м³/с' }] }] }));
  await prisma.$executeRawUnsafe(`INSERT INTO _ComponentElementToTag(A,B) VALUES ('unit-root','tag-root')`);
  await prisma.$executeRawUnsafe(`INSERT INTO EquipmentSystem(id,name,projectId) VALUES ('sys-b','SYS-1','project-b')`);
  await prisma.$executeRawUnsafe(`INSERT INTO Monoblock(id,name,systemId) VALUES ('mono-b','M1','sys-b')`);
  const initialSpecs = JSON.stringify({ groups: [{ title: 'Параметры', params: [{ key: 'Давление', value: '1', unit: 'Па' }] }] });
  await prisma.$executeRawUnsafe(`INSERT INTO ComponentElement(id,name,itemCode,monoblockId,specs) VALUES ('element-a','FAN-1','FAN-1','mono-a',?)`, initialSpecs);
  await prisma.$executeRawUnsafe(`INSERT INTO _ComponentElementToTag(A,B) VALUES ('element-a','tag-a')`);
  const secondSpecs = JSON.stringify({ groups: [{ title: 'Параметры', params: [{ key: 'Давление', value: '5', unit: 'Па' }] }] });
  await prisma.$executeRawUnsafe(`INSERT INTO ComponentElement(id,name,itemCode,monoblockId,specs) VALUES ('element-b','FAN-1','FAN-1','mono-b',?)`, secondSpecs);
  await prisma.$executeRawUnsafe(`INSERT INTO _ComponentElementToTag(A,B) VALUES ('element-b','tag-b')`);

  const sourcePath = '/api/equipment/projects/:projectId/sources';
  const created = await call('POST', sourcePath, { projectId: 'project-a' }, { tagId: 'tag-a', elementId: 'element-a', targetType: 'component', ...rawSource(xml('2'), 'B') });
  check('привязка к другому XML не переписывает позицию и не ставит ложный imported baseline', created.statusCode === 201 && created.body.source.lastImportedSha256 === null && (await prisma.componentElement.findUnique({ where: { id: 'element-a' } })).specs === initialSpecs);
  const sourceId = created.body.source.sourceId;
  const secondSource = await call('POST', sourcePath, { projectId: 'project-b' }, { tagId: 'tag-b', elementId: 'element-b', targetType: 'component', ...rawSource(xml('5'), 'A') });
  check('вторая независимая привязка сохраняется для другого стабильного tagId', secondSource.statusCode === 201 && secondSource.body.source.tagId === 'tag-b' && secondSource.body.source.lastImportedSha256 !== null);
  const checkPath = '/api/equipment/projects/:projectId/sources/:sourceId/check';
  const params = { projectId: 'project-a', sourceId };
  const bad = await call('POST', checkPath, params, rawSource('<broken', 'C'));
  check('повреждённый XML возвращает отказ и не создаёт кандидата', bad.statusCode === 400 && await prisma.equipmentXmlCandidate.count() === 0);
  const firstCheck = await call('POST', checkPath, params, rawSource(xml('2'), 'B'));
  const candidate = firstCheck.body.candidate;
  check('check сохраняет новый кандидат, но не обновляет imported baseline', firstCheck.statusCode === 201 && candidate.status === 'pending' && (await prisma.equipmentXmlSource.findUnique({ where: { id: sourceId } })).lastImportedSha256 === null);
  const decisionsPath = '/api/equipment/projects/:projectId/sources/:sourceId/candidates/:candidateId/decisions';
  const decideParams = { ...params, candidateId: candidate.id };
  const applied = await call('POST', decisionsPath, decideParams, { expectedVersion: candidate.expectedVersion, decisions: [{ id: candidate.changes[0].id, action: 'accept' }] });
  const afterAccept = await prisma.componentElement.findUnique({ where: { id: 'element-a' } });
  const sourceAfterAccept = await prisma.equipmentXmlSource.findUnique({ where: { id: sourceId } });
  check('явный accept записывает характеристику, baseline и историю', applied.statusCode === 200 && JSON.parse(afterAccept.specs).groups[0].params[0].value === '2' && afterAccept.version === 2 && sourceAfterAccept.lastImportedSha256 === candidate.sha256 && await prisma.equipmentXmlApplication.count() === 1);
  const undoPlan = await (await import('../server/equipmentXmlUndo.js')).planXmlRevisionUndo(applied.body.batchId);
  check('неизменённое решение допускает безопасный undo', undoPlan.action === 'restore');
  const undo = await (await import('../server/equipmentXmlUndo.js')).applyXmlRevisionUndo(applied.body.batchId, undoPlan);
  check('undo восстанавливает прежние характеристики', undo.restored === 1 && (await prisma.componentElement.findUnique({ where: { id: 'element-a' } })).specs === initialSpecs);

  // Повторный SHA после внешней правки обязан пересобрать diff на актуальной версии.
  await prisma.componentElement.update({ where: { id: 'element-a' }, data: { specs: JSON.stringify({ groups: [{ title: 'Параметры', params: [{ key: 'Давление', value: '3', unit: 'Па' }] }] }), version: 4, overrides: JSON.stringify({ 'Параметры||Давление': 'ручное' }) } });
  const rebased = await call('POST', checkPath, params, rawSource(xml('2'), 'B'));
  check('same-SHA stale candidate rebases against current raw/manual value', rebased.statusCode === 200 && rebased.body.rebased === true && rebased.body.candidate.expectedVersion === 4 && rebased.body.candidate.changes[0].current.value === 'ручное' && JSON.parse((await prisma.equipmentXmlCandidate.findUnique({ where: { id: candidate.id } })).decisionHistory).length === 1);
  const acceptedManual = await call('POST', decisionsPath, decideParams, { expectedVersion: 4, decisions: [{ id: rebased.body.candidate.changes[0].id, action: 'accept', overrideManual: true }] });
  check('явно принятый XML очищает ручной override по адресу group||key', acceptedManual.statusCode === 200 && (await prisma.componentElement.findUnique({ where: { id: 'element-a' } })).overrides === null);
  const xmlUnchanged = xml('2').replace('<param', '\n<param').replace('</param>', '</param>\n');
  const noDiff = await call('POST', checkPath, params, rawSource(xmlUnchanged, 'C'));
  check('новая ревизия без различий требует отдельного подтверждения без автоматического baseline', noDiff.statusCode === 201 && noDiff.body.candidate.status === 'pending' && (await prisma.equipmentXmlSource.findUnique({ where: { id: sourceId } })).lastImportedSha256 !== noDiff.body.candidate.sha256);
  const confirmed = await call('POST', decisionsPath, { ...params, candidateId: noDiff.body.candidate.id }, { expectedVersion: 5, confirmNoChanges: true });
  check('явное подтверждение no-diff обновляет baseline и создаёт undo snapshot', confirmed.statusCode === 200 && confirmed.body.status === 'complete' && (await prisma.equipmentXmlSource.findUnique({ where: { id: sourceId } })).lastImportedSha256 === noDiff.body.candidate.sha256);
  await prisma.componentElement.update({ where: { id: 'element-a' }, data: { specs: initialSpecs, version: 6 } });
  const changedUndo = await (await import('../server/equipmentXmlUndo.js')).planXmlRevisionUndo(acceptedManual.body.batchId);
  check('undo пропускает операцию после более поздней инженерной правки', changedUndo.action === 'skip');

  const systemXml = `<project><system name="SYS-1"><group title="Установка"><param name="Расход" unit="м³/с">2</param></group><monoblock name="M1"><block name="FAN-1"><group title="Параметры"><param name="Давление" unit="Па">8</param></group></block></monoblock></system></project>`;
  const systemSource = await call('POST', sourcePath, { projectId: 'project-a' }, { tagId: 'tag-root', elementId: 'unit-root', targetType: 'system', systemId: 'sys-a', ...rawSource(systemXml, 'D', 'SYS-1.xml') });
  const systemSourceId = systemSource.body.source.sourceId;
  const systemCandidate = await call('POST', checkPath, { projectId: 'project-a', sourceId: systemSourceId }, rawSource(systemXml, 'D', 'SYS-1.xml'));
  check('системный XML обнаруживает корневую и вложенную характеристику при неизменном составе', systemCandidate.statusCode === 201 && systemCandidate.body.candidate.changes.length === 2 && systemCandidate.body.candidate.changes.some((change: any) => change.targetId === 'unit-root') && systemCandidate.body.candidate.changes.some((change: any) => change.targetId === 'element-a'));
  const systemDecisions = await call('POST', '/api/equipment/projects/:projectId/sources/:sourceId/candidates/:candidateId/decisions', { projectId: 'project-a', sourceId: systemSourceId, candidateId: systemCandidate.body.candidate.id }, { expectedVersion: systemCandidate.body.candidate.expectedVersion, decisions: systemCandidate.body.candidate.changes.map((change: any) => ({ id: change.id, action: 'accept' })) });
  check('решение атомарно обновляет вложенную позицию вместе с корнем установки', systemDecisions.statusCode === 200 && JSON.parse((await prisma.componentElement.findUnique({ where: { id: 'unit-root' } })).specs).groups[0].params[0].value === '2' && JSON.parse((await prisma.componentElement.findUnique({ where: { id: 'element-a' } })).specs).groups[0].params[0].value === '8');
  const systemUndoPlan = await (await import('../server/equipmentXmlUndo.js')).planXmlRevisionUndo(systemDecisions.body.batchId);
  const systemUndo = await (await import('../server/equipmentXmlUndo.js')).applyXmlRevisionUndo(systemDecisions.body.batchId, systemUndoPlan);
  check('undo восстанавливает сразу все позиции системной ревизии', systemUndo.restored === 1 && JSON.parse((await prisma.componentElement.findUnique({ where: { id: 'unit-root' } })).specs).groups[0].params[0].value === '1' && JSON.parse((await prisma.componentElement.findUnique({ where: { id: 'element-a' } })).specs).groups[0].params[0].value === '1');
  const staleChildXml = systemXml.replace('>2</param>', '>3</param>').replace('>8</param>', '>9</param>');
  const staleMulti = await call('POST', checkPath, { projectId: 'project-a', sourceId: systemSourceId }, rawSource(staleChildXml, 'E', 'SYS-1.xml'));
  await prisma.componentElement.update({ where: { id: 'element-a' }, data: { version: (await prisma.componentElement.findUnique({ where: { id: 'element-a' } })).version + 1 } });
  const staleMultiApply = await call('POST', '/api/equipment/projects/:projectId/sources/:sourceId/candidates/:candidateId/decisions', { projectId: 'project-a', sourceId: systemSourceId, candidateId: staleMulti.body.candidate.id }, { expectedVersion: staleMulti.body.candidate.expectedVersion, decisions: staleMulti.body.candidate.changes.map((change: any) => ({ id: change.id, action: 'accept' })) });
  check('изменение вложенной позиции после сравнения блокирует атомарное применение всей ревизии', staleMultiApply.statusCode === 409 && JSON.parse((await prisma.componentElement.findUnique({ where: { id: 'unit-root' } })).specs).groups[0].params[0].value === '1');
  const stableSystemXml = `<project><system name="SYS-1"><group title="Установка"><param name="Расход" unit="м³/с">1</param></group><monoblock name="M1"><block name="FAN-1"><group title="Параметры"><param name="Давление" unit="Па">1</param></group></block></monoblock></system></project>`;
  const stableCandidate = await call('POST', checkPath, { projectId: 'project-a', sourceId: systemSourceId }, rawSource(stableSystemXml, 'F', 'SYS-1.xml'));
  const childVersionBeforeRacedConfirm = (await prisma.componentElement.findUnique({ where: { id: 'element-a' } })).version;
  const originalTransaction = prisma.$transaction.bind(prisma);
  (prisma as any).$transaction = async (...args: any[]) => {
    const child = await prisma.componentElement.findUnique({ where: { id: 'element-a' } });
    await prisma.componentElement.update({ where: { id: 'element-a' }, data: { version: child.version + 1 } });
    (prisma as any).$transaction = originalTransaction;
    return originalTransaction(...args);
  };
  const racedConfirm = await call('POST', '/api/equipment/projects/:projectId/sources/:sourceId/candidates/:candidateId/decisions', { projectId: 'project-a', sourceId: systemSourceId, candidateId: stableCandidate.body.candidate.id }, { expectedVersion: stableCandidate.body.candidate.expectedVersion, confirmNoChanges: true });
  check('confirm no-changes повторно CAS-проверяет неизменённую вложенную позицию внутри транзакции', racedConfirm.statusCode === 409 && (await prisma.componentElement.findUnique({ where: { id: 'element-a' } })).version === childVersionBeforeRacedConfirm + 1 && (await prisma.equipmentXmlSource.findUnique({ where: { id: systemSourceId } })).lastImportedSha256 === null);
  const addedXml = systemXml.replace('<param name="Давление" unit="Па">8</param>', '<param name="Давление" unit="Па">4</param>').replace('</monoblock>', '<block name="FAN-2"><group title="Параметры"><param name="Давление" unit="Па">2</param></group></block></monoblock>');
  const addedCandidate = await call('POST', checkPath, { projectId: 'project-a', sourceId: systemSourceId }, rawSource(addedXml, 'D2', 'SYS-1.xml'));
  const addedAction = addedCandidate.body.candidate.structuralActions.find((action: any) => action.kind === 'added');
  check('структурное сравнение требует явного решения для новой позиции', addedCandidate.statusCode === 201 && !!addedAction && addedAction.proposed.itemCode === 'FAN-2');
  const addedApply = await call('POST', '/api/equipment/projects/:projectId/sources/:sourceId/candidates/:candidateId/decisions', { projectId: 'project-a', sourceId: systemSourceId, candidateId: addedCandidate.body.candidate.id }, { expectedVersion: addedCandidate.body.candidate.expectedVersion, structuralDecisions: [{ id: addedAction.id, action: 'accept' }] });
  const laterParameter = addedCandidate.body.candidate.changes.find((change: any) => change.targetId === 'element-a');
  const laterApply = await call('POST', '/api/equipment/projects/:projectId/sources/:sourceId/candidates/:candidateId/decisions', { projectId: 'project-a', sourceId: systemSourceId, candidateId: addedCandidate.body.candidate.id }, { expectedVersion: addedApply.body.expectedVersion, decisions: [{ id: laterParameter.id, action: 'accept' }] });
  check('повторное частичное решение не дублирует ранее созданную позицию', addedApply.statusCode === 200 && laterApply.statusCode === 200 && await prisma.componentElement.count({ where: { monoblockId: 'mono-a', itemCode: 'FAN-2', status: 'OK' } }) === 1 && JSON.parse((await prisma.componentElement.findUnique({ where: { id: 'element-a' } })).specs).groups[0].params[0].value === '4');
  const addedUndoPlan = await (await import('../server/equipmentXmlUndo.js')).planXmlRevisionUndo(laterApply.body.batchId);
  const addedUndo = await (await import('../server/equipmentXmlUndo.js')).applyXmlRevisionUndo(laterApply.body.batchId, addedUndoPlan);
  const addedElement = await prisma.componentElement.findFirst({ where: { monoblockId: 'mono-a', itemCode: 'FAN-2' } });
  check('единый undo частичной системной ревизии снимает созданную строку и восстанавливает прежние параметры', addedUndo.restored === 1 && (await prisma.componentElement.findFirst({ where: { monoblockId: 'mono-a', itemCode: 'FAN-2' } })).status === 'REMOVED' && JSON.parse((await prisma.componentElement.findUnique({ where: { id: 'element-a' } })).specs).groups[0].params[0].value === '1');
  const restoreCandidate = await call('POST', checkPath, { projectId: 'project-a', sourceId: systemSourceId }, rawSource(addedXml, 'D4', 'SYS-1.xml'));
  const restoreAction = restoreCandidate.body.candidate.structuralActions.find((action: any) => action.kind === 'restored' && action.elementIds.includes(addedElement.id));
  const restoreApply = await call('POST', '/api/equipment/projects/:projectId/sources/:sourceId/candidates/:candidateId/decisions', { projectId: 'project-a', sourceId: systemSourceId, candidateId: restoreCandidate.body.candidate.id }, { expectedVersion: restoreCandidate.body.candidate.expectedVersion, structuralDecisions: [{ id: restoreAction.id, action: 'accept' }] });
  check('явное решение restored возвращает ранее снятую позицию', !!restoreAction && restoreApply.statusCode === 200 && (await prisma.componentElement.findUnique({ where: { id: addedElement.id } })).status === 'OK');
  const removeCandidate = await call('POST', checkPath, { projectId: 'project-a', sourceId: systemSourceId }, rawSource(systemXml, 'D3', 'SYS-1.xml'));
  const removeAction = removeCandidate.body.candidate.structuralActions.find((action: any) => action.kind === 'removed' && action.elementIds.includes(addedElement.id));
  const removeApply = await call('POST', '/api/equipment/projects/:projectId/sources/:sourceId/candidates/:candidateId/decisions', { projectId: 'project-a', sourceId: systemSourceId, candidateId: removeCandidate.body.candidate.id }, { expectedVersion: removeCandidate.body.candidate.expectedVersion, structuralDecisions: [{ id: removeAction.id, action: 'accept' }] });
  check('явное принятие removed снимает отсутствующую в XML позицию, не удаляя запись', !!removeAction && removeApply.statusCode === 200 && (await prisma.componentElement.findFirst({ where: { monoblockId: 'mono-a', itemCode: 'FAN-2' } })).status === 'REMOVED');
  const rebound = await call('PUT', '/api/equipment/projects/:projectId/sources/:sourceId/rebind', params, rawSource(xml('2'), 'B'));
  const staleDecision = await call('POST', decisionsPath, decideParams, { expectedVersion: 6, decisions: [{ id: candidate.changes[0].id, action: 'accept' }] });
  const rechecked = await call('POST', checkPath, params, rawSource(xml('2'), 'B'));
  check('перепривязка блокирует старые решения и требует повторного сравнения даже для прежнего SHA', rebound.statusCode === 200 && staleDecision.statusCode === 409 && rechecked.statusCode === 200 && rechecked.body.rebased === true);

  const unauthorized = await call('GET', '/api/equipment/projects/:projectId/sources/:sourceId/candidates', params, {}, { id: 'outsider', role: 'ENGINEER_VENT', isActive: true });
  check('посторонний участник не читает кандидатов закрытого проекта', unauthorized.statusCode === 403);
  const foreign = await call('GET', '/api/equipment/projects/:projectId/sources/:sourceId/candidates', { projectId: 'project-b', sourceId }, {});
  check('route не переносит источник между проектами', foreign.statusCode === 404);

  const persistedCount = await prisma.equipmentXmlCandidate.count();
  await prisma.$disconnect();
  const restarted = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: join(dir, 'fixture.sqlite') }) });
  setPrisma(restarted);
  check('кандидаты и решения переживают перезапуск клиента базы', await restarted.equipmentXmlCandidate.count() === persistedCount && !!await restarted.equipmentXmlSource.findUnique({ where: { id: sourceId } }));
  await restarted.$disconnect();
  console.log(`\n${checks} интеграционных проверок SQLite пройдено, 0 провалено`);
} finally {
  try { await prisma.$disconnect(); } catch (_) { /* клиент уже остановлен */ }
  rmSync(dir, { recursive: true, force: true });
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
