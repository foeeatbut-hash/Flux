import { testCredentials } from './testCredentials';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const login = testCredentials();
const call = (route: string, token = '', method = 'GET', body?: any, origin?: string) => fetch(BASE + route, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

(async () => {
  const response = await call('/api/login', '', 'POST', login);
  const admin = await response.json() as any;
  assert(admin.token, 'Нужен тестовый сервер с доступным администратором');
  assert.equal((await call('/api/users', admin.token + '.extra')).status, 401);
  let employeeId = '';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-access-test-'));
  try {
    for (const route of ['/api/db/download', '/API/DB/DOWNLOAD/', '/API/users', '/api/backup/status']) {
      assert.equal((await call(route)).status, 401, route);
    }
    assert.equal((await call('/api/db/config', '', 'GET', undefined, 'https://foreign.example')).status, 401);
    const retired = await call('/api/login', '', 'POST', { symbol: 'RaupovMaster', password: '000000' });
    assert.equal((await retired.json() as any).success, false);
    console.log('✓ анонимная выгрузка, другой регистр API и чужой Origin не обходят вход');

    const symbol = `safety-${crypto.randomUUID()}`;
    const password = crypto.randomUUID();
    const made = await call('/api/users', admin.token, 'POST', { name: 'Проверка доступа', symbol, password, role: 'ENGINEER_VENT' });
    const data = await made.json() as any;
    employeeId = data.user?.id || data.id;
    assert(employeeId, JSON.stringify(data));
    const session = await (await call('/api/login', '', 'POST', { symbol, password })).json() as any;
    assert(session.token);
    for (const [route, method] of [
      ['/api/db/download', 'GET'], ['/API/DB/DOWNLOAD/', 'GET'],
      ['/api/seed', 'POST'], ['/API/SEED/', 'POST'], ['/api/backup/status', 'GET'],
    ]) assert.equal((await call(route, session.token, method)).status, 403, route);
    console.log('✓ сотрудник не выгружает всю базу и не запускает служебное заполнение');

    const download = await call('/api/db/download', admin.token);
    assert.equal(download.status, 200);
    const snapshot = path.join(dir, 'download.sqlite');
    fs.writeFileSync(snapshot, Buffer.from(await download.arrayBuffer()));
    const Database = require('better-sqlite3');
    const db = new Database(snapshot, { readonly: true });
    try {
      assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
      assert(db.prepare('SELECT id FROM User WHERE id = ?').get(employeeId), 'Свежая запись должна попасть в копию');
    } finally { db.close(); }
    console.log('✓ администратор получает целостную копию с только что созданной записью');
  } finally {
    if (employeeId) assert.equal((await call(`/api/users/${employeeId}`, admin.token, 'DELETE')).status, 200);
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
