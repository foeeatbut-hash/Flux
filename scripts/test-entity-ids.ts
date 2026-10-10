import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { VEZA_SAMPLE_XML } from './fixtures/veza.js';
import { parseVezaXml } from '../server/vezaXml.js';
import { detectEquipType } from '../server/equipmentParser.js';
import { importEquipmentToDB } from '../server/equipmentImport.js';
import { nextFieldId, nextProjectEntityId, nextProjectId } from '../server/entityIds.js';

const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-entity-ids-'));
  const file = path.join(dir, 'ids.sqlite');
  const url = `file:${file}`;
  const a = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url, timeout: 15000 }) });
  const b = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url, timeout: 15000 }) });
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(file, a, schema, () => {});
    await a.project.create({ data: { id: 'PRJ-000001', name: 'Существующий проект' } });
    const projectId = await nextProjectId(a);
    assert.equal(projectId, 'PRJ-000002', 'существующий ID проекта пропускается');
    await a.project.create({ data: { id: projectId, name: 'Проект' }, select: { id: true } });

    const projectIds = await Promise.all(Array.from({ length: 24 }, () => nextProjectId(a)));
    assert.equal(new Set(projectIds).size, projectIds.length, 'параллельные запросы не получают одинаковый номер');
    assert.ok(projectIds.every(id => /^PRJ-\d{6,}$/.test(id)), 'номер проекта сохраняет ведущие нули');

    const [eq, tag, sys, mb, dict, fld, item] = await Promise.all([
      nextProjectEntityId(a, projectId, 'EQ'), nextProjectEntityId(a, projectId, 'TAG'),
      nextProjectEntityId(a, projectId, 'SYS'), nextProjectEntityId(a, projectId, 'MB'),
      nextProjectEntityId(a, projectId, 'DICT'), nextFieldId(a, projectId, true), nextFieldId(a, projectId, false),
    ]);
    assert.equal(eq, `${projectId}-EQ-000001`);
    assert.equal(tag, `${projectId}-TAG-000001`);
    assert.equal(sys, `${projectId}-SYS-000001`);
    assert.equal(mb, `${projectId}-MB-000001`);
    assert.equal(dict, `${projectId}-DICT-000001`);
    assert.equal(fld, `${projectId}-FLD-000001`);
    assert.equal(item, `${projectId}-DI-000001`);

    const otherProjectId = await nextProjectId(b);
    await b.project.create({ data: { id: otherProjectId, name: 'Другой проект' }, select: { id: true } });
    const [firstProjectEq, secondProjectEq] = await Promise.all([
      nextProjectEntityId(a, projectId, 'EQ'), nextProjectEntityId(a, otherProjectId, 'EQ'),
    ]);
    assert.equal(firstProjectEq, `${projectId}-EQ-000002`);
    assert.equal(secondProjectEq, `${otherProjectId}-EQ-000001`, 'одинаковый порядковый номер не пересекает границу проекта');

    const nested = await a.$transaction(async (tx: any) => {
      const txOptions = { inTransaction: true };
      const dictionaryId = await nextProjectEntityId(tx, projectId, 'DICT', txOptions);
      const rootId = await nextFieldId(tx, projectId, true, txOptions);
      const childId = await nextFieldId(tx, projectId, false, txOptions);
      return tx.dictionary.create({
        data: {
          id: dictionaryId,
          projectId,
          name: '__tag_creation_config__',
          items: { create: [{ id: rootId, code: '001', nameRu: 'Корень' }, { id: childId, code: 'x', nameRu: 'Значение', parentId: rootId }] },
        },
        select: { id: true, items: { select: { id: true, parentId: true } } },
      });
    });
    assert.equal(nested.id, `${projectId}-DICT-000002`, 'счётчик с транзакционным клиентом выдаёт следующий справочник');
    assert.deepEqual(nested.items.map((row: any) => row.id), [`${projectId}-FLD-000002`, `${projectId}-DI-000002`]);
    assert.equal(nested.items[1].parentId, nested.items[0].id, 'вложенная запись сохраняет ссылку на родительский ID');

    const importProjectId = await nextProjectId(a);
    await a.project.create({ data: { id: importProjectId, name: 'Проект импорта' } });
    const parsed = parseVezaXml(VEZA_SAMPLE_XML, detectEquipType);
    const importResult = await importEquipmentToDB(a, importProjectId, 'AHU', 'synthetic.xml', { units: [parsed.units[0]] } as any, 'wait');
    const importedSystem = await a.equipmentSystem.findFirst({ where: { projectId: importProjectId } });
    const importedMono = await a.monoblock.findFirst({ where: { systemId: importedSystem.id } });
    const importedComponent = await a.componentElement.findFirst({ where: { monoblockId: importedMono.id } });
    assert.match(importedSystem.id, new RegExp(`^${importProjectId}-SYS-\\d{6}$`));
    assert.match(importedMono.id, new RegExp(`^${importProjectId}-MB-\\d{6}$`));
    assert.match(importedComponent.id, new RegExp(`^${importProjectId}-EQ-\\d{6}$`));
    assert.ok(importResult.newBlocks > 0, 'вложенный импорт оборудования использует project scoped IDs');

    console.log('✓ entity IDs: collision skip, concurrent SQLite allocations, project prefixes, nested transaction and equipment import writes');
  } finally {
    await Promise.all([a.$disconnect(), b.$disconnect()]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
