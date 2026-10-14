import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setPrisma } from '../server/context.js';
import { actorMay } from '../server/projectAccess.js';
import { registerProjectFolderBindingRoutes } from '../server/routes/projectFolderBindings.js';

type Handler = (req: any, res: any) => Promise<unknown>;
const handlers = new Map<string, Handler>();
// Право проверяется настоящей actorMay (роль + личные права), как server.ts проверяет project.manage.
registerProjectFolderBindingRoutes({ get: (path: string, handler: Handler) => handlers.set(`GET ${path}`, handler), post: (path: string, handler: Handler) => handlers.set(`POST ${path}`, handler) } as any, { mayManage: req => actorMay((req as any).authUser, async () => null) });

const MANAGE = JSON.stringify({ 'project.manage': { enabled: true } });
const users: Record<string, any> = {
  admin: { id: 'admin', role: 'ADMIN' },
  manager: { id: 'manager', role: 'USER', permissions: MANAGE },
  plain: { id: 'plain', role: 'USER' },
  // Право выключено явно: наличие записи в permissions ещё ничего не значит.
  off: { id: 'off', role: 'USER', permissions: JSON.stringify({ 'project.manage': { enabled: false } }) },
};
const keyOf = (path: string) => createHash('sha256').update(path).digest('hex');

