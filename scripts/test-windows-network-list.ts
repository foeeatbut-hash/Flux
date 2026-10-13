import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WindowsFilesService } from '../electron/filesystem/service';
async function waitFor(predicate: () => boolean) { const end = Date.now() + 3000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(predicate(), 'hydration timeout'); }
async function main() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-network-list-')), desktop = path.join(sandbox, 'desktop'), userData = path.join(sandbox, 'data');
  const patches: any[] = []; let detailsFinished = false; let detailsStarted = false;
  await fs.mkdir(desktop); await fs.writeFile(path.join(desktop, 'alpha.txt'), 'alpha'); await fs.mkdir(path.join(desktop, 'folder'));
  const service = await WindowsFilesService.create({ userData, knownFolders: { desktop }, trashItem: async () => {}, showItemInFolder: () => {}, openPath: async () => '', isNetworkFolder: async () => true, onChanged: change => patches.push(change), fileDetails: async paths => { detailsStarted = true; await new Promise(resolve => setTimeout(resolve, 300)); detailsFinished = true; return paths.map(() => ({ hidden: false })); } });
  try {
    const root = (await service.roots())[0], before = Date.now();
    const listing = await service.list({ rootId: root.id, relativePath: '' });
    assert.ok(Date.now() - before < 250, 'names return without waiting for slow file properties');
    assert.equal(listing.entries.length, 2); assert.ok(listing.entries.every(entry => entry.detailsPending));
    assert.equal(detailsFinished, false); assert.equal(detailsStarted, false);
    const initial = new Map(listing.entries.map(entry => [entry.relativePath, entry.fileId]));
    await waitFor(() => patches.length > 0 && detailsFinished);
    assert.ok(patches.every(patch => patch.relativePath === '' && !patch.rescan));
    assert.deepEqual(new Map(patches.flatMap(patch => patch.entries).map((entry: any) => [entry.relativePath, entry.fileId])), initial);
    const refreshed = await service.list({ rootId: root.id, relativePath: '' });
    assert.ok(refreshed.entries.every(entry => !entry.detailsPending), 'cached hydrated entries are reused');
    console.log('✓ names-first network listing returns before slow properties and preserves row identity');
  } finally { service.close(); await fs.rm(sandbox, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
