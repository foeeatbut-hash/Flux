#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mariaDatabaseOptions } from '../../../shared/companyDatabase.ts';
import { ownerTestLogin } from '../ownerTestLogin.ts';

const require = createRequire(import.meta.url);
const mariadb = require('mariadb');
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = realpathSync(path.resolve(here, '../../..'));
const markerName = 'FLUX_REMAINING_LIVE_RUN_ID';
const appPorts = [4300, 4301];
const originFor = port => `http://127.0.0.1:${port}`;
const fixtureNamePattern = /^flux_[a-z0-9_]+_fixture(?:_|$)/;

function fail(message) { throw new Error(message); }

function parseFixtureUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { fail('Set FLUX_REMAINING_LIVE_DATABASE_URL to a valid loopback MariaDB fixture URL.'); }
  if (!['mysql:', 'mariadb:'].includes(u.protocol)) fail('The fixture URL must use mysql:// or mariadb://.');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname.toLowerCase())) fail('The fixture database must be on loopback.');
  if (!u.username || !u.password) fail('The fixture URL must include a dedicated fixture database account.');
  const dbName = decodeURIComponent(u.pathname.slice(1));
  if (!fixtureNamePattern.test(dbName)) fail('The database name must match flux_<name>_fixture (optionally followed by an underscore suffix).');
  if (/[\u0000-\u001f\u007f]/.test(decodeURIComponent(`${u.username}${u.password}${u.pathname}`))) fail('Control characters are not allowed in fixture connection details.');
  return { url: u, dbName };
}

async function assertMariaDb(rawUrl, requireEmpty = true) {
  const { dbName } = parseFixtureUrl(rawUrl);
  const conn = await mariadb.createConnection(mariaDatabaseOptions(rawUrl));
  try {
    const rows = await conn.query('SELECT VERSION() AS version, DATABASE() AS databaseName');
    const version = String(rows[0]?.version || '');
    if (!/mariadb/i.test(version)) fail('The selected database server did not identify itself as MariaDB.');
    if (String(rows[0]?.databaseName || '') !== dbName) fail('MariaDB selected a database different from the fixture name in the URL.');
    if (requireEmpty) {
      const tables = await conn.query('SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
      if (Number(tables[0]?.count) !== 0) fail('The MariaDB fixture database must be empty before server startup. No tables were changed.');
    }
    return { version, dbName };
  } finally {
    await conn.end();
  }
}

function writePrivate(file, data) {
  writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
}

function childEnvironment(dataDir, port, runId) {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: dataDir,
    USERPROFILE: dataDir,
    APPDATA: dataDir,
    TEMP: dataDir,
    TMP: dataDir,
    NODE_ENV: 'test',
    PORT: String(port),
    VENT_APP_DATA: dataDir,
    FLUX_TEST_OWNER: '1',
    FLUX_TEST_LICENSE: '1',
    FLUX_TEST_LICENSE_AUTO: '1',
    FLUX_EMBEDDED: '1',
    FLUX_LISTEN_HOST: '127.0.0.1',
    DISABLE_HMR: 'true',
    // В API-прогоне обе стороны обходятся без Vite; UI-стенд сохраняет первый frontend.
    FLUX_API_ONLY: process.env.FLUX_REMAINING_LIVE_API_ONLY === '1' || port === appPorts[1] ? '1' : '0',
    [markerName]: runId,
  };
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function writeState(stateDir, value) {
  const tmp = path.join(stateDir, 'state.json.tmp');
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  const target = path.join(stateDir, 'state.json');
  rmSync(target, { force: true });
  // Rename is atomic within the private temporary directory.
  renameSync(tmp, target);
}

async function ready(origin, port, expectedVersion, deadlineMs = 180_000) {
  const deadline = Date.now() + deadlineMs;
  let lastReason = 'health endpoint has not answered';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2500) });
      if (response.ok) {
        const health = await response.json();
        if (health.ok === true && health.databaseMode === 'REMOTE' && health.dialect === 'mysql') return;
        lastReason = 'health was not ready with REMOTE/mysql';
      } else lastReason = `health HTTP ${response.status}`;
    } catch { lastReason = 'health endpoint has not answered'; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  fail(`Server on port ${port} did not become ready in time (${lastReason}; MariaDB ${expectedVersion.split(/[- ]/)[0]}). See its private log in the state directory.`);
}

function procStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fieldsFromState = stat.slice(close + 2).trim().split(/\s+/);
    return fieldsFromState[19] || '';
  } catch { return ''; }
}

function readProcIdentity(server, runId) {
  if (process.platform !== 'linux') fail('Safe stop currently requires Linux /proc PID identity checks.');
  try {
    const pid = Number(server.pid);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    const markerPresent = cmdline.includes(`--flux-remaining-live-run=${runId}`);
    const sameStartedProcess = !!server.startedTicks && procStartTicks(pid) === String(server.startedTicks);
    // PID was returned directly by spawn and its kernel start tick was stored
    // privately. Also match the command; this works when /proc/environ is
    // inaccessible under hidepid policies and detects PID reuse.
    return cmdline.includes('server.ts') && (markerPresent || sameStartedProcess);
  } catch { return false; }
}

async function isRecordedServerReady(server) {
  const pid = Number(server.pid);
  let command;
  try { command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); }
  catch { return false; }
  if (!command.includes('server.ts') || !server.startedTicks || procStartTicks(pid) !== String(server.startedTicks)) return false;
  try {
    const response = await fetch(`${server.origin}/api/health`, { signal: AbortSignal.timeout(2500) });
    const body = await response.json();
    return response.ok && body.ok === true && body.databaseMode === 'REMOTE' && body.dialect === 'mysql';
  } catch { return false; }
}

