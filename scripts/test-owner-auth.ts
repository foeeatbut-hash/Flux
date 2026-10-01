/** Вход владельца и реальные HTTP-предохранители управления профилями. */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { OwnerChallenges } from '../server/ownerAuth';
import { administratorPermission, requiresOwner } from '../server/accessPolicy';
import { registerUserRoutes } from '../server/routes/users';
import { registerAuthRoutes } from '../server/routes/auth';
import { registerOwnerRoutes } from '../server/routes/owner';
import { setPrisma } from '../server/context';

let ok = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) ok++;
  else { fail++; console.log(`✗ ${name}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`); }
};
const key = crypto.generateKeyPairSync('ed25519');
const backup = crypto.generateKeyPairSync('ed25519');
const stranger = crypto.generateKeyPairSync('ed25519');
const hex = (p: crypto.KeyObject) => p.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
let now = 1000;
const challenges = new OwnerChallenges([hex(key.publicKey), hex(backup.publicKey)], () => now);
const issue = () => challenges.issue('installation-A', 'https://company.test');
const sign = (c: { message: string }, k = key.privateKey) => crypto.sign(null, Buffer.from(c.message), k).toString('base64');
const verify = (c: { nonce: string }, signature: string, install = 'installation-A', origin = 'https://company.test') => challenges.verify(c.nonce, signature, install, origin);
let c = issue(); const signature = sign(c);
eq('вход владельца принимает подпись основного ключа', verify(c, signature), true);
eq('одноразовый вызов нельзя использовать дважды', verify(c, signature), false);
c = issue(); eq('запасной ключ восстанавливает доступ', verify(c, sign(c, backup.privateKey)), true);
c = issue(); eq('чужой ключ не входит', verify(c, sign(c, stranger.privateKey)), false);
eq('неудачная попытка также расходует вызов', verify(c, sign(c)), false);
c = issue(); eq('вызов связан с установкой', verify(c, sign(c), 'installation-B'), false);
c = issue(); eq('вызов связан с сервером', verify(c, sign(c), 'installation-A', 'https://evil.test'), false);
c = issue(); now += 60_000; eq('вызов истекает ровно через минуту', verify(c, sign(c)), false);
c = issue(); eq('укороченная подпись отвергается', verify(c, signature.slice(1)), false);
const closed = new OwnerChallenges(['', 'invalid']); const unconfigured = closed.issue('A', 'https://company.test');
eq('без установленных открытых ключей вход закрыт', closed.verify(unconfigured.nonce, sign(unconfigured), 'A', 'https://company.test'), false);
eq('администратор без личного права не создает профили', administratorPermission({ role: 'ADMIN' }, 'admin.users.create'), false);
eq('владелец выдает администраторам доступ', administratorPermission({ role: 'OWNER' }, 'admin.users.create'), true);
eq('выданное личное право работает', administratorPermission({ role: 'ADMIN', permissions: JSON.stringify({ 'admin.users.create': { enabled: true } }) }, 'admin.users.create'), true);
eq('просроченное право не работает', administratorPermission({ role: 'ADMIN', permissions: { 'admin.users.create': { enabled: true, until: '2000-01-01' } } }, 'admin.users.create'), false);
for (const [route, method] of [['/api/db/config', 'GET'], ['/api/db/download', 'GET'], ['/api/backup/settings', 'POST'], ['/api/updates/upload', 'POST'], ['/api/updates/1.2.3', 'DELETE'], ['/API/ROLES/abc/', 'PUT']]) eq(`${method} ${route} требует владельца`, requiresOwner(route, method), true);
eq('сотрудник может скачивать выпуски', requiresOwner('/api/updates/download/1.2.3'), false);

