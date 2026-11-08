/**
 * Сквозная проверка прав ДО на настоящем сервере (server.ts, одноразовая база): замок связанного файла и выпуск
 * без нужного права — 403 от общей таблицы прав, с правом — доходит до обработчика. Не заменяет проверку таблицы
 * в test-docflow-permissions: здесь проходит весь путь запрос → вход → роль → личный запрет → маршрут.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
let passed = 0;
const check = (label: string, condition: unknown, detail?: unknown) => { assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); passed++; console.log(`✓ ${label}`); };

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-docflow-live-'));
  const allocator = net.createServer();
  await new Promise<void>((resolve) => allocator.listen(0, '127.0.0.1', resolve));
  const port = (allocator.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => allocator.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [...(process.env.FLUX_TEST_REQUIRE ? ['--require', process.env.FLUX_TEST_REQUIRE] : []), '--import', 'tsx', 'server.ts'], {
    env: { ...process.env, VENT_APP_DATA: directory, PORT: String(port), DATABASE_URL: '', FLUX_EMBEDDED: '1', FLUX_LISTEN_HOST: '127.0.0.1', FLUX_API_ONLY: '1', FLUX_TEST_LICENSE: '1', FLUX_TEST_LICENSE_AUTO: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { if (output.length < 100000) output += d; });
  child.stderr.on('data', (d) => { if (output.length < 100000) output += d; });
  try {
    const deadline = Date.now() + 120000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Сервер завершился (${child.exitCode}): ${output.slice(-1500)}`);
      try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }); if (r.ok) break; } catch { /* ещё поднимается */ }
      if (Date.now() > deadline) throw new Error(`Сервер не поднялся: ${output.slice(-1500)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const Database = require('better-sqlite3');
    const db = new Database(path.join(directory, 'database.sqlite'));
    const password = 'disposable-live-password';
    const hash = (() => { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`; })();
    const user = (id: string, role: string, permissions = '{}') => db.prepare('INSERT INTO "User" (id, symbol, name, password, role, permissions) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, hash, role, permissions);
    user('live-admin', 'ADMIN');
    // Инженер: права назначения файлов нет по умолчанию; у второго выдано, но отнят выпуск личным запретом
    user('live-engineer', 'ENGINEER_VENT');
    user('live-files', 'ENGINEER_VENT', JSON.stringify({ 'docflow.files': { enabled: true, until: null }, 'docflow.issue': { enabled: false, until: null } }));
    db.prepare('INSERT INTO "Project" (id, name) VALUES (?, ?)').run('live-p', 'Живой проект');
    for (const id of ['live-admin', 'live-engineer', 'live-files']) db.prepare('INSERT INTO "ProjectMember" (id, projectId, userId) VALUES (?, ?, ?)').run(`m-${id}`, 'live-p', id);
    db.prepare('INSERT INTO "DocRegister" (id, projectId, name) VALUES (?, ?, ?)').run('live-r', 'live-p', 'ВДР');
    db.prepare('INSERT INTO "DocRegisterItem" (id, registerId, projectId, contractorNo, vdrCode, revision, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run('live-i', 'live-r', 'live-p', 'X-1', 'E02', 'A', 'READY');
    db.close();
    // Связь создаётся клиентом Prisma, как в работе сервера: даты и логические значения в формате самой базы
    const { PrismaClient } = require('../prisma-clients/client-sqlite');
    const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
    const seed = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${path.join(directory, 'database.sqlite')}` }) });
    await seed.docFileLink.create({ data: { id: 'live-l', itemId: 'live-i', projectId: 'live-p', revision: 'A', folderKey: 'a'.repeat(64), relativePath: 'E02/X-1_A.pdf', fileName: 'X-1_A.pdf', locked: true } });
    await seed.$disconnect();

    const login = async (symbol: string) => {
      const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, password }) });
      assert.equal(r.status, 200, `вход ${symbol}`);
      return (await r.json() as any).token as string;
    };
    const [admin, engineer, files] = [await login('live-admin'), await login('live-engineer'), await login('live-files')];
    const call = async (token: string, method: string, url: string, body?: any) => {
      const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    const lock = (token: string, locked: boolean) => call(token, 'POST', '/api/docflow/links/lock', { projectId: 'live-p', itemId: 'live-i', linkId: 'live-l', locked });
    const issueRows = [{ itemId: 'live-i', linkId: 'live-l', reason: 'IFR', date: new Date().toISOString().slice(0, 10), sha256: 'a'.repeat(64) }];

    const denied = await lock(engineer, false);
    check('замок без права docflow.files — 403 от сервера, замок не изменился', denied.status === 403 && /docflow\.files|Назначение файлов|прав/i.test(JSON.stringify(denied.body)), denied);
    const stillLocked = new (require('better-sqlite3'))(path.join(directory, 'database.sqlite'), { readonly: true });
    check('в базе замок остался закрытым', stillLocked.prepare('SELECT locked FROM "DocFileLink" WHERE id = ?').get('live-l').locked === 1);
    stillLocked.close();
    check('неавторизованный запрос замка — 401', (await fetch(`${base}/api/docflow/links/lock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 401);
    const granted = await lock(files, false);
    check('с правом docflow.files замок снимается', granted.status === 200 && granted.body.link?.locked === false, granted);
    check('и ставится обратно администратором', (await lock(admin, true)).body.link?.locked === true);
    check('список замков для моста виден участнику проекта', (await call(engineer, 'GET', '/api/docflow/locks')).body.links?.some((l: any) => l.id === 'live-l'));

    const noIssue = await call(files, 'POST', '/api/docflow/issue/plan', { projectId: 'live-p', rows: issueRows });
    check('выпуск при личном запрете docflow.issue — 403', noIssue.status === 403, noIssue);
    check('старый адрес выпуска при запрете — тоже 403', (await call(files, 'POST', '/api/vdr/items/live-i/issue-revision', { kind: 'next' })).status === 403);
    const allowed = await call(admin, 'POST', '/api/docflow/issue/plan', { projectId: 'live-p', rows: issueRows });
    check('администратору план выпуска строится (проверки вернули причины, не 403)', allowed.status === 200 && Array.isArray(allowed.body.rows), allowed);
  } finally {
    if (child.exitCode === null && !child.signalCode) { const exited = once(child, 'exit'); child.kill(); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(`docflow-live-permissions: ${passed} проверок прошли`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
