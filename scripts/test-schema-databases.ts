import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureTables, createTableSql, setDialect, type TableSpec } from '../server/ddl';
import { registerSchemaClient, mariaDbSchemaCoordinator, postgresSchemaCoordinator } from '../server/schemaRuntime';
import { ensureUserProfileSchema } from '../server/userProfileSchema';
import { ensurePlayTables } from '../server/play/tables';
import { ensureCatalog } from '../server/routes/catalog';
import { syncCatalogSeed } from '../server/catalogSeed';
import { seedCatalog, SEED_VERSION } from '../catalog/seed';
import { defaultBlankTemplate } from '../catalog/blank/defaults';
import { buildDatabaseClient } from '../server/databaseClient';
import { ensureRemoteSchema } from '../server/schema-sync';

// These URLs must name disposable local fixtures. Never load app/company config.
const require = createRequire(import.meta.url);
const specs: TableSpec[] = [{ table: 'SchemaFixture', cols: [
  { name: 'id', kind: 'text', pk: true },
  { name: 'owner', kind: 'text', indexed: true },
  { name: 'state', kind: 'text', def: 'ACTIVE' },
], indexes: [{ name: 'SchemaFixture_active_key', cols: ['owner'], unique: true, where: `"state" = 'ACTIVE'` }] }];

