import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma } from '../server/context.js';
import { registerProjectOfficeRoutes } from '../server/routes/projectOffice.js';
import { registerSchemaClient } from '../server/schemaRuntime.js';
import { putCatalogSetting } from '../server/catalogWorkspace.js';

const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

const handlers = new Map<string, Function>();
const app = {
  get: (route: string, handler: Function) => handlers.set(`GET ${route}`, handler),
  post: (route: string, handler: Function) => handlers.set(`POST ${route}`, handler),
  put: (route: string, handler: Function) => handlers.set(`PUT ${route}`, handler),
  delete: (route: string, handler: Function) => handlers.set(`DELETE ${route}`, handler),
} as any;

function route(method: string, pathName: string, actor: any, options: any = {}) {
  const handler = handlers.get(`${method} ${pathName}`);
  assert.ok(handler, `зарегистрирован маршрут ${method} ${pathName}`);
  const result: any = { statusCode: 200, body: undefined };
  const response = { status(code: number) { result.statusCode = code; return this; }, json(body: any) { result.body = body; return this; } };
  return Promise.resolve(handler({ authUser: actor, params: {}, query: {}, body: {}, ...options }, response)).then(() => result);
}

function value(row: any, key: string): any {
  const cell = row?.values?.[key];
  return cell && typeof cell === 'object' && 'value' in cell ? cell.value : cell;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-office-sources-'));
  const dbPath = path.join(dir, 'sources.sqlite');
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}`, timeout: 15000 }) });
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    registerSchemaClient(prisma, 'sqlite');
    setPrisma(prisma);
    registerProjectOfficeRoutes(app);

    await prisma.project.create({ data: { id: 'project-1', name: 'Тестовый проект' } });
    await prisma.project.create({ data: { id: 'project-hidden', name: 'Закрытый проект' } });
    await prisma.projectMember.create({ data: { id: 'membership-1', projectId: 'project-1', userId: 'owner' } });
    await prisma.projectMember.create({ data: { id: 'membership-2', projectId: 'project-hidden', userId: 'other' } });

    const blankCatalog = await route('GET', '/api/project-data/office/catalog', { id: 'owner', role: 'ENGINEER' }, { query: { projectId: 'project-1' } });
    assert.equal(blankCatalog.statusCode, 200, 'пустой проект отдаёт каталог');
    assert.ok(blankCatalog.body.managementFields && blankCatalog.body.e3fluxFields, 'каталог содержит оба источника');
    const blankRows = await route('POST', '/api/project-data/office/query', { id: 'owner', role: 'ENGINEER' }, { body: { projectId: 'project-1', query: { entity: 'procurement', columns: ['identifier', 'supplier', 'qty', 'stage', 'note', 'stageLog'], filters: [], sort: [], limit: 10 } } });
    assert.equal(blankRows.statusCode, 200, 'пустая закупка возвращается успешно');
    assert.deepEqual(blankRows.body.rows, []);
    assert.equal(typeof blankRows.body.revision, 'string', 'пустая выборка имеет ревизию источника');

    await prisma.tag.create({ data: { id: 'tag-a', projectId: 'project-1', identifier: 'P-10', metadata: JSON.stringify({ procurement: { supplier: 'Поставщик А', qty: '4', stage: 'ordered', note: 'Срочно', stageLog: { ordered: { at: '2026-01-01', by: 'Иван' } } } }) } });
    await prisma.tag.create({ data: { id: 'tag-b', projectId: 'project-1', identifier: 'P-20', metadata: JSON.stringify({ procurement: { supplier: 'Поставщик Б', qty: '2', stage: 'draft' } }) } });
    await prisma.docRegister.create({ data: { id: 'vdr-1', projectId: 'project-1', name: 'ВДР тест', vendor: 'Поставщик А', items: { create: [{ id: 'vdr-item-1', projectId: 'project-1', vendorNo: 'V-10', titleRu: 'Насос', vdrCode: 'C01', revision: 'A', status: 'READY' }] } } });
    await prisma.e3Project.create({ data: { id: 'e3-project-1', fluxProjectId: 'project-1', key: 'key-1', name: 'Электропроект' } });
    await prisma.e3Binding.create({ data: { id: 'binding-1', e3ProjectId: 'e3-project-1', elementId: 'element-1', designation: 'M-10', sheet: 'Лист 1' } });
    const solutionBook = { version: 1, solutions: [{ id: 'solution-1', name: 'Решение насоса', short: 'Насос', mainClass: 'M', subclass: 'P' }], ioTable: [{ id: 'io-1', group: 'DI', name: 'Авария', code: 'DI-1', di: 1, do: 0, ai: 0, ao: 0, notes: { di: 'Сигнал', do: '', ai: '', ao: '' } }] };
    const attributeBook = { items: [{ name: 'FLUX_TAG', title: 'Тег Flux', carrier: 'component', class: 'M', source: 'flux' }] };
    await putCatalogSetting(prisma, 'e3_solutions', solutionBook);
    await putCatalogSetting(prisma, 'e3_attributes', attributeBook);

    const procurement = await route('POST', '/api/project-data/office/query', { id: 'owner', role: 'ENGINEER' }, { body: { projectId: 'project-1', query: { entity: 'procurement', columns: ['identifier', 'supplier', 'qty', 'stage', 'note', 'stageLog'], filters: [{ field: 'supplier', op: 'contains', value: 'Поставщик А' }], sort: [{ field: 'identifier', dir: 'asc' }], limit: 20, excludedEntityIds: [] } } });
    assert.equal(procurement.statusCode, 200, 'закупки читаются через офисный маршрут');
    assert.equal(procurement.body.rows.length, 1, 'фильтр по поставщику отбирает позицию');
    const pRow = procurement.body.rows[0];
    assert.equal(value(pRow, 'supplier'), 'Поставщик А');
    assert.equal(value(pRow, 'qty'), '4');
    assert.equal(value(pRow, 'stage'), 'ordered');
    assert.ok(pRow.entityId && pRow.sourceId && pRow.entityType, 'строка закупки имеет стабильную идентичность источника');
    const sortedProcurement = await route('POST', '/api/project-data/office/query', { id: 'owner', role: 'ENGINEER' }, { body: { projectId: 'project-1', query: { entity: 'procurement', columns: ['identifier'], filters: [], sort: [{ field: 'identifier', dir: 'desc' }], limit: 10 } } });
    assert.deepEqual(sortedProcurement.body.rows.map((row: any) => value(row, 'identifier')), ['P-20', 'P-10'], 'сортировка применяется к стабильному идентификатору тега');

    const vdr = await route('POST', '/api/project-data/office/query', { id: 'owner', role: 'ENGINEER' }, { body: { projectId: 'project-1', query: { entity: 'vdr', columns: ['vdr.titleRu', 'vdr.vendorNo', 'vdr.status'], filters: [{ field: 'vdr.titleRu', op: 'contains', value: 'Насос' }], sort: [], limit: 20 } } });
    assert.equal(vdr.statusCode, 200, 'ВДР читается через офисный маршрут');
    assert.equal(vdr.body.rows.length, 1);
    assert.equal(value(vdr.body.rows[0], 'vdr.titleRu'), 'Насос');
    assert.equal(value(vdr.body.rows[0], 'vdr.vendorNo'), 'V-10');

    const e3 = await route('POST', '/api/project-data/office/query', { id: 'owner', role: 'ENGINEER' }, { body: { projectId: 'project-1', query: { entity: 'e3', columns: ['e3.kind', 'e3.designation', 'e3.sheet', 'e3.projectName', 'e3.solutionName', 'e3.title'], filters: [], sort: [], limit: 20 } } });
    assert.equal(e3.statusCode, 200, 'связанные данные E3 читаются через офисный маршрут');
    assert.ok(e3.body.rows.some((row: any) => value(row, 'e3.kind') === 'binding' && value(row, 'e3.designation') === 'M-10'));
    assert.ok(e3.body.rows.some((row: any) => value(row, 'e3.kind') === 'solution'));
    assert.ok(e3.body.rows.some((row: any) => value(row, 'e3.kind') === 'attribute' && value(row, 'e3.title') === 'Тег Flux'));
    assert.ok(e3.body.rows.some((row: any) => value(row, 'e3.kind') === 'io'));

    const excluded = await route('POST', '/api/project-data/office/query', { id: 'owner', role: 'ENGINEER' }, { body: { projectId: 'project-1', query: { entity: 'procurement', columns: ['identifier'], filters: [], sort: [], limit: 20, excludedEntityIds: [pRow.entityId] } } });
    assert.equal(excluded.statusCode, 200);
    assert.equal(excluded.body.rows.some((row: any) => row.entityId === pRow.entityId), false, 'исключённая сущность не попадает в результат');

    const deniedCatalog = await route('GET', '/api/project-data/office/catalog', { id: 'intruder', role: 'ENGINEER' }, { query: { projectId: 'project-1' } });
    const deniedQuery = await route('POST', '/api/project-data/office/query', { id: 'intruder', role: 'ENGINEER' }, { body: { projectId: 'project-1', query: { entity: 'procurement', columns: ['identifier'], filters: [], sort: [], limit: 10 } } });
    assert.equal(deniedCatalog.statusCode, 404, 'каталог закрытого проекта скрыт от постороннего');
    assert.equal(deniedQuery.statusCode, 404, 'выборка закрытого проекта скрыта от постороннего');

    await putCatalogSetting(prisma, 'e3_solutions', { solutions: [{ id: 'duplicate', name: 'A' }, { id: 'duplicate', name: 'B' }], ioTable: [] });
    const ambiguous = await route('POST', '/api/project-data/office/query', { id: 'owner', role: 'ENGINEER' }, { body: { projectId: 'project-1', query: { entity: 'e3', columns: ['e3.kind'], filters: [], sort: [], limit: 20 } } });
    assert.equal(ambiguous.statusCode, 409, 'неоднозначные ID решений дают явный конфликт');
    await putCatalogSetting(prisma, 'e3_solutions', solutionBook);

    const bulk = Array.from({ length: 1005 }, (_, index) => ({ id: `bulk-${index}`, projectId: 'project-1', identifier: `B-${String(index).padStart(4, '0')}`, metadata: JSON.stringify({ procurement: { supplier: 'Массовый', qty: '1', stage: 'ordered' } }) }));
    await prisma.tag.createMany({ data: bulk });
    const started = Date.now();
    const many = await route('POST', '/api/project-data/office/query', { id: 'owner', role: 'ENGINEER' }, { body: { projectId: 'project-1', query: { entity: 'procurement', columns: ['identifier', 'supplier'], filters: [], sort: [{ field: 'identifier', dir: 'asc' }], limit: 2000 } } });
    assert.equal(many.statusCode, 200, 'выборка более тысячи записей завершается');
    assert.ok(many.body.rows.length >= 1007, 'выборка не обрезана на тысяче записей');
    assert.ok(Date.now() - started < 10000, 'выборка более тысячи записей не зависает');

    console.log('✓ office sources: каталоги, закупки, ВДР, E3, права, фильтры, исключения и 1000+ строк');
  } finally {
    setPrisma(null);
    await prisma.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
