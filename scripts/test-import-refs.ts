import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ImportRefStore } from '../electron/filesystem/importRefs.js';
import { WINDOWS_IMPORT_READ_BYTES } from '../filesystem/contracts.js';

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-import-refs-'));
  const largePath = path.join(directory, 'large.ifc');
  const store = new ImportRefStore();
  let now = 1_000_000;
  const originalNow = Date.now;
  Date.now = () => now;
  const checks: Array<[string, () => Promise<void>]> = [];
  try {
    const handle = await fs.open(largePath, 'w'); await handle.truncate(70 * 1024 * 1024 + 17); await handle.close();
    const expectedMtime = 1_700_000_000_000;
    await fs.utimes(largePath, new Date(expectedMtime), new Date(expectedMtime));
    const ref = (await store.registerPaths(1, [largePath], async () => ({ sourceFolder: { rootId: 'local-root', relativePath: '' }, fileRef: { rootId: 'local-root', relativePath: 'large.ifc' } })))[0];
    checks.push(['ticket retains cloneable file/folder capabilities without exposing the selected path', async () => { assert.equal('path' in ref, false); assert.equal(ref.name, 'large.ifc'); assert.equal(ref.lastModified, expectedMtime); assert.deepEqual(ref.provenance, { sourceFolder: { rootId: 'local-root', relativePath: '' }, fileRef: { rootId: 'local-root', relativePath: 'large.ifc' } }); assert.equal(JSON.stringify(ref).includes(directory), false); }]);
    checks.push(['provenance failure does not cancel native file selection', async () => {
      const picked = (await store.registerPaths(1, [largePath], async () => { throw new Error('provenance unavailable'); }))[0];
      assert.equal(picked.provenance, undefined);
      const firstByte = await store.read(1, picked.ticket, 0, 1);
      assert.equal(Buffer.from(firstByte.base64, 'base64').length, 1);
    }]);
    checks.push(['draft file parent ref retains draftId during provenance registration', async () => {
      let folderSeen: any;
      let fileSeen: any;
      const drafted = (await store.registerRefs(1, {
        entry: async () => ({ kind: 'file', name: 'draft.pdf' }),
        filename: async () => largePath,
      } as any, [{ rootId: 'draft-root', relativePath: 'draft-folder/draft.pdf', draftId: 'draft-17' }], async (folder, file) => {
        folderSeen = folder; fileSeen = file; return { sourceFolder: folder, fileRef: file };
      }))[0];
      assert.deepEqual(folderSeen, { rootId: 'draft-root', relativePath: 'draft-folder', draftId: 'draft-17' });
      assert.equal(fileSeen.draftId, 'draft-17');
      assert.equal(drafted.provenance?.sourceFolder.draftId, 'draft-17');
      store.release(1, [drafted.ticket]);
    }]);
    checks.push(['draft file parent ref retains draftId during provenance registration', async () => {
      let folderSeen: any;
      let fileSeen: any;
      const drafted = (await store.registerRefs(1, {
        entry: async () => ({ kind: 'file', name: 'draft.pdf' }),
        filename: async () => largePath,
      } as any, [{ rootId: 'draft-root', relativePath: 'draft-folder/draft.pdf', draftId: 'draft-17' }], async (folder, file) => {
        folderSeen = folder; fileSeen = file; return { sourceFolder: folder, fileRef: file };
      }))[0];
      assert.deepEqual(folderSeen, { rootId: 'draft-root', relativePath: 'draft-folder', draftId: 'draft-17' });
      assert.equal(fileSeen.draftId, 'draft-17');
      assert.equal(drafted.provenance?.sourceFolder.draftId, 'draft-17');
      store.release(1, [drafted.ticket]);
    }]);
    checks.push(['registerRefs keeps file selection working when provenance fails', async () => {
      const picked = (await store.registerRefs(1, {
        entry: async () => ({ kind: 'file', name: 'draft.pdf' }),
        filename: async () => largePath,
      } as any, [{ rootId: 'draft-root', relativePath: 'draft-folder/draft.pdf', draftId: 'draft-17' }], async () => {
        throw new Error('provenance unavailable');
      }))[0];
      assert.equal(picked.provenance, undefined);
      assert.equal(Buffer.from((await store.read(1, picked.ticket, 0, 1)).base64, 'base64').length, 1);
      store.release(1, [picked.ticket]);
    }]);
    checks.push(['limits every IPC read to one MiB', async () => { await assert.rejects(() => store.read(1, ref.ticket, 0, WINDOWS_IMPORT_READ_BYTES + 1)); }]);
    checks.push(['streams files larger than 64 MiB while renewing the idle TTL', async () => {
      let offset = 0; let total = 0;
      while (offset < ref.size) {
        const length = Math.min(WINDOWS_IMPORT_READ_BYTES, ref.size - offset);
        const piece = await store.read(1, ref.ticket, offset, length);
        total += Buffer.from(piece.base64, 'base64').length;
        offset += length;
        now += 60_000;
      }
      assert.equal(total, ref.size); assert.equal(offset, ref.size);
    }]);
    checks.push(['binds each ticket to its IPC sender', async () => { await assert.rejects(() => store.read(2, ref.ticket, 0, 1)); }]);
    checks.push(['expires after five idle minutes', async () => {
      const idle = (await store.registerPaths(1, [largePath]))[0];
      now += 5 * 60_000 + 1;
      await assert.rejects(() => store.read(1, idle.ticket, 0, 1));
    }]);
    checks.push(['detects path replacement after selection', async () => {
      const stale = (await store.registerPaths(1, [largePath]))[0];
      await fs.rename(largePath, `${largePath}.old`);
      await fs.writeFile(largePath, Buffer.from('replacement'));
      await assert.rejects(() => store.read(1, stale.ticket, 0, 1));
    }]);
    let failed = 0;
    for (const [name, test] of checks) {
      try { await test(); console.log(`PASS ${name}`); }
      catch (error) { failed += 1; console.error(`FAIL ${name}`, error); }
    }
    console.log(`${checks.length - failed}/${checks.length} import ref checks passed`);
    if (failed) process.exitCode = 1;
  } finally { Date.now = originalNow; await fs.rm(directory, { recursive: true, force: true }); }
}
void main();
