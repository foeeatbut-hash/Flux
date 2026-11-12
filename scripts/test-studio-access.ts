/**
 * Вход в Flux Studio: сервер пускает право «Разработка программ» и владельца.
 *
 * Что доказывается:
 * - без права разработки (в том числе у администратора) вход закрыт кодом 403
 *   на сервере, а не скрытой кнопкой в окне;
 * - с правом module.develop и у владельца вход открыт;
 * - список программ показывает только свои запросы человека, чужие не видны;
 * - список ограничен: больше предела программ не отдаётся.
 *
 * Запуск: npx tsx scripts/test-studio-access.ts
 */
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRemoteSchema } from '../server/schema-sync';
import { registerStudioRoutes, STUDIO_MODULE_LIMIT } from '../server/routes/studio';

const Database = require('better-sqlite3');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-access-'));

async function main() {
  const file = path.join(dir, 'flux.sqlite');
  new Database(file).close();
  const { PrismaClient } = require('@prisma/client-sqlite');
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  await ensureRemoteSchema(db, 'sqlite', fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8'), () => {});

  // Права — как на сервере: личные поверх прав должности. Общая проверка userCan отдаёт администратору
  // любое не-admin.* право, поэтому Studio её не использует; здесь администраторы проверяются отдельно.
  const grant = (until?: string) => JSON.stringify({ 'module.develop': { enabled: true, ...(until ? { until } : {}) } });
  const positionRights: Record<string, Record<string, any>> = { MODULE_DEVELOPER: { 'module.develop': { enabled: true } } };
  const people: Record<string, any> = {
    owner: { id: 'flux-owner', name: 'Владелец', role: 'OWNER' },
    dev: { id: 'dev', name: 'Разработчик', role: 'MODULE_DEVELOPER' },
    other: { id: 'other', name: 'Другой', role: 'MODULE_DEVELOPER' },
    personal: { id: 'personal', name: 'Личное право', role: 'ENGINEER_VENT', permissions: grant() },
    expired: { id: 'expired', name: 'Просрочено', role: 'ENGINEER_VENT', permissions: grant('2000-01-01') },
    off: { id: 'off', name: 'Отключён', role: 'MODULE_DEVELOPER', isActive: false },
    disabled: { id: 'disabled', name: 'Выключено', role: 'ENGINEER_VENT', permissions: JSON.stringify({ 'module.develop': { enabled: false } }) },
    admin: { id: 'admin', name: 'Админ', role: 'ADMIN', permissions: '{}' },
    adminGranted: { id: 'adminGranted', name: 'Админ с правом', role: 'ADMIN', permissions: grant() },
    heavy: { id: 'heavy', name: 'Много', role: 'MODULE_DEVELOPER' },
    plain: { id: 'plain', name: 'Инженер', role: 'ENGINEER_VENT' },
  };
  const app = express();
  app.use('/api', (req: any, res, next) => { req.authUser = people[String(req.headers.authorization || '').replace(/^Bearer /, '')]; return req.authUser ? next() : res.status(401).end(); });
  registerStudioRoutes(app, { getPrisma: () => db, permissionsOf: async (user) => ({ ...(positionRights[user.role] || {}), ...JSON.parse(user.permissions || '{}') }) });
  const server = await new Promise<import('http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (who: string, route: string) => {
    const r = await fetch(origin + route, { headers: { Authorization: `Bearer ${who}` } });
    return { status: r.status, body: (r.headers.get('content-type') || '').includes('json') ? await r.json() as any : null };
  };

  console.log('Сервер проверяет право входа');
  ok('без токена вход закрыт', (await fetch(`${origin}/api/studio/session`)).status === 401);
  ok('сотрудник без права: 403 с подсказкой, что просить', (await call('plain', '/api/studio/session')).status === 403
    && /Разработка программ/.test((await call('plain', '/api/studio/session')).body.error));
  ok('администратор без явного права не входит (общая проверка прав пустила бы его)', (await call('admin', '/api/studio/session')).status === 403 && (await call('admin', '/api/studio/modules')).status === 403);
  ok('администратор с явно выданным правом входит', (await call('adminGranted', '/api/studio/session')).status === 200);
  ok('личное право без должности пускает', (await call('personal', '/api/studio/session')).status === 200);
  ok('право должности пускает', (await call('dev', '/api/studio/session')).status === 200);
  ok('просроченное, выключенное и отключённого профиля право не пускает', [(await call('expired', '/api/studio/session')).status, (await call('disabled', '/api/studio/session')).status, (await call('off', '/api/studio/session')).status].every((x) => x === 403));
  ok('список программ без права закрыт так же', (await call('plain', '/api/studio/modules')).status === 403);
  const dev = await call('dev', '/api/studio/session');
  ok('разработчик с module.develop входит, как не владелец', dev.status === 200 && dev.body.ok === true && dev.body.owner === false);
  const owner = await call('owner', '/api/studio/session');
  ok('владелец входит и помечен владельцем', owner.status === 200 && owner.body.owner === true);

  console.log('Свои программы');
  const base = { signature: 's', authorKey: 'k', size: 1, sha256: 'h', chunkCount: 1 };
  let n = 0;
  const add = (authorId: string, moduleId: string, version: string, state = 'pending') => db.moduleRequest.create({ data: {
    ...base, signature: `sig-${++n}`, signatureHash: `hash-${n}`, authorId, moduleId, version, state, createdAt: new Date(Date.now() + n * 1000) } });
  await add('dev', 'alpha', '1.0.0', 'released');
  await add('dev', 'alpha', '1.1.0');
  await add('dev', 'beta', '0.1.0', 'returned');
  await add('other', 'gamma', '1.0.0');
  const mine = (await call('dev', '/api/studio/modules')).body.modules;
  ok('разработчик видит только свои программы', mine.length === 2 && mine.every((m: any) => ['alpha', 'beta'].includes(m.moduleId)));
  const alpha = mine.find((m: any) => m.moduleId === 'alpha');
  ok('по программе — последняя отправленная версия и число запросов', alpha.version === '1.1.0' && alpha.requests === 2 && alpha.state === 'pending');
  ok('чужая программа не видна и владельцу как «своя»', (await call('owner', '/api/studio/modules')).body.modules.length === 0);

  console.log('Предел списка');
  for (let i = 0; i < STUDIO_MODULE_LIMIT + 5; i++) await add('other', `mass-${i}`, '1.0.0');
  const big = (await call('other', '/api/studio/modules')).body.modules;
  ok(`список не длиннее ${STUDIO_MODULE_LIMIT}`, big.length === STUDIO_MODULE_LIMIT);
  for (let i = 0; i < 1100; i++) await add('heavy', 'many', `1.0.${i}`);
  const many = (await call('heavy', '/api/studio/modules')).body.modules.find((m: any) => m.moduleId === 'many');
  ok('число отправок честное и при тысяче с лишним запросов', many.requests === 1100);

  server.close();
  await db.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nStudio: вход и свои программы — ${passed} проверок пройдено`);
}
main().catch((e) => { console.error(e); fs.rmSync(dir, { recursive: true, force: true }); process.exit(1); });
