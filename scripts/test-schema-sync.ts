/**
 * Автомиграция создаёт составные уникальные ключи @@unique([a, b]).
 *
 * Раньше она создавала таблицы с колонками и первичным ключом, но без
 * составных ключей. У того, кто обновился со старой версии, и в общей базе
 * таблица FileChunk выглядела исправной, а запись куска файла падала:
 * upsert — это INSERT … ON CONFLICT("fileId","idx"), и SQLite отвечал, что
 * такого ключа нет. Проверяем на настоящей SQLite с настоящей схемой.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRemoteSchema, parsePrismaSchema } from '../server/schema-sync';

let ok = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  pass ? ok++ : fail++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${pass ? '' : ` — получено ${JSON.stringify(got)}, ожидалось ${JSON.stringify(want)}`}`);
};

/** Клиент с теми двумя методами Prisma, которыми пользуется автомиграция */
const asPrisma = (db: Database.Database) => ({
  $queryRawUnsafe: async (sql: string) => db.prepare(sql).all(),
  $executeRawUnsafe: async (sql: string) => { db.exec(sql); return 0; },
});

/** Уникальные индексы таблицы как наборы колонок */
const uniqueSets = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA index_list("${table}")`).all() as any[])
    .filter((ix) => ix.unique === 1)
    .map((ix) => (db.prepare(`PRAGMA index_info("${ix.name}")`).all() as any[]).map((c) => c.name).sort().join(','))
    .sort();

const SCHEMA = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'flux-schema-sync-'));
const logs: string[] = [];
const log = (m: string) => logs.push(m);

async function main() {
  console.log('1. Разбор схемы');
  const models = parsePrismaSchema('sqlite', SCHEMA);
  const chunk = models.find((m) => m.name === 'FileChunk');
  eq('у FileChunk найден ключ (fileId, idx) с именем, как у Prisma',
    chunk?.uniques, [{ name: 'FileChunk_fileId_idx_key', columns: ['fileId', 'idx'] }]);
  const mapped = parsePrismaSchema('sqlite', 'model A {\n  id String @id\n  x String\n  y Int\n  @@unique([x, y], map: "A_xy")\n}');
  eq('имя из map: берётся как есть', mapped[0]?.uniques, [{ name: 'A_xy', columns: ['x', 'y'] }]);
  eq('модели без составных ключей — пустой список', models.find((m) => m.name === 'FileNode')?.uniques, []);

  console.log('\n2. Таблица, созданная старой автомиграцией, получает ключ');
  const db = new Database(join(dir, 'old.sqlite'));
  // Так её создавала прежняя версия: колонки и первичный ключ, без (fileId, idx)
  db.exec('CREATE TABLE "FileChunk" ("id" TEXT NOT NULL, "fileId" TEXT NOT NULL, "idx" INTEGER NOT NULL, "data" BLOB NOT NULL, PRIMARY KEY ("id"))');
  const upsert = () => db.prepare(
    `INSERT INTO "FileChunk" ("id","fileId","idx","data") VALUES (?, 'f1', 0, x'01')
     ON CONFLICT("fileId","idx") DO UPDATE SET "data" = excluded."data"`,
  ).run(String(Math.random()));
  let before = '';
  try { upsert(); } catch (e: any) { before = e.message; }
  eq('до починки запись куска падает — это и есть дефект', /ON CONFLICT/.test(before), true);

  const applied = await ensureRemoteSchema(asPrisma(db), 'sqlite', SCHEMA, log);
  eq('ключ FileChunk создан', applied.includes('ключ FileChunk_fileId_idx_key'), true);
  eq('в таблице есть уникальный индекс (fileId, idx)', uniqueSets(db, 'FileChunk').includes('fileId,idx'), true);
  let after = '';
  try { upsert(); upsert(); } catch (e: any) { after = e.message; }
  eq('после починки запись куска проходит', after, '');
  eq('повторная запись того же куска не плодит строк',
    (db.prepare('SELECT COUNT(*) AS n FROM "FileChunk"').get() as any).n, 1);

  console.log('\n3. Повторный запуск ничего не меняет');
  const again = await ensureRemoteSchema(asPrisma(db), 'sqlite', SCHEMA, log);
  eq('второй проход не создаёт ключей', again.filter((a) => a.startsWith('ключ ')), []);
  eq('индекс не удвоился', uniqueSets(db, 'FileChunk').filter((s) => s === 'fileId,idx').length, 1);

  console.log('\n4. Ключ под другим именем узнаётся по колонкам');
  // Так ключ гостей календаря заводит ensureSchemaColumns — под своим именем
  const cal = new Database(join(dir, 'cal.sqlite'));
  cal.exec('CREATE TABLE "CalGuest" ("id" TEXT NOT NULL PRIMARY KEY, "eventId" TEXT NOT NULL, "userId" TEXT NOT NULL)');
  cal.exec('CREATE UNIQUE INDEX "CalGuest_event_user_key" ON "CalGuest"("eventId", "userId")');
  const third = await ensureRemoteSchema(asPrisma(cal), 'sqlite', SCHEMA, log);
  eq('второй такой же ключ не создан', third.some((a) => a.startsWith('ключ CalGuest')), false);
  cal.close();

  console.log('\n5. Повторы в таблице — ключ не создаётся, данные целы');
  const dup = new Database(join(dir, 'dup.sqlite'));
  dup.exec('CREATE TABLE "FileChunk" ("id" TEXT NOT NULL PRIMARY KEY, "fileId" TEXT NOT NULL, "idx" INTEGER NOT NULL, "data" BLOB NOT NULL)');
  dup.exec(`INSERT INTO "FileChunk" VALUES ('a', 'f1', 0, x'01'), ('b', 'f1', 0, x'02')`);
  logs.length = 0;
  let threw = '';
  try { await ensureRemoteSchema(asPrisma(dup), 'sqlite', SCHEMA, log); } catch (e: any) { threw = e.message; }
  eq('автомиграция не падает', threw, '');
  eq('обе строки на месте', (dup.prepare('SELECT COUNT(*) AS n FROM "FileChunk"').get() as any).n, 2);
  eq('в логе сказано, какой ключ не создан и почему',
    logs.some((l) => l.includes('FileChunk_fileId_idx_key') && l.includes('повторы')), true);

  console.log('\n6. Новая таблица создаётся сразу с ключом');
  const fresh = new Database(join(dir, 'fresh.sqlite'));
  await ensureRemoteSchema(asPrisma(fresh), 'sqlite', SCHEMA, log);
  eq('FileChunk в пустой базе — с ключом (fileId, idx)', uniqueSets(fresh, 'FileChunk').includes('fileId,idx'), true);
  const missing = parsePrismaSchema('sqlite', SCHEMA)
    .flatMap((m) => m.uniques.map((u) => ({ table: m.name, key: [...u.columns].sort().join(',') })))
    .filter(({ table, key }) => !uniqueSets(fresh, table).includes(key))
    .map(({ table, key }) => `${table}(${key})`);
  eq('ни один составной ключ схемы не потерян', missing, []);

  db.close(); dup.close(); fresh.close();
}

main()
  .catch((e) => { fail++; console.error('  ✗ набор прерван:', e?.message || e); })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
    process.exit(fail ? 1 : 0);
  });