async function stopState(stateDir) {
  const stateFile = path.join(stateDir, 'state.json');
  if (!existsSync(stateFile)) fail('No runner state file found in that directory.');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (state.kind !== 'flux-remaining-live' || !Array.isArray(state.servers)) fail('Unrecognized private runner state.');
  for (const server of [...state.servers].reverse()) {
    const pid = Number(server.pid);
    if (!Number.isInteger(pid) || pid < 2) continue;
    if (!readProcIdentity(server, state.runId)) {
      process.stderr.write(`Skipped PID ${pid}: it is no longer the recorded fixture server.\n`);
      continue;
    }
    try { process.kill(pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && readProcIdentity(server, state.runId)) await new Promise(resolve => setTimeout(resolve, 100));
    if (readProcIdentity(server, state.runId)) {
      process.kill(pid, 'SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (readProcIdentity(server, state.runId)) fail(`Fixture server PID ${pid} could not be stopped safely.`);
  }
  // Remove stored DB URLs and per-server auth secrets once processes have ended.
  for (const server of state.servers) {
    try { rmSync(path.join(server.dataDir, 'config.json'), { force: true }); } catch {}
    try { rmSync(path.join(server.dataDir, 'auth-secret'), { force: true }); } catch {}
    try {
      const log = readFileSync(server.logPath, 'utf8');
      const redacted = log.replace(/\b(mysql|mariadb|postgres(?:ql)?):\/\/[^\s/@]+(?::[^\s/@]*)?@/gi, '$1://[REDACTED]@');
      writeFileSync(server.logPath, redacted, { mode: 0o600 });
      chmodSync(server.logPath, 0o600);
    } catch {}
    try { rmSync(path.join(server.dataDir, 'backend-init.log'), { force: true }); } catch {}
  }
  if (state.keeper && Number(state.keeper.pid) !== process.pid) {
    const keeperPid = Number(state.keeper.pid);
    try {
      const command = readFileSync(`/proc/${keeperPid}/cmdline`, 'utf8').replaceAll('\0', ' ');
      const sameKeeper = procStartTicks(keeperPid) === String(state.keeper.startedTicks) &&
        command.includes('remaining-live.mjs') && command.includes(stateDir) && command.includes(String(state.keeper.command));
      if (sameKeeper) {
        process.kill(keeperPid, 'SIGTERM');
        process.stdout.write('Stopped the exact recorded foreground fixture keeper.\n');
      }
    } catch (e) { if (e.code !== 'ESRCH' && e.code !== 'ENOENT') throw e; }
  }
  process.stdout.write(`Stopped only fixture server processes recorded at ${stateDir}.\n`);
  process.stdout.write('The disposable MariaDB database was left intact for review; remove it separately when every live check is finished.\n');
}

async function start() {
  const rawUrl = process.env.FLUX_REMAINING_LIVE_DATABASE_URL;
  if (!rawUrl) fail('Set FLUX_REMAINING_LIVE_DATABASE_URL explicitly; no application config fallback is used.');
  const db = await assertMariaDb(rawUrl, true);
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'flux-remaining-live-'));
  chmodSync(stateDir, 0o700);
  const runId = randomUUID();
  const state = { kind: 'flux-remaining-live', runId, createdAt: new Date().toISOString(), databaseName: db.dbName, mariaDbVersion: db.version, servers: [] };
  try {
    for (let index = 0; index < appPorts.length; index++) {
      const port = appPorts[index];
      const dataDir = path.join(stateDir, `server-${index + 1}`);
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      chmodSync(dataDir, 0o700);
      writePrivate(path.join(dataDir, 'config.json'), JSON.stringify({ current_db_type: 'REMOTE', database_url: rawUrl }, null, 2));
      const logPath = path.join(stateDir, `server-${index + 1}.log`);
      const logFd = openSync(logPath, 'a', 0o600);
      chmodSync(logPath, 0o600);
      const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts', `--flux-remaining-live-run=${runId}`], {
        cwd: repo,
        env: childEnvironment(dataDir, port, runId),
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      child.unref();
      closeSync(logFd);
      if (!child.pid) fail(`Server ${index + 1} did not return a PID.`);
      let startedTicks = '';
      for (let n = 0; n < 20 && !startedTicks; n++) {
        startedTicks = procStartTicks(child.pid);
        if (!startedTicks) await new Promise(resolve => setTimeout(resolve, 50));
      }
      state.servers.push({ index: index + 1, pid: child.pid, startedTicks, port, origin: originFor(port), dataDir, logPath });
      writeState(stateDir, state);
      if (!startedTicks) fail(`Could not record the safe process identity for server ${index + 1}.`);
      await ready(originFor(port), port, db.version);
    }
    writeState(stateDir, state);
    process.stdout.write(`Fixture state: ${stateDir}\n`);
    for (const server of state.servers) process.stdout.write(`Server ${server.index}: ${server.origin}\n`);
    process.stdout.write(`MariaDB: ${db.version.split(/[- ]/)[0]}, disposable database ${db.dbName}\n`);
    if (process.argv.includes('--keepalive')) await keepForeground(stateDir, state);
  } catch (error) {
    try { await stopState(stateDir); } catch {}
    process.stderr.write(`Private failed-run state retained for diagnosis: ${stateDir}\n`);
    throw error;
  }
}

async function restart(stateDir) {
  const statePath = path.join(stateDir, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  if (state.kind !== 'flux-remaining-live' || state.servers?.length !== 2) fail('Restart requires a recorded two-server fixture state.');
  const rawUrl = process.env.FLUX_REMAINING_LIVE_DATABASE_URL;
  if (!rawUrl) fail('Set FLUX_REMAINING_LIVE_DATABASE_URL explicitly for restart; stopped fixtures remove stored credentials.');
  const db = await assertMariaDb(rawUrl, false);
  if (db.dbName !== state.databaseName) fail('Restart URL does not match the recorded fixture database.');
  for (const server of state.servers) {
    const healthy = await isRecordedServerReady(server);
    if (healthy) continue;
    if (readProcIdentity(server, state.runId)) fail(`Recorded server ${server.index} is running but unhealthy; restart refused.`);
    // An exited recorded child is safe to replace; no arbitrary process is
    // stopped. The strict port below must also be free before spawning.
  }
  writeState(stateDir, state);
  await stopState(stateDir);

  const runId = randomUUID();
  state.runId = runId;
  state.servers = [];
  for (let index = 0; index < appPorts.length; index++) {
    const port = appPorts[index];
    try {
      const occupied = await fetch(`${originFor(port)}/api/health`, { signal: AbortSignal.timeout(700) });
      if (occupied.ok || occupied.status) fail(`Reserved fixture port ${port} is already serving another process; restart refused.`);
    } catch (e) { if (String(e?.message || '').includes('Reserved fixture port')) throw e; }
    const dataDir = path.join(stateDir, `server-${index + 1}`);
    writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ current_db_type: 'REMOTE', database_url: rawUrl }, null, 2), { mode: 0o600 });
    chmodSync(path.join(dataDir, 'config.json'), 0o600);
    const logPath = path.join(stateDir, `server-${index + 1}.log`);
    const logFd = openSync(logPath, 'a', 0o600);
    const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts', `--flux-remaining-live-run=${runId}`], {
      cwd: repo, env: childEnvironment(dataDir, port, runId), detached: true, stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    closeSync(logFd);
    if (!child.pid) fail(`Restarted server ${index + 1} did not return a PID.`);
    let startedTicks = '';
    for (let n = 0; n < 20 && !startedTicks; n++) {
      startedTicks = procStartTicks(child.pid);
      if (!startedTicks) await new Promise(resolve => setTimeout(resolve, 50));
    }
    state.servers.push({ index: index + 1, pid: child.pid, startedTicks, port, origin: originFor(port), dataDir, logPath });
    writeState(stateDir, state);
    if (!startedTicks) fail(`Could not record the safe process identity for restarted server ${index + 1}.`);
    await ready(originFor(port), port, db.version);
  }
  writeState(stateDir, state);
  process.stdout.write(`Restarted both fixture servers with source-only test licensing enabled.\n`);
  for (const server of state.servers) process.stdout.write(`Server ${server.index}: ${server.origin}\n`);
  process.stdout.write('Synthetic database records were preserved.\n');
  if (process.argv.includes('--keepalive')) await keepForeground(stateDir, state);
}

