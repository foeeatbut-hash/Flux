/** Run the compiled backend on disposable local data, never app/company config. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { credentialStamp, SESSION_TTL_MS } from '../server/authSessions';

async function runCorruptDatabaseScenario(bundle: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-compiled-corrupt-db-'));
  const databasePath = path.join(directory, 'database.sqlite');
  const originalBytes = Buffer.from('synthetic damaged SQLite fixture\n\x00\xff');
  fs.writeFileSync(databasePath, originalBytes);

  const allocator = net.createServer();
  await new Promise<void>(resolve => allocator.listen(0, '127.0.0.1', resolve));
  const port = (allocator.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => allocator.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [bundle], {
    env: { ...process.env, VENT_APP_DATA: directory, NODE_ENV: 'production', PORT: String(port),
      DATABASE_URL: '', FLUX_EMBEDDED: '1', FLUX_LISTEN_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { if (output.length < 100000) output += data; });
  child.stderr.on('data', data => { if (output.length < 100000) output += data; });

  try {
    let health: any;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Compiled backend exited (${child.exitCode}): ${output.slice(-2000)}`);
      try {
        const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) });
        if (response.status === 503) { health = await response.json(); break; }
      } catch {}
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
    assert.equal(health?.code, 'LOCAL_DATABASE_UNAVAILABLE', 'compiled backend refuses a damaged local database');
    assert.equal(health?.ok, false);
    const projects = await fetch(base + '/api/projects', { signal: AbortSignal.timeout(5000) });
    assert.equal(projects.status, 503, 'compiled backend keeps API unavailable in damaged-database recovery mode');
    assert.equal((await projects.json()).code, 'LOCAL_DATABASE_UNAVAILABLE');
  } finally {
    if (child.exitCode === null && !child.signalCode) {
      const exited = once(child, 'exit');
      child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited; clearTimeout(timer);
    }
    try {
      assert.deepEqual(fs.readFileSync(databasePath), originalBytes, 'damaged database bytes remain unchanged after compiled startup refusal');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

async function run() {
  const bundle = path.resolve('dist/server.cjs');
  assert.ok(fs.existsSync(bundle), 'compile server.ts to dist/server.cjs first');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-compiled-security-'));
  const allocator = net.createServer();
  await new Promise<void>(resolve => allocator.listen(0, '127.0.0.1', resolve));
  const port = (allocator.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => allocator.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [bundle], {
    env: { ...process.env, VENT_APP_DATA: directory, NODE_ENV: 'production', PORT: String(port),
      DATABASE_URL: '', FLUX_EMBEDDED: '1', FLUX_LISTEN_HOST: '127.0.0.1',
      FLUX_TEST_OWNER: '1', FLUX_TEST_LICENSE: '1', FLUX_TEST_LICENSE_AUTO: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { if (output.length < 100000) output += data; });
  child.stderr.on('data', data => { if (output.length < 100000) output += data; });
  const request = (route: string, body: any, token?: string) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  try {
    let health: any;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Compiled backend exited (${child.exitCode}): ${output.slice(-2000)}`);
      try {
        const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) });
        if (response.ok) { health = await response.json(); break; }
      } catch {}
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
    assert.equal(health?.ok, true, 'compiled first startup prepares a clean database');
    assert.equal(health.needsSetup, true, 'compiled first startup creates no demo profiles');
    const challenge: any = await (await fetch(base + '/api/owner/challenge')).json();
    const fixtureKey = crypto.createPrivateKey(fs.readFileSync('scripts/fixtures/owner-test-key.txt'));
    const fixtureLogin = await request('/api/owner/login', { nonce: challenge.nonce, sig: crypto.sign(null, Buffer.from(challenge.message), fixtureKey).toString('base64') });
    assert.equal(fixtureLogin.status, 401, 'compiled backend rejects source fixture Owner key even with test env flags');

    const Database = require('better-sqlite3');
    const db = new Database(path.join(directory, 'database.sqlite'));
    try {
      const salt = crypto.randomBytes(16), password = 'disposable-employee-password';
      const hash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
      db.prepare('INSERT INTO "User" (id, symbol, name, password, role) VALUES (?, ?, ?, ?, ?)').run('fixture-employee', 'fixture-employee', 'Fixture', hash, 'ENGINEER_VENT');
      db.prepare('INSERT INTO "User" (id, symbol, name, password, role) VALUES (?, ?, ?, ?, ?)').run('flux-owner', 'fixture-injected-owner', 'Fixture Owner', '', 'OWNER');
    } finally { db.close(); }
    const employeeResponse = await request('/api/login', { symbol: 'fixture-employee', password: 'disposable-employee-password' });
    assert.equal(employeeResponse.status, 200);
    const employee: any = await employeeResponse.json();
    const projects = await fetch(base + '/api/projects', { headers: { Authorization: `Bearer ${employee.token}` } });
    assert.equal(projects.status, 402, 'compiled backend ignores automatic test license env flags');
    assert.equal((await request('/api/login', { symbol: 'fixture-injected-owner', password: '' })).status, 401, 'DB-injected OWNER cannot enter by password');

    const secret = fs.readFileSync(path.join(directory, 'auth-secret'), 'utf8').trim();
    const owner = { id: 'flux-owner', role: 'OWNER', password: '', isActive: true, validUntil: null };
    const now = Date.now();
    const claims = Buffer.from(JSON.stringify({ v: 2, uid: owner.id, iat: now, exp: now + SESSION_TTL_MS, stamp: credentialStamp(owner), sid: 'f'.repeat(32) })).toString('base64url');
    const forged = `${claims}.${crypto.createHmac('sha256', secret).update(claims).digest('base64url')}`;
    assert.equal((await request('/api/updates', {}, forged)).status, 401, 'local secret and injected DB profile do not publish as Owner');
    console.log('✓ compiled CJS: clean first start, no fixture Owner key or auto-license, no DB-injected/HMAC-forged Owner');
  } finally {
    if (child.exitCode === null && !child.signalCode) {
      const exited = once(child, 'exit');
      child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited; clearTimeout(timer);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  await runCorruptDatabaseScenario(bundle);
  console.log('✓ compiled CJS: damaged local database returns LOCAL_DATABASE_UNAVAILABLE and preserves original bytes');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
