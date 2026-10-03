/** Two independently authenticated servers share an isolated SQLite or opted-in loopback MariaDB fixture. */
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerUpdateRoutes } from '../server/updates';
import { OwnerChallenges } from '../server/ownerAuth';
import { testSignature } from './fixtures/updateTestSign';
import { downloadVerifiedUpdate, assertUpdatePublished } from '../electron/updateDownload';
import { readUpdateSignature, updateRefusal } from '../electron/updateSignature';
import { stageExecutable, replaceExecutable, restoreExecutable } from '../electron/updateFiles';
import { buildDatabaseClient } from '../server/databaseClient';
import { setDialect } from '../server/ddl';

const Database = require('better-sqlite3');
const { PrismaClient } = require('@prisma/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const mariaFixtureUrl = String(process.env.FLUX_UPDATE_MARIA_FIXTURE_URL || '').trim();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-update-cycle-'));
let clients: any[] = [];
function sqliteClients() {
  const file = path.join(dir, 'updates.sqlite'), sql = new Database(file);
  // Deliberately old AppUpdate: route DDL must add publication metadata before Prisma SELECT.
  sql.exec(`CREATE TABLE AppUpdate (id TEXT PRIMARY KEY, version TEXT UNIQUE NOT NULL, changelog TEXT NOT NULL, fileUrl TEXT NOT NULL, createdAt DATETIME NOT NULL DEFAULT current_timestamp);
   CREATE TABLE AppSetting (id TEXT PRIMARY KEY, key TEXT NOT NULL, userId TEXT, value TEXT NOT NULL, updatedAt DATETIME NOT NULL DEFAULT current_timestamp);`);
  sql.close();
  return [0, 1].map(() => new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) }));
}
async function mariaClients() {
  let url: URL;
  try { url = new URL(mariaFixtureUrl); } catch { throw new Error('FLUX_UPDATE_MARIA_FIXTURE_URL must be a valid MariaDB fixture URI.'); }
  if (!/^mysql:$/i.test(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !decodeURIComponent(url.pathname.slice(1)).toLowerCase().includes('fixture')) {
    throw new Error('MariaDB update fixture must use mysql://, a loopback host, and a database name containing fixture.');
  }
  const mariadb = require('mariadb');
  const connection = await mariadb.createConnection(mariaFixtureUrl.replace(/^mysql:\/\//i, 'mariadb://'));
  try {
    const tables = await connection.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()');
    if (Number(tables[0]?.n) !== 0) throw new Error('MariaDB update fixture must be an empty disposable database.');
    // These intentionally old tables exercise the production route migration against MySQL.
    await connection.query('CREATE TABLE `AppUpdate` (`id` VARCHAR(191) NOT NULL, `version` VARCHAR(191) NOT NULL, `changelog` TEXT NOT NULL, `fileUrl` TEXT NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`), UNIQUE KEY `AppUpdate_version_key` (`version`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await connection.query('CREATE TABLE `AppSetting` (`id` VARCHAR(191) NOT NULL, `key` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NULL, `value` LONGTEXT NOT NULL, `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`), UNIQUE KEY `AppSetting_key_userId_key` (`key`, `userId`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
  } finally { await connection.end(); }
  const deps = { load: require, sqliteAdapter: () => { throw new Error('SQLite is disabled for MariaDB fixture clients.'); }, selectDialect: setDialect };
  return [0, 1].map(() => buildDatabaseClient('REMOTE', mariaFixtureUrl, deps));
}
const ownerKey = crypto.createPrivateKey(fs.readFileSync(path.join(__dirname, 'fixtures/owner-test-key.txt')));
const updateKey = crypto.createPrivateKey(fs.readFileSync(path.join(__dirname, 'fixtures/update-test-key.txt')));
const publicHex = (key: crypto.KeyObject) => crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const updateHex = publicHex(updateKey);
const body = Buffer.alloc(6 * 1024 * 1024, 72); body.write('MZ');
let checks = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; };
let pauseCreate: null | (() => Promise<void>) = null;
const wrapped = new Proxy({}, { get(_target, name) {
  const db = clients[0];
  if (name === 'appUpdateChunk') return new Proxy(db.appUpdateChunk, { get(delegate, method) {
    if (method === 'create') return async (args: any) => { if (pauseCreate) await pauseCreate(); return delegate.create(args); };
    const value = delegate[method]; return typeof value === 'function' ? value.bind(delegate) : value;
  } });
  const value = db[name]; return typeof value === 'function' ? value.bind(db) : value;
} });
async function server(db: any) {
  const app = express(); app.use(express.json());
  const sessions = new Map([['employee', { id: 'employee', role: 'ENGINEER_VENT' }], ['admin', { id: 'admin', role: 'ADMIN' }]]);
  const challenge = new OwnerChallenges([publicHex(ownerKey)]); let origin = '';
  app.get('/challenge', (_req, res) => res.json(challenge.issue('fixture-installation', origin)));
  app.post('/owner-login', (req, res) => {
    if (!challenge.verify(req.body.nonce, req.body.signature, 'fixture-installation', origin)) return res.status(403).end();
    const token = crypto.randomUUID(); sessions.set(token, { id: 'owner', role: 'OWNER' }); res.json({ token });
  });
  app.use('/api', (req: any, res, next) => {
    req.authUser = sessions.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!req.authUser) return res.status(401).end(); next();
  });
  registerUpdateRoutes(app, { getPrisma: () => db, dataDir: dir, updatePublicKeyHex: updateHex, broadcast: () => {}, notifyAll: async () => {} });
  const listener = await new Promise<import('http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = `http://127.0.0.1:${(listener.address() as any).port}`;
  const login = async (key = ownerKey) => {
    const c: any = await (await fetch(`${origin}/challenge`)).json();
    return fetch(`${origin}/owner-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: c.nonce, signature: crypto.sign(null, Buffer.from(c.message), key).toString('base64') }) });
  };
  check('a stranger cannot obtain an Owner session', (await login(crypto.generateKeyPairSync('ed25519').privateKey)).status === 403);
  const token = ((await (await login()).json()) as any).token;
  const call = (route: string, method = 'GET', value?: any, who = token) => fetch(origin + route, {
    method, headers: { Authorization: `Bearer ${who}`, 'Content-Type': Buffer.isBuffer(value) ? 'application/octet-stream' : 'application/json' },
    body: value === undefined ? undefined : Buffer.isBuffer(value) ? new Uint8Array(value) : JSON.stringify(value),
  });
  return { origin, listener, token, call };
}
async function run() {
  clients = mariaFixtureUrl ? await mariaClients() : sqliteClients();
  const a = await server(wrapped), b = await server(clients[1]);
  const upload = async (s: typeof a, version: string) => {
    const r = await s.call(`/api/updates/upload?version=${version}`, 'POST', body);
    check(`upload ${version} succeeds`, r.status === 200); return await r.json() as any;
  };
  const publish = (s: typeof a, version: string, generation: string, signature = testSignature(body, version)) => s.call('/api/updates', 'POST', { version, generation, signature, changelog: 'Проверка' });
  try {
    check('unauthenticated uploads are denied', (await a.call('/api/updates/upload?version=9.8.7', 'POST', body, 'fake')).status === 401);
    check('administrator cannot upload', (await a.call('/api/updates/upload?version=9.8.7', 'POST', body, 'admin')).status === 403);
    check('employee cannot publish', (await b.call('/api/updates', 'POST', {}, 'employee')).status === 403);
    check('administrator cannot withdraw', (await a.call('/api/updates/9.8.7', 'DELETE', undefined, 'admin')).status === 403);
    let resume!: () => void, reached!: () => void;
    const held = new Promise<void>(r => { resume = r; }), arrived = new Promise<void>(r => { reached = r; });
    pauseCreate = async () => { pauseCreate = null; reached(); await held; };
    const writing = a.call('/api/updates/upload?version=9.8.7', 'POST', body);
    await arrived;
    check('the second server cannot overwrite an active generation', (await b.call('/api/updates/upload?version=9.8.7', 'POST', body)).status === 409);
    const other = await upload(b, '9.8.8');
    const publishers = await Promise.all([publish(a, '9.8.8', other.generation), publish(b, '9.8.8', other.generation)]);
    check('database compare-and-set allows exactly one concurrent publisher', publishers.map(r => r.status).sort().join(',') === '200,409');
    resume(); const uploaded = await writing; check('the paused generation survives the other publisher cleanup', uploaded.status === 200);
    const up: any = await uploaded.json();
    check('unpublished generations are hidden from employees', (await b.call('/api/updates/download/9.8.7')).status === 404);
    check('unsigned publication is rejected', (await publish(a, '9.8.7', up.generation, '')).status === 400);
    check('a signature from another version is rejected', (await publish(a, '9.8.7', up.generation, testSignature(body, '9.8.8'))).status === 400);
    check('a stale generation cannot publish', (await publish(a, '9.8.7', crypto.randomUUID())).status === 400);
    const first = await clients[0].appUpdateChunk.findFirst({ where: { version: up.generation }, orderBy: { idx: 'asc' } });
    const corrupt = Buffer.from(first.data); corrupt[100] ^= 1;
    await clients[0].appUpdateChunk.update({ where: { id: first.id }, data: { data: corrupt } });
    check('corrupted bytes block publication', (await publish(a, '9.8.7', up.generation)).status === 400);
    await clients[0].appUpdateChunk.update({ where: { id: first.id }, data: { data: first.data } });
    check('signed complete generation publishes', (await publish(a, '9.8.7', up.generation)).status === 200);
    check('published releases are immutable', (await a.call('/api/updates/upload?version=9.8.7', 'POST', body)).status === 409);
    const downloaded = await b.call('/api/updates/download/9.8.7', 'GET', undefined, 'employee');
    check('employee on the independent server gets every byte', downloaded.status === 200 && Buffer.from(await downloaded.arrayBuffer()).equals(body));
    const latest: any = await (await b.call('/api/updates/latest')).json();
    check('latest carries an atomic signature and generation', latest.version === '9.8.7' && readUpdateSignature(latest.signature, updateHex)?.size === body.length && latest.generation === up.generation);
    const opts = { version: '9.8.7', current: '1.0.0', signature: latest.signature, server: b.origin, token: 'employee', keyHex: updateHex };
    const dest = path.join(dir, 'Flux-9.8.7.exe');
    await downloadVerifiedUpdate(`${b.origin}/api/updates/download/9.8.7`, dest, opts);
    check('employee download helper verifies and stores complete bytes', fs.readFileSync(dest).equals(body));
    await assertUpdatePublished(opts); checks++;
    const target = path.join(dir, 'Flux.exe'); const old = Buffer.from('old-program'); fs.writeFileSync(target, old);
    const staged = stageExecutable(dest, target); replaceExecutable(target, staged.staged, staged.backup);
    check('apply swaps a fully staged copy', fs.readFileSync(target).equals(body) && fs.readFileSync(staged.backup).equals(old));
    restoreExecutable(target, staged.backup);
    check('failed launch rollback preserves original program bytes', fs.readFileSync(target).equals(old));
    const failure = stageExecutable(dest, target); fs.unlinkSync(failure.staged);
    assert.throws(() => replaceExecutable(target, failure.staged, failure.backup));
    check('failed rename restores original bytes', fs.readFileSync(target).equals(old));
    await clients[0].appUpdateChunk.delete({ where: { id: first.id } });
    check('missing published chunks fail before sending EXE headers', (await b.call('/api/updates/download/9.8.7')).status === 409);
    const broken: any = await (await b.call('/api/updates/check/9.8.7')).json(); check('readiness checks every chunk', broken.ok === false);
    const fallback: any = await (await b.call('/api/updates/latest')).json(); check('latest skips incomplete release and reports it', fallback.version === '9.8.8' && fallback.broken[0].version === '9.8.7');
    await clients[0].appUpdateChunk.create({ data: { version: up.generation, idx: first.idx, data: first.data } });
    await b.call('/api/updates/9.8.7', 'DELETE');
    check('withdrawn release is unavailable', (await a.call('/api/updates/download/9.8.7')).status === 404);
    await assert.rejects(() => assertUpdatePublished(opts), /отозван/); checks++;
    check('stale signed publication cannot resurrect withdrawn release', (await publish(a, '9.8.7', up.generation)).status === 409);
    check('a withdrawn version cannot be uploaded again', (await b.call('/api/updates/upload?version=9.8.7', 'POST', body)).status === 409);
    check('fixture keys are not accepted by the normal employee key', readUpdateSignature(latest.signature) === null);
    check('wrong download verification key refuses execution', !!updateRefusal({ ...opts, size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), keyHex: publicHex(crypto.generateKeyPairSync('ed25519').privateKey) }));
    // Withdraw while bytes are in flight; upload completion must not switch revoked back to ready.
    const heldAgain = new Promise<void>(r => { resume = r; }), arrivedAgain = new Promise<void>(r => { reached = r; });
    pauseCreate = async () => { pauseCreate = null; reached(); await heldAgain; };
    const inflight = a.call('/api/updates/upload?version=9.8.9', 'POST', body); await arrivedAgain;
    await b.call('/api/updates/9.8.9', 'DELETE'); resume();
    check('withdrawal fences upload completion', (await inflight).status === 503);
    check('withdrawal tombstone survives late cleanup', (await clients[0].appUpdate.findUnique({ where: { version: '9.8.9' } })).state === 'revoked');
  } finally { for (const s of [a, b]) await new Promise<void>(r => s.listener.close(() => r())); }
}
run().then(() => console.log(`${checks} ${mariaFixtureUrl ? 'MariaDB' : 'SQLite'} update-cycle checks passed`)).catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await Promise.all(clients.map(c => c.$disconnect())); fs.rmSync(dir, { recursive: true, force: true }); });
