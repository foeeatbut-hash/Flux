/** Two-server Explorer lifecycle over the parent's disposable MariaDB fixture. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

type Fixture = { kind: string; databaseName: string; servers: { index: number; origin: string }[]; accounts: { symbol: string; password: string; role: string }[] };
const fixturePath = process.env.FLUX_REMAINING_LIVE_METADATA || '/tmp/flux-remaining-live.json';
assert.equal(process.env.FLUX_TEST_FIXTURE, '1', 'refuse live mutation unless the explicit test fixture marker is set');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
assert.equal(fixture.kind, 'flux-remaining-live-fixture');
assert.match(fixture.databaseName, /^flux_[a-z0-9_]+_fixture(?:_|$)/);
const origin = (index: number) => {
  const entry = fixture.servers.find(server => server.index === index);
  assert.ok(entry, `fixture server ${index} is configured`);
  const url = new URL(entry.origin);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  return url.origin;
};
const BASE = origin(1), BASE2 = origin(2), ADMIN = fixture.accounts[0];
assert.equal(ADMIN.role, 'ADMIN');

type Result = { status: number; json: any; bytes: Buffer };
async function call(base: string, method: string, path: string, token = '', body?: any): Promise<Result> {
  const raw = Buffer.isBuffer(body);
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { /* raw bytes */ }
  return { status: response.status, json, bytes };
}

