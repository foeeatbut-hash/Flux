import assert from 'node:assert/strict';
import { setPrisma } from '../server/context.js';
import { registerProjectFolderBindingRoutes } from '../server/routes/projectFolderBindings.js';

type Handler = (req: any, res: any) => Promise<unknown>;
const handlers = new Map<string, Handler>();
registerProjectFolderBindingRoutes({ get: (path: string, handler: Handler) => handlers.set(`GET ${path}`, handler), post: (path: string, handler: Handler) => handlers.set(`POST ${path}`, handler) } as any);

let settings = new Map<string, { id: string; key: string; userId: string; value: string }>();
let members: Array<{ projectId: string; userId: string }> = [];
let forceCasFailure = false;
setPrisma({
  project: { findUnique: async ({ where }: any) => where.id === 'p1' ? { id: 'p1' } : null },
  projectMember: { count: async () => 0, findMany: async () => members },
  appSetting: {
    findFirst: async ({ where }: any) => [...settings.values()].find(row => row.key === where.key && row.userId === where.userId) || null,
    create: async ({ data }: any) => {
      const key = `${data.userId}:${data.key}`;
      if (settings.has(key)) throw new Error('unique constraint');
      const row = { id: `setting-${settings.size + 1}`, ...data };
      settings.set(key, row);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      if (forceCasFailure) { forceCasFailure = false; return { count: 0 }; }
      const row = [...settings.values()].find(item => item.id === where.id && item.value === where.value);
      if (!row) return { count: 0 };
      const key = `${row.userId}:${row.key}`;
      settings.set(key, { ...row, ...data });
      return { count: 1 };
    },
  },
});

async function call(method: 'GET' | 'POST', user: string | null, query: any = {}, body: any = {}) {
  let status = 200;
  let payload: any;
  const res = { status(code: number) { status = code; return this; }, json(value: any) { payload = value; return this; } };
  const handler = handlers.get(`${method} /api/explorer/project-bindings`)!;
  await handler({ authUser: user ? { id: user, role: 'USER' } : null, query, body }, res);
  return { status, payload };
}

