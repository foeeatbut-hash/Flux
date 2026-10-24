/**
 * Удаление пункта справочника на отдельной SQLite базе: в локальной базе нет
 * внешних ключей, поэтому варианты удалённой категории должен снимать сам маршрут.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import express from 'express';
import { registerDictionaryRoutes } from '../server/routes/dictionaries.js';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma } from '../server/context.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-dictionary-delete-'));
const dbPath = path.join(temp, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`✓ ${label}`);
};

async function main() {
  const app = express();
  app.use(express.json());
  registerDictionaryRoutes(app);
  const server = createServer(app);
  let listening = false;
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);

    await prisma.project.create({ data: { id: 'del-project', name: 'Delete test' } });
    await prisma.dictionary.create({ data: { id: 'del-dict', projectId: 'del-project', name: '__tag_creation_config__' } });
    const item = (id: string, parentId: string | null, nameRu: string) =>
      prisma.dictionaryItem.create({ data: { id, dictionaryId: 'del-dict', code: id, nameRu, parentId } });
    await item('cat-a', null, 'Категория А');
    await item('opt-a1', 'cat-a', 'Вариант 1');
    await item('opt-a2', 'cat-a', 'Вариант 2');
    await item('sub-a2x', 'opt-a2', 'Вложенный');
    await item('cat-b', null, 'Категория Б');
    await item('opt-b1', 'cat-b', 'Вариант Б');

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    listening = true;
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = (id: string) => `http://127.0.0.1:${address.port}/api/dictionaries/items/${id}`;

    const removed = await fetch(url('cat-a'), { method: 'DELETE' });
    check('удаление категории принято', removed.status === 200, removed.status);
    const left = (await prisma.dictionaryItem.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((row: any) => row.id);
    check('варианты и вложенные пункты удалённой категории не остались сиротами', left.join(',') === 'cat-b,opt-b1', left);

    const again = await fetch(url('cat-a'), { method: 'DELETE' });
    check('повторное удаление уже удалённого пункта не падает', again.status === 200, again.status);

    const one = await fetch(url('opt-b1'), { method: 'DELETE' });
    check('удаление одного варианта не трогает категорию', one.status === 200
      && (await prisma.dictionaryItem.findUnique({ where: { id: 'cat-b' } })) !== null);
    console.log('\n4 проверки удаления пунктов справочника на SQLite пройдено');
  } finally {
    if (listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await prisma.$disconnect();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
