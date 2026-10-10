/** Проверяет настоящий HTTP маршрут переименования поля на отдельной SQLite базе. */
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-dynamic-field-rename-'));
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

    await prisma.project.create({ data: { id: 'rename-project', name: 'Rename test' } });
    await prisma.project.create({ data: { id: 'other-project', name: 'Other test' } });
    const dictionary = await prisma.dictionary.create({ data: { id: 'rename-dict', projectId: 'rename-project', name: '__tag_creation_config__' } });
    const otherDictionary = await prisma.dictionary.create({ data: { id: 'other-dict', projectId: 'other-project', name: '__tag_creation_config__' } });
    const category = await prisma.dictionaryItem.create({ data: { id: 'field-id', dictionaryId: dictionary.id, code: 'FIELD', nameRu: 'Старое поле' } });
    await prisma.dictionaryItem.create({ data: { id: 'other-field-id', dictionaryId: otherDictionary.id, code: 'FIELD', nameRu: 'Старое поле' } });
    await prisma.tag.create({ data: { id: 'legacy-tag', projectId: 'rename-project', identifier: 'T-1', metadata: JSON.stringify({ dynamicFields: { 'Старое поле': 'Да' }, custom: { keep: true } }) } });
    await prisma.tag.create({ data: { id: 'conflict-tag', projectId: 'rename-project', identifier: 'T-2', metadata: JSON.stringify({ dynamicFields: { 'field-id': 'Новое', 'Старое поле': 'Старое' } }) } });
    await prisma.tag.create({ data: { id: 'other-tag', projectId: 'other-project', identifier: 'T-3', metadata: JSON.stringify({ dynamicFields: { 'Старое поле': 'Чужой проект' } }) } });
    await prisma.tag.create({ data: { id: 'malformed-tag', projectId: 'rename-project', identifier: 'T-4', metadata: '{broken' } });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    listening = true;
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/dictionaries/items/${category.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: category.code, nameRu: 'Новое поле', parentId: null }),
    });
    const result = await response.json() as any;
    const legacy = JSON.parse((await prisma.tag.findUnique({ where: { id: 'legacy-tag' } }))!.metadata!);
    const conflict = JSON.parse((await prisma.tag.findUnique({ where: { id: 'conflict-tag' } }))!.metadata!);
    const other = JSON.parse((await prisma.tag.findUnique({ where: { id: 'other-tag' } }))!.metadata!);
    const malformed = (await prisma.tag.findUnique({ where: { id: 'malformed-tag' } }))!.metadata;

    check('HTTP rename succeeds and returns the renamed field', response.status === 200 && result.item?.nameRu === 'Новое поле', result);
    check('legacy value is copied to its stable category ID and retained by name', legacy.dynamicFields['field-id'] === 'Да' && legacy.dynamicFields['Старое поле'] === 'Да' && legacy.custom.keep === true, legacy);
    check('existing ID value wins and legacy conflicting value remains', conflict.dynamicFields['field-id'] === 'Новое' && conflict.dynamicFields['Старое поле'] === 'Старое', conflict);
    check('rename only migrates tags in the dictionary project', other.dynamicFields['Старое поле'] === 'Чужой проект' && other.dynamicFields['field-id'] === undefined, other);
    check('malformed metadata remains untouched', malformed === '{broken', malformed);
    console.log('\n5 проверок SQLite HTTP переименования пройдено');
  } finally {
    if (listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await prisma.$disconnect();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
