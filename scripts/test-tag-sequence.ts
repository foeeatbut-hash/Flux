/**
 * Нумерация тегов по префиксу и уникальный код тега в проекте (SQLite).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import { nextTagIdentifier as next } from '../server/tagSequence';
import { ensureSchemaColumns } from '../server/localSchema';

const Database = require('better-sqlite3');

// 76: разрядность — у тега с наибольшим номером, три знака только без тегов
assert.equal(next([], 'P-'), 'P-001');
assert.equal(next(['P-01', 'P-02', 'P-09'], 'P-'), 'P-10');
assert.equal(next(['P-9', 'P-10'], 'P-'), 'P-11');
assert.equal(next(['K001', 'K999'], 'K'), 'K1000');
// 77: с суффиксом чужие серии не считаются
assert.equal(next(['K005', 'K001B'], 'K', 'B'), 'K002B');
assert.equal(next(['K005'], 'K', 'B'), 'K001B');
assert.equal(next(['K001B', 'K003B', 'K010'], 'K', 'B'), 'K004B');
// без суффикса «005B» не число
assert.equal(next(['K005B', 'K002'], 'K'), 'K003');
// регистр префикса различается
assert.equal(next(['p-05'], 'P-'), 'P-001');
console.log('✓ нумерация: разрядность, суффикс, регистр');

// 78: индекс на SQLite создаётся, а при старых повторах — нет, и данные целы
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-tag-seq-'));
try {
  const mk = (name: string, rows: Array<[string, string, string]>) => {
    const f = path.join(dir, name);
    const db = new Database(f);
    db.exec('CREATE TABLE "Tag" ("id" TEXT PRIMARY KEY NOT NULL, "identifier" TEXT NOT NULL, "projectId" TEXT NOT NULL)');
    const ins = db.prepare('INSERT INTO "Tag" VALUES (?,?,?)');
    for (const r of rows) ins.run(...r);
    db.close();
    return f;
  };
  const indexes = (f: string) => { const db = new Database(f, { readonly: true }); try { return db.prepare("PRAGMA index_list('Tag')").all().map((i: any) => i.name); } finally { db.close(); } };

  const clean = mk('clean.sqlite', [['1', 'A-1', 'p'], ['2', 'A-1', 'q']]);
  ensureSchemaColumns(clean, () => {});
  assert(indexes(clean).includes('Tag_projectId_identifier_key'));
  const db1 = new Database(clean);
  assert.throws(() => db1.prepare('INSERT INTO "Tag" (id, identifier, projectId) VALUES (?,?,?)').run('3', 'A-1', 'p'), /UNIQUE/);
  db1.close();

  const logs: string[] = [];
  const dup = mk('dup.sqlite', [['1', 'A-1', 'p'], ['2', 'A-1', 'p']]);
  ensureSchemaColumns(dup, m => logs.push(m));
  assert(!indexes(dup).includes('Tag_projectId_identifier_key'));
  assert(logs.some(l => /повторяющиеся коды тегов/.test(l) && /p\/A-1/.test(l)));
  const db2 = new Database(dup, { readonly: true });
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM "Tag"').get().n, 2, 'старые повторы не удалены');
  db2.close();
  console.log('✓ уникальный индекс: ставится в чистой базе, при повторах — только запись в журнал');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
