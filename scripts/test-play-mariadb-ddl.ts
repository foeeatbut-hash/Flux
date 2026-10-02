import assert from 'node:assert/strict';
import { setDialect, ensureTables, conditionalColumnName } from '../server/ddl';
import { PLAY_TABLES } from '../server/play/tables';

// Метаданные уже существующей схемы нужны, чтобы тест поймал возвращение
// пробного ALTER каждой колонки, а не считал сотни отказов нормой.
setDialect('mysql');
function fixture(conflict = false) {
  const generated = new Set<string>();
  const indexes = new Set<string>();
  const columns = PLAY_TABLES.flatMap(spec => spec.cols.map(col => ({ t: spec.table, c: col.name })));
  const indexRows: any[] = [];
  let executions = 0;
  const db = {
    async $queryRawUnsafe(sql: string) { return sql.includes('information_schema.columns') ? columns : indexRows; },
    async $executeRawUnsafe(sql: string) {
      executions++;
      assert.ok(!sql.startsWith('CREATE TABLE'), 'существующие таблицы не создаются повторно');
      if (sql.startsWith('ALTER TABLE') && !sql.includes(' AS (CASE WHEN ')) {
        throw Error('Программа попыталась добавить существующую колонку');
      }
      if (sql.startsWith('ALTER TABLE')) {
        assert.ok(!generated.has(sql));
        generated.add(sql);
        const [, t, c] = sql.match(/ALTER TABLE `([^`]+)` ADD COLUMN `([^`]+)`/)!;
        columns.push({ t, c });
      }
      if (sql.startsWith('CREATE UNIQUE INDEX') || sql.startsWith('CREATE INDEX')) {
        if (conflict && sql.includes('PlayPartyMember_one_active_key')) throw Error('Duplicate entry in existing active rows');
        assert.ok(!indexes.has(sql));
        indexes.add(sql);
        const [, name, table, cols] = sql.match(/INDEX `([^`]+)` ON `([^`]+)` \((.*)\)/)!;
        for (const c of cols.matchAll(/`([^`]+)`/g)) indexRows.push({ t: table, n: name, c: c[1], nu: sql.startsWith('CREATE UNIQUE') ? 0 : 1 });
      }
    },
  };
  return { db, generated, indexes, executions: () => executions };
}

async function main() {
  const a = fixture();
  assert.deepEqual(await Promise.all([ensureTables(a.db, PLAY_TABLES, undefined, true), ensureTables(a.db, PLAY_TABLES, undefined, true)]), ['', '']);
  const partial = PLAY_TABLES.flatMap(table => (table.indexes || []).filter(index => !!index.where).map(index => ({ table, index })));
  assert.equal(partial.length, 6);
  assert.equal(a.generated.size, partial.reduce((sum, { index }) => sum + index.cols.length, 0));
  for (const { index } of partial) {
    assert.ok([...a.indexes].some(sql => sql.includes(`\`${index.name}\``)));
    for (const col of index.cols) assert.ok([...a.generated].some(sql => sql.includes(conditionalColumnName(index.name, col))));
  }
  const executions = a.executions();
  assert.equal(await ensureTables(a.db, PLAY_TABLES, undefined, true), '');
  assert.equal(a.executions(), executions, 'повторный запрос не исполняет DDL');
  const broken = fixture(true);
  assert.match(await ensureTables(broken.db, PLAY_TABLES, undefined, true), /PlayPartyMember_one_active_key/);
  console.log('✓ MariaDB: шесть условных ограничений, существующие колонки не ALTER, singleflight не повторяет подготовку');
  console.log('✓ Конфликт уникальности блокирует включение игр с причиной');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
