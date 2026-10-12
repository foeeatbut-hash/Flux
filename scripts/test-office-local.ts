/**
 * Flux Office для файлов Проводника: state / запись схемы / preview / confirm
 * над присланным содержимым (server/routes/projectOfficeLocal.ts).
 * Проверяет то же, что маршруты файла проекта, плюс три свойства локального
 * варианта: права по выбранному проекту, новые байты вместо записи, ничего не
 * хранится на сервере.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { setPrisma } from '../server/context.js';
import { registerProjectOfficeRoutes } from '../server/routes/projectOffice.js';
import { registerProjectOfficeLocalRoutes } from '../server/routes/projectOfficeLocal.js';
import { readOfficeBindings } from '../server/officeBindings.js';
import { registerSchemaClient } from '../server/schemaRuntime.js';
import { carryFluxPart } from '../office/fluxPart.js';
import { makeDocx } from './officeHarness';

const tags = [
  { id: '42', projectId: 'project-1', identifier: 'P-42', brand: 'Flux', metadata: null, componentElements: [] },
  { id: '43', projectId: 'project-1', identifier: 'P-43', brand: 'Flux', metadata: null, componentElements: [] },
];
// Любое обращение к файлам сервера означает, что локальный вариант вернулся к FileNode
const forbidden = async () => { throw new Error('локальный вариант не должен трогать файлы сервера'); };
const indexes = new Map<string, { table: string; unique: boolean; cols: string[] }>();
const prisma: any = {
  fileNode: { findUnique: forbidden, create: forbidden, update: forbidden },
  fileChunk: { findMany: forbidden, create: forbidden, createMany: forbidden },
  fileVersion: { create: forbidden },
  folder: { findUnique: async () => null },
  user: { findFirst: async () => null },
  projectMember: { count: async () => 0, findMany: async ({ where }: any) => where?.projectId === 'closed-project' ? [{ userId: 'member' }] : [] },
  project: { findUnique: async () => ({ system: false }) },
  tag: {
    findMany: async () => tags,
    count: async () => tags.length,
    aggregate: async () => ({ _max: { createdAt: null, updatedAt: null } }),
  },
  equipmentSystem: { findMany: async () => [] },
  catalogClass: { findMany: async () => [{ id: 'seeded' }] },
  catalogManufacturer: { findMany: async () => [] },
  catalogFamily: { findMany: async () => [] },
  catalogComponent: { findMany: async () => [] },
  catalogTagRule: { findMany: async () => [] },
  blankTemplate: { count: async () => 1 },
  componentElement: { count: async () => 0, aggregate: async () => ({ _max: { updatedAt: null } }) },
  appSetting: { findFirst: async () => null },
  // Каталог проверяет индексы через PRAGMA: хватает запомнить созданные
  $queryRawUnsafe: async (sql: string) => {
    if (/^PRAGMA table_info/i.test(sql)) return [{ name: 'id' }];
    const table = /^PRAGMA index_list\("(.+)"\)/i.exec(sql)?.[1];
    if (table) return [...indexes].filter(([, index]) => index.table === table).map(([name, index]) => ({ name, unique: index.unique ? 1 : 0, partial: 0 }));
    const named = /^PRAGMA index_info\("(.+)"\)/i.exec(sql)?.[1];
    return named ? (indexes.get(named)?.cols || []).map((name) => ({ name })) : [];
  },
  $executeRawUnsafe: async (sql: string) => {
    const made = /^CREATE (UNIQUE )?INDEX IF NOT EXISTS "(.+?)" ON "(.+?)" \((.+?)\)/i.exec(sql);
    if (made) indexes.set(made[2], { table: made[3], unique: !!made[1], cols: made[4].split(',').map((col) => col.trim().replace(/"/g, '')) });
    return 1;
  },
  $transaction: async (callback: Function) => callback(prisma),
};
registerSchemaClient(prisma, 'sqlite');
setPrisma(prisma);

const handlers = new Map<string, Function>();
const app = {
  get: (path: string, handler: Function) => handlers.set(`GET ${path}`, handler),
  post: (path: string, handler: Function) => handlers.set(`POST ${path}`, handler),
  put: (path: string, handler: Function) => handlers.set(`PUT ${path}`, handler),
  delete: (path: string, handler: Function) => handlers.set(`DELETE ${path}`, handler),
} as any;
registerProjectOfficeRoutes(app);
registerProjectOfficeLocalRoutes(app);

async function call(path: string, body: any, authUser: any = { id: 'owner', role: 'ENGINEER' }) {
  const handler = handlers.get(`POST /api/project-data/office-local/${path}`);
  assert.ok(handler, `маршрут есть: ${path}`);
  const output: any = { statusCode: 200, body: undefined };
  const res = { status(code: number) { output.statusCode = code; return this; }, json(value: any) { output.body = value; return this; } };
  await handler({ body, params: {}, query: {}, authUser }, res);
  return output;
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const schemaOf = (anchorId = 'head-1') => ({ version: 1, anchors: [{ kind: 'word-row', id: anchorId, parts: [{ kind: 'field', binding: { fieldKey: 'identifier', sourceId: 'tags', entityType: 'tag', entityId: null, sourceRevision: '', anchorId } }] }] });

void (async () => {
  const docx = await makeDocx();
  const base64 = docx.toString('base64');

  // Состояние чистого пакета: схемы нет, хеш — от присланных байт
  const empty = await call('state', { projectId: 'project-1', base64 });
  assert.equal(empty.statusCode, 200, JSON.stringify(empty.body));
  assert.equal(empty.body.baseHash, sha(docx));
  assert.deepEqual(empty.body.schema.anchors, []);
  assert.equal(typeof empty.body.sourceRevision, 'string');
  console.log('  ✓ state: чистый пакет, хеш от присланных байт');

  // Запись схемы возвращает байты; присланный файл не меняется
  const refused = await call('write-state', { projectId: 'project-1', base64, baseHash: 'stale', schema: schemaOf() });
  assert.equal(refused.statusCode, 409);
  const written = await call('write-state', { projectId: 'project-1', base64, baseHash: empty.body.baseHash, sourceRevision: empty.body.sourceRevision, schema: schemaOf() });
  assert.equal(written.statusCode, 200, JSON.stringify(written.body));
  const updated = Buffer.from(written.body.base64, 'base64');
  assert.equal(written.body.baseHash, sha(updated));
  assert.notEqual(written.body.baseHash, empty.body.baseHash);
  assert.equal(written.body.anchorCount, 1);
  const bindings = await readOfficeBindings(updated);
  assert.equal(bindings?.anchors[0].id, 'head-1');
  assert.ok((await JSZip.loadAsync(updated)).file('word/document.xml'), 'остальные части пакета на месте');
  console.log('  ✓ write-state: новые байты со схемой, неверный baseHash — 409');

  // Редактор не знает о записанной схеме: хост переносит часть Flux в его байты
  const carried = await carryFluxPart(new Uint8Array(updated), new Uint8Array(docx));
  assert.equal((await readOfficeBindings(Buffer.from(carried)))?.anchors[0].id, 'head-1');
  const plain = new Uint8Array(docx);
  assert.equal(await carryFluxPart(plain, plain), plain, 'без части Flux тело не пережимается');
  console.log('  ✓ carryFluxPart: схема переносится в байты редактора');

  // Круг: состояние новых байт возвращает ту же схему в модели редактора
  const again = await call('state', { projectId: 'project-1', base64: written.body.base64 });
  assert.equal(again.body.baseHash, written.body.baseHash);
  assert.equal(again.body.schema.anchors[0].id, 'head-1');
  assert.equal(again.body.schema.anchors[0].kind, 'word-row');
  console.log('  ✓ state: схема читается из записанных байт');

  // План по содержимому: добавления по выбранным тегам, подтверждение с той же версией
  const query = { entity: 'tag', columns: ['identifier'], filters: [], sort: [], limit: 100, excludedEntityIds: [] };
  const rows = await call('state', { projectId: 'project-1', base64: written.body.base64 });
  const listing = (await (async () => {
    const handler = handlers.get('POST /api/project-data/office/query')!;
    const out: any = {}; await handler({ body: { projectId: 'project-1', query }, authUser: { id: 'owner', role: 'ENGINEER' } }, { status() { return this; }, json(v: any) { out.body = v; } });
    return out.body;
  })());
  assert.ok(listing?.rows, JSON.stringify(listing));
  assert.equal(listing.rows.length, 2, JSON.stringify(listing));
  const request = { projectId: 'project-1', base64: written.body.base64, baseHash: rows.body.baseHash, sourceRevision: listing.revision, selectedEntityIds: listing.rows.map((row: any) => row.entityId), query, schema: again.body.schema };
  const preview = await call('preview', request);
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.baseHash, rows.body.baseHash);
  assert.equal(preview.body.writes.length, 2);
  assert.equal(preview.body.errors.length, 0);
  const confirmed = await call('confirm', { ...request, planId: preview.body.planId });
  assert.equal(confirmed.statusCode, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.status, 'ready-for-editor');
  assert.deepEqual(confirmed.body.writes, preview.body.writes);
  console.log('  ✓ preview и confirm: план по присланным байтам, запись не выполняется');

  // План привязан к версии: другие байты или чужой planId — 409
  const edited = await call('preview', { ...request, base64: base64 });
  assert.equal(edited.statusCode, 409);
  const wrongPlan = await call('confirm', { ...request, planId: 'другой' });
  assert.equal(wrongPlan.statusCode, 409);
  const staleSource = await call('preview', { ...request, sourceRevision: 'старая' });
  assert.equal(staleSource.statusCode, 409);
  const noRows = await call('preview', { ...request, selectedEntityIds: [] });
  assert.equal(noRows.statusCode, 400);
  console.log('  ✓ план привязан к байтам, ревизии источника и набору строк');

  // Права — по выбранному проекту, как у файла проекта
  for (const [name, body] of [['state', { base64 }], ['write-state', { base64, baseHash: sha(docx), schema: schemaOf() }], ['preview', request], ['confirm', { ...request, planId: preview.body.planId }]] as const) {
    const denied = await call(name, { ...body, projectId: 'closed-project' }, { id: 'outsider', role: 'ENGINEER' });
    assert.equal(denied.statusCode, 404, `${name}: посторонний не видит проект`);
    assert.equal(denied.body.error, 'Проект не найден');
  }
  const member = await call('state', { projectId: 'closed-project', base64 }, { id: 'member', role: 'ENGINEER' });
  assert.equal(member.statusCode, 200);
  const admin = await call('state', { projectId: 'closed-project', base64 }, { id: 'boss', role: 'ADMIN' });
  assert.equal(admin.statusCode, 200);
  const noProject = await call('state', { base64 });
  assert.equal(noProject.statusCode, 400);
  const defaultProject = await call('state', { projectId: 'default', base64 });
  assert.equal(defaultProject.statusCode, 400, 'проект «по умолчанию» не подставляется');
  console.log('  ✓ права по проекту: участник и админ читают, посторонний получает 404');

  // Содержимое: пусто, не пакет, слишком большое
  assert.equal((await call('state', { projectId: 'project-1' })).statusCode, 400);
  assert.equal((await call('state', { projectId: 'project-1', base64: Buffer.from('просто текст').toString('base64') })).statusCode, 400);
  assert.equal((await call('state', { projectId: 'project-1', base64: 'A'.repeat(50 * 1024 * 1024) })).statusCode, 413);
  console.log('  ✓ не пакет, пусто и слишком большой файл отклоняются');
  console.log('Office local: маршруты содержимого файла Проводника проверены');
})().catch((error) => { console.error(error); process.exitCode = 1; });