async function runHttp() {
  const users = new Map<string, any>([
    ['owner', { id: 'owner', symbol: 'owner', name: 'Владелец', role: 'OWNER', password: '', isActive: true }],
    ['admin', { id: 'admin', symbol: 'admin', role: 'ADMIN', permissions: '{}' }],
    ['staff', { id: 'staff', symbol: 'staff', role: 'ENGINEER_VENT', permissions: '{}' }],
    ['manager', { id: 'manager', symbol: 'manager', role: 'ADMIN', permissions: JSON.stringify({ 'admin.users.create': { enabled: true }, 'admin.users.manage': { enabled: true } }) }],
  ]);
  const settings = new Map<string, any>();
  setPrisma({
    user: {
      findUnique: async ({ where }: any) => [...users.values()].find(u => where.id ? u.id === where.id : u.symbol === where.symbol) || null,
      findFirst: async ({ where }: any) => [...users.values()].find(u => u.symbol === where.symbol && u.role === where.role) || null,
      findMany: async () => [...users.values()],
      upsert: async ({ where, create, update }: any) => { const u = users.get(where.id); const record = u ? { ...u, ...update } : create; users.set(where.id, record); return record; },
      create: async ({ data }: any) => { const u = { id: `test-${users.size}`, ...data }; users.set(u.id, u); return u; },
      update: async ({ where, data }: any) => { const u = { ...users.get(where.id), ...data }; users.set(where.id, u); return u; },
      delete: async ({ where }: any) => users.delete(where.id),
      count: async () => 2,
    },
    role: { findUnique: async ({ where }: any) => ['OWNER', 'ADMIN', 'ENGINEER_VENT'].includes(where.code) ? { code: where.code } : null },
    appSetting: {
      findFirst: async ({ where }: any) => [...settings.values()].find(s => s.key === where.key) || null,
      upsert: async ({ where, create }: any) => { const s = settings.get(where.id) || create; settings.set(where.id, s); return s; },
    },
  });
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.authUser = users.get(String(req.headers['x-test-user'])); next(); });
  registerUserRoutes(app, { hashPassword: p => `hash-${p}`, invalidateRolePerms: () => {}, invalidateAuthUser: () => {} });
  registerAuthRoutes(app, { hashPassword: p => `hash-${p}`, verifyPassword: () => true, issueAuthToken: id => id, rolePermissionsOf: async () => ({}), trustedNowFull: async () => ({ now: Date.now(), tampered: false, source: 'test' }), trustedNowSync: Date.now, isClockTampered: () => false });
  process.env.FLUX_TEST_OWNER = '1';
  registerOwnerRoutes(app, { issueAuthToken: id => `token-${id}` });
  const server = await new Promise<import('http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (url: string, method: string, user: string, body?: unknown) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Test-User': user }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    eq('пароль не впускает OWNER даже при совпадении', (await call('/api/login', 'POST', '', { symbol: 'owner', password: '' })).status, 401);
    eq('ADMIN без полномочий получает HTTP403 при создании', (await call('/api/users', 'POST', 'admin', { name: 'Инженер', symbol: 'n' })).status, 403);
    eq('ADMIN не назначает ADMIN', (await call('/api/users', 'POST', 'manager', { name: 'Инженер', symbol: 'n', role: 'ADMIN' })).status, 403);
    eq('никто не создает второго OWNER через пользователей', (await call('/api/users', 'POST', 'owner', { name: 'Владелец 2', symbol: 'other-owner', role: 'OWNER' })).status, 403);
    eq('ADMIN не выдает admin.* сотруднику', (await call('/api/users', 'POST', 'manager', { name: 'Инженер', symbol: 'n', permissions: { 'admin.users.create': { enabled: true } } })).status, 403);
    eq('администратор с правом создает инженера', (await call('/api/users', 'POST', 'manager', { name: 'Инженер', symbol: 'new', password: 'qwerty' })).status, 200);
    eq('владелец создает администратора', (await call('/api/users', 'POST', 'owner', { name: 'Администратор', symbol: 'new-admin', role: 'ADMIN', password: 'qwerty' })).status, 200);
    eq('владелец не меняется обычным PUT', (await call('/api/users/owner', 'PUT', 'owner', { role: 'ENGINEER_VENT' })).status, 403);
    eq('владелец не удаляется обычным DELETE', (await call('/api/users/owner', 'DELETE', 'owner')).status, 403);
    eq('ADMIN не меняет права другого ADMIN', (await call('/api/users/admin', 'PUT', 'manager', { permissions: {} })).status, 403);
    eq('роль сотрудника не повышается до ADMIN', (await call('/api/users/staff', 'PUT', 'manager', { role: 'ADMIN' })).status, 403);
    eq('ADMIN не создает системную роль', (await call('/api/roles', 'POST', 'manager', { name: 'Фальшивая', code: 'OWNER' })).status, 403);
    const first = await (await call('/api/owner/challenge', 'GET', '')).json() as any;
    const testKey = crypto.createPrivateKey(fs.readFileSync(path.join(__dirname, 'fixtures/owner-test-key.txt')));
    const signed = crypto.sign(null, Buffer.from(first.message), testKey).toString('base64');
    const logged = await call('/api/owner/login', 'POST', '', { nonce: first.nonce, sig: signed });
    eq('реальный HTTP вход по ключу выдает сессию OWNER', logged.status, 200);
    const result = await logged.json() as any;
    eq('OWNER имеет единственный фиксированный идентификатор', result.user.id, 'flux-owner');
    eq('пароль отсутствует в ответе OWNER', 'password' in result.user, false);
    eq('OWNER хранится без рабочего пароля', users.get('flux-owner')?.password, '');
    eq('HTTP повтор подписи не выдает новую сессию', (await call('/api/owner/login', 'POST', '', { nonce: first.nonce, sig: signed })).status, 401);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
runHttp().then(() => { console.log(`\n${ok} проверок пройдено, ${fail} провалено`); process.exit(fail ? 1 : 0); }).catch(e => { console.error(e); process.exit(1); });
