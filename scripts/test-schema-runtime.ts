import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ensureTables, setDialect, type TableSpec } from '../server/ddl';
import { registerSchemaClient, oncePerDatabase, mariaDbSchemaCoordinator, postgresSchemaCoordinator } from '../server/schemaRuntime';
import { setPrisma } from '../server/context';
import { ensureUserProfileSchema } from '../server/userProfileSchema';

const require = createRequire(import.meta.url);
const Sqlite = require('better-sqlite3');
const spec: TableSpec[] = [{ table: 'Test', cols: [{ name: 'id', kind: 'text', pk: true }, { name: 'owner', kind: 'text', notNull: true }, { name: 'state', kind: 'text', def: 'ACTIVE' }], indexes: [{ name: 'Test_active_key', cols: ['owner'], unique: true, where: `"state" = 'ACTIVE'` }] }];
function fixture() {
  const sqlite = new Sqlite(':memory:');
  const executed: string[] = [];
  let reads = 0;
  const prisma = {
    async $executeRawUnsafe(sql: string) { executed.push(sql); sqlite.exec(sql); return 0; },
    async $queryRawUnsafe(sql: string) { reads++; return sqlite.prepare(sql).all(); },
  };
  registerSchemaClient(prisma, 'sqlite');
  return { prisma, sqlite, executed, reads: () => reads };
}
async function main() {
  const a = fixture(), b = fixture();
  try {
    a.sqlite.exec('CREATE TABLE "Test" ("id" TEXT PRIMARY KEY, "owner" TEXT NOT NULL)');
    a.sqlite.exec(`INSERT INTO "Test" (id, owner) VALUES ('keep', 'first')`);
    setDialect('mysql');
    assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => ensureTables(a.prisma, spec, undefined, true))), Array(8).fill(''));
    assert.equal(a.executed.filter(sql => sql.startsWith('ALTER TABLE')).length, 1, 'добавлена лишь отсутствующая колонка, параллельный ensure не повторяет DDL');
    assert.equal(a.sqlite.prepare('SELECT state FROM Test WHERE id = ?').get('keep').state, 'ACTIVE');
    assert.throws(() => a.sqlite.exec(`INSERT INTO Test(id, owner) VALUES ('duplicate', 'first')`), /UNIQUE/);
    a.sqlite.exec(`INSERT INTO Test(id, owner, state) VALUES ('closed', 'first', 'CLOSED')`);
    const readCount = a.reads();
    assert.equal(await ensureTables(a.prisma, spec, undefined, true), '');
    assert.equal(a.reads(), readCount, 'успех cached без round trips');
    assert.equal(await ensureTables(b.prisma, spec, undefined, true), '', 'второй настоящий клиент готовится независимо');
    assert.ok(b.executed.some(sql => sql.startsWith('CREATE TABLE')));

    setPrisma(a.prisma);
    assert.equal(await ensureTables(a.prisma, spec, undefined, true), '');
    assert.ok(a.reads() > readCount, 'новое поколение того же клиента перечитывает схему');
    const altered = a.executed.length;
    assert.equal(altered, 2, 'полная существующая схема обходится без DDL');

    const broken = fixture();
    try {
      broken.sqlite.exec('CREATE TABLE Test(id TEXT PRIMARY KEY, owner TEXT, state TEXT); CREATE INDEX Test_active_key ON Test(owner)');
      assert.match(await ensureTables(broken.prisma, spec, undefined, true), /не соответствует/);
      broken.sqlite.exec('DROP INDEX Test_active_key');
      assert.equal(await ensureTables(broken.prisma, spec, undefined, true), '', 'ошибка не помечает подготовку успешной');
    } finally { broken.sqlite.close(); }

    let complete!: () => void;
    const gate = new Promise<void>(resolve => { complete = resolve; });
    let runs = 0;
    const old = oncePerDatabase(a.prisma, 'generation-race', async () => { runs++; await gate; });
    await Promise.resolve();
    setPrisma(b.prisma);
    await oncePerDatabase(a.prisma, 'generation-race', async () => { runs++; });
    complete(); await old;
    await oncePerDatabase(a.prisma, 'generation-race', async () => { runs++; });
    assert.equal(runs, 2, 'завершение старого поколения не заменяет новое');

    const users = fixture();
    try {
      await assert.rejects(ensureUserProfileSchema(users.prisma), /Основная таблица User отсутствует/);
      users.sqlite.exec('CREATE TABLE User(id TEXT PRIMARY KEY); INSERT INTO User VALUES (\'employee\')');
      await Promise.all(Array.from({ length: 8 }, () => ensureUserProfileSchema(users.prisma)));
      assert.equal(users.executed.length, 3, 'поля профиля добавлены один раз');
      assert.deepEqual(users.sqlite.prepare('SELECT * FROM User').get(), { id: 'employee', position: null, department: null, email: null });
      const userReads = users.reads();
      await ensureUserProfileSchema(users.prisma);
      assert.equal(users.reads(), userReads);
      setPrisma(users.prisma);
      await ensureUserProfileSchema(users.prisma);
      assert.ok(users.reads() > userReads);
      assert.equal(users.executed.length, 3, 'смена поколения перечитывает профиль без повторного ALTER');
    } finally { users.sqlite.close(); }
  } finally { a.sqlite.close(); b.sqlite.close(); setPrisma(null); setDialect('sqlite'); }

  for (const outcome of ['success', 'failure', 'abort', 'timeout', 'disconnect'] as const) {
    const calls: string[] = [];
    const coordinator = mariaDbSchemaCoordinator(async () => ({
      async query(sql: string) {
        calls.push(sql);
        if (sql.includes('DATABASE()')) return [{ db: 'fixture' }];
        if (sql.includes('GET_LOCK')) return [{ acquired: outcome === 'timeout' ? 0 : 1 }];
        if (sql.includes('ALTER TABLE') && outcome === 'disconnect') throw Error('socket disconnected');
        return [];
      },
      async end() { calls.push('end'); },
    }));
    const work = async (connection: any) => {
      await connection.$executeRawUnsafe('ALTER TABLE Test ADD COLUMN missing TEXT');
      if (outcome === 'failure') throw Error('DDL refused');
      if (outcome === 'abort') throw Object.assign(Error('cancelled'), { name: 'AbortError' });
      return 'ok';
    };
    if (outcome === 'success') assert.equal(await coordinator(work), 'ok');
    else await assert.rejects(coordinator(work), outcome === 'timeout' ? /занята/ : outcome === 'disconnect' ? /disconnected/ : outcome === 'failure' ? /refused/ : /cancelled/);
    assert.equal(calls.at(-1), 'end');
    assert.equal(calls.some(sql => sql.includes('RELEASE_LOCK')), outcome !== 'timeout');
    if (outcome === 'timeout') assert.ok(!calls.some(sql => sql.includes('ALTER TABLE')));
  }
  console.log('✓ SQLite: неполная схема дополнена, данные сохранены, условный UNIQUE действует, singleflight и generation проверены');
  console.log('✓ MariaDB coordinator: DDL pinned, release/close при успехе, ошибке, отмене и обрыве; timeout блокирует DDL');
  for (const outcome of ['success', 'failure', 'abort', 'timeout', 'disconnect', 'release'] as const) {
    const calls: string[] = [];
    const coordinate = postgresSchemaCoordinator(async () => ({
      async query(sql: string) {
        calls.push(sql);
        if (sql.includes('pg_advisory_lock(') && outcome === 'timeout') throw Error('lock timeout');
        if (sql.includes('pg_advisory_unlock(') && outcome === 'release') throw Error('release failed');
        if (sql.startsWith('ALTER TABLE') && outcome === 'disconnect') throw Error('socket disconnected');
        return { rows: [], rowCount: 0 };
      },
      async end() { calls.push('end'); },
    }));
    const pending = coordinate(async c => {
      await c.$executeRawUnsafe('ALTER TABLE Test ADD COLUMN x TEXT');
      if (outcome === 'failure') throw Error('DDL refused');
      if (outcome === 'abort') throw Error('cancelled');
      return 'ok';
    });
    if (outcome === 'success') assert.equal(await pending, 'ok');
    else await assert.rejects(pending, outcome === 'timeout' ? /timeout/ : outcome === 'disconnect' ? /disconnected/ : outcome === 'failure' ? /refused/ : outcome === 'abort' ? /cancelled/ : /release failed/);
    assert.equal(calls.at(-1), 'end');
    assert.equal(calls.some(sql => sql.includes('pg_advisory_unlock(')), outcome !== 'timeout');
    if (outcome === 'timeout') assert.ok(!calls.some(sql => sql.startsWith('ALTER TABLE')));
  }
  console.log('✓ PostgreSQL coordinator: advisory lock, pinned DDL, release/close on success/failure/abort/disconnect/timeout/release failure');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
