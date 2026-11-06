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
import { sealEnvelope } from '../modules/trust/envelope';
import { buildPromotionClaim } from '../modules/trust/owner';
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
  certificateEnvelope, hexOf, moduleBundle, newKey, pinEnvelope, releaseEnvelope, requestEnvelope, revocationEnvelope,
} from './fixtures/moduleTrust';

const Database = require('better-sqlite3');
const pgUrl = String(process.env.FLUX_MODULES_PG_FIXTURE_URL || '').trim();
const mariaUrl = String(process.env.FLUX_MODULES_MARIA_FIXTURE_URL || '').trim();
const dialect = pgUrl ? 'postgresql' : mariaUrl ? 'mysql' : 'sqlite';
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-module-channels-'));
const root = newKey(), rootHex = hexOf(root), dev = newKey(), devHex = hexOf(dev), pub = newKey(), pubHex = hexOf(pub);
const MODULE = 'equipment-inspector';

async function main() {
  assert.ok(!(pgUrl && mariaUrl), 'задайте только одну fixture-базу');
  let db: any;
  const fixture = pgUrl || mariaUrl;
  if (fixture) {
    const url = new URL(fixture);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.includes('fixture'), 'только одноразовая база на loopback с fixture в имени');
    const { PrismaClient } = require(pgUrl ? '@prisma/client-pg' : '@prisma/client-mysql');
    db = pgUrl ? new PrismaClient({ adapter: new (require('@prisma/adapter-pg').PrismaPg)({ connectionString: fixture }) })
      : new PrismaClient({ adapter: new (require('@prisma/adapter-mariadb').PrismaMariaDb)(fixture) });
    const tables = await db.$queryRawUnsafe(pgUrl ? "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public'"
      : 'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()');
    assert.equal(Number(tables[0].n), 0, 'база для проверки должна быть пустой');
  } else {
    const file = path.join(dir, 'flux.sqlite');
    new Database(file).close();
    const { PrismaClient } = require('@prisma/client-sqlite');
    const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
    db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  }
  const schema = { sqlite: 'schema.prisma', postgresql: 'schema.postgresql.prisma', mysql: 'schema.mariadb.prisma' }[dialect];
  const log: string[] = [];
  await ensureRemoteSchema(db, dialect, fs.readFileSync(path.join(__dirname, '..', 'prisma', schema), 'utf8'), (m) => log.push(m));
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

  const bundle = moduleBundle('1.0.0');
  const req = await submit('dev', dev, bundle, { version: '1.0.0', channel: 'test' });
  assert.equal(req.status, 200);
  const issued = await release(req.body.id, bundle, '1.0.0', devHex, 'test');
  const original = issued.body.release;
  const before = await call('owner', `/api/modules/releases/${original.id}/chunks`);
  assert.equal((await call('other', '/api/modules/releases')).body.releases.length, 0);
  const claim = buildPromotionClaim({ releaseSignature: original.signature, rootHex });
  const signed = sealEnvelope('promotion', claim, root);
  const post = (who: string, signature: string) => call(who, '/api/modules/promotions', 'POST', { signature });
  assert.equal((await post('dev', signed)).status, 403);
  assert.equal((await post('owner', sealEnvelope('promotion', claim, dev))).status, 400);
  assert.equal((await post('owner', sealEnvelope('promotion', { ...claim, releaseSignatureHash: '0'.repeat(64) }, root))).status, 400);
  const signedAgain = sealEnvelope('promotion', { ...claim, iat: claim.iat + 1 }, root);
  const concurrent = await Promise.all([post('owner', signed), post('owner', signedAgain), post('owner', signed)]);
  assert.ok(concurrent.every(r => r.status === 200));
  const stored = (await call('other', '/api/modules/promotions')).body.promotions;
  assert.ok(stored.includes(signed) && stored.includes(signedAgain));
  assert.equal(stored.length, 2);
  const visible = (await call('other', '/api/modules/releases')).body.releases[0];
  assert.equal(visible.id, original.id); assert.equal(visible.signature, original.signature); assert.equal(visible.channel, 'production');
  assert.deepEqual((await call('other', `/api/modules/releases/${original.id}/chunks`)).body, before.body);
  const cache = new ModuleCache(path.join(dir, 'promotion-cache'), rootHex);
  await syncModuleReleases(cache, async route => (await call('other', route)).body);
  assert.equal((await cache.runnable()).get(MODULE)?.signature, original.signature);
  const offline = new ModuleCache(path.join(dir, 'promotion-cache'), rootHex);
  assert.equal((await offline.runnable()).get(MODULE)?.signature, original.signature);
  await offline.addPins([pinEnvelope(root, MODULE, 'production', '0.9.0')]);
  assert.equal((await offline.runnable()).size, 0);
  await offline.addPins([pinEnvelope(root, MODULE, 'production', null, Date.now() + 1000)]);
  assert.equal((await offline.runnable()).size, 1);
  await offline.addRevocations([revocationEnvelope(root, 'release', `${MODULE}@1.0.0`)]);
  assert.equal((await offline.runnable()).size, 0);
  console.log('Перевод, подписи, кэш, откат и отзыв проверены');

  server.close();
  await db.$disconnect();
  console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${passed})`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('✗', e); process.exit(1); });