async function keepForeground(stateDir, state) {
  state.keeper = { pid: process.pid, startedTicks: procStartTicks(process.pid), command: process.argv[2] };
  if (!state.keeper.startedTicks) fail('Could not record foreground keeper process identity.');
  writeState(stateDir, state);
  process.stdout.write(`Foreground keeper active (PID ${process.pid}); stop the fixture through its recorded state directory.\n`);
  await new Promise(resolve => {
    const poll = setInterval(() => {
      const stopFile = path.join(stateDir, 'stop-keeper');
      if (existsSync(stopFile)) {
        rmSync(stopFile, { force: true });
        clearInterval(poll);
        resolve();
      }
    }, 1000);
    process.once('SIGTERM', () => { clearInterval(poll); resolve(); });
    process.once('SIGINT', () => { clearInterval(poll); resolve(); });
  });
}

async function jsonCall(origin, route, method, body, token) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) fail(`Fixture seed step failed: ${method} ${route} returned HTTP ${response.status}. Response content was suppressed.`);
  return data;
}

async function seed(stateDir) {
  const state = JSON.parse(readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  if (state.kind !== 'flux-remaining-live' || state.servers?.length !== 2) fail('Start the two-server fixture before seeding.');
  for (const s of state.servers) if (!(await isRecordedServerReady(s))) fail(`Recorded fixture server ${s.index} is not ready; no seed changes were made.`);
  const target = path.resolve(process.env.FLUX_REMAINING_LIVE_METADATA || path.join(os.tmpdir(), 'flux-remaining-live.json'));
  if (existsSync(target)) {
    const existing = JSON.parse(readFileSync(target, 'utf8'));
    if (existing.kind !== 'flux-remaining-live-fixture' || existing.databaseName !== state.databaseName || existing.accounts?.length !== 7) fail('Existing metadata does not match this fixture database; refusing to create duplicate accounts.');
    const owner = await ownerTestLogin(state.servers[0].origin);
    if (owner.user?.role !== 'OWNER' || !owner.token) fail('Source-only fixture owner login failed while reconciling the existing ADMIN.');
    await ensureAdminFixturePermissions(state.servers[0].origin, owner.token, existing.accounts);
    for (const server of state.servers) for (const identity of existing.accounts) {
      const login = await jsonCall(server.origin, '/api/login', 'POST', { symbol: identity.symbol, password: identity.password });
      if (login?.success !== true || login.user?.id !== identity.id) fail(`Existing synthetic account did not authenticate on server ${server.index}; refusing duplicate seed.`);
    }
    chmodSync(target, 0o600);
    process.stdout.write(`Existing fixture accounts verified on both servers; no duplicate seed was created.\nPrivate fixture metadata: ${target}\n`);
    return;
  }
  const [first, second] = state.servers;
  const owner = await ownerTestLogin(first.origin);
  if (owner.user?.role !== 'OWNER' || !owner.token) fail('Source-only fixture owner login failed.');

  const suffix = randomBytes(4).toString('hex');
  const makePassword = () => `Fixture-${randomBytes(24).toString('base64url')}`;
  const admin = { symbol: `fixture.admin.${suffix}`, password: makePassword(), role: 'ADMIN', lastName: 'Тестовый', firstName: 'Администратор', permissions: { 'admin.users.create': { enabled: true, mode: 'ALLOW' }, 'admin.users.manage': { enabled: true, mode: 'ALLOW' } } };
  const employees = Array.from({ length: 6 }, (_, i) => ({
    symbol: `fixture.user${i + 1}.${suffix}`,
    password: makePassword(),
    role: 'ENGINEER_VENT',
    lastName: `Проверочный${i + 1}`,
    firstName: `Сотрудник${i + 1}`,
  }));
  const createdAdmin = await jsonCall(first.origin, '/api/users', 'POST', admin, owner.token);
  const createdEmployees = [];
  for (const employee of employees) createdEmployees.push(await jsonCall(first.origin, '/api/users', 'POST', employee, owner.token));
  const projectResponse = await jsonCall(first.origin, '/api/projects', 'POST', { name: `Проверочный проект ${suffix}`, code: `FIXTURE-${suffix}` }, owner.token);
  const project = projectResponse?.project;
  if (!project?.id) fail('Project creation did not return an ID.');
  const playGroup = createdEmployees.slice(0, 4).map(x => x.id);
  await jsonCall(first.origin, `/api/projects/${encodeURIComponent(project.id)}/members`, 'POST', { userIds: playGroup }, owner.token);

  const identities = [
    { ...createdAdmin, symbol: admin.symbol, password: admin.password, role: 'ADMIN' },
    ...createdEmployees.map((user, index) => ({ ...user, symbol: employees[index].symbol, password: employees[index].password, role: 'ENGINEER_VENT', group: index < 4 ? 'play' : 'outsider' })),
  ].map(({ id, symbol, password, role, group }) => ({ id, symbol, password, role, ...(group ? { group } : {}) }));

  // Every account must authenticate on both independently-secreted app servers.
  for (const server of [first, second]) {
    for (const identity of identities) {
      const login = await jsonCall(server.origin, '/api/login', 'POST', { symbol: identity.symbol, password: identity.password });
      if (login?.success !== true || !login?.token || login.user?.id !== identity.id || login.user?.role !== identity.role) {
        fail(`Synthetic ${identity.role} account did not authenticate on server ${server.index}. Token and response details were suppressed.`);
      }
    }
  }
  const fixture = {
    kind: 'flux-remaining-live-fixture',
    createdAt: new Date().toISOString(),
    databaseName: state.databaseName,
    mariaDbVersion: state.mariaDbVersion,
    servers: state.servers.map(({ index, origin }) => ({ index, origin })),
    owner: { id: owner.user.id, role: 'OWNER', login: 'source-only owner test key; no password is stored' },
    project: { id: project.id, name: project.name },
    accounts: identities,
    envBindings: Object.fromEntries(identities.map((identity, index) => index === 0
      ? [identity.symbol, { user: 'FLUX_USER', pass: 'FLUX_PASS' }]
      : [identity.symbol, { user: `FLUX_USER${index + 1}`, pass: `FLUX_PASS${index + 1}` }])),
    groups: { play: identities.filter(x => x.group === 'play').map(x => x.id), outsiders: identities.filter(x => x.group === 'outsider').map(x => x.id) },
    notes: 'All account passwords are synthetic and disposable. Owner bearer tokens and database URL are intentionally omitted.',
  };
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, JSON.stringify(fixture, null, 2), { mode: 0o600, flag: 'w' });
  chmodSync(target, 0o600);
  process.stdout.write(`Seeded OWNER, ADMIN, six ENGINEER_VENT accounts, one project and four project members.\n`);
  process.stdout.write(`Private fixture metadata: ${target}\n`);
  process.stdout.write(`Logins were verified on both server origins: ${first.origin} and ${second.origin}. Credentials and tokens were suppressed.\n`);
}

