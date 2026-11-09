/**
 * Правки по внешнему ревью на настоящем сервере (server.ts, одноразовая SQLite): права на
 * генератор тегов и снятие конфликта, самоправка администратора и смена своего пароля, проверка
 * логина при создании сотрудника, повторный выход, ошибки разбора запроса, лимит входа по паре
 * адрес+логин. Без правок каждая из этих проверок падает (см. описание PR).
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
import { io as connectSocket } from 'socket.io-client';

const require = createRequire(import.meta.url);
let passed = 0;
// FLUX_TEST_KEEP_GOING=1 — не останавливаться на первом провале (для сравнения с версией без правок)
let failed = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  if (!condition && process.env.FLUX_TEST_KEEP_GOING === '1') { failed++; console.log(`✗ ${label}`); return; }
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); passed++; console.log(`✓ ${label}`);
};

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-review-auth-'));
  const allocator = net.createServer();
  await new Promise<void>((resolve) => allocator.listen(0, '127.0.0.1', resolve));
  const port = (allocator.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => allocator.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [...(process.env.FLUX_TEST_REQUIRE ? ['--require', process.env.FLUX_TEST_REQUIRE] : []), '--import', 'tsx', 'server.ts'], {
    env: { ...process.env, VENT_APP_DATA: directory, HOME: directory, PORT: String(port), DATABASE_URL: '', FLUX_EMBEDDED: '1', FLUX_LISTEN_HOST: '127.0.0.1', FLUX_API_ONLY: '1', FLUX_TEST_LICENSE: '1', FLUX_TEST_LICENSE_AUTO: '1' },
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
    const dbPath = path.join(directory, 'database.sqlite');
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    const password = 'disposable-live-password';
    const hash = (plain: string) => { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(plain, salt, 64).toString('hex')}`; };
    const user = (id: string, role: string, permissions = '{}') => db.prepare('INSERT INTO "User" (id, symbol, name, password, role, permissions) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, hash(password), role, permissions);
    const deny = JSON.stringify({ 'tags.manage': { enabled: false, until: null }, 'equipment.manage': { enabled: false, until: null } });
    const grant = JSON.stringify({ 'tags.manage': { enabled: true, until: null }, 'equipment.manage': { enabled: true, until: null } });
    user('rv-admin', 'ADMIN', JSON.stringify({ 'admin.users.create': { enabled: true }, 'admin.users.manage': { enabled: true } }));
    user('rv-admin2', 'ADMIN');
    user('rv-denied', 'ENGINEER_VENT', deny);
    user('rv-granted', 'ENGINEER_VENT', grant);
    user('Ivan', 'ENGINEER_VENT');
    user('rv-victim', 'ENGINEER_VENT');
    user('rv-other', 'ENGINEER_VENT');
    db.prepare('INSERT INTO "Project" (id, name) VALUES (?, ?)').run('rv-p', 'Проект ревью');
    for (const id of ['rv-admin', 'rv-denied', 'rv-granted']) db.prepare('INSERT INTO "ProjectMember" (id, projectId, userId) VALUES (?, ?, ?)').run(`m-${id}`, 'rv-p', id);
    db.close();

    const post = (url: string, body: any, headers: Record<string, string> = {}) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const login = async (symbol: string, pw = password) => {
      const r = await post('/api/login', { symbol, password: pw });
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    const token = async (symbol: string, pw = password) => { const r = await login(symbol, pw); assert.equal(r.status, 200, `вход ${symbol}`); return r.body.token as string; };
    const call = async (t: string, method: string, url: string, body?: any) => {
      const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    const [admin, admin2, denied, granted] = [await token('rv-admin'), await token('rv-admin2'), await token('rv-denied'), await token('rv-granted')];

    // ── Права: маршруты записи, которых не было в таблице (44, 80, НОВОЕ-3) ──
    const gen = { projectId: 'rv-p', prefix: 'AHU-' };
    const noGen = await call(denied, 'POST', '/api/tags/generate', gen);
    check('генератор тегов без права tags.manage — 403', noGen.status === 403 && noGen.body.feature === 'tags.manage', noGen);
    const okGen = await call(granted, 'POST', '/api/tags/generate', gen);
    check('с правом tags.manage генератор создаёт тег', okGen.status === 200 && okGen.body.tag?.identifier === 'AHU-001', okGen);
    check('без префикса — 400, а не 500', (await call(granted, 'POST', '/api/tags/generate', { projectId: 'rv-p' })).status === 400);
    check('снятие конфликта без права equipment.manage — 403', (await call(denied, 'POST', '/api/components/nope/resolve-conflict', {})).status === 403);
    check('с правом: несуществующий компонент — 404, а не 500', (await call(granted, 'POST', '/api/components/nope/resolve-conflict', {})).status === 404);

    // ── Самоправка администратора и смена своего пароля (52, 53) ──
    const rename = await call(admin2, 'PUT', '/api/users/rv-admin2', { name: 'Админ Второй' });
    check('администратор правит своё имя (раньше 403)', rename.status === 200, rename);
    const escalate = await call(admin2, 'PUT', '/api/users/rv-admin2', { name: 'Админ Второй', role: 'ENGINEER_VENT', isActive: false, permissions: JSON.stringify({ 'admin.users.manage': { enabled: true } }), validUntil: '2000-01-01' });
    const after = new Database(dbPath, { readonly: true }).prepare('SELECT role, isActive, permissions, validUntil FROM "User" WHERE id = ?').get('rv-admin2');
    check('роль, активность, права и срок у себя не меняются', after.role === 'ADMIN' && after.isActive === 1 && after.permissions === '{}' && !after.validUntil, { escalate, after });
    check('смена своего пароля без текущего — 403', (await call(admin2, 'PUT', '/api/users/rv-admin2', { password: 'new-password-1' })).status === 403);
    check('с неверным текущим — 403', (await call(admin2, 'PUT', '/api/users/rv-admin2', { password: 'new-password-1', currentPassword: 'wrong' })).status === 403);
    check('слишком короткий новый пароль — 400', (await call(admin2, 'PUT', '/api/users/rv-admin2', { password: 'short', currentPassword: password })).status === 400);
    const changed = await call(admin2, 'PUT', '/api/users/rv-admin2', { password: 'new-password-1', currentPassword: password });
    check('с верным текущим пароль меняется', changed.status === 200, changed);
    check('вход с новым паролем работает, со старым — нет', (await login('rv-admin2', 'new-password-1')).status === 200 && (await login('rv-admin2', password)).status === 401);
    check('чужой пароль администратор меняет без старого', (await call(admin, 'PUT', '/api/users/rv-other', { password: 'reset-by-admin-1' })).status === 200 && (await login('rv-other', 'reset-by-admin-1')).status === 200);

    // ── Создание сотрудника: единая проверка логина (54, 55, 56, 57) ──
    const create = (body: any) => call(admin, 'POST', '/api/users', { name: 'Новый', positionCode: 'ENGINEER_VENT', password: 'long-enough-1', ...body });
    check('без логина — 400 (раньше создавался «undefined»)', (await create({ symbol: undefined })).status === 400);
    check('логин с @ — 400', (await create({ symbol: 'a@b' })).status === 400);
    check('дубль с точностью до регистра — 400', (await create({ symbol: 'ivan' })).status === 400);
    check('мусорный срок — 400, а не 500', (await create({ symbol: 'rv-new1', validUntil: 'not-a-date' })).status === 400);
    { const r = await create({ symbol: 'rv-new2', permissions: '{oops' }); check('права не JSON — 400', r.status === 400, r); }
    check('короткий пароль — 400', (await create({ symbol: 'rv-new3', password: 'abc' })).status === 400);
    const created = await create({ symbol: '  rv-new4  ' });
    check('логин сохраняется без пробелов по краям и входит', created.status === 200 && created.body.symbol === 'rv-new4' && (await login('rv-new4', 'long-enough-1')).status === 200, created);

    // ── Ошибки разбора запроса (40) ──
    const badJson = await post('/api/login', '{"symbol": ');
    check('битый JSON — 400, а не 500', badJson.status === 400, badJson.status);
    const notString = await post('/api/login', { symbol: 123, password: ['x'] });
    check('вход с не-строкой — 400', notString.status === 400);

    // ── Повторный выход одного человека (НОВОЕ-1) ──
    const first = await token('rv-granted'); const second = await token('rv-granted');
    const out1 = await call(first, 'POST', '/api/logout'); const out2 = await call(second, 'POST', '/api/logout');
    check('оба выхода одного человека успешны (раньше второй — 503)', out1.status === 200 && out2.status === 200, { out1, out2 });
    check('обе сессии после выхода отвергнуты', (await call(first, 'GET', '/api/auth/me')).status === 401 && (await call(second, 'GET', '/api/auth/me')).status === 401);
    const rows = new Database(dbPath, { readonly: true }).prepare("SELECT COUNT(*) AS n FROM \"AppSetting\" WHERE key LIKE 'auth.session.revoked%'").get().n;
    check('оба отзыва записаны в общую базу', rows === 2, rows);

    // ── Сокеты: частота списка присутствия и «ушёл/вернулся» (100, 101) ──
    const open = (t: string) => new Promise<any>((resolve, reject) => { const sock = connectSocket(base, { auth: { token: t }, transports: ['websocket'], reconnection: false }); sock.once('connect', () => resolve(sock)); sock.once('connect_error', reject); });
    const fresh = await token('rv-granted');
    const s1 = await open(fresh);
    let lists = 0; s1.on('presence:list', () => { lists++; });
    await new Promise((r) => setTimeout(r, 600)); // первый список приходит сам
    const before = lists;
    for (let i = 0; i < 30; i++) s1.emit('presence:list');
    await new Promise((r) => setTimeout(r, 2500));
    check('30 запросов списка за мгновение дают не больше двух ответов', lists - before >= 1 && lists - before <= 2, lists - before);
    s1.disconnect();
    const s2 = await open(fresh); // вернулся сразу после ухода
    await new Promise((r) => setTimeout(r, 1500));
    const presence = new Database(dbPath, { readonly: true }).prepare('SELECT at FROM "Presence" WHERE userId = ?').get('rv-granted');
    const atMs = typeof presence?.at === 'number' ? presence.at : Date.parse(presence?.at);
    check('вернувшийся сразу после ухода не остаётся «ушедшим» в общей базе', Date.now() - atMs < 20000, presence);
    s2.disconnect();

    // ── Сброс якоря времени — только владельцу (48) ──
    check('сброс якоря времени администратору недоступен — 403', (await call(admin, 'POST', '/api/admin/time-anchor/reset', {})).status === 403);

    // ── Лимит входа по паре адрес+логин (14, НОВОЕ-2) ──
    for (let i = 0; i < 5; i++) await login('rv-victim', 'wrong-password');
    const locked = await login('rv-victim', password);
    check('пять промахов по логину — пауза для этой пары (429)', locked.status === 429, locked);
    // За прокси у всех один адрес: имитируем заголовком не будем — проверяем, что другой логин с того же адреса не заперт
    check('другой логин с того же адреса входит', (await login('rv-other', 'reset-by-admin-1')).status === 200);
  } finally {
    if (child.exitCode === null && !child.signalCode) { const exited = once(child, 'exit'); child.kill(); const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(`review-auth-live: ${passed} проверок прошли${failed ? `, ${failed} провалено` : ''}`);
  if (failed) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
