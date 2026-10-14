import assert from 'node:assert/strict';
import { setPrisma } from '../server/context.js';
import { registerProjectOfficeRoutes } from '../server/routes/projectOffice.js';
import { registerSchemaClient } from '../server/schemaRuntime.js';

const file = { id: 'doc-1', name: 'test.docx', type: 'DOCX', scope: 'SHARED', ownerId: null, folderId: null, projectId: 'project-1', deletedAt: null, content: '', size: 0 };
const tags = [{ id: '42', projectId: 'project-1', identifier: 'P-42', brand: 'Flux', metadata: null, componentElements: [] }];
const settingRows = new Map<string, any>();
const keyOf = (key: string, userId: string | null) => `${key}\u0000${userId ?? 'global'}`;
let settingSeq = 0;
const prisma: any = {
  fileNode: { findUnique: async ({ where }: any) => where.id === file.id ? { ...file } : null },
  fileChunk: { findMany: async () => [] },
  fileVersion: {},
  folder: { findUnique: async () => null },
  user: { findFirst: async () => null },
  projectMember: { count: async () => 0, findMany: async () => [] },
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
  appSetting: {
    findFirst: async ({ where }: any) => settingRows.get(keyOf(where.key, where.userId)) || null,
    create: async ({ data }: any) => {
      const key = keyOf(data.key, data.userId);
      if (settingRows.has(key)) throw new Error('duplicate setting');
      const row = { ...data, id: data.id || `setting-${++settingSeq}` };
      settingRows.set(key, row); return row;
    },
    updateMany: async ({ where, data }: any) => {
      const row = [...settingRows.values()].find((item) => item.id === where.id && item.value === where.value);
      if (!row) return { count: 0 };
      row.value = data.value; return { count: 1 };
    },
    update: async ({ where, data }: any) => {
      const row = [...settingRows.values()].find((item) => item.id === where.id);
      if (!row) throw new Error('missing');
      Object.assign(row, data); return row;
    },
  },
  $queryRawUnsafe: async (sql: string) => /^PRAGMA table_info/i.test(sql) ? [{ name: 'id' }] : [],
  $executeRawUnsafe: async () => 1,
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

async function call(method: string, path: string, opts: any = {}) {
  const handler = handlers.get(`${method} ${path}`);
  assert.ok(handler, `handler exists: ${method} ${path}`);
  const output: any = { statusCode: 200, body: undefined };
  const res = { status(code: number) { output.statusCode = code; return this; }, json(body: any) { output.body = body; return this; } };
  await handler({ body: {}, params: {}, query: {}, authUser: { id: 'owner', role: 'ENGINEER' }, ...opts }, res);
  return output;
}

void (async () => {
  const unsupported = await call('POST', '/api/project-data/office/query', { body: { projectId: 'project-1', query: { entity: 'unknown', columns: ['name'], filters: [], sort: [], limit: 10 } } });
  if (unsupported.statusCode !== 400) console.error('unsupported response', unsupported.statusCode, unsupported.body);
  assert.equal(unsupported.statusCode, 400);
  assert.match(unsupported.body.error, /не поддерживается/);

  const schema = { version: 1, anchors: [{ kind: 'excel-range', id: 'head-1', sheetName: 'Sheet1', address: 'A1', parts: [{ kind: 'text', text: 'Header' }] }] };
  const query = { entity: 'tag', columns: ['identifier'], filters: [], sort: [], limit: 10, excludedEntityIds: [] };
  const personal = await call('POST', '/api/project-data/office/templates', { body: { name: 'Private', scope: 'PERSONAL', schema, query } });
  assert.equal(personal.statusCode, 200);
  const outsider = await call('GET', '/api/project-data/office/templates', { authUser: { id: 'other', role: 'ENGINEER' } });
  assert.equal(outsider.body.templates.some((template: any) => template.id === personal.body.template.id), false);
  const pinned = await call('POST', '/api/project-data/office/templates/:id/pin', { params: { id: personal.body.template.id }, body: { pinned: true } });
  assert.deepEqual(pinned.body.pinned, [personal.body.template.id]);
  const otherPin = await call('POST', '/api/project-data/office/templates/:id/pin', { params: { id: personal.body.template.id }, authUser: { id: 'other', role: 'ENGINEER' }, body: { pinned: true } });
  assert.equal(otherPin.statusCode, 404);
  // Решение владельца: общий шаблон создаёт любой сотрудник
  const shared = await call('POST', '/api/project-data/office/templates', { body: { name: 'Shared', scope: 'SHARED', schema, query } });
  assert.equal(shared.statusCode, 200);
  assert.equal(shared.body.template.scope, 'SHARED');
  // Править и удалять его не может никто, кроме создателя, в том числе администратор
  for (const actor of [{ id: 'other', role: 'ENGINEER' }, { id: 'admin', role: 'ADMIN' }]) {
    const edit = await call('PUT', '/api/project-data/office/templates/:id', { params: { id: shared.body.template.id }, authUser: actor, body: { name: 'Чужая правка', schema, query } });
    assert.equal(edit.statusCode, 404, `${actor.id} не правит чужой общий шаблон`);
    const remove = await call('DELETE', '/api/project-data/office/templates/:id', { params: { id: shared.body.template.id }, authUser: actor });
    assert.equal(remove.statusCode, 404, `${actor.id} не удаляет чужой общий шаблон`);
  }
  const stillThere = await call('GET', '/api/project-data/office/templates', { authUser: { id: 'other', role: 'ENGINEER' } });
  assert.equal(stillThere.body.templates.find((template: any) => template.id === shared.body.template.id)?.name, 'Shared');
  const ownEdit = await call('PUT', '/api/project-data/office/templates/:id', { params: { id: shared.body.template.id }, body: { name: 'Shared 2', schema, query } });
  assert.equal(ownEdit.statusCode, 200);
  // Другой сотрудник может сохранить свою копию (личную или общую), оригинал не меняется
  const copy = await call('POST', '/api/project-data/office/templates', { authUser: { id: 'other', role: 'ENGINEER' }, body: { name: 'Копия', scope: 'SHARED', schema, query } });
  assert.equal(copy.statusCode, 200);
  assert.notEqual(copy.body.template.id, shared.body.template.id);
  const visibleShared = await call('GET', '/api/project-data/office/templates', { authUser: { id: 'other', role: 'ENGINEER' } });
  assert.equal(visibleShared.body.templates.some((template: any) => template.id === shared.body.template.id), true);
  const unauthorizedUpdate = await call('PUT', '/api/project-data/office/templates/:id', { params: { id: personal.body.template.id }, authUser: { id: 'other', role: 'ENGINEER' }, body: { name: 'Stolen', schema, query: {} } });
  assert.equal(unauthorizedUpdate.statusCode, 404);
  console.log('Office API: запрет неподдерживаемого источника и права шаблонов проверены');
})().catch((error) => { console.error(error); process.exitCode = 1; });
