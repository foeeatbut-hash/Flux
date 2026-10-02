// Actual HTTP checks for employee import. This intentionally writes test users.
// Run only against a disposable SQLite fixture with the explicit opt-in below.
// Required environment:
//   FLUX_EMPLOYEE_IMPORT_HTTP_FIXTURE=1
//   FLUX_API=http://127.0.0.1:3100
//   FLUX_TEST_DB=/tmp/<fixture>/database.sqlite
//   FLUX_USER and FLUX_PASS for the fixture owner account
// Optional FLUX_TEST_EMPLOYEE_SYMBOL_PREFIX (defaults to HTTP-IT-).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function fail(message) { throw new Error(message); }
if (process.env.FLUX_EMPLOYEE_IMPORT_HTTP_FIXTURE !== '1') {
  fail('Refusing to run: set FLUX_EMPLOYEE_IMPORT_HTTP_FIXTURE=1 for a disposable fixture');
}
const base = process.env.FLUX_API || '';
let endpoint;
try { endpoint = new URL(base); } catch { fail('FLUX_API must be a loopback HTTP URL'); }
if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(endpoint.hostname)) {
  fail('Refusing non-loopback FLUX_API');
}
const dbPath = process.env.FLUX_TEST_DB || '';
if (!dbPath || !fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) fail('FLUX_TEST_DB must name an existing fixture SQLite file');
const tempRoot = fs.realpathSync(os.tmpdir());
const realDbPath = fs.realpathSync(dbPath);
if (!realDbPath.startsWith(tempRoot + path.sep) || path.basename(realDbPath) !== 'database.sqlite') {
  fail('Refusing database outside an OS-temp fixture directory');
}
if (!process.env.FLUX_USER || !process.env.FLUX_PASS) fail('FLUX_USER and FLUX_PASS must be set for the fixture owner');
const prefix = process.env.FLUX_TEST_EMPLOYEE_SYMBOL_PREFIX || 'HTTP-IT-';
if (!/^[A-Z0-9_-]{1,20}$/.test(prefix)) fail('Invalid FLUX_TEST_EMPLOYEE_SYMBOL_PREFIX');

let checks = 0;
let failures = 0;
function check(name, ok, detail) {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}
async function call(method, urlPath, token, body) {
  const r = await fetch(base + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: r.status, data, text };
}
async function login(symbol, password) {
  const r = await call('POST', '/api/login', null, { symbol, password });
  if (r.status !== 200 || !r.data?.success) fail('fixture login failed');
  return r.data.token;
}
function sqlite(sql, ...args) {
  const p = spawnSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2],sys.argv[3:]); c.commit()', realDbPath, sql, ...args], { encoding: 'utf8' });
  if (p.status !== 0) fail('fixture SQLite operation failed');
}
function resetLoginTimes(symbols) {
  sqlite(`UPDATE "User" SET "lastLoginAt"=NULL WHERE "symbol" IN (${symbols.map(() => '?').join(',')})`, ...symbols);
}
function importInput(symbols, department = 'HTTP fixture') {
  const rows = [['Табельный номер', 'Фамилия', 'Имя', 'Роль', 'Должность', 'Отдел', 'Электронная почта'],
    ...symbols.map((s, i) => [s, `Тестов${i + 1}`, `Сотрудник${i + 1}`, 'ENGINEER_VENT', 'Инженер', department, `fixture${i + 1}@example.invalid`])];
  return { rows, mapping: { symbol: 0, lastName: 1, firstName: 2, role: 3, position: 4, department: 5, email: 6 }, defaultRole: 'ENGINEER_VENT', mode: 'create' };
}
function tokenKey(token) { return `employee_import_batch:${token}`; }
function expireUndo(token) {
  sqlite('UPDATE "AppSetting" SET "value"=? WHERE "key"=?', JSON.stringify({ actorId: 'fixture', expiresAt: 1, items: [], undone: false }), tokenKey(token));
}

