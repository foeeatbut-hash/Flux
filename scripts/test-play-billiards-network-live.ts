/** Два независимых процесса HTTP на общей временной БД с настоящими сессиями и лицензией. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import express from 'express';
import 'express-async-errors';
import { setPrisma } from '../server/context';
import { setDialect } from '../server/ddl';
import { ensureRemoteSchema } from '../server/schema-sync';
import { createAuthSessions } from '../server/authSessions';
import { configureLicenseService, personLicenseMiddleware } from '../server/licenseService';
import { registerPlayAccess } from '../server/play/access';
import { registerPlayRoutes } from '../server/play/routes';
import { PLAY_PLAYER_ENTITLEMENTS } from '../play/features';
const { PrismaClient } = require('@prisma/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const client = (file: string, pgUrl = '', schema = '') => {
  if (!pgUrl) return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  const { PrismaClient: PostgreSQLClient } = require('@prisma/client-pg');
  const { PrismaPg } = require('@prisma/adapter-pg');
  return new PostgreSQLClient({ adapter: new PrismaPg({ connectionString: pgUrl }, { schema }) });
};

async function worker() {
  const prisma = client(process.env.POOL_DB!, process.env.POOL_PG_URL, process.env.POOL_PG_SCHEMA);
  setPrisma(prisma); setDialect(process.env.POOL_PG_URL ? 'postgresql' : 'sqlite');
  configureLicenseService({ trustedNow: Date.now, fromSource: true, automaticTestLicense: true });
  const sessions = createAuthSessions({ secret: process.env.POOL_SECRET! });
  const app = express(); app.use(express.json());
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.post('/api/login', async (req, res) => {
    const user = await prisma.user.findUnique({ where: { symbol: req.body.symbol } });
    const hash = crypto.createHash('sha256').update(String(req.body.password)).digest('hex');
    if (!user || hash !== user.password) return res.status(401).json({ error: 'Ошибка входа' });
    return res.json({ token: await sessions.issue(user.id), user: { id: user.id } });
  });
  app.use(async (req: any, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const user = await sessions.validate(token);
    if (!user) return res.status(401).json({ error: 'Требуется вход' });
    req.authUser = user; next();
  });
  app.use(personLicenseMiddleware({ allowed: () => false }));
  registerPlayAccess(app); registerPlayRoutes(app);
  const server = app.listen(0, '127.0.0.1', () => {
    const address = server.address(); console.log(`POOL_READY=${typeof address === 'object' ? address?.port : 0}`);
  });
  process.on('SIGTERM', () => server.close(() => { void prisma.$disconnect().then(() => process.exit(0)); }));
}
async function startWorker(env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; base: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', __filename, '--serve'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Временный сервер не запустился')); }, 20000);
    child.stdout!.on('data', data => { output += data; const match = /POOL_READY=(\d+)/.exec(output); if (match) { clearTimeout(timer); resolve({ child, base: `http://127.0.0.1:${match[1]}` }); } });
    child.stderr!.on('data', data => { output += data; process.stderr.write(data); });
    child.on('exit', code => { if (!output.includes('POOL_READY=')) { clearTimeout(timer); reject(new Error(`Сервер ${code}: ${output.slice(-2000)}`)); } });
  });
}
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-pool-network-')), file = path.join(dir, 'play.sqlite');
  const pgSchema = `pool_${crypto.randomBytes(6).toString('hex')}`;
  const pgBase = process.env.FLUX_PG_URL || '';
  let pgAdmin: any = null, pgUrl = '';
  if (pgBase) {
    const { Pool } = require('pg'); pgAdmin = new Pool({ connectionString: pgBase });
    await pgAdmin.query(`CREATE SCHEMA "${pgSchema}"`);
    const url = new URL(pgBase); url.searchParams.set('options', `-c search_path=${pgSchema}`); pgUrl = url.toString();
  }
  const prisma = client(file, pgUrl, pgSchema), children: ChildProcess[] = [];
  try {
    console.log(pgUrl ? 'PostgreSQL: два отдельных процесса, отдельная временная схема' : 'SQLite: два отдельных процесса, временная база');
    await ensureRemoteSchema(prisma, pgUrl ? 'postgresql' : 'sqlite', fs.readFileSync(pgUrl ? 'prisma/schema.postgresql.prisma' : 'prisma/schema.prisma', 'utf8'), message => { if (/ошиб|не удалось/i.test(message)) console.error(message); });
    await prisma.role.create({ data: { code: 'ENGINEER_VENT', name: 'Инженер', updatedAt: new Date() } });
    const password = crypto.randomUUID();
    const permissions = Object.fromEntries(PLAY_PLAYER_ENTITLEMENTS.map(p => [p.id, { enabled: true, mode: 'ALLOW' }]));
    for (const name of ['one', 'two', 'outsider', 'watcher', 'no-game', 'admin']) await prisma.user.create({ data: { id: name, symbol: `__pool_${name}`, name, password: crypto.createHash('sha256').update(password).digest('hex'), role: 'ENGINEER_VENT', permissions: JSON.stringify(name === 'no-game' ? { 'app.play': { enabled: true, mode: 'ALLOW' } } : name === 'admin' ? { ...permissions, 'play.admin': { enabled: true, mode: 'ALLOW' } } : permissions) } });
    await prisma.appSetting.create({ data: { id: 'play-enabled', key: 'play_enabled', value: '1' } });
    const env = { ...process.env, POOL_DB: file, POOL_PG_URL: pgUrl, POOL_PG_SCHEMA: pgSchema, POOL_SECRET: crypto.randomBytes(32).toString('hex'), FLUX_TEST_LICENSE: '1', FLUX_TEST_LICENSE_AUTO: '1' };
    const one = await startWorker(env); children.push(one.child);
    const two = await startWorker(env); children.push(two.child);
    const test = spawn(process.execPath, ['--import', 'tsx', 'scripts/test-play-builtin-live.ts'], { env: { ...env, FLUX_API: one.base, FLUX_API2: two.base, FLUX_USER: '__pool_one', FLUX_PASS: password, FLUX_USER2: '__pool_two', FLUX_PASS2: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    const code = await new Promise<number | null>((resolve, reject) => { test.stdout!.on('data', data => process.stdout.write(data)); test.stderr!.on('data', data => process.stderr.write(data)); test.on('error', reject); test.on('exit', resolve); });
    assert.equal(code, 0, 'Два HTTP-процесса должны пройти всю партию');
    const login = async (symbol: string) => { const res = await fetch(one.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, password }) }); return (await res.json() as any).token; };
    const own = await login('__pool_one'), outsider = await login('__pool_outsider'), noGame = await login('__pool_no-game');
    const row = await prisma.playMatch.findFirst({ orderBy: { updatedAt: 'desc' } });
    assert.ok(row, 'Матч сохранён общей БД');
    for (const route of [`/api/play/match/${row.sessionId}`, `/api/play/session/${row.sessionId}/result`]) {
      const res = await fetch(one.base + route, { headers: { Authorization: `Bearer ${outsider}` } }); const data = await res.json() as any;
      assert.ok(!data.result, 'Посторонний не получает чужой стол или результат');
    }
    console.log('✓ Посторонний не читает чужой стол и результат');
    const denied = await fetch(two.base + `/api/play/match/${row.sessionId}`, { headers: { Authorization: `Bearer ${noGame}` } });
    assert.equal(denied.status, 404); console.log('✓ Доступ к платформе не заменяет право на бильярд');
    const saved = await fetch(two.base + `/api/play/match/${row.sessionId}`, { headers: { Authorization: `Bearer ${own}` } });
    assert.equal((await saved.json() as any).result.revision, row.revision); console.log('✓ Другая HTTP-инстанция восстанавливает сохранённую ревизию по реальной сессии');
    const admin = await login('__pool_admin');
    const request = async (token: string, method: string, route: string, body?: unknown) => {
      const response = await fetch(one.base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() as any };
    };
    assert.equal((await request(own, 'PUT', '/api/play/maintenance', { on: true })).status, 404);
    assert.equal((await request(admin, 'PUT', '/api/play/maintenance', { on: true })).status, 200);
    const lobby = await request(own, 'POST', '/api/play/lobby', { gameId: 'billiards' });
    const start = await request(own, 'POST', '/api/play/session', { lobbyId: lobby.data.result.id, expectedVersion: lobby.data.result.revision });
    assert.equal(start.data.code, 'MAINTENANCE');
    assert.equal((await request(admin, 'PUT', '/api/play/maintenance', { on: false })).status, 200);
    console.log('✓ Обслуживание изменяет только управляющий; запрет начала стоит на сервере');
    await prisma.playSession.create({ data: { id: 'stuck-fixture', lobbyId: lobby.data.result.id, gameId: 'billiards', createdAt: new Date(Date.now() - 600000) } });
    const sessions = await request(admin, 'GET', '/api/play/admin/sessions');
    assert.ok(sessions.data.sessions.some((session: any) => session.id === 'stuck-fixture' && session.stuck));
    assert.equal((await request(admin, 'POST', '/api/play/admin/cancel/stuck-fixture', {})).data.cancelled, true);
    console.log('✓ Зависший матч виден управляющему и снимается с освобождением лобби');
    await prisma.playLobby.update({ where: { id: lobby.data.result.id }, data: { gameId: 'reversi', state: 'STARTED' } });
    await prisma.playSession.create({ data: { id: 'archived-fixture', lobbyId: lobby.data.result.id, gameId: 'reversi', state: 'RUNNING' } });
    await prisma.playSessionMember.create({ data: { sessionId: 'archived-fixture', userId: 'one', team: 1, state: 'ACTIVE' } });
    const newRoom = await request(own, 'POST', '/api/play/lobby', { gameId: 'billiards' });
    assert.ok(newRoom.data.ok);
    assert.equal((await prisma.playSession.findUnique({ where: { id: 'archived-fixture' } })).state, 'CANCELLED');
    console.log('✓ Снятая игра не запирает новую комнату, старый матч сохранён в истории БД');
    const history = await request(own, 'GET', '/api/play/history');
    assert.ok(history.data.result.some((match: any) => match.id === row.sessionId));
    const strangerHistory = await request(outsider, 'GET', '/api/play/history');
    assert.equal(strangerHistory.data.result.length, 0);
    console.log('✓ История отбирает только собственные завершённые партии');
    const stopped = await request(own, 'POST', `/api/play/match/${row.sessionId}/move`, { move: { type: 'shot', power: 1, angle: 0 }, expectedRevision: row.revision });
    assert.equal(stopped.data.ok, false);
    console.log('✓ Завершённую партию нельзя продолжить прямым запросом');
    console.log('Сетевая изолированная регрессия пройдена');
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
    await prisma.$disconnect();
    if (pgAdmin) { await pgAdmin.query(`DROP SCHEMA "${pgSchema}" CASCADE`); await pgAdmin.end(); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
(process.argv.includes('--serve') ? worker() : main()).catch(error => { console.error(error); process.exit(1); });