const scope = { deviceId: 'device-1', rootId: 'root-1' };
const checks: Array<[string, () => Promise<void>]> = [
  ['requires an authenticated actor', async () => assert.equal((await call('GET', null, scope)).status, 401)],
  ['persists a planned binding and returns revision one', async () => {
    const result = await call('POST', 'u1', {}, { ...scope, expectedRevision: 0, operation: { kind: 'upsert', binding: { id: 'b1', canonicalFolderId: 'folder-1', relativePath: 'Engineering\\Unit 1', projectId: 'p1' } } });
    assert.equal(result.status, 200); assert.equal(result.payload.revision, 1); assert.equal(result.payload.bindings[0].actorId, 'u1');
  }],
  ['rejects a stale replay without changing storage', async () => {
    const before = settings.values().next().value.value;
    const result = await call('POST', 'u1', {}, { ...scope, expectedRevision: 0, operation: { kind: 'remove', bindingId: 'b1' } });
    assert.equal(result.status, 409); assert.equal(settings.values().next().value.value, before);
  }],
  ['preserves bindings for projects whose membership was revoked', async () => {
    members = [{ projectId: 'p1', userId: 'u2' }];
    const result = await call('GET', 'u1', scope);
    assert.equal(result.status, 200); assert.deepEqual(result.payload.bindings, []);
    const denied = await call('POST', 'u1', {}, { ...scope, expectedRevision: 1, operation: { kind: 'remove', bindingId: 'b1' } });
    assert.equal(denied.status, 403);
    assert.equal(JSON.parse(settings.values().next().value.value).bindings.length, 1);
    members = [];
  }],
  ['supports explicit boundary removal and one-step undo', async () => {
    const removed = await call('POST', 'u1', {}, { ...scope, expectedRevision: 1, operation: { kind: 'remove', bindingId: 'b1' } });
    assert.equal(removed.status, 200); assert.equal(removed.payload.bindings.length, 0);
    const undoId = removed.payload.undo.at(-1).id;
    const undone = await call('POST', 'u1', {}, { ...scope, expectedRevision: 2, operation: { kind: 'undo', undoId } });
    assert.equal(undone.status, 200); assert.equal(undone.payload.bindings.length, 1); assert.equal(undone.payload.revision, 3);
  }],
  ['reanchors a renamed folder only by the same canonical ID and supports CAS undo', async () => {
    const moved = await call('POST', 'u1', {}, { ...scope, expectedRevision: 3, operation: { kind: 'upsert', binding: { id: 'b1', canonicalFolderId: 'folder-1', relativePath: 'Engineering/Renamed', projectId: 'p1' } } });
    assert.equal(moved.status, 200); assert.equal(moved.payload.bindings[0].relativePath, 'Engineering/Renamed');
    const stale = await call('POST', 'u1', {}, { ...scope, expectedRevision: 3, operation: { kind: 'undo', undoId: moved.payload.undo.at(-1).id } });
    assert.equal(stale.status, 409);
    const undone = await call('POST', 'u1', {}, { ...scope, expectedRevision: 4, operation: { kind: 'undo', undoId: moved.payload.undo.at(-1).id } });
    assert.equal(undone.status, 200); assert.equal(undone.payload.bindings[0].relativePath, 'Engineering\\Unit 1');
  }],
  ['rejects a failed compare-and-swap write', async () => {
    forceCasFailure = true;
    const result = await call('POST', 'u1', {}, { ...scope, expectedRevision: 5, operation: { kind: 'remove', bindingId: 'b1' } });
    assert.equal(result.status, 409); assert.equal(JSON.parse(settings.values().next().value.value).bindings.length, 1);
  }],
  ['keeps saving, removing and undoing at the 500 binding limit by trimming old undo entries', async () => {
    const big = { deviceId: 'device-1', rootId: 'root-big' };
    let revision = 0;
    let last: any;
    for (let i = 0; i < 500; i += 1) {
      last = await call('POST', 'u1', {}, { ...big, expectedRevision: revision, operation: { kind: 'upsert', binding: { id: `big-${i}`, canonicalFolderId: `folder-${i}`, relativePath: `Engineering/Section ${String(i).padStart(3, '0')}/${'Long folder name '.repeat(6)}`, projectId: 'p1' } } });
      assert.equal(last.status, 200, `upsert ${i}`);
      revision = last.payload.revision;
    }
    assert.equal(last.payload.bindings.length, 500);
    const over = await call('POST', 'u1', {}, { ...big, expectedRevision: revision, operation: { kind: 'upsert', binding: { id: 'big-over', canonicalFolderId: 'folder-over', relativePath: 'Over', projectId: 'p1' } } });
    assert.equal(over.status, 413);
    const removed = await call('POST', 'u1', {}, { ...big, expectedRevision: revision, operation: { kind: 'remove', bindingId: 'big-0' } });
    assert.equal(removed.status, 200); assert.equal(removed.payload.bindings.length, 499);
    revision = removed.payload.revision;
    const moved = await call('POST', 'u1', {}, { ...big, expectedRevision: revision, operation: { kind: 'upsert', binding: { id: 'big-1', canonicalFolderId: 'folder-1', relativePath: 'Moved/Folder', projectId: 'p1' } } });
    assert.equal(moved.status, 200); revision = moved.payload.revision;
    const storedKey = [...settings.values()].find(row => JSON.parse(row.value).revision === revision)!;
    assert.ok(Buffer.byteLength(storedKey.value, 'utf8') <= 256_000);
    assert.equal(JSON.parse(storedKey.value).bindings.length, 499);
    if (moved.payload.undo.length) {
      const undone = await call('POST', 'u1', {}, { ...big, expectedRevision: revision, operation: { kind: 'undo', undoId: moved.payload.undo.at(-1).id } });
      assert.equal(undone.status, 200); assert.equal(undone.payload.bindings.length, 499);
    }
  }],
  ['scopes the persistent ledger by authenticated actor', async () => {
    const result = await call('GET', 'u2', scope);
    assert.equal(result.status, 200); assert.equal(result.payload.revision, 0); assert.deepEqual(result.payload.bindings, []);
  }],
];

async function main() {
  let failed = 0;
  for (const [name, test] of checks) {
    try { await test(); console.log(`PASS ${name}`); }
    catch (error) { failed += 1; console.error(`FAIL ${name}`, error); }
  }
  console.log(`${checks.length - failed}/${checks.length} project folder binding API checks passed`);
  if (failed) process.exitCode = 1;
}
void main();