async function test(dialect: 'mysql' | 'postgresql', endpoint: string) {
  const url = new URL(endpoint);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'only loopback fixture databases are allowed');
  assert.ok(url.pathname.includes('fixture'), 'database must be explicitly named as a fixture');
  const mysql = dialect === 'mysql';
  const { PrismaClient } = require(mysql ? '@prisma/client-mysql' : '@prisma/client-pg');
  const adapter = () => mysql
    ? new (require('@prisma/adapter-mariadb').PrismaMariaDb)(endpoint)
    : new (require('@prisma/adapter-pg').PrismaPg)({ connectionString: endpoint });
  let opens = 0, ddl = 0;
  const socketIds = new Set<number>();
  const connect = async () => {
    opens++;
    const c = await require('mariadb').createConnection(endpoint.replace(/^mysql:\/\//i, 'mariadb://'));
    const [{ id }] = await c.query('SELECT CONNECTION_ID() AS id');
    const query = c.query.bind(c);
    c.query = async (...args: any[]) => {
      if (/^(ALTER|CREATE|SELECT (GET_LOCK|RELEASE_LOCK))/.test(args[0])) {
        const [current] = await query('SELECT CONNECTION_ID() AS id');
        assert.equal(Number(current.id), Number(id), 'lock, DDL and release use the same physical connection');
        socketIds.add(Number(id));
        if (/^(ALTER|CREATE)/.test(args[0])) ddl++;
      }
      return query(...args);
    };
    return c;
  };
  const make = () => {
    const p = new PrismaClient({ adapter: adapter() });
    registerSchemaClient(p, dialect, mysql ? mariaDbSchemaCoordinator(connect) : postgresSchemaCoordinator(async () => {
      const client = new (require('pg').Client)({ connectionString: endpoint });
      await client.connect(); return client;
    }));
    return p;
  };
  const p = make(), other = make();
  const q = (id: string) => mysql ? `\`${id}\`` : `"${id}"`;
  try {
    await assert.rejects(ensureUserProfileSchema(p), /Основная таблица User отсутствует/);
    const absent = await p.$queryRawUnsafe(mysql
      ? "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='User'"
      : "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='User'");
    assert.equal(absent.length, 0, 'partial migration never creates an incomplete User table');
    await p.$executeRawUnsafe(createTableSql(dialect, 'User', [{ name: 'id', kind: 'text', pk: true }]));
    await p.$executeRawUnsafe(`INSERT INTO ${q('User')} (${q('id')}) VALUES ('keep-profile')`);
    await Promise.all(Array.from({ length: 8 }, () => ensureUserProfileSchema(p)));
    const profile = await p.$queryRawUnsafe(`SELECT * FROM ${q('User')}`);
    assert.equal(profile[0].id, 'keep-profile');
    for (const field of ['position', 'department', 'email']) assert.equal(profile[0][field], null);

    await p.$executeRawUnsafe(createTableSql(dialect, specs[0].table, specs[0].cols.slice(0, 2)));
    await p.$executeRawUnsafe(`INSERT INTO ${q('SchemaFixture')} (${q('id')}, ${q('owner')}) VALUES ('keep', 'employee')`);
    const startOpens = opens;
    assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => ensureTables(p, specs, undefined, true))), Array(8).fill(''));
    if (mysql) assert.equal(opens - startOpens, 1, 'one preparation connection per client/spec');
    const before = ddl;
    assert.equal(await ensureTables(p, specs, undefined, true), '');
    assert.equal(ddl, before, 'ready client does not repeat DDL');
    assert.equal(await ensureTables(other, specs, undefined, true), '', 'second client validates independently');
    const kept = await p.$queryRawUnsafe(`SELECT ${q('state')} FROM ${q('SchemaFixture')} WHERE ${q('id')}='keep'`);
    assert.equal(kept[0].state, 'ACTIVE');
    await assert.rejects(p.$executeRawUnsafe(`INSERT INTO ${q('SchemaFixture')} (${q('id')},${q('owner')}) VALUES ('duplicate','employee')`));
    await p.$executeRawUnsafe(`INSERT INTO ${q('SchemaFixture')} (${q('id')},${q('owner')},${q('state')}) VALUES ('closed','employee','CLOSED')`);
    assert.deepEqual(await Promise.all([ensurePlayTables(p), ensurePlayTables(p)]), ['', '']);
    // Two server clients race through first seed; duplicate fallback preserves rows.
    await Promise.all([ensureCatalog(p), ensureCatalog(other)]);
    const seed = seedCatalog();
    assert.equal(await p.catalogComponent.count(), seed.components.length);
    const family = seed.families[0];
    await p.catalogFamily.update({ where: { id: family.id }, data: { edited: true, code: 'manual', seedVersion: 0 } });
    await syncCatalogSeed(other, seed, SEED_VERSION, defaultBlankTemplate());
    assert.equal((await p.catalogFamily.findUnique({ where: { id: family.id } })).code, 'manual');
    const production = buildDatabaseClient('REMOTE', endpoint, {
      load: require, selectDialect: () => {}, sqliteAdapter: () => { throw Error('unexpected SQLite'); },
    });
    try { assert.equal(await ensureTables(production, specs, undefined, true), '', 'production factory registers a working physical-connection coordinator'); }
    finally { await production.$disconnect(); }
    const schemaLogs: string[] = [];
    const schema = readFileSync(join(__dirname, '..', 'prisma', mysql ? 'schema.mariadb.prisma' : 'schema.postgresql.prisma'), 'utf8');
    await ensureRemoteSchema(p, dialect, schema, message => schemaLogs.push(message));
    assert.deepEqual(schemaLogs.filter(message => /Не удалось|Пропуск|Ошибка при/.test(message)), [], 'full startup schema migrates without hidden failures');
    const user = await p.user.create({ data: { symbol: 'fixture-member', name: 'Fixture', password: 'fixture-explicit-hash' } });
    const group = await p.chatGroup.create({ data: { name: 'Fixture group', members: { connect: { id: user.id } } } });
    const read = await p.user.findUnique({ where: { id: user.id }, include: { chatGroups: true } });
    assert.equal(read.chatGroups[0].id, group.id, 'Prisma implicit membership relation works');
    await p.user.delete({ where: { id: user.id } });
    const remaining = await p.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM ${q('_GroupMembers')}`);
    assert.equal(Number(remaining[0].n), 0, 'implicit relation has cascading foreign keys');
    assert.equal(await p.chatGroup.count(), 1, 'cascade preserves the group');
    if (mysql) {
      // Real driver failure: finally releases and closes the physical connection.
      const coordinate = mariaDbSchemaCoordinator(connect);
      await assert.rejects(coordinate(async c => { await c.$executeRawUnsafe('ALTER TABLE missing_fixture_table ADD COLUMN x TEXT'); }), /missing_fixture_table/);
      const probe = await require('mariadb').createConnection(endpoint.replace(/^mysql:\/\//i, 'mariadb://'));
      const name = `flux:schema:${createHash('sha256').update(url.pathname.slice(1)).digest('hex').slice(0, 48)}`;
      try {
        assert.equal(Number((await probe.query('SELECT GET_LOCK(?, 0) AS acquired', [name]))[0].acquired), 1, 'failure released lock');
        await probe.query('SELECT RELEASE_LOCK(?)', [name]);
      } finally { await probe.end(); }
      assert.ok(socketIds.size >= 3);
    }
    console.log(`✓ ${dialect}: partial migrations preserve data, singleflight, conditional unique, full Play DDL, concurrent seed/manual catalog edits${mysql ? ', physical connection lock/release' : ''}`);
  } finally { await Promise.all([p.$disconnect(), other.$disconnect()]); }
}

async function main() {
  for (const [dialect, name] of [['mysql', 'FLUX_SCHEMA_MARIA_FIXTURE_URL'], ['postgresql', 'FLUX_SCHEMA_PG_FIXTURE_URL']] as const) {
    const endpoint = process.env[name];
    assert.ok(endpoint, `${name} must name a fresh disposable loopback fixture`);
    await test(dialect, endpoint);
  }
  setDialect('sqlite');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
