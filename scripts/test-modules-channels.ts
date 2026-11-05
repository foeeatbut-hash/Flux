/**
 * Права разработки, роль «Разработчик», тестовый и рабочий каналы, откат.
 *
 * Что доказывается:
 * - присылать код может только тот, у кого есть право module.develop, а
 *   рабочий канал просит только тот, у кого есть ещё и module.publish — это
 *   проверяет сервер, а не окно;
 * - «что нового» обязательно;
 * - тестовый выпуск не виден и не скачивается тем, кого владелец не назначил;
 * - откат подписывает владелец: назначение «канал не выше версии X»
 *   работает без связи, чужая подпись и старая запись вместо новой не
 *   принимаются, стёртая из базы строка отката его не снимает.
 *
 * Запуск: npx tsx scripts/test-modules-channels.ts
 */
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRemoteSchema } from '../server/schema-sync';
import { registerModulePublishingRoutes } from '../server/routes/modulePublishing';
import { ModuleCache, syncModuleReleases } from '../electron/moduleCache';
import { FEATURES, DEFAULT_DENIED } from '../src/lib/permissions';
import { FALLBACK_ROLES } from '../src/lib/roles';
import { BUILTIN_ROLES } from '../server/routes/users';
import {
  certificateEnvelope, hexOf, moduleBundle, newKey, pinEnvelope, releaseEnvelope, requestEnvelope,
} from './fixtures/moduleTrust';

const Database = require('better-sqlite3');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-module-channels-'));
const root = newKey(), rootHex = hexOf(root), dev = newKey(), devHex = hexOf(dev), pub = newKey(), pubHex = hexOf(pub);
const MODULE = 'equipment-inspector';