async function main() {
  const healthA = await call(BASE, 'GET', '/api/health');
  const healthB = await call(BASE2, 'GET', '/api/health');
  assert.equal(healthA.status, 200); assert.equal(healthB.status, 200);
  assert.equal(healthA.json?.databaseMode, 'REMOTE'); assert.equal(healthB.json?.databaseMode, 'REMOTE');
  const login = await call(BASE, 'POST', '/api/login', '', { symbol: ADMIN.symbol, password: ADMIN.password });
  const token = String(login.json?.token || '');
  assert.ok(token, 'synthetic fixture administrator login');
  const peerLogin = await call(BASE2, 'POST', '/api/login', '', { symbol: ADMIN.symbol, password: ADMIN.password });
  const token2 = String(peerLogin.json?.token || '');
  assert.ok(token2, 'synthetic fixture administrator login on server 2');
  const createdProjects: string[] = [];
  const createdFiles: string[] = [];
  let projectId = '';
  try {
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const project = await call(BASE, 'POST', '/api/projects', token, { name: `Files lifecycle ${stamp}` });
    projectId = String(project.json?.project?.id || '');
    assert.equal(project.status, 200); assert.ok(projectId);
    createdProjects.push(projectId);
    const folder = await call(BASE, 'POST', '/api/folders', token, { name: `Recycle test ${stamp}`, projectId, parentId: null, scope: 'SHARED' });
    const folderId = String(folder.json?.folder?.id || '');
    assert.equal(folder.status, 200); assert.ok(folderId);
    const initialTree = await call(BASE2, 'GET', `/api/projects/${projectId}/folders`, token2);
    const folderOnPeer = (initialTree.json?.folders || []).find((row: any) => row.id === folderId);
    assert.ok(folderOnPeer, `new project folder is independently visible on server 2 (HTTP ${initialTree.status}, folders ${(initialTree.json?.folders || []).length})`);
    console.log('✓ unique project and folder persist across both loopback servers');

    const name = `Verifiable ${stamp}.txt`;
    const made = await call(BASE, 'POST', '/api/files', token, { name, folderId, type: 'TXT', filePath: `/shared/${stamp}/${name}` });
    const fileId = String(made.json?.file?.id || '');
    assert.equal(made.status, 200); assert.ok(fileId); createdFiles.push(fileId);
    const original = Buffer.from(`synthetic office file ${stamp}\0\xff\nexact bytes`);
    const chunk = await call(BASE, 'POST', `/api/files/${fileId}/chunk`, token, { idx: 0, data: original.toString('base64') });
    const complete = await call(BASE, 'POST', `/api/files/${fileId}/done`, token, { count: 1 });
    const rawBefore = await call(BASE2, 'GET', `/api/files/${fileId}/raw`, token2);
    assert.equal(chunk.status, 200); assert.equal(complete.status, 200); assert.deepEqual(rawBefore.bytes, original);
    console.log('✓ file bytes written on server 1 are independently read unchanged on server 2');

    const renamed = await call(BASE, 'PATCH', `/api/files/${fileId}`, token, { name: `Renamed ${stamp}.txt` });
    const reRead = await call(BASE2, 'GET', `/api/files/${fileId}?meta=1`, token2);
    assert.equal(renamed.status, 200); assert.equal(reRead.json?.file?.name, `Renamed ${stamp}.txt`);
    console.log('✓ Explorer rename persists to the shared project and is readable on server 2');

    const trashed = await call(BASE, 'DELETE', `/api/files/${fileId}`, token);
    const trashA = await call(BASE, 'GET', `/api/projects/${projectId}/trash`, token);
    const trashB = await call(BASE2, 'GET', `/api/projects/${projectId}/trash`, token2);
    assert.equal(trashed.status, 200);
    assert.ok((trashA.json?.files || []).some((row: any) => row.id === fileId));
    assert.ok((trashB.json?.files || []).some((row: any) => row.id === fileId));
    assert.equal((await call(BASE2, 'GET', `/api/files/${fileId}`, token2)).status, 404);
    console.log('✓ soft delete moves only the selected file into the shared project trash');

    const restore = await call(BASE2, 'POST', `/api/files/${fileId}/restore`, token2, {});
    const restored = await call(BASE, 'GET', `/api/files/${fileId}?meta=1`, token);
    assert.equal(restore.status, 200); assert.equal(restored.json?.file?.deletedAt, null);
    console.log('✓ restore makes the same file readable again on server 1');

    const finalTrashFile = await call(BASE, 'POST', '/api/files', token, { name: `Purge only ${stamp}.txt`, folderId, type: 'TXT', filePath: `/shared/${stamp}/purge.txt` });
    const purgeId = String(finalTrashFile.json?.file?.id || '');
    assert.equal(finalTrashFile.status, 200); assert.ok(purgeId); createdFiles.push(purgeId);
    assert.equal((await call(BASE, 'DELETE', `/api/files/${purgeId}`, token)).status, 200);
    const beforePurge = await call(BASE2, 'GET', `/api/projects/${projectId}/trash`, token2);
    const trashIds = [...(beforePurge.json?.files || []).map((row: any) => row.id), ...(beforePurge.json?.folders || []).map((row: any) => row.id)];
    // `/trash` also includes trashed root files by design. Never issue a bulk
    // purge if this isolated project contains anything not created here.
    if (trashIds.length !== 1 || trashIds[0] !== purgeId || (beforePurge.json?.folders || []).length !== 0) {
      console.log(`NOT_RUN explorer.purge: isolated project trash also contains ${trashIds.length - 1} pre-existing shared/root item(s); guarded test left them untouched`);
    } else {
      const purged = await call(BASE, 'DELETE', `/api/projects/${projectId}/trash`, token);
      assert.equal(purged.status, 200); assert.equal(purged.json?.files, 1); assert.equal(purged.json?.folders, 0);
      assert.equal((await call(BASE2, 'GET', `/api/files/${purgeId}`, token2)).status, 404);
      console.log('✓ guarded purge permanently removes exactly the one script-owned trashed file');
    }
  } finally {
    // Remove only IDs created here. Project deletion is scoped to this run's unique project.
    for (const id of createdFiles) await call(BASE, 'DELETE', `/api/files/${id}`, token).catch(() => undefined);
    for (const id of createdProjects) await call(BASE, 'DELETE', `/api/projects/${id}`, token).catch(() => undefined);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
