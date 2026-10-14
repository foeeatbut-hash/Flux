/** Живой контракт источников Office на отдельной SQLite-базе. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import net from 'node:net';
import { toProjectQuery } from '../src/components/office/fluxData.js';
import { officeEntityId } from '../src/lib/officeModel.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const cwd = process.cwd();
let port = 0, base = '';
let dataDir = '', dbPath = '';
let child: ChildProcess | null = null, db: any = null, serverLog = '';
const stamp = crypto.randomBytes(5).toString('hex');
const projectId = `office_src_project_${stamp}`;
const user = { id: `office_src_user_${stamp}`, symbol: `OS${stamp}`, password: crypto.randomBytes(16).toString('hex') };
const outsider = { id: `office_src_out_${stamp}`, symbol: `OX${stamp}`, password: crypto.randomBytes(16).toString('hex') };
const now = new Date().toISOString();
let failures = 0;
const pass = (label: string, condition: unknown, detail?: unknown) => {
  if (condition) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)); }
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

async function availablePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Не удалось получить порт одноразового сервера');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitHealthy() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) {
        const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
        const found = !!probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='User'").get();
        probe.close();
        if (found) return;
      }
    } catch { }
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Одноразовый сервер завершился с кодом ${child.exitCode}\n${serverLog}`);
    await wait(250);
  }
  throw new Error('Одноразовый сервер не стал доступен за 30 секунд');
}

function launch(): ChildProcess {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd, env: {
    ...process.env, VENT_APP_DATA: dataDir, PORT: String(port), FLUX_LISTEN_HOST: '127.0.0.1', FLUX_API_ONLY: '1',
    FLUX_TEST_LICENSE: '1', FLUX_TEST_LICENSE_AUTO: '1', NODE_ENV: 'test',
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr?.on('data', (chunk) => { serverLog += String(chunk); });
  return proc;
}

async function stop() {
  if (!child) return;
  const current = child; child = null;
  if (current.exitCode !== null) return;
  current.kill('SIGTERM');
  await Promise.race([new Promise<void>((resolve) => current.once('exit', () => resolve())), wait(5000)]);
  if (current.exitCode === null) current.kill('SIGKILL');
}

async function request(token: string, method: string, route: string, body?: unknown) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { }
  return { status: response.status, json, text };
}

function seed() {
  const insertUser = db.prepare('INSERT INTO User (id, symbol, password, name, role, isActive, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)');
  db.transaction(() => {
    insertUser.run(user.id, user.symbol, hashPassword(user.password), 'Office Sources Member', 'ENGINEER_VENT', now);
    insertUser.run(outsider.id, outsider.symbol, hashPassword(outsider.password), 'Office Sources Outsider', 'ENGINEER_VENT', now);
    db.prepare('INSERT INTO Project (id, name, createdAt) VALUES (?, ?, ?)').run(projectId, 'Office Sources Fixture', now);
    db.prepare('INSERT INTO ProjectMember (id, projectId, userId, addedBy, addedAt) VALUES (?, ?, ?, ?, ?)').run(`membership_${stamp}`, projectId, user.id, user.id, now);
    db.prepare('INSERT INTO EquipmentSystem (id, name, projectId, category, createdAt) VALUES (?, ?, ?, ?, ?)').run(`sys_${stamp}`, 'П1', projectId, 'AHU', now);
    db.prepare('INSERT INTO Monoblock (id, name, systemId, createdAt) VALUES (?, ?, ?, ?)').run(`mono_${stamp}`, 'МБ-1', `sys_${stamp}`, now);
    db.prepare('INSERT INTO ComponentElement (id, name, itemCode, monoblockId, specs, equipType, status, hasConflict, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
      .run(`element_${stamp}`, 'Узел E3', 'EQ-1', `mono_${stamp}`, '{}', 'КЛАПАН', 'OK', now, now);
    db.prepare('INSERT INTO Tag (id, identifier, projectId, metadata, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`tag_${stamp}`, 'TAG-1', projectId, JSON.stringify({ procurement: { stage: 'ordered', supplier: 'Поставщик 1', qty: '2', note: 'Срочно', stageLog: { ordered: { at: now, by: user.id } } } }), now, now);
    db.prepare('INSERT INTO E3Project (id, fluxProjectId, key, name, path, e3Version, partsDb, lastSeenAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`e3p_${stamp}`, projectId, `key-${stamp}`, 'Схема-1', '', '', '', now, now);
    db.prepare('INSERT INTO E3Binding (id, e3ProjectId, elementId, solutionId, answersJson, manualSolution, designation, sheet, sentVersion, sentAttrsJson, overridesJson, state, lastExportId, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`e3b_${stamp}`, `e3p_${stamp}`, `element_${stamp}`, 'SOL-1', JSON.stringify({}), 0, 'XV-1', 'Лист 1', 'v1', JSON.stringify({ '|MOTOR_POWER': '4 kW' }), JSON.stringify({ '|MOTOR_POWER': '5 kW' }), 'PLACED', '', now);
    db.prepare('INSERT INTO DocRegister (id, projectId, name, vendor, contractor, owner, poNumber, revision, revisions, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`reg_${stamp}`, projectId, 'ВДР 1', 'Поставщик 1', 'Подрядчик 1', 'Владелец 1', 'PO-1', 'B', JSON.stringify([{ revision: 'A' }, { revision: 'B' }]), now, now);
    db.prepare('INSERT INTO DocRegisterItem (id, registerId, projectId, contractorNo, titleRu, titleEn, vdrCode, revision, equipmentTags, status, remarks, reviewCode, dueDate, extra, meta, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`doc_${stamp}`, `reg_${stamp}`, projectId, 'C-1', 'Паспорт', 'Passport', 'C01', '2', JSON.stringify(['TAG-1']), 'READY', 'Замечание', 'A', '2027-01-01', JSON.stringify({ CustomColumn: 'X' }), JSON.stringify({ flag: 'Y' }), now, now);
    db.prepare('INSERT INTO AppSetting (id, key, userId, value, updatedAt) VALUES (?, ?, NULL, ?, ?)')
      .run(`setting-stage-${stamp}`, 'procurement_stages', JSON.stringify([{ id: 'ordered', label: 'Заказан' }, { id: 'purchased', label: 'Куплен' }]), now);
    db.prepare('INSERT INTO AppSetting (id, key, userId, value, updatedAt) VALUES (?, ?, NULL, ?, ?)')
      .run(`setting-attr-${stamp}`, 'e3_attributes', JSON.stringify({ version: 1, items: [{ name: 'MOTOR_POWER', title: 'Мощность', removed: false }] }), now);
    db.prepare('INSERT INTO AppSetting (id, key, userId, value, updatedAt) VALUES (?, ?, NULL, ?, ?)')
      .run(`setting-solution-${stamp}`, 'e3_solutions', JSON.stringify({ version: 1, solutions: [{ id: 'SOL-1', name: 'Клапан с приводом', mainClass: 'VALVE', features: {}, recipeOverride: [{ role: 'Привод', row: { group: 'Приводы', name: 'Пружинный' }, count: 2 }] }], ioTable: [{ id: 'io-spring', group: 'Приводы', name: 'Пружинный', code: 'SP', di: 1, do: 2, ai: 0, ao: 0 }], ioRules: [] }), now);
    const addTag = db.prepare('INSERT INTO Tag (id, identifier, projectId, metadata, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 1001; i++) addTag.run(`bulk_${stamp}_${String(i).padStart(4, '0')}`, `BULK-${String(i).padStart(4, '0')}`, projectId, JSON.stringify({ procurement: { supplier: 'Bulk Supplier', qty: String(i) } }), now, now);
  })();
}

async function main() {
  port = await availablePort();
  base = `http://127.0.0.1:${port}`;
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'flux-office-sources-'));
  dbPath = path.join(dataDir, 'database.sqlite');
  child = launch();
  await waitHealthy();
  db = new Database(dbPath);
  seed();
  const login = async (who: typeof user) => (await request('', 'POST', '/api/login', { symbol: who.symbol, password: who.password })).json?.token || '';
  const token = await login(user), outsiderToken = await login(outsider);
  pass('member and outsider authenticate to disposable API', !!token && !!outsiderToken);
  assert(token && outsiderToken, 'Fixture login failed');

  console.log('1. Management catalogue and rows');
  const catalog = await request(token, 'GET', `/api/project-data/catalog?projectId=${projectId}`);
  const managementPaths = new Set((catalog.json?.managementFields || []).map((field: any) => field.path));
  pass('catalog describes stored procurement and VDR fields', catalog.status === 200 && managementPaths.has('procurement.stageHistory') && managementPaths.has('vdr.titleRu') && managementPaths.has('vdr.extra.CustomColumn'), catalog.json);
  const mgmtQuery = { entity: 'management', columns: ['tag.identifier', 'procurement.stage', 'procurement.stageName', 'procurement.supplier', 'procurement.qty'], filters: [], sort: [{ field: 'procurement.supplier', dir: 'asc' }], limit: 20, excludedEntityIds: [] };
  const management = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: mgmtQuery });
  const procurement = management.json?.rows?.find((row: any) => row.entityType === 'procurement' && row.tag === 'TAG-1');
  pass('procurement row uses the persistent tag ID and returns canonical numeric quantity', management.status === 200 && procurement?.sourceId === 'management' && procurement?.values?.['procurement.stage']?.value === 'ordered' && procurement?.values?.['procurement.stageName']?.value === 'Заказан' && procurement?.values?.['procurement.qty']?.value === 2, procurement);
  const vdrQuery = { entity: 'management', types: ['vdr'], columns: ['vdr.register', 'vdr.vendor', 'vdr.titleRu', 'vdr.tags', 'vdr.extra.CustomColumn'], filters: [], sort: [], limit: 10 };
  const vdr = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: vdrQuery });
  const doc = vdr.json?.rows?.find((row: any) => row.entityType === 'vdr');
  pass('VDR rows expose stored document fields and match tags by identifier', vdr.status === 200 && doc?.values?.['vdr.titleRu']?.value === 'Паспорт' && doc?.values?.['vdr.tags']?.value === 'TAG-1' && doc?.values?.['vdr.extra.CustomColumn']?.value === 'X', vdr);
  const numericGuard = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: { entity: 'management', columns: ['procurement.qty'], filters: [{ field: 'procurement.qty', op: 'gte', value: '0' }], sort: [], limit: 2000 } });
  pass('numeric comparison ignores missing values instead of treating them as zero', numericGuard.status === 200 && numericGuard.json?.total === 1002 && numericGuard.json.rows.every((row: any) => row.entityType === 'procurement'), { total: numericGuard.json?.total, types: [...new Set((numericGuard.json?.rows || []).map((row: any) => row.entityType))] });

  console.log('2. E3Flux positions, attributes and IO');
  const e3CatalogFields = new Set((catalog.json?.e3fluxFields || []).map((field: any) => field.path));
  pass('catalog includes configured E3 attributes and IO fields', e3CatalogFields.has('e3.attr:|MOTOR_POWER') && e3CatalogFields.has('e3.io:io-spring|di'), [...e3CatalogFields]);
  const e3Query = { entity: 'e3flux', columns: ['element.itemCode', 'element.name', 'e3.sheet', 'e3.solutionName', 'e3.designation', 'e3.attr:|MOTOR_POWER', 'e3.override:|MOTOR_POWER', 'e3.devices', 'e3.di', 'e3.do', 'e3.io:io-spring|di'], filters: [], sort: [], limit: 20 };
  const e3 = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: e3Query });
  const position = e3.json?.rows?.[0];
  pass('E3 row is joined by element ID and returns stored attributes plus calculated recipe IO', e3.status === 200 && position?.entityType === 'e3' && position?.values?.['element.itemCode']?.value === 'EQ-1' && position?.values?.['e3.solutionName']?.value === 'Клапан с приводом' && position?.values?.['e3.attr:|MOTOR_POWER']?.value === '4 kW' && position?.values?.['e3.override:|MOTOR_POWER']?.value === '5 kW' && position?.values?.['e3.di']?.value === 2 && position?.values?.['e3.do']?.value === 4 && position?.values?.['e3.io:io-spring|di']?.value === 2, position);
  const e3Revision = e3.json?.revision;
  db.prepare('UPDATE E3Binding SET sheet = ?, updatedAt = ? WHERE id = ?').run('Лист 2', new Date(Date.now() + 1000).toISOString(), `e3b_${stamp}`);
  const changedBinding = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: e3Query });
  pass('E3 revision changes when binding sheet changes', changedBinding.status === 200 && changedBinding.json?.revision !== e3Revision && changedBinding.json?.rows?.[0]?.values?.['e3.sheet']?.value === 'Лист 2', changedBinding.json);
  db.prepare('UPDATE ComponentElement SET name = ?, updatedAt = ? WHERE id = ?').run('Узел переименован', new Date(Date.now() + 2000).toISOString(), `element_${stamp}`);
  const changedElement = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: e3Query });
  pass('E3 revision changes when Flux element name changes', changedElement.status === 200 && changedElement.json?.revision !== changedBinding.json?.revision && changedElement.json?.rows?.[0]?.values?.['element.name']?.value === 'Узел переименован', changedElement.json);
  const solutionSettingId = `setting-solution-${stamp}`;
  const originalSolutionBook = db.prepare('SELECT value FROM AppSetting WHERE id = ?').get(solutionSettingId)?.value;
  const duplicateSolutionBook = JSON.parse(originalSolutionBook);
  duplicateSolutionBook.solutions.push({ ...duplicateSolutionBook.solutions[0], name: 'Дубликат ID' });
  db.prepare('UPDATE AppSetting SET value = ? WHERE id = ?').run(JSON.stringify(duplicateSolutionBook), solutionSettingId);
  const ambiguousSolution = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: e3Query });
  pass('duplicate E3 solution IDs return an explicit conflict', ambiguousSolution.status === 409 && /неоднозначный ID типового решения/i.test(ambiguousSolution.json?.error || ''), ambiguousSolution.json);
  db.prepare('UPDATE AppSetting SET value = ? WHERE id = ?').run(originalSolutionBook, solutionSettingId);
  const adapter = toProjectQuery({ projectId, sources: ['e3flux'], types: ['e3'], filters: [], sort: [{ fieldKey: 'element.name', direction: 'desc' }], excludedEntityIds: ['skip-me'], limit: 17, columns: ['element.name'] });
  pass('client adapter forwards source types and query options for E3Flux', adapter.entity === 'e3flux' && JSON.stringify(adapter.types) === JSON.stringify(['e3']) && adapter.limit === 17 && Array.isArray(adapter.excludedEntityIds) && (adapter.excludedEntityIds as string[])[0] === 'skip-me', adapter);

  console.log('3. Filters, ordering, empty and ambiguous source data');
  const before = Date.now();
  const large = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: { entity: 'management', columns: ['tag.identifier'], filters: [{ field: 'procurement.qty', op: 'gte', value: '1000' }], sort: [{ field: 'procurement.qty', dir: 'desc' }], limit: 1001 } });
  const elapsed = Date.now() - before;
  pass('1,000-plus query filters and sorts without hanging', large.status === 200 && large.json?.total === 1 && elapsed < 10000, { elapsed, total: large.json?.total });
  const multipleSort = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: { entity: 'management', types: ['procurement'], columns: ['tag.identifier', 'procurement.qty'], filters: [{ field: 'procurement.supplier', op: 'equals', value: 'Bulk Supplier' }], sort: [{ field: 'procurement.qty', dir: 'desc' }, { field: 'tag.identifier', dir: 'asc' }], limit: 2 } });
  pass('query applies type filter and multiple stable sort keys', multipleSort.status === 200 && multipleSort.json?.total === 1001 && multipleSort.json?.rows?.[0]?.values?.['procurement.qty']?.value === 1000 && multipleSort.json?.rows?.[1]?.values?.['procurement.qty']?.value === 999, multipleSort.json);
  const excluded = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: { ...mgmtQuery, columns: ['tag.identifier'], limit: 2, excludedEntityIds: [procurement.entityId] } });
  pass('excluded stable entity IDs do not consume the page limit', excluded.status === 200 && excluded.json?.rows?.length === 2 && !excluded.json.rows.some((row: any) => row.entityId === procurement.entityId) && excluded.json.total >= 1001, excluded.json);
  const emptyProject = `office_src_empty_${stamp}`;
  db.prepare('INSERT INTO Project (id, name, createdAt) VALUES (?, ?, ?)').run(emptyProject, 'Empty project', now);
  db.prepare('INSERT INTO ProjectMember (id, projectId, userId, addedBy, addedAt) VALUES (?, ?, ?, ?, ?)').run(`membership_empty_${stamp}`, emptyProject, user.id, user.id, now);
  const empty = await request(token, 'POST', '/api/project-data/office/query', { projectId: emptyProject, query: { entity: 'e3flux', columns: ['e3.solutionId'], filters: [], sort: [], limit: 20 } });
  pass('empty E3 project returns an empty result with a source revision', empty.status === 200 && empty.json?.total === 0 && empty.json?.rows?.length === 0 && !!empty.json?.revision, empty.json);
  db.prepare('INSERT INTO Tag (id, identifier, projectId, metadata, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(`tag_dup_${stamp}`, 'DUP', projectId, '{}', now, now);
  db.prepare('INSERT INTO Tag (id, identifier, projectId, metadata, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(`tag_dup2_${stamp}`, 'DUP', projectId, '{}', now, now);
  db.prepare('INSERT INTO DocRegisterItem (id, registerId, projectId, contractorNo, equipmentTags, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`doc_amb_${stamp}`, `reg_${stamp}`, projectId, 'C-2', JSON.stringify(['DUP']), now, now);
  const ambiguous = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: vdrQuery });
  const ambiguousRow = ambiguous.json?.rows?.find((row: any) => row.entityId === officeEntityId('management', 'vdr', `doc_amb_${stamp}`));
  const goodRow = ambiguous.json?.rows?.find((row: any) => row.entityId === officeEntityId('management', 'vdr', `doc_${stamp}`));
  const ambiguousProc = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: mgmtQuery });
  pass('ambiguous VDR tag breaks only that row value, other VDR and procurement rows stay readable', ambiguous.status === 200 && ambiguousRow?.values?.['vdr.tags']?.value === null && goodRow?.values?.['vdr.tags']?.value === 'TAG-1' && ambiguousProc.status === 200 && ambiguousProc.json?.rows?.some((row: any) => row.tag === 'TAG-1'), { status: ambiguous.status, ambiguousRow, goodRow });
  const ambiguousWarn = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: { ...vdrQuery, columns: ['vdr.tags', 'vdr.tagsConflict'] } });
  pass('ambiguity is reported in the per-row vdr.tagsConflict field', /DUP/.test(String(ambiguousWarn.json?.rows?.find((row: any) => row.entityId === ambiguousRow?.entityId)?.values?.['vdr.tagsConflict']?.value)), ambiguousWarn.json);

  console.log('4. Project permissions');
  const denied = await request(outsiderToken, 'POST', '/api/project-data/office/query', { projectId, query: mgmtQuery });
  const deniedE3 = await request(outsiderToken, 'POST', '/api/project-data/office/query', { projectId, query: e3Query });
  const deniedCatalog = await request(outsiderToken, 'GET', `/api/project-data/catalog?projectId=${projectId}`);
  pass('outsider cannot read either Office source or its field catalog', [403, 404].includes(denied.status) && [403, 404].includes(deniedE3.status) && [403, 404].includes(deniedCatalog.status), [denied.status, deniedE3.status, deniedCatalog.status]);
  pass('source revision is checked on reads', (await request(token, 'POST', '/api/project-data/office/query', { projectId, sourceRevision: 'stale', query: mgmtQuery })).status === 409);
  db.prepare('INSERT INTO E3Project (id, fluxProjectId, key, name, path, e3Version, partsDb, lastSeenAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`e3p2_${stamp}`, projectId, `key2-${stamp}`, 'Схема-2', '', '', '', now, now);
  db.prepare('INSERT INTO E3Binding (id, e3ProjectId, elementId, solutionId, answersJson, manualSolution, designation, sheet, sentVersion, sentAttrsJson, overridesJson, state, lastExportId, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`e3b2_${stamp}`, `e3p2_${stamp}`, `element_${stamp}`, 'SOL-1', '{}', 0, 'XV-1', 'Лист 2', 'v1', '{}', '{}', 'PLACED', '', now);
  const duplicateE3 = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: e3Query });
  pass('two E3 project bindings for one Flux element fail explicitly', duplicateE3.status === 409 && /несколько привязок E3/i.test(duplicateE3.json?.error || ''), duplicateE3.json);

  console.log('5. Scale, owner-keyed attributes, malformed settings, missing lazy tables');
  const bigProject = `office_src_big_${stamp}`, bigCount = 3000;
  db.transaction(() => {
    db.prepare('INSERT INTO Project (id, name, createdAt) VALUES (?, ?, ?)').run(bigProject, 'Office big E3', now);
    db.prepare('INSERT INTO ProjectMember (id, projectId, userId, addedBy, addedAt) VALUES (?, ?, ?, ?, ?)').run(`membership_big_${stamp}`, bigProject, user.id, user.id, now);
    db.prepare('INSERT INTO EquipmentSystem (id, name, projectId, category, createdAt) VALUES (?, ?, ?, ?, ?)').run(`bsys_${stamp}`, 'П2', bigProject, 'AHU', now);
    db.prepare('INSERT INTO Monoblock (id, name, systemId, createdAt) VALUES (?, ?, ?, ?)').run(`bmono_${stamp}`, 'МБ-2', `bsys_${stamp}`, now);
    db.prepare('INSERT INTO E3Project (id, fluxProjectId, key, name, path, e3Version, partsDb, lastSeenAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`bige3_${stamp}`, bigProject, `bigkey-${stamp}`, 'Большая схема', '', '', '', now, now);
    const addElement = db.prepare('INSERT INTO ComponentElement (id, name, itemCode, monoblockId, specs, equipType, status, hasConflict, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)');
    const addBinding = db.prepare('INSERT INTO E3Binding (id, e3ProjectId, elementId, solutionId, answersJson, manualSolution, designation, sheet, sentVersion, sentAttrsJson, overridesJson, state, lastExportId, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < bigCount; i++) {
      addElement.run(`bel_${stamp}_${i}`, `Узел ${i}`, `BE-${i}`, `bmono_${stamp}`, '{}', 'КЛАПАН', 'OK', now, now);
      addBinding.run(`bbind_${stamp}_${i}`, `bige3_${stamp}`, `bel_${stamp}_${i}`, 'SOL-1', '{}', 0, `XV-${i}`, 'Лист 1', 'v1', JSON.stringify({ 'Двигатель|MOTOR_POWER': `${i} kW` }), '{}', 'PLACED', '', now);
    }
  })();
  const bigQuery = { entity: 'e3flux', columns: ['element.itemCode', 'e3.di', 'e3.attr:|MOTOR_POWER'], filters: [], sort: [], limit: 5000 };
  const bigStart = Date.now();
  const big = await request(token, 'POST', '/api/project-data/office/query', { projectId: bigProject, query: bigQuery });
  const bigElapsed = Date.now() - bigStart;
  pass(`E3 with ${bigCount} bound elements is read in linear time`, big.status === 200 && big.json?.total === bigCount && bigElapsed < 3000, { status: big.status, elapsed: bigElapsed, total: big.json?.total });
  console.log(`    (${bigCount} E3 rows in ${bigElapsed} ms)`);
  const bigRow = big.json?.rows?.find((row: any) => row.values?.['element.itemCode']?.value === 'BE-7');
  pass('configured E3 column resolves a value stored under an owner key', bigRow?.values?.['e3.attr:|MOTOR_POWER']?.value === '7 kW' && bigRow?.values?.['e3.di']?.value === 2, bigRow);

  const attrSettingId = `setting-attr-${stamp}`, stageSettingId = `setting-stage-${stamp}`;
  const originalAttrs = db.prepare('SELECT value FROM AppSetting WHERE id = ?').get(attrSettingId)?.value;
  const originalStages = db.prepare('SELECT value FROM AppSetting WHERE id = ?').get(stageSettingId)?.value;
  db.prepare('UPDATE AppSetting SET value = ? WHERE id = ?').run(JSON.stringify({ version: 1, items: 'oops' }), attrSettingId);
  db.prepare('UPDATE AppSetting SET value = ? WHERE id = ?').run('null', stageSettingId);
  const malformedCatalog = await request(token, 'GET', `/api/project-data/catalog?projectId=${projectId}`);
  const malformedRows = await request(token, 'POST', '/api/project-data/office/query', { projectId: bigProject, query: { ...bigQuery, columns: ['element.itemCode'] } });
  const malformedMgmt = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: mgmtQuery });
  pass('malformed settings (items not an array, null) are treated as empty', malformedCatalog.status === 200 && malformedRows.status === 200 && malformedMgmt.status === 200, [malformedCatalog.status, malformedRows.status, malformedMgmt.status]);
  db.prepare('UPDATE AppSetting SET value = ? WHERE id = ?').run(originalAttrs, attrSettingId);
  db.prepare('UPDATE AppSetting SET value = ? WHERE id = ?').run(originalStages, stageSettingId);

  // Таблицы ВДР и E3 создаются лениво: на свежей базе их может не быть, каталог и ряды не должны отвечать 500.
  for (const table of ['DocRegisterItemRevision', 'DocRegisterItem', 'DocRegister', 'E3Binding', 'E3Project']) db.exec(`DROP TABLE IF EXISTS "${table}"`);
  const bareCatalog = await request(token, 'GET', `/api/project-data/catalog?projectId=${projectId}`);
  const bareManagement = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: mgmtQuery });
  const bareE3 = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: { ...e3Query, columns: ['element.itemCode', 'e3.sheet'] } });
  const bareVdr = await request(token, 'POST', '/api/project-data/office/query', { projectId, query: { ...vdrQuery, columns: ['vdr.register', 'vdr.titleRu'] } });
  pass('catalog keeps Tags/Equipment and static source fields when VDR/E3 tables are missing', bareCatalog.status === 200 && Array.isArray(bareCatalog.json?.managementFields) && (bareCatalog.json?.e3fluxFields || []).some((field: any) => field.path === 'e3.sheet'), [bareCatalog.status, bareCatalog.text.slice(0, 200)]);
  pass('rows of missing-table sources are empty, procurement rows still readable', bareManagement.status === 200 && bareManagement.json?.rows?.some((row: any) => row.tag === 'TAG-1') && bareE3.status === 200 && bareE3.json?.total === 0 && bareVdr.status === 200 && bareVdr.json?.total === 0, [bareManagement.status, bareE3.status, bareE3.json?.total, bareVdr.status, bareVdr.json?.total]);
}

void (async () => {
  try {
    await main();
    console.log(`\nOffice source API: ${failures} провалено`);
    process.exitCode = failures ? 1 : 0;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await stop();
    db?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
})();