(async () => {
  const admin = await login(process.env.FLUX_USER, process.env.FLUX_PASS);
  const symbols = Array.from({ length: 200 }, (_, i) => `${prefix}${String(i + 1).padStart(3, '0')}`);
  const input = importInput(symbols, 'HTTP fixture');
  const p = await call('POST', '/api/users/import/preview', admin, input);
  check('200-row template mapping preview', p.status === 200 && p.data?.rows?.length === 200 && p.data.rows.every(x => !x.error), p.status === 200 ? `${p.data.rows.length} rows` : `HTTP ${p.status}`);
  const applied = await call('POST', '/api/users/import/apply', admin, { ...input, selected: p.data.rows.map(x => x.row) });
  const passRows = applied.data?.credentials || [];
  check('200-row atomic apply and individual credentials', applied.status === 200 && applied.data?.imported === 200 && passRows.length === 200 && !!applied.data.undoToken, applied.status === 200 ? `${applied.data.imported} rows` : `HTTP ${applied.status}`);
  const batchToken = applied.data.undoToken;
  const firstLogin = await call('POST', '/api/login', null, { symbol: passRows[0].symbol, password: passRows[0].password });
  check('generated initial password authenticates', firstLogin.status === 200 && firstLogin.data?.success, firstLogin.status);

  const snapshotPath = `/api/settings/${encodeURIComponent(tokenKey(batchToken))}`;
  const getAdmin = await call('GET', snapshotPath, admin);
  check('admin cannot read undo snapshot through settings', getAdmin.status === 403, getAdmin.status);
  const getEmployee = await call('GET', snapshotPath, firstLogin.data.token);
  check('employee cannot read undo snapshot through settings', getEmployee.status === 403, getEmployee.status);
  const postAdmin = await call('POST', snapshotPath, admin, { value: 'overwritten by fixture' });
  check('admin cannot overwrite undo snapshot through settings', postAdmin.status === 403, postAdmin.status);
  const postEmployee = await call('POST', snapshotPath, firstLogin.data.token, { value: 'overwritten by fixture' });
  check('employee cannot overwrite undo snapshot through settings', postEmployee.status === 403, postEmployee.status);

  const dupe = await call('POST', '/api/users/import/preview', admin, input);
  check('duplicate logins appear as preview errors', dupe.status === 200 && dupe.data.rows.every(x => x.error?.includes('уже существует')), dupe.status === 200 ? 'all 200 rejected' : `HTTP ${dupe.status}`);

  const updateRows = [['Табельный номер', 'Отдел'], [passRows[0].symbol, 'Changed HTTP fixture']];
  const updateMapping = { symbol: 0, department: 1 };
  const up = await call('POST', '/api/users/import/preview', admin, { rows: updateRows, mapping: updateMapping, mode: 'update' });
  check('partial update preview preserves empty columns', up.status === 200 && up.data.rows.length === 1 && !up.data.rows[0].error, up.status);
  const updateApply = await call('POST', '/api/users/import/apply', admin, { rows: updateRows, mapping: updateMapping, mode: 'update', selected: [2] });
  check('partial update apply', updateApply.status === 200 && updateApply.data?.imported === 1, updateApply.status);
  const stillWorks = await call('POST', '/api/login', null, { symbol: passRows[0].symbol, password: passRows[0].password });
  check('existing password preserved after update', stillWorks.status === 200 && stillWorks.data?.success, stillWorks.status);

  const changedUndo = await call('POST', '/api/users/import/undo', admin, { undoToken: batchToken });
  check('undo refuses a changed imported profile', changedUndo.status === 409, changedUndo.status);
  const undoUpdate = await call('POST', '/api/users/import/undo', admin, { undoToken: updateApply.data.undoToken });
  check('update batch can be undone', undoUpdate.status === 200 && undoUpdate.data?.success, undoUpdate.status);

  const otherToken = await login(passRows[1].symbol, passRows[1].password);
  const wrongActor = await call('POST', '/api/users/import/undo', otherToken, { undoToken: batchToken });
  check('another employee cannot undo the batch', wrongActor.status === 403, wrongActor.status);

  const expiredInput = importInput([`${prefix}EXPIRY`], 'expiry fixture');
  const expPreview = await call('POST', '/api/users/import/preview', admin, expiredInput);
  const expApply = await call('POST', '/api/users/import/apply', admin, { ...expiredInput, selected: [2] });
  check('expiry fixture import created', expPreview.status === 200 && !expPreview.data.rows[0].error && expApply.status === 200 && !!expApply.data.undoToken, expApply.status);
  expireUndo(expApply.data.undoToken);
  const expiredUndo = await call('POST', '/api/users/import/undo', admin, { undoToken: expApply.data.undoToken });
  check('expired undo snapshot is rejected', expiredUndo.status === 404, expiredUndo.status);
  const expiredUser = await call('POST', '/api/login', null, { symbol: `${prefix}EXPIRY`, password: expApply.data.credentials[0].password });
  check('expired undo leaves imported employee intact', expiredUser.status === 200 && expiredUser.data?.success, expiredUser.status);
  sqlite('DELETE FROM "User" WHERE "symbol"=?', `${prefix}EXPIRY`);
  sqlite('DELETE FROM "AppSetting" WHERE "key"=?', tokenKey(expApply.data.undoToken));

  const raceInput = importInput([`${prefix}RACE`], 'race fixture');
  const racePreview = await call('POST', '/api/users/import/preview', admin, raceInput);
  check('concurrent apply fixture preview created', racePreview.status === 200 && !racePreview.data.rows[0].error, racePreview.status);
  const raceApplies = await Promise.all([
    call('POST', '/api/users/import/apply', admin, { ...raceInput, selected: [2] }),
    call('POST', '/api/users/import/apply', admin, { ...raceInput, selected: [2] }),
  ]);
  const appliedOnce = raceApplies.filter(r => r.status === 200 && r.data?.imported === 1 && r.data?.undoToken);
  check('concurrent duplicate apply creates one employee', appliedOnce.length === 1 && raceApplies.every(r => [200, 409].includes(r.status)), raceApplies.map(r => r.status).join('/'));
  const raceApply = appliedOnce[0];
  if (!raceApply) fail('concurrent apply produced no undo token');
  const raceResults = await Promise.all([
    call('POST', '/api/users/import/undo', admin, { undoToken: raceApply.data.undoToken }),
    call('POST', '/api/users/import/undo', admin, { undoToken: raceApply.data.undoToken }),
  ]);
  const successCount = raceResults.filter(r => r.status === 200 && r.data?.success).length;
  check('concurrent undo has exactly one winner', successCount === 1 && raceResults.every(r => [200, 404, 409].includes(r.status)), raceResults.map(r => r.status).join('/'));

  const thirdLogin = await call('POST', '/api/login', null, { symbol: passRows[2].symbol, password: passRows[2].password });
  const file = await call('POST', '/api/files', thirdLogin.data.token, { name: 'undo-dependency.txt', filePath: '/shared/undo-dependency.txt', content: 'fixture', type: 'FILE' });
  check('create restrictive FK dependency for undo test', file.status === 200 && !!file.data?.file?.id, file.status);
  const fileId = file.data.file.id;
  resetLoginTimes(symbols);
  const blocked = await call('POST', '/api/users/import/undo', admin, { undoToken: batchToken });
  check('undo remains atomic when a foreign-key dependency blocks deletion', blocked.status === 409, blocked.status);
  sqlite('DELETE FROM "FileNode" WHERE "id"=?', fileId);
  const undone = await call('POST', '/api/users/import/undo', admin, { undoToken: batchToken });
  check('unchanged import batch can be undone after dependency removal', undone.status === 200 && undone.data?.success && undone.data.restored === 200, undone.status === 200 ? `${undone.data.restored} rows` : `HTTP ${undone.status}`);
  console.log(`Completed ${checks} HTTP integration checks: ${failures} failed.`);
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(`Integration failure: ${e.message}`); process.exit(1); });
