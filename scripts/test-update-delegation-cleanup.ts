/**
 * Миграция: выданные администраторам разрешения на обновления снимаются, остальное остаётся.
 *
 * Решение владельца (9 ноября 2026): обновлениями управляет только владелец. Проверяется на настоящей
 * схеме в SQLite и, если заданы одноразовые базы (FLUX_RETIRE_PG_FIXTURE_URL / FLUX_RETIRE_MARIA_FIXTURE_URL),
 * в PostgreSQL и MariaDB: те же шаги, тот же результат.
 *
 * Запуск: npx tsx scripts/test-update-delegation-cleanup.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRemoteSchema } from '../server/schema-sync';
import { retireUpdateDelegations } from '../server/updateDelegationCleanup';

const Database = require('better-sqlite3');
const pgUrl = String(process.env.FLUX_RETIRE_PG_FIXTURE_URL || '').trim();
const mariaUrl = String(process.env.FLUX_RETIRE_MARIA_FIXTURE_URL || '').trim();
const dialect = pgUrl ? 'postgresql' : mariaUrl ? 'mysql' : 'sqlite';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-retire-delegations-'));
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };

async function open() {
  const fixture = pgUrl || mariaUrl;
  if (fixture) {
    const url = new URL(fixture);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.includes('fixture'), 'только одноразовая база на loopback с fixture в имени');
    const { PrismaClient } = require(pgUrl ? '@prisma/client-pg' : '@prisma/client-mysql');
    return pgUrl ? new PrismaClient({ adapter: new (require('@prisma/adapter-pg').PrismaPg)({ connectionString: fixture }) })
      : new PrismaClient({ adapter: new (require('@prisma/adapter-mariadb').PrismaMariaDb)(fixture) });
  }
  const file = path.join(dir, 'flux.sqlite');
  new Database(file).close();
  const { PrismaClient } = require('@prisma/client-sqlite');
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
}

async function main() {
  const db = await open();
  const schema = { sqlite: 'schema.prisma', postgresql: 'schema.postgresql.prisma', mysql: 'schema.mariadb.prisma' }[dialect];
  await ensureRemoteSchema(db, dialect, fs.readFileSync(path.join(__dirname, '..', 'prisma', schema), 'utf8'), () => {});
  console.log(`Снятие разрешений администраторам на обновления (${dialect})`);

  const permissions = JSON.stringify({ 'admin.users.manage': { enabled: true, until: null }, 'vdr.delete': { enabled: true, until: null } });
  await db.user.create({ data: { id: 'admin-a', symbol: 'a', password: 'x', name: 'Админ А', role: 'ADMIN', permissions } });
  await db.user.create({ data: { id: 'admin-b', symbol: 'b', password: 'x', name: 'Админ Б', role: 'ADMIN', permissions } });
  const setting = (id: string, key: string, value: string) => db.appSetting.create({ data: { id, key, userId: null, value } });
  await setting('update.delegation:admin-a', 'update.delegation', JSON.stringify({ code: 'FLUXUPDAUTH1.a' }));
  await setting('update.delegation:admin-b', 'update.delegation', JSON.stringify({ code: 'FLUXUPDAUTH1.b' }));
  // Идущая кампания: команда, голова цепочки устройства, сведения об устройстве и чужие настройки того же вида
  await setting('update.command:cmd-1', 'update.command', JSON.stringify({ command: 'c', delegation: 'FLUXUPDAUTH1.inside', releaseSignature: 'r' }));
  await setting('update.head:dev:emp', 'update.head', 'cmd-1');
  await setting('update.device:dev', 'update.device', '{}');
  await setting('equip_visibility', 'equip_visibility', '{}');

  const removed = await retireUpdateDelegations(db);
  const rows = async (key: string) => (await db.appSetting.findMany({ where: { key } })).length;
  ok('оба разрешения сняты', removed === 2 && await rows('update.delegation') === 0);
  ok('идущая кампания цела: команда, голова цепочки, устройство', await rows('update.command') === 1 && await rows('update.head') === 1 && await rows('update.device') === 1);
  ok('команда сохранила своё разрешение внутри конверта', JSON.parse((await db.appSetting.findUnique({ where: { id: 'update.command:cmd-1' } })).value).delegation === 'FLUXUPDAUTH1.inside');
  ok('прочие настройки не тронуты', await rows('equip_visibility') === 1);
  ok('права администраторов на остальное сохранены побайтно', (await db.user.findMany({ where: { role: 'ADMIN' } })).every((u: any) => u.permissions === permissions));
  const marker = await db.appSetting.findFirst({ where: { key: 'migration:update.delegation.retired.v1' } });
  ok('в отметке записано, чьи разрешения сняты', JSON.parse(marker.value).profiles.sort().join() === 'admin-a,admin-b');
  ok('повторный запуск ничего не делает', await retireUpdateDelegations(db) === 0 && await rows('update.command') === 1);
  await db.$disconnect?.();
  console.log(`\n${passed} проверок пройдено, 0 провалено`);
}
main().then(() => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); }, e => { console.error(e); fs.rmSync(dir, { recursive: true, force: true }); process.exit(1); });
