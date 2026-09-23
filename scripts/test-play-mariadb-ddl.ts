import assert from 'node:assert/strict';
import { setDialect, ensureTables } from '../server/ddl';
import { PLAY_TABLES } from '../server/play/tables';

// Имитируем уже существующие обычные колонки. Важно проверить не только
// текст SQL, но и то, что страховка реально выполняет все ограничения.
setDialect('mysql');
const generated = new Set<string>();
const indexes = new Set<string>();
const db = {
  async $executeRawUnsafe(sql: string) {
    if (sql.startsWith('ALTER TABLE') && !sql.includes(' AS (CASE WHEN ')) {
      throw Error('Duplicate column name');
    }
    if (sql.startsWith('ALTER TABLE')) {
      if (generated.has(sql)) throw Error('Duplicate column name');
      generated.add(sql);
    }
    if (sql.startsWith('CREATE UNIQUE INDEX') || sql.startsWith('CREATE INDEX')) {
      if (indexes.has(sql)) throw Error('Duplicate key name');
      indexes.add(sql);
    }
  },
};

async function main() {
  assert.equal(await ensureTables(db, PLAY_TABLES, undefined, true), '');
  const partial = PLAY_TABLES.flatMap(table => (table.indexes || [])
    .filter(index => !!index.where).map(index => ({ table, index })));
  assert.equal(partial.length, 6);
  assert.equal(generated.size, partial.reduce((sum, { index }) => sum + index.cols.length, 0));
  for (const { index } of partial) {
    assert.ok([...indexes].some(sql => sql.includes(`\`${index.name}\``)));
  }
  assert.equal(await ensureTables(db, PLAY_TABLES, undefined, true), '', 'повторная подготовка идемпотентна');

  const broken = {
    async $executeRawUnsafe(sql: string) {
      if (sql.startsWith('ALTER TABLE') && !sql.includes(' AS (CASE WHEN ')) throw Error('Duplicate column name');
      if (sql.includes('PlayPartyMember_one_active_key') && sql.startsWith('CREATE UNIQUE INDEX')) {
        throw Error('Duplicate entry in existing active rows');
      }
    },
  };
  const failure = await ensureTables(broken, PLAY_TABLES, undefined, true);
  assert.match(failure, /PlayPartyMember_one_active_key/);
  console.log('✓ MariaDB создаёт все шесть условных ограничений и допускает повторную подготовку');
  console.log('✓ При конфликтующих данных включение игр останавливается с причиной');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