let settings = new Map<string, { id: string; key: string; userId: string; value: string }>();
let members: Array<{ projectId: string; userId: string }> = [];
let forceCasFailure = false;
setPrisma({
  project: { findUnique: async ({ where }: any) => ['p1', 'p2'].includes(where.id) ? { id: where.id } : null },
  projectMember: { count: async () => 0, findMany: async ({ where }: any = {}) => members.filter(row => !where?.projectId || row.projectId === where.projectId) },
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
  await handler({ authUser: user ? users[user] : null, query, body }, res);
  return { status, payload };
}
const upsert = (user: string, expectedRevision: number, binding: any) => call('POST', user, {}, { expectedRevision, operation: { kind: 'upsert', binding } });
const remove = (user: string, expectedRevision: number, bindingId: string) => call('POST', user, {}, { expectedRevision, operation: { kind: 'remove', bindingId } });
const undo = (user: string, expectedRevision: number, undoId: string) => call('POST', user, {}, { expectedRevision, operation: { kind: 'undo', undoId } });
const stored = () => JSON.parse([...settings.values()].find(row => row.key === 'explorer_project_bindings:shared:v1')!.value);
const k1 = keyOf('//srv/share/engineering/unit 1');
const k2 = keyOf('//srv/share/shared');

const checks: Array<[string, () => Promise<void>]> = [
  ['requires an authenticated actor', async () => { assert.equal((await call('GET', null)).status, 401); assert.equal((await upsert('admin', 0, {})).status === 401, false); assert.equal((await call('POST', null, {}, {})).status, 401); }],
  ['a user without project.manage gets 403 on POST and nothing is written', async () => {
    for (const user of ['plain', 'off']) {
      const result = await upsert(user, 0, { locationKey: k1, projectId: 'p1', label: 'Unit 1' });
      assert.equal(result.status, 403, user);
    }
    assert.equal(settings.size, 0);
  }],
  ['a manager with project.manage can bind; the record carries key, label, actor and time', async () => {
    const result = await upsert('manager', 0, { id: 'b1', locationKey: k1, projectId: 'p1', label: ' Unit 1 ', path: 'C:\\secret', rootId: 'r1', deviceId: 'd1' });
    assert.equal(result.status, 200); assert.equal(result.payload.revision, 1); assert.equal(result.payload.canManage, true);
    const row = result.payload.bindings[0];
    assert.deepEqual(Object.keys(row).sort(), ['actorId', 'at', 'id', 'label', 'locationKey', 'projectId']);
    assert.equal(row.actorId, 'manager'); assert.equal(row.label, 'Unit 1'); assert.ok(!Number.isNaN(Date.parse(row.at)));
    assert.ok(!JSON.stringify(stored()).includes('secret'), 'путь в журнал не попадает');
  }],
  ['a non-manager sees the shared binding on GET, read-only, with no undo history', async () => {
    const result = await call('GET', 'plain');
    assert.equal(result.status, 200); assert.equal(result.payload.canManage, false);
    assert.equal(result.payload.bindings.length, 1); assert.equal(result.payload.bindings[0].locationKey, k1);
    assert.deepEqual(result.payload.undo, []);
  }],
  ['the ledger is shared: every user and any device or root parameter read the same record', async () => {
    const a = await call('GET', 'admin', { deviceId: 'device-1', rootId: 'root-1' });
    const b = await call('GET', 'manager', { deviceId: 'device-2', rootId: 'root-9' });
    const c = await call('GET', 'off');
    assert.deepEqual(a.payload.bindings, b.payload.bindings); assert.deepEqual(b.payload.bindings, c.payload.bindings);
    assert.equal(a.payload.canManage, true); assert.equal(c.payload.canManage, false);
  }],
  ['old per-user and per-device ledgers are ignored', async () => {
    settings.set('plain:explorer_project_bindings:legacy', { id: 'legacy', key: 'explorer_project_bindings:' + keyOf('device\0root'), userId: 'plain', value: JSON.stringify({ revision: 7, bindings: [{ id: 'old', rootId: 'r', relativePath: 'X', projectId: 'p1' }], undo: [] }) });
    const result = await call('GET', 'plain');
    assert.equal(result.payload.revision, 1); assert.equal(result.payload.bindings.length, 1);
    settings.delete('plain:explorer_project_bindings:legacy');
  }],
  ['an administrator can bind as well', async () => {
    const result = await upsert('admin', 1, { id: 'b2', locationKey: k2, projectId: 'p1', label: 'Shared' });
    assert.equal(result.status, 200); assert.equal(result.payload.revision, 2); assert.equal(result.payload.bindings.length, 2);
  }],
  ['rejects a stale replay without changing storage', async () => {
    const before = JSON.stringify(stored());
    const result = await remove('manager', 1, 'b1');
    assert.equal(result.status, 409); assert.equal(JSON.stringify(stored()), before);
  }],
  ['a second binding for the same folder is a conflict', async () => {
    const result = await upsert('manager', 2, { id: 'other', locationKey: k1, projectId: 'p2', label: 'Unit 1' });
    assert.equal(result.status, 409);
    const withoutId = await upsert('manager', 2, { locationKey: k1, projectId: 'p2', label: 'Unit 1' });
    assert.equal(withoutId.status, 409);
  }],
  ['rejects malformed records', async () => {
    for (const binding of [{ locationKey: 'Z:\\Projects', projectId: 'p1', label: 'x' }, { locationKey: keyOf('x'), projectId: 'p1', label: '' }, { locationKey: keyOf('x'), projectId: 'ghost', label: 'x' }]) {
      const result = await upsert('manager', 2, binding);
      assert.ok([400, 403].includes(result.status), JSON.stringify(binding));
    }
    assert.equal(stored().revision, 2);
  }],
  ['bindings of a project hidden from a user are filtered out for that user only', async () => {
    members = [{ projectId: 'p1', userId: 'someone-else' }];
    const plain = await call('GET', 'plain');
    assert.deepEqual(plain.payload.bindings, []);
    const manager = await call('GET', 'manager');
    assert.deepEqual(manager.payload.bindings, []); assert.deepEqual(manager.payload.undo, []);
    const admin = await call('GET', 'admin');
    assert.equal(admin.payload.bindings.length, 2);
    members = [];
  }],
  ['a manager cannot touch bindings of a project they cannot see, and hidden rows survive', async () => {
    members = [{ projectId: 'p1', userId: 'someone-else' }];
    assert.equal((await remove('manager', 2, 'b1')).status, 403);
    assert.equal((await upsert('manager', 2, { id: 'b1', locationKey: k1, projectId: 'p2', label: 'Unit 1' })).status, 403);
    assert.equal((await upsert('manager', 2, { id: 'b3', locationKey: keyOf('x'), projectId: 'p1', label: 'x' })).status, 403);
    assert.equal(stored().bindings.length, 2);
    const visible = await upsert('manager', 2, { id: 'b4', locationKey: keyOf('//srv/share/open'), projectId: 'p2', label: 'Open' });
    assert.equal(visible.status, 200); assert.deepEqual(visible.payload.bindings.map((row: any) => row.projectId), ['p2']);
    assert.equal(stored().bindings.length, 3, 'скрытые записи остались в журнале');
    const denied = await undo('manager', 3, stored().undo.at(-1).id);
    assert.equal(denied.status, 403, 'снимок отмены включает скрытый проект: стирать его состояние нельзя');
    assert.equal(stored().bindings.length, 3);
    members = [];
  }],
  ['supports boundary removal and one-step undo for managers', async () => {
    const before = stored();
    const removed = await remove('manager', before.revision, 'b1');
    assert.equal(removed.status, 200); assert.equal(removed.payload.bindings.length, before.bindings.length - 1);
    const undone = await undo('admin', removed.payload.revision, removed.payload.undo.at(-1).id);
    assert.equal(undone.status, 200); assert.equal(undone.payload.bindings.length, before.bindings.length); assert.equal(undone.payload.revision, before.revision + 2);
  }],
  ['a non-manager cannot remove or undo', async () => {
    const revision = stored().revision;
    assert.equal((await remove('plain', revision, 'b1')).status, 403);
    assert.equal((await undo('plain', revision, stored().undo.at(-1).id)).status, 403);
  }],
  ['changing the project of a bound folder keeps one record and supports CAS undo', async () => {
    const revision = stored().revision;
    const changed = await upsert('manager', revision, { id: 'b1', locationKey: k1, projectId: 'p2', label: 'Unit 1 renamed' });
    assert.equal(changed.status, 200); assert.equal(changed.payload.bindings.filter((row: any) => row.locationKey === k1).length, 1);
    assert.equal(changed.payload.bindings.find((row: any) => row.id === 'b1').projectId, 'p2');
    const stale = await undo('manager', revision, changed.payload.undo.at(-1).id);
    assert.equal(stale.status, 409);
    const undone = await undo('manager', revision + 1, changed.payload.undo.at(-1).id);
    assert.equal(undone.status, 200); assert.equal(undone.payload.bindings.find((row: any) => row.id === 'b1').projectId, 'p1');
  }],
  ['rejects a failed compare-and-swap write', async () => {
    forceCasFailure = true;
    const before = stored();
    const result = await remove('manager', before.revision, 'b1');
    assert.equal(result.status, 409); assert.equal(stored().bindings.length, before.bindings.length);
  }],
  ['keeps saving, removing and undoing at the 500 binding limit by trimming old undo entries', async () => {
    settings.clear();
    let revision = 0;
    let last: any;
    for (let i = 0; i < 500; i += 1) {
      last = await upsert('manager', revision, { id: `big-${i}`, locationKey: keyOf(`//srv/share/section ${i}`), projectId: 'p1', label: `Section ${i} ${'Long folder name '.repeat(6)}` });
      assert.equal(last.status, 200, `upsert ${i}`);
      revision = last.payload.revision;
    }
    assert.equal(last.payload.bindings.length, 500);
    assert.equal((await upsert('manager', revision, { id: 'big-over', locationKey: keyOf('over'), projectId: 'p1', label: 'Over' })).status, 413);
    const removed = await remove('manager', revision, 'big-0');
    assert.equal(removed.status, 200); assert.equal(removed.payload.bindings.length, 499);
    revision = removed.payload.revision;
    const moved = await upsert('manager', revision, { id: 'big-1', locationKey: keyOf('//srv/share/section 1'), projectId: 'p2', label: 'Moved' });
    assert.equal(moved.status, 200); revision = moved.payload.revision;
    const row = [...settings.values()][0];
    assert.ok(Buffer.byteLength(row.value, 'utf8') <= 256_000);
    assert.equal(JSON.parse(row.value).bindings.length, 499);
    if (moved.payload.undo.length) {
      const undone = await undo('manager', revision, moved.payload.undo.at(-1).id);
      assert.equal(undone.status, 200); assert.equal(undone.payload.bindings.length, 499);
    }
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
