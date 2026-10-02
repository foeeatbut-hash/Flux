/** Chunk-schema repair regression uses temporary SQLite only; never damages the configured company DB. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureTables } from '../server/ddl';
import { resetSchemaPreparations } from '../server/schemaRuntime';
const Database = require('better-sqlite3');
const { PrismaClient } = require('@prisma/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-update-repair-'));
const file = path.join(directory, 'fixture.sqlite');
const raw = new Database(file);
raw.exec('CREATE TABLE AppUpdateChunk (id TEXT PRIMARY KEY, version TEXT NOT NULL, idx INTEGER NOT NULL)'); raw.close();
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
const spec: any[] = [{ table: 'AppUpdateChunk', cols: [
  { name: 'id', kind: 'text', pk: true }, { name: 'version', kind: 'text', notNull: true, def: '', indexed: true },
  { name: 'idx', kind: 'int', notNull: true, def: 0 }, { name: 'data', kind: 'blob', notNull: true },
], indexes: [{ name: 'AppUpdateChunk_version_idx_key', cols: ['version', 'idx'], unique: true }] }];
(async () => {
  assert.equal(await ensureTables(prisma, spec), '');
  const bytes = Buffer.from('MZ-complete-fixture');
  await prisma.appUpdateChunk.create({ data: { version: 'generation', idx: 0, data: bytes } });
  assert.deepEqual(Buffer.from((await prisma.appUpdateChunk.findFirst()).data), bytes);
  await assert.rejects(() => prisma.appUpdateChunk.create({ data: { version: 'generation', idx: 0, data: bytes } }));
  await prisma.$executeRawUnsafe('DROP TABLE AppUpdateChunk');
  await prisma.$executeRawUnsafe('CREATE TABLE AppUpdateChunk (id TEXT PRIMARY KEY, version TEXT NOT NULL, idx INTEGER NOT NULL)');
  resetSchemaPreparations(prisma);
  assert.equal(await ensureTables(prisma, spec), '');
  await prisma.appUpdateChunk.create({ data: { version: 'new-generation', idx: 0, data: bytes } });
  assert.deepEqual(Buffer.from((await prisma.appUpdateChunk.findFirst()).data), bytes);
  console.log('5 isolated update chunk repair checks passed');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  await prisma.$disconnect(); fs.rmSync(directory, { recursive: true, force: true });
});