async function main() {
  console.log('Права и роль «Разработчик»');
  const feature = (id: string) => FEATURES.find((f) => f.id === id);
  ok('module.develop и module.publish есть в каталоге прав и опасные', feature('module.develop')?.risky && feature('module.publish')?.risky);
  ok('по умолчанию оба права закрыты', DEFAULT_DENIED.includes('module.develop') && DEFAULT_DENIED.includes('module.publish'));
  const role = BUILTIN_ROLES.find((r) => r.code === 'MODULE_DEVELOPER');
  const grants = JSON.parse(role?.permissions || '{}');
  ok('системная роль «Разработчик» выдаёт разработку, но не рабочий канал', role?.name === 'Разработчик' && grants['module.develop']?.enabled && !grants['module.publish']);
  ok('роль есть и в запасном списке окна', FALLBACK_ROLES.some((r) => r.code === 'MODULE_DEVELOPER'));
  ok('обычная инженерная роль разработку не получает', !JSON.parse(BUILTIN_ROLES.find((r) => r.code === 'ENGINEER_AUTO')!.permissions)['module.develop']);

  const file = path.join(dir, 'flux.sqlite');
  new Database(file).close();
  const { PrismaClient } = require('@prisma/client-sqlite');
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  const log: string[] = [];
  await ensureRemoteSchema(db, 'sqlite', fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8'), (m) => log.push(m));
  ok('таблицы созданы, включая назначения каналов', !log.some((m) => /Не удалось|Ошибка при/.test(m)) && (await db.moduleChannelPin.count()) === 0);

  // Права берутся из таблицы ниже, как userCan на настоящем сервере
  const people: Record<string, { id: string; role: string; perms: string[] }> = {
    owner: { id: 'flux-owner', role: 'OWNER', perms: [] }, dev: { id: 'dev', role: 'MODULE_DEVELOPER', perms: ['module.develop'] },
    pub: { id: 'pub', role: 'MODULE_DEVELOPER', perms: ['module.develop', 'module.publish'] },
    plain: { id: 'plain', role: 'ENGINEER_AUTO', perms: [] }, tester: { id: 'tester', role: 'ENGINEER_VENT', perms: [] },
    other: { id: 'other', role: 'ENGINEER_VENT', perms: [] },
  };
  const app = express(); app.use(express.json({ limit: '50mb' }));
  app.use('/api', (req: any, res, next) => { req.authUser = people[String(req.headers.authorization || '').replace(/^Bearer /, '')]; return req.authUser ? next() : res.status(401).end(); });
  registerModulePublishingRoutes(app, { getPrisma: () => db, broadcast: () => {}, modulePublicKeyHex: rootHex,
    can: (user, f) => user.role === 'OWNER' || user.perms.includes(f) });
  const server = await new Promise<import('http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (who: string, route: string, method = 'GET', body?: unknown) => {
    const r = await fetch(origin + route, { method, headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (r.headers.get('content-type') || '').includes('json') ? await r.json() as any : null };
  };
  const submit = (who: string, key: any, bundle: Uint8Array, p: Parameters<typeof requestEnvelope>[2]) =>
    call(who, '/api/modules/requests', 'POST', { signature: requestEnvelope(key, bundle, p), bundle: Buffer.from(bundle).toString('base64') });
  const release = (requestId: string, bundle: Uint8Array, version: string, author: string, channel: 'test' | 'production') =>
    call('owner', `/api/modules/requests/${requestId}/release`, 'POST', { signature: releaseEnvelope(root, bundle, { version, author, request: requestId, channel }) });
  await call('owner', '/api/modules/certificates', 'POST', { signature: certificateEnvelope(root, devHex, 'dev') });
  await call('owner', '/api/modules/certificates', 'POST', { signature: certificateEnvelope(root, pubHex, 'pub') });
  const plainKey = newKey();
  await call('owner', '/api/modules/certificates', 'POST', { signature: certificateEnvelope(root, hexOf(plainKey), 'plain') });

  console.log('Сервер проверяет права');
  const b100 = moduleBundle('1.0.0');
  ok('без права разработки запрос не принимается даже с сертификатом', (await submit('plain', plainKey, b100, { version: '1.0.0' })).status === 403);
  ok('с правом разработки — в тестовый принимается', (await submit('dev', dev, b100, { version: '1.0.0', channel: 'test' })).status === 200);
  const prod = moduleBundle('1.0.1');
  const refused = await submit('dev', dev, prod, { version: '1.0.1', channel: 'production' });
  ok('рабочий канал без module.publish — отказ с подсказкой про тестовый', refused.status === 403 && /тестовый/.test(refused.body.error));
  ok('с module.publish рабочий канал просить можно', (await submit('pub', pub, prod, { version: '1.0.1', channel: 'production' })).status === 200);
  const empty = moduleBundle('1.0.2');
  ok('«что нового» обязательно', (await call('dev', '/api/modules/requests', 'POST', {
    signature: requestEnvelope(dev, empty, { version: '1.0.2', changelog: '   ' }), bundle: Buffer.from(empty).toString('base64') })).status === 400);
  const me = (id: string) => call(id, '/api/modules/me').then((r) => r.body);
  ok('/me отдаёт права разработки и каналы', (await me('dev')).develop === true && (await me('dev')).publish === false && (await me('plain')).develop === false
    && (await me('owner')).owner === true);

  console.log('Тестовый и рабочий каналы');
  const queue = (await call('owner', '/api/modules/requests')).body.requests;
  const req100 = queue.find((r: any) => r.version === '1.0.0'), req101 = queue.find((r: any) => r.version === '1.0.1');
  ok('выпуск 1.0.0 в тестовый канал', (await release(req100.id, b100, '1.0.0', devHex, 'test')).status === 200);
  ok('выпуск 1.0.1 в рабочий канал', (await release(req101.id, prod, '1.0.1', pubHex, 'production')).status === 200);
  const versionsFor = async (who: string) => (await call(who, '/api/modules/releases')).body.releases.map((r: any) => r.version).sort();
  ok('не назначенный человек видит только рабочий канал', (await versionsFor('other')).join() === '1.0.1');
  const testRelease = (await call('owner', '/api/modules/releases')).body.releases.find((r: any) => r.version === '1.0.0');
  ok('куски тестового выпуска ему не отдаются', (await call('other', `/api/modules/releases/${testRelease.id}/chunks`)).status === 404);
  ok('назначать тестировщиков может только владелец', (await call('dev', '/api/modules/testers', 'PUT', { testers: ['dev'] })).status === 403);
  ok('владелец назначил тестировщика', (await call('owner', '/api/modules/testers', 'PUT', { testers: ['tester', 'tester', ''] })).body.testers.join() === 'tester');
  ok('тестировщик видит оба канала', (await versionsFor('tester')).join() === '1.0.0,1.0.1' && (await me('tester')).channels.includes('test'));
  ok('куски тестового выпуска тестировщику отдаются', (await call('tester', `/api/modules/releases/${testRelease.id}/chunks`)).status === 200);

  console.log('Кэш Flux: каналы человека');
  let clock = Date.now();
  const cache = new ModuleCache(path.join(dir, 'cache'), rootHex, () => clock);
  const syncAs = (who: string) => syncModuleReleases(cache, async (route) => (await call(who, route)).body);
  await syncAs('tester');
  const running = async (channels: Array<'production' | 'test'>) => (await cache.runnable(channels)).get(MODULE)?.claim.version || null;
  ok('рабочий канал: запускается только 1.0.1', await running(['production']) === '1.0.1');
  ok('тестировщик: тестовый 1.0.0 старее рабочего 1.0.1 — берётся новейший', await running(['production', 'test']) === '1.0.1');
  ok('только тестовый канал: 1.0.0', await running(['test']) === '1.0.0');

  console.log('Откат подписывает владелец');
  const b110 = moduleBundle('1.1.0');
  const req110 = (await submit('pub', pub, b110, { version: '1.1.0', channel: 'production', baseRelease: `${MODULE}@1.0.1` })).body.id;
  await release(req110, b110, '1.1.0', pubHex, 'production');
  await syncAs('other');
  ok('вышла 1.1.0 — запускается она', await running(['production']) === '1.1.0');
  ok('откат не подписанный владельцем сервер не принимает', (await call('owner', '/api/modules/pins', 'POST', { signature: pinEnvelope(dev, MODULE, 'production', '1.0.1') })).status === 400);
  ok('откат принимает только владелец', (await call('dev', '/api/modules/pins', 'POST', { signature: pinEnvelope(root, MODULE, 'production', '1.0.1') })).status === 403);
  const t0 = Date.now();
  const pinDown = pinEnvelope(root, MODULE, 'production', '1.0.1', t0);
  ok('откат рабочего канала на 1.0.1 записан', (await call('owner', '/api/modules/pins', 'POST', { signature: pinDown })).status === 200);
  ok('повтор того же отката не плодит строк', (await call('owner', '/api/modules/pins', 'POST', { signature: pinDown })).status === 200 && await db.moduleChannelPin.count() === 1);
  await cache.addPins([pinEnvelope(dev, MODULE, 'production', '1.0.0')]);
  ok('Flux не принимает откат с чужой подписью', (await cache.pins()).caps.size === 0);
  await syncAs('other');
  ok('после отката запускается 1.0.1, а не 1.1.0', await running(['production']) === '1.0.1');
  const verified = await cache.verifiedVersions(MODULE);
  ok('причина понятна: «владелец вернул канал»', verified.some((v: any) => v.version === '1.1.0' && /вернул канал/.test(v.why)));
  ok('откатанная версия остаётся в кэше на случай снятия отката', (await cache.cached()).some((c) => c.version === '1.1.0'));

  await db.moduleChannelPin.deleteMany({});
  await syncAs('other');
  ok('строку отката стёрли из базы — откат остаётся', await running(['production']) === '1.0.1');
  const offline = new ModuleCache(path.join(dir, 'cache'), rootHex, () => clock);
  ok('без связи откат тоже действует', (await offline.runnable(['production'])).get(MODULE)?.claim.version === '1.0.1');

  await cache.addPins([pinEnvelope(root, MODULE, 'production', '1.0.0', t0 - 60_000)]);
  ok('более старая запись не перекрывает позднюю', await running(['production']) === '1.0.1');
  await cache.addPins([pinEnvelope(root, MODULE, 'production', '1.0.0', t0 + 60_000)]);
  ok('более поздняя запись меняет потолок: теперь 1.0.0 не запускается в рабочем (его там нет) — берётся то, что ниже потолка', await running(['production']) === null);
  await cache.addPins([pinEnvelope(root, MODULE, 'production', null, t0 + 120_000)]);
  ok('владелец снял ограничение — снова новейший 1.1.0', await running(['production']) === '1.1.0');

  server.close();
  await db.$disconnect();
  console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${passed})`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('✗', e); process.exit(1); });
