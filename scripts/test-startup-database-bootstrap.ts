import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-startup-db-'));

async function run() {
  console.log('Creating an isolated empty SQLite database and synchronizing its Prisma schema.');
  const freshPath = path.join(root, 'fresh', 'database.sqlite');
  const commands: string[] = [];
  let sqlite: any;
  const openSqlite = () => sqlite || (sqlite = new Database(freshPath));
  const client = {
    async $queryRawUnsafe(sql: string) { return openSqlite().prepare(sql).all(); },
    async $executeRawUnsafe(sql: string) { openSqlite().exec(sql); return 0; },
  };
  try {
    const result = await bootstrapLocalDatabase(freshPath, client, schema, message => commands.push(message));
    openSqlite();
    assert.equal(result.created, true, 'missing database is created as a new file');
    assert.ok(result.applied.length > 0, 'Prisma models are created by schema sync');
    assert.ok(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='User'").get());
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM "User"').get().n, 0, 'bootstrap creates no demo users');
    assert.ok(commands.some(message => message.includes('новая пустая база')));
  } finally {
    sqlite?.close();
  }

  console.log('Checking a valid existing database keeps its tables and rows.');
  const existingPath = path.join(root, 'existing', 'database.sqlite');
  fs.mkdirSync(path.dirname(existingPath), { recursive: true });
  const existingDb = new Database(existingPath);
  existingDb.exec('CREATE TABLE PreserveMe (value TEXT NOT NULL); INSERT INTO PreserveMe VALUES (\'keep-this-row\');');
  existingDb.close();
  const existingConnection = new Database(existingPath);
  const existingClient = {
    async $queryRawUnsafe(sql: string) { return existingConnection.prepare(sql).all(); },
    async $executeRawUnsafe(sql: string) { existingConnection.exec(sql); return 0; },
  };
  let existingResult;
  try { existingResult = await bootstrapLocalDatabase(existingPath, existingClient, schema, () => {}); }
  finally { existingConnection.close(); }
  assert.equal(existingResult.created, false, 'an existing file is never classified as a new database');
  const preserved = new Database(existingPath, { readonly: true });
  try {
    assert.equal(preserved.prepare('SELECT value FROM PreserveMe').get().value, 'keep-this-row');
    assert.ok(preserved.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='User'").get());
  } finally { preserved.close(); }

  const brokenPath = path.join(root, 'old', 'database.sqlite');
  console.log('Checking refusal preserves existing database, WAL, and SHM bytes.');
  fs.mkdirSync(path.dirname(brokenPath), { recursive: true });
  const oldDb = new Database(brokenPath);
  oldDb.pragma('journal_mode = WAL');
  oldDb.pragma('wal_autocheckpoint = 0');
  oldDb.exec('CREATE TABLE FixtureOnly (id TEXT PRIMARY KEY); DROP TABLE FixtureOnly;');
  const before = [brokenPath, `${brokenPath}-wal`, `${brokenPath}-shm`].map(file => ({
    exists: fs.existsSync(file), size: fs.existsSync(file) ? fs.statSync(file).size : 0,
  }));
  assert.ok(before.every(file => file.exists && file.size > 0), 'fixture has a nonempty database, WAL, and SHM');
  const rejectedClient = {
    async $queryRawUnsafe() { throw new Error('must not query rejected database'); },
    async $executeRawUnsafe() { throw new Error('must not mutate rejected database'); },
  };
  try {
    await assert.rejects(bootstrapLocalDatabase(brokenPath, rejectedClient, schema, () => {}));
    const after = [brokenPath, `${brokenPath}-wal`, `${brokenPath}-shm`].map(file => ({
      exists: fs.existsSync(file), size: fs.existsSync(file) ? fs.statSync(file).size : 0,
    }));
    assert.deepEqual(after.map(file => file.exists), before.map(file => file.exists), 'database, WAL, and SHM remain present');
    assert.ok(after.every(file => file.size > 0), 'database, WAL, and SHM remain nonempty');
  } finally { oldDb.close(); }
}

run().then(() => console.log('Isolated startup database bootstrap checks passed.'))
  .finally(() => fs.rmSync(root, { recursive: true, force: true }))
  .catch(error => { console.error(error); process.exitCode = 1; });