async function ensureAdminFixturePermissions(origin, ownerToken, identities) {
  const admin = identities.find(account => account.role === 'ADMIN');
  if (!admin?.id) fail('Fixture metadata contains no ADMIN identity.');
  const rows = await jsonCall(origin, '/api/users', 'GET', undefined, ownerToken);
  const users = Array.isArray(rows) ? rows : rows?.users || [];
  const stored = users.find(user => user.id === admin.id);
  if (!stored) fail('Fixture ADMIN record is missing; no duplicate account was created.');
  let permissions = {};
  try { permissions = typeof stored.permissions === 'string' ? JSON.parse(stored.permissions) : (stored.permissions || {}); }
  catch { fail('Fixture ADMIN permissions are malformed; refusing to overwrite existing rights.'); }
  let changed = false;
  for (const feature of ['admin.users.create', 'admin.users.manage']) {
    if (permissions?.[feature]?.enabled !== true || permissions?.[feature]?.mode === 'DENY') {
      permissions[feature] = { enabled: true, mode: 'ALLOW' };
      changed = true;
    }
  }
  if (changed) await jsonCall(origin, `/api/users/${encodeURIComponent(admin.id)}`, 'PUT', { permissions: JSON.stringify(permissions) }, ownerToken);
}

async function preflight(stateDir) {
  const state = JSON.parse(readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  const target = path.resolve(process.env.FLUX_REMAINING_LIVE_METADATA || path.join(os.tmpdir(), 'flux-remaining-live.json'));
  const fixture = JSON.parse(readFileSync(target, 'utf8'));
  if (fixture.kind !== 'flux-remaining-live-fixture' || fixture.databaseName !== state.databaseName) fail('Fixture metadata does not match the active MariaDB database.');
  const admin = fixture.accounts.find(account => account.role === 'ADMIN');
  if (!admin) fail('Fixture metadata contains no ADMIN account.');
  for (const server of state.servers) {
    if (!(await isRecordedServerReady(server))) fail(`Fixture server ${server.index} is not ready.`);
    const login = await jsonCall(server.origin, '/api/login', 'POST', { symbol: admin.symbol, password: admin.password });
    if (!login?.token || login.user?.role !== 'ADMIN') fail(`ADMIN login failed on server ${server.index}.`);
    const licenseResponse = await fetch(`${server.origin}/api/license/me`, { headers: { authorization: `Bearer ${login.token}` }, signal: AbortSignal.timeout(10_000) });
    const license = await licenseResponse.json();
    if (!licenseResponse.ok || license.licensed !== true || license.testMode !== true) fail(`Source-only fixture license is not active on server ${server.index}.`);
    let fileId = '';
    try {
      const created = await jsonCall(server.origin, '/api/files', 'POST', {
        name: `remaining-live-preflight-${randomBytes(5).toString('hex')}.txt`,
        filePath: '/personal/remaining-live-preflight.txt', size: 1, type: 'FILE', content: 'x', scope: 'PERSONAL',
      }, login.token);
      fileId = String(created?.file?.id || '');
      if (!fileId) fail(`Small-file POST returned no file ID on server ${server.index}.`);
      await jsonCall(server.origin, `/api/files/${encodeURIComponent(fileId)}`, 'DELETE', undefined, login.token);
      fileId = '';
    } finally {
      if (fileId) {
        const deleted = await fetch(`${server.origin}/api/files/${encodeURIComponent(fileId)}`, { method: 'DELETE', headers: { authorization: `Bearer ${login.token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
        if (!deleted?.ok) fail(`Preflight cleanup failed for its own small fixture file on server ${server.index}.`);
      }
    }
    process.stdout.write(`Server ${server.index}: ready, source-only personal license, one-byte POST and owned-file DELETE passed.\n`);
  }
  const adminA = await jsonCall(state.servers[0].origin, '/api/login', 'POST', { symbol: admin.symbol, password: admin.password });
  if (!adminA?.token) fail('ADMIN login failed before the temporary employee cleanup check.');
  const suffix = randomBytes(6).toString('hex');
  const cleanupPassword = `Fixture-cleanup-${randomBytes(18).toString('base64url')}`;
  const made = await jsonCall(state.servers[0].origin, '/api/users', 'POST', {
    symbol: `fixture.cleanup.${suffix}`, password: cleanupPassword, role: 'ENGINEER_VENT',
    lastName: 'Временный', firstName: 'Удаляемый',
  }, adminA.token);
  const userId = String(made?.id || made?.user?.id || '');
  if (!userId) fail('ADMIN could not create the temporary cleanup probe.');
  let deleted = false;
  try {
    const adminB = await jsonCall(state.servers[1].origin, '/api/login', 'POST', { symbol: admin.symbol, password: admin.password });
    if (!adminB?.token) fail('ADMIN login failed on the second server before cleanup.');
    await jsonCall(state.servers[1].origin, `/api/users/${encodeURIComponent(userId)}`, 'DELETE', undefined, adminB.token);
    const after = await jsonCall(state.servers[0].origin, '/api/users', 'GET', undefined, adminA.token);
    const users = Array.isArray(after) ? after : after?.users || [];
    if (users.some(user => user.id === userId)) fail('Temporary cleanup probe remains after its DELETE.');
    deleted = true;
    process.stdout.write('Cross-server temporary-user POST and exact-ID DELETE passed.\n');
  } finally {
    if (!deleted) {
      const cleanup = await fetch(`${state.servers[0].origin}/api/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE', headers: { authorization: `Bearer ${adminA.token}` }, signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (!cleanup?.ok && cleanup?.status !== 404) fail('Temporary cleanup probe could not be removed by its owner fixture ADMIN.');
    }
  }
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  if (command === 'start' && (!arg || arg === '--keepalive')) return start();
  if (command === 'restart' && arg) return restart(path.resolve(arg));
  if (command === 'seed' && arg) return seed(path.resolve(arg));
  if (command === 'preflight' && arg) return preflight(path.resolve(arg));
  if (command === 'stop' && arg) return stopState(path.resolve(arg));
  fail('Usage: remaining-live.mjs start | restart <state-directory> | seed <state-directory> | preflight <state-directory> | stop <state-directory>');
}

main().catch(error => {
  process.stderr.write(`${error?.message || 'Fixture helper failed.'}\n`);
  process.exitCode = 1;
});
