import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { hashWindowsBytes, WindowsFilesService } from '../electron/filesystem/service';
import { applyClick, EMPTY_SELECTION, reconcileSelection } from '../src/components/files/useSelection';
import { contentsRows, DEFAULT_VIEW } from '../src/components/files/viewModel';
async function waitFor(predicate: () => boolean) { const end = Date.now() + 3000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(predicate(), 'hydration timeout'); }
async function main() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-network-list-')), desktop = path.join(sandbox, 'desktop'), userData = path.join(sandbox, 'data');
  const patches: any[] = []; let detailsFinished = false; let detailsStarted = false;
  await fs.mkdir(desktop); await fs.writeFile(path.join(desktop, 'alpha.txt'), 'alpha'); await fs.link(path.join(desktop, 'alpha.txt'), path.join(desktop, 'alpha-hardlink.txt')); await fs.mkdir(path.join(desktop, 'folder'));
  const service = await WindowsFilesService.create({ userData, knownFolders: { desktop }, trashItem: async () => {}, showItemInFolder: () => {}, openPath: async () => '', isNetworkFolder: async () => true, onChanged: change => patches.push(change), fileDetails: async paths => { detailsStarted = true; await new Promise(resolve => setTimeout(resolve, 300)); detailsFinished = true; return paths.map(() => ({ hidden: false })); } });
  try {
    const filename = path.join(desktop, 'alpha.txt'), stat = await fs.lstat(filename, { bigint: true });
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
    const canonicalKey = hashWindowsBytes(Buffer.from(`${service.state.data.deviceId}:${identity}`));
    const canonicalId = 'legacy-file-id-with-project-history';
    service.state.data.identity[canonicalKey] = canonicalId;
    service.state.data.metadata[canonicalId] = { fileId: canonicalId, tags: ['AHU-01'], projectIds: ['project-42'], revision: 'B', responsible: 'Иванов', history: [{ at: '2026-01-02T00:00:00.000Z', action: 'save', relativePath: 'alpha.txt' }] };
    await service.state.save();
    const root = (await service.roots())[0], before = Date.now();
    const listing = await service.list({ rootId: root.id, relativePath: '' });
    assert.ok(Date.now() - before < 250, 'names return without waiting for slow file properties');
    assert.equal(listing.entries.length, 3); assert.ok(listing.entries.every(entry => entry.detailsPending));
    assert.equal(listing.entries.find(entry => entry.name === 'alpha.txt')?.metadata, undefined, 'unverified path aliases do not expose metadata for a different canonical file');
    assert.equal(detailsFinished, false); assert.equal(detailsStarted, false);
    const initial = new Map(listing.entries.map(entry => [entry.relativePath, entry.uiKey]));
    assert.deepEqual(contentsRows(listing.entries, DEFAULT_VIEW).filter(row => row.kind === 'entry').map(row => row.key).sort(), listing.entries.map(entry => entry.uiKey).sort(), 'list row keys use the stable per-path UI key');
    await waitFor(() => patches.length > 0 && detailsFinished);
    assert.ok(patches.every(patch => patch.relativePath === '' && !patch.rescan));
    const hydrated = new Map(patches.flatMap(patch => patch.entries).map((entry: any) => [entry.relativePath, entry]));
    assert.deepEqual(new Map([...hydrated].map(([relative, entry]) => [relative, entry.uiKey])), initial, 'the stable row key survives hydration');
    assert.equal(hydrated.get('alpha.txt').fileId, canonicalId);
    assert.equal(hydrated.get('alpha-hardlink.txt').fileId, canonicalId, 'hard links keep one canonical identity');
    assert.equal(service.state.data.identity[canonicalKey], canonicalId, 'hydration never overwrites a canonical identity');
    assert.equal(service.state.data.identity[hydrated.get('alpha.txt').uiKey], canonicalId, 'the first path alias points to the canonical identity');
    assert.equal(service.state.data.identity[hydrated.get('alpha-hardlink.txt').uiKey], canonicalId, 'the second hard-link path aliases the same identity');
    const selectedBeforeHydration = applyClick(EMPTY_SELECTION, listing.entries, listing.entries.find(entry => entry.name === 'alpha.txt')!, {});
    const selectedAfterHydration = reconcileSelection(selectedBeforeHydration, [...hydrated.values()]);
    assert.deepEqual(selectedAfterHydration.ids, [hydrated.get('alpha.txt').uiKey], 'selection follows the stable UI key across canonical identity hydration');
    const metadata = await service.metadata({ rootId: root.id, relativePath: 'alpha.txt' });
    assert.deepEqual(metadata.tags, ['AHU-01']); assert.deepEqual(metadata.projectIds, ['project-42']); assert.equal(metadata.history[0].relativePath, 'alpha.txt');
    console.log('✓ hydration preserves canonical metadata and hard-link identity while the row key stays stable');
    const refreshed = await service.list({ rootId: root.id, relativePath: '' });
    assert.ok(refreshed.entries.every(entry => !entry.detailsPending), 'cached hydrated entries are reused');
    assert.equal(refreshed.entries.find(entry => entry.name === 'alpha.txt')?.fileId, canonicalId);
    console.log('✓ names-first network listing returns before slow properties and reuses canonical aliases');
    // Сбой и зависание lstat закрывают строку без сведений и освобождают ключ; в кэш такая строка не попадает.
    const failing = path.join(sandbox, 'failing'); await fs.mkdir(failing); await fs.writeFile(path.join(failing, 'boom.txt'), 'x'); await fs.writeFile(path.join(failing, 'hang.txt'), 'y');
    const failingRoot = await service.addRoot(failing, 'Сбои'); patches.length = 0; (service as any).hydrateItemMs = 100;
    const realLstat = fs.lstat; (fs as any).lstat = (target: any, ...rest: any[]) => /boom\.txt$/u.test(String(target)) ? Promise.reject(Object.assign(new Error('io'), { code: 'EIO' })) : /hang\.txt$/u.test(String(target)) ? new Promise(() => undefined) : (realLstat as any)(target, ...rest);
    try {
      const failingList = await service.list({ rootId: failingRoot.id, relativePath: '' });
      assert.ok(failingList.entries.every(entry => entry.detailsPending));
      await waitFor(() => patches.flatMap(patch => patch.entries).length === 2 && (service as any).hydrating.size === 0);
      assert.ok(patches.flatMap(patch => patch.entries).every((entry: any) => entry.detailsPending === false), 'a failed or hung lstat closes the row without details');
      const again = await service.list({ rootId: failingRoot.id, relativePath: '' });
      assert.ok(again.entries.every(entry => entry.detailsPending), 'temporary failures are not cached: the next read retries');
      await waitFor(() => (service as any).hydrating.size === 0);
    } finally { (fs as any).lstat = realLstat; }
    console.log('✓ failed and hung lstat do not leave rows pending or hydrating keys set');
  } finally { service.close(); await fs.rm(sandbox, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
