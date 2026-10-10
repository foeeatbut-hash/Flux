import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { getEquipmentSourceBinding, pickEquipmentSource, pickEquipmentSourceForImport, removeEquipmentSourceBinding, saveEquipmentSourceBinding, scanEquipmentSource, type EquipmentSourceAdapter, type EquipmentSourceRequest } from '../src/lib/equipmentSourcesLocal';
import type { WindowsEquipmentSourcePick, WindowsFileEntry, WindowsFileRef, WindowsFilesResponse } from '../filesystem/contracts';
import { decodeEquipmentSourceXml, inferEquipmentSourceFilenameRule, matchesEquipmentSourceFilename } from '../equipment/sourceXml';
import { resolveEquipmentSourceFolder, resolveEquipmentSourceSelection } from '../electron/filesystem/equipmentSourcePicker';
import { WindowsFilesService } from '../electron/filesystem/service';
import { useStore } from '../src/store/store';

const folder = (name: string, relativePath: string): WindowsFileEntry => ({ name, relativePath, storage: 'windows', kind: 'directory', fileId: relativePath, size: 0, modifiedAt: '2026-01-01T00:00:00.000Z', linked: false });
const file = (name: string, relativePath: string, text: string): WindowsFileEntry & { text: string } => ({ name, relativePath, text, storage: 'windows', kind: 'file', fileId: relativePath, size: Buffer.byteLength(text), modifiedAt: '2026-01-01T00:00:00.000Z', linked: false });
const bytes = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const xml = (unit: string, component = 'FAN') => `<root><system name="${unit}"><monoblock><block name="${component}"/></monoblock></system></root>`;
const root: WindowsFileRef = { rootId: 'drive-local', relativePath: 'Equipment/L23' };
const binding = { sourceId: 'src-1', projectId: 'project-1', tagId: 'tag-1', elementId: 'element-1', targetType: 'system' as const, tagIdentifier: 'Л23', rootId: root.rootId, relativePath: root.relativePath, revisionOrder: ['A', 'B', 'C'] };

function fixtureAdapter(entries: Map<string, (WindowsFileEntry & { text?: string })[]>, readOverrides: Record<string, WindowsFilesResponse<any>> = {}): EquipmentSourceAdapter {
  return {
    async list(ref, offset, limit) {
      const all = entries.get(ref.relativePath);
      if (!all) return { ok: false, error: { code: 'ENOENT', message: 'Папка источника недоступна.' } };
      const page = all.slice(offset, offset + limit);
      return { ok: true, data: { entries: page, nextOffset: offset + page.length < all.length ? offset + page.length : null } };
    },
    async read(ref) {
      if (readOverrides[ref.relativePath]) return readOverrides[ref.relativePath];
      const entry = [...entries.values()].flat().find((candidate) => candidate.relativePath === ref.relativePath);
      if (!entry?.text) return { ok: false, error: { code: 'ENOENT', message: 'Файл недоступен.' } };
      const content = Buffer.from(entry.text);
      return { ok: true, data: { name: entry.name, size: content.length, modifiedAt: entry.modifiedAt, sha256: 'a'.repeat(64), base64: bytes(entry.text) } };
    },
  };
}

async function main() {
  const fixture = new Map<string, (WindowsFileEntry & { text?: string })[]>([
    ['Equipment/L23', [folder('A', 'Equipment/L23/A'), folder('B', 'Equipment/L23/B'), folder('C', 'Equipment/L23/C')]],
    ['Equipment/L23/A', [file('Л23.xml', 'Equipment/L23/A/Л23.xml', xml('Л23')), file('Л230.xml', 'Equipment/L23/A/Л230.xml', xml('Л230'))]],
    ['Equipment/L23/B', [file('Л23.xml', 'Equipment/L23/B/Л23.xml', xml('Л23'))]],
    ['Equipment/L23/C', []],
  ]);
  const result = await scanEquipmentSource(binding, fixtureAdapter(fixture));
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') {
    assert.deepEqual(result.candidates.map((candidate) => candidate.revision), ['A', 'B']);
    assert.equal(result.recommended?.revision, 'B');
    assert.equal(result.candidates.every((candidate) => candidate.fileName === 'Л23.xml'), true);
    assert.equal(result.candidates.every((candidate) => candidate.sha256 === 'a'.repeat(64)), true);
  }

  let readCount = 0;
  const pickerRequest: EquipmentSourceRequest = async <T,>(request: any) => {
    if (request.action === 'pickEquipmentSource') return { ok: true, data: {
      canceled: false,
      selectedFile: { ref: { rootId: root.rootId, relativePath: 'Equipment/L23/A/Л23.xml' }, name: 'Л23.xml' },
      sourceFolder: root,
    } as WindowsEquipmentSourcePick as T };
    if (request.action === 'read') {
      readCount++;
      const content = Buffer.from(xml('Л23'));
      return { ok: true, data: { name: 'Л23.xml', size: content.length, modifiedAt: '2026-01-01T00:00:00.000Z', sha256: 'b'.repeat(64), base64: content.toString('base64') } as T };
    }
    return { ok: false, error: { code: 'INVALID_ACTION', message: 'неожиданная команда' } };
  };
  const preview = await pickEquipmentSource('Л23', pickerRequest);
  assert.equal(preview.ok && preview.data.status, 'ready');
  if (preview.ok && preview.data.status === 'ready') {
    assert.equal(preview.data.revision, 'A');
    assert.deepEqual(preview.data.selectedRule, { kind: 'exact-tag' });
    assert.equal(preview.data.sha256, 'b'.repeat(64));
    assert.equal(preview.data.base64, Buffer.from(xml('Л23')).toString('base64'));
  }
  assert.equal(readCount, 2, 'проверка выбора читает два одинаковых снимка файла');
  const untaggedPreview = await pickEquipmentSource(undefined, pickerRequest);
  assert.equal(untaggedPreview.ok && untaggedPreview.data.status, 'ready', 'XML для позиции без тега выбирается без угадывания тега');
  if (untaggedPreview.ok && untaggedPreview.data.status === 'ready') assert.deepEqual(untaggedPreview.data.selectedRule, { kind: 'selected-name', fileName: 'Л23.xml' }, 'привязка без тега закрепляет явно выбранное имя файла');
  assert.equal(readCount, 4, 'привязка без тега также читает два снимка и проверяет стабильность файла');
  const directRequest: EquipmentSourceRequest = async <T,>(request: any) => {
    if (request.action === 'pickEquipmentSource') return { ok: true, data: {
      canceled: false,
      selectedFile: { ref: { rootId: root.rootId, relativePath: 'Equipment/L23/Л23.xml' }, name: 'Л23.xml' },
      sourceFolder: root,
    } as WindowsEquipmentSourcePick as T };
    if (request.action === 'read') {
      const content = Buffer.from(`<root><system name="Л23"/><revision>A</revision></root>`);
      return { ok: true, data: { name: 'Л23.xml', size: content.length, modifiedAt: '2026-01-01T00:00:00.000Z', sha256: 'c'.repeat(64), base64: content.toString('base64') } as T };
    }
    return { ok: false, error: { code: 'INVALID_ACTION', message: 'неожиданная команда' } };
  };
  const directPreview = await pickEquipmentSource('Л23', directRequest);
  assert.equal(directPreview.ok && directPreview.data.status, 'ready');
  if (directPreview.ok && directPreview.data.status === 'ready') assert.equal(directPreview.data.revision, 'A', 'прямая XML-ревизия берётся из XML, а не из имени файла');

  const mismatchedPreviewRequest: EquipmentSourceRequest = async <T,>(request: any) => {
    if (request.action === 'pickEquipmentSource') return { ok: true, data: {
      canceled: false,
      selectedFile: { ref: { rootId: root.rootId, relativePath: 'Equipment/L23/B/Л23.xml' }, name: 'Л23.xml' },
      sourceFolder: root,
    } as WindowsEquipmentSourcePick as T };
    if (request.action === 'read') {
      const content = Buffer.from(`<root><system name="Л23"/><revision>A</revision></root>`);
      return { ok: true, data: { name: 'Л23.xml', size: content.length, modifiedAt: '2026-01-01T00:00:00.000Z', sha256: 'd'.repeat(64), base64: content.toString('base64') } as T };
    }
    return { ok: false, error: { code: 'INVALID_ACTION', message: 'неожиданная команда' } };
  };
  const mismatchedPreview = await pickEquipmentSource('Л23', mismatchedPreviewRequest);
  assert.equal(mismatchedPreview.ok && mismatchedPreview.data.status, 'ready');
  if (mismatchedPreview.ok && mismatchedPreview.data.status === 'ready') {
    assert.equal(mismatchedPreview.data.revision, 'A', 'XML revision takes priority over revision folder');
    assert.match(mismatchedPreview.data.revisionWarning || '', /папки — B/u, 'preview exposes a folder/XML revision mismatch');
  }

  const importPickerRequest = (contentText: string, selectedRef: WindowsFileRef, name: string, sourceFolder = root, unstable = false, busy = false): EquipmentSourceRequest => {
    let reads = 0;
    return async <T,>(request: any) => {
      if (request.action === 'pickEquipmentSource') return { ok: true, data: { canceled: false, selectedFile: { ref: selectedRef, name }, sourceFolder } as WindowsEquipmentSourcePick as T };
      if (request.action === 'read') {
        reads++;
        if (busy) return { ok: false, error: { code: 'BUSY', message: 'Файл занят копированием.' } };
        const content = Buffer.from(contentText);
        return { ok: true, data: { name, size: content.length, modifiedAt: `2026-01-01T00:00:0${unstable ? reads : 1}.000Z`, sha256: (unstable ? String(reads) : 'e').repeat(64), base64: content.toString('base64') } as T };
      }
      return { ok: false, error: { code: 'INVALID_ACTION', message: 'неожиданная команда' } };
    };
  };
  const importPreview = await pickEquipmentSourceForImport(importPickerRequest('<root><system name="Л23"/><revision>A</revision></root>', { rootId: root.rootId, relativePath: 'Equipment/L23/B/unknown.xml' }, 'unknown.xml'));
  assert.equal(importPreview.ok && importPreview.data.status, 'ready', 'unknown-tag first-import preview accepts well-formed XML');
  if (importPreview.ok && importPreview.data.status === 'ready') {
    assert.equal(importPreview.data.revision, 'A', 'first-import revision comes from XML before folder B');
    assert.deepEqual(importPreview.data.sourceFolder, root);
    assert.equal(importPreview.data.selectedFile.name, 'unknown.xml');
    assert.equal(importPreview.data.selectedFile.ref.relativePath, 'Equipment/L23/B/unknown.xml');
    assert.match(importPreview.data.revisionWarning || '', /папки — B/u);
    assert.equal(JSON.stringify(importPreview.data).includes('C:\\'), false, 'first-import snapshot has no absolute Windows path');
  }
  const corruptImportPreview = await pickEquipmentSourceForImport(importPickerRequest('<root><system', { rootId: root.rootId, relativePath: 'Equipment/L23/B/broken.xml' }, 'broken.xml'));
  assert.equal(corruptImportPreview.ok && corruptImportPreview.data.status, 'invalid', 'malformed XML is rejected before import preview');
  const unstableImportPreview = await pickEquipmentSourceForImport(importPickerRequest('<root><revision>A</revision></root>', { rootId: root.rootId, relativePath: 'Equipment/L23/A/changing.xml' }, 'changing.xml', root, true));
  assert.equal(unstableImportPreview.ok && unstableImportPreview.data.status, 'unstable', 'changing bytes are rejected as an in-progress copy');
  const busyImportPreview = await pickEquipmentSourceForImport(importPickerRequest('<root><revision>A</revision></root>', { rootId: root.rootId, relativePath: 'Equipment/L23/A/busy.xml' }, 'busy.xml', root, false, true));
  assert.equal(busyImportPreview.ok && busyImportPreview.data.status, 'unstable', 'a native busy-file response is classified as an unstable copy');

  const componentFixture = new Map([
    ['Equipment/L23', [folder('A', 'Equipment/L23/A')]],
    ['Equipment/L23/A', [file('FAN.xml', 'Equipment/L23/A/FAN.xml', xml('Л23', 'FAN'))]],
  ]);
  const componentResult = await scanEquipmentSource({ ...binding, targetType: 'component', tagIdentifier: 'FAN' }, fixtureAdapter(componentFixture));
  assert.equal(componentResult.status, 'ready');

  const nonExactFixture = new Map([
    ['Equipment/L23', [folder('A', 'Equipment/L23/A')]],
    ['Equipment/L23/A', [file('паспорт-Л23.xml', 'Equipment/L23/A/паспорт-Л23.xml', xml('Л23')),
      file('Л230.xml', 'Equipment/L23/A/Л230.xml', xml('Л23'))]],
  ]);
  const nonExactResult = await scanEquipmentSource({ ...binding, selectedRule: undefined }, fixtureAdapter(nonExactFixture));
  assert.equal(nonExactResult.status, 'ready');
  if (nonExactResult.status === 'ready') assert.deepEqual(nonExactResult.candidates[0].selectedRule, { kind: 'selected-name', fileName: 'паспорт-Л23.xml' });
  assert.equal(matchesEquipmentSourceFilename('Л230.xml', 'Л23'), false);
  assert.deepEqual(inferEquipmentSourceFilenameRule('паспорт-Л23.xml', 'Л23'), { kind: 'selected-name', fileName: 'паспорт-Л23.xml' });
  const ambiguityFixture = new Map([
    ['Equipment/L23', [folder('A', 'Equipment/L23/A')]],
    ['Equipment/L23/A', [file('Л23-v1.xml', 'Equipment/L23/A/Л23-v1.xml', xml('Л23')), file('Л23-v2.xml', 'Equipment/L23/A/Л23-v2.xml', xml('Л23'))]],
  ]);
  assert.equal((await scanEquipmentSource({ ...binding, selectedRule: undefined }, fixtureAdapter(ambiguityFixture)).then((value) => value.status)), 'ambiguous');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml('Л23'), 'utf16le')]);
  assert.equal(decodeEquipmentSourceXml(utf16)?.includes('Л23'), true);

  const selectedPath = path.join(process.cwd(), '__fixtures__', 'Equipment', 'Л23', 'A', 'Л23.xml');
  let authorizedRoot = '';
  const noRoot = {
    async refForShellPath() { return null; },
    async addRoot(folder: string) { authorizedRoot = folder; return { id: 'limited-root' }; },
  };
  const resolved = await resolveEquipmentSourceSelection(noRoot, selectedPath);
  assert.equal(authorizedRoot, path.dirname(path.dirname(selectedPath)));
  assert.deepEqual(resolved.sourceFolder, { rootId: 'limited-root', relativePath: '' });
  assert.equal(resolved.selectedFile.ref.relativePath, 'A/Л23.xml');
  assert.equal(JSON.stringify(resolved).includes(selectedPath), false, 'мост не отдаёт абсолютный путь renderer');
  const existingRoot = {
    async refForShellPath(filename: string) {
      return filename === path.dirname(path.dirname(selectedPath)) ? { rootId: 'existing-root', relativePath: 'Projects/Л23' } : null;
    },
    async addRoot() { throw new Error('корень уже доступен'); },
  };
  assert.deepEqual((await resolveEquipmentSourceSelection(existingRoot, selectedPath)).selectedFile.ref, { rootId: 'existing-root', relativePath: 'Projects/Л23/A/Л23.xml' });
  const pickedFolder = await resolveEquipmentSourceFolder(noRoot, path.dirname(path.dirname(selectedPath)));
  assert.deepEqual(pickedFolder, { rootId: 'limited-root', relativePath: '' });

  const saved = new Map<string, string>();
  useStore.setState({ user: { id: 'source-test-user', name: 'Test', symbol: 'T', role: 'ADMIN' } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => saved.get(key) || null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
  } });
  const localBinding = { ...binding, rootId: 'local-root', relativePath: 'Equipment/L23', selectedFileRef: { rootId: 'local-root', relativePath: 'Equipment/L23/A/Л23.xml' }, selectedRule: { kind: 'exact-tag' as const } };
  saveEquipmentSourceBinding(localBinding);
  assert.deepEqual(getEquipmentSourceBinding(binding.projectId, binding.sourceId, binding.tagId, binding.elementId), { ...localBinding, userId: 'source-test-user' });
  useStore.setState({ user: { id: 'other-user', name: 'Other', symbol: 'O', role: 'ADMIN' } });
  assert.equal(getEquipmentSourceBinding(binding.projectId, binding.sourceId, binding.tagId, binding.elementId), null, 'локальная capability не видна другому аккаунту');
  useStore.setState({ user: { id: 'source-test-user', name: 'Test', symbol: 'T', role: 'ADMIN' } });
  removeEquipmentSourceBinding(binding.projectId, binding.sourceId, binding.tagId, binding.elementId);
  assert.equal(getEquipmentSourceBinding(binding.projectId, binding.sourceId, binding.tagId, binding.elementId), null);
  delete (globalThis as any).localStorage;
  useStore.setState({ user: null });

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-equipment-source-'));
  const sourceFolder = path.join(temp, 'Оборудование', 'Л23');
  let service: WindowsFilesService | undefined;
  try {
    for (const revision of ['A', 'B', 'C']) await fs.mkdir(path.join(sourceFolder, revision), { recursive: true });
    await fs.writeFile(path.join(sourceFolder, 'A', 'Л23.xml'), xml('Л23'));
    await fs.writeFile(path.join(sourceFolder, 'A', 'Л230.xml'), xml('Л230'));
    await fs.writeFile(path.join(sourceFolder, 'B', 'Л23.xml'), xml('Л23', 'FAN-B'));
    service = await WindowsFilesService.create({ userData: path.join(temp, 'flux-data'), trashItem: async () => undefined, showItemInFolder: () => undefined, openPath: async () => '' });
    const nativeRoot = await service.addRoot(sourceFolder, 'Л23');
    const nativeBinding = { ...binding, rootId: nativeRoot.id, relativePath: '' };
    const nativeAdapter: EquipmentSourceAdapter = {
      async list(ref, offset, limit) {
        try {
          const result = await service!.list(ref, offset, limit);
          return { ok: true, data: { entries: result.entries, nextOffset: result.nextOffset } };
        } catch (error: any) { return { ok: false, error: { code: error.code || 'FILESYSTEM_ERROR', message: error.message } }; }
      },
      async read(ref) {
        try { return { ok: true, data: await service!.read(ref) }; }
        catch (error: any) { return { ok: false, error: { code: error.code || 'FILESYSTEM_ERROR', message: error.message } }; }
      },
    };
    const nativeResult = await scanEquipmentSource(nativeBinding, nativeAdapter);
    assert.equal(nativeResult.status, 'ready');
    if (nativeResult.status === 'ready') {
      assert.deepEqual(nativeResult.candidates.map((candidate) => candidate.revision), ['A', 'B']);
      assert.equal(nativeResult.candidates[0].sha256, (await service.fileHash(nativeResult.candidates[0].fileRef)).sha256);
      assert.equal(nativeResult.recommended?.revision, 'B');
    }
    await fs.writeFile(path.join(sourceFolder, 'B', 'Л23.xml'), xml('Л23', 'FAN-B-updated'));
    const changedSameRevision = await scanEquipmentSource(nativeBinding, nativeAdapter);
    assert.equal(changedSameRevision.status, 'ready');
    if (changedSameRevision.status === 'ready' && nativeResult.status === 'ready') {
      assert.notEqual(changedSameRevision.recommended?.sha256, nativeResult.recommended?.sha256, 'изменение байтов в прежней ревизии видно по контрольной сумме');
    }
    const nativeSelection = await resolveEquipmentSourceSelection(service, path.join(sourceFolder, 'A', 'Л23.xml'));
    assert.deepEqual(nativeSelection.sourceFolder, { rootId: nativeRoot.id, relativePath: '' });
    assert.equal(nativeSelection.selectedFile.ref.relativePath, 'A/Л23.xml');
    assert.deepEqual(await resolveEquipmentSourceFolder(service, sourceFolder), { rootId: nativeRoot.id, relativePath: '' });
    await fs.writeFile(path.join(sourceFolder, 'Л23.xml'), '<root><system name="Л23"/><revision>D</revision></root>');
    const directFileResult = await scanEquipmentSource({ ...nativeBinding, revisionOrder: ['A', 'B', 'C', 'D'] }, nativeAdapter);
    assert.equal(directFileResult.status, 'ready');
    if (directFileResult.status === 'ready') assert.equal(directFileResult.recommended?.revision, 'D', 'прямой XML без папки использует ревизию из содержимого');
  } finally {
    service?.close();
    await fs.rm(temp, { recursive: true, force: true });
  }

  const mismatch = new Map([['Equipment/L23', [folder('A', 'Equipment/L23/A')]], ['Equipment/L23/A', [file('Л23.xml', 'Equipment/L23/A/Л23.xml', xml('Л230'))]]]);
  assert.equal((await scanEquipmentSource(binding, fixtureAdapter(mismatch))).status, 'invalid');

  const ambiguous = new Map([['Equipment/L23', [folder('A', 'Equipment/L23/A')]], ['Equipment/L23/A', [file('Л23.xml', 'Equipment/L23/A/Л23.xml', xml('Л23')), file('Л23.XML', 'Equipment/L23/A/Л23.XML', xml('Л23'))]]]);
  assert.equal((await scanEquipmentSource(binding, fixtureAdapter(ambiguous))).status, 'ambiguous');

  const unstable = new Map([['Equipment/L23', [folder('A', 'Equipment/L23/A')]], ['Equipment/L23/A', [file('Л23.xml', 'Equipment/L23/A/Л23.xml', xml('Л23'))]]]);
  const unstableResult = await scanEquipmentSource(binding, fixtureAdapter(unstable, {
    'Equipment/L23/A/Л23.xml': { ok: false, error: { code: 'CONFLICT', message: 'Файл изменился во время чтения.' } },
  }));
  assert.equal(unstableResult.status, 'unstable');
  const changing = fixtureAdapter(unstable);
  let snapshots = 0;
  changing.read = async (ref) => {
    const entry = unstable.get('Equipment/L23/A')?.find((candidate) => candidate.relativePath === ref.relativePath) as (WindowsFileEntry & { text?: string }) | undefined;
    snapshots++;
    if (!entry?.text) return { ok: false, error: { code: 'ENOENT', message: 'Файл недоступен.' } };
    return { ok: true, data: { name: entry.name, size: Buffer.byteLength(entry.text), modifiedAt: `2026-01-01T00:00:0${snapshots}.000Z`, sha256: String(snapshots).repeat(64), base64: bytes(entry.text) } };
  };
  assert.equal((await scanEquipmentSource(binding, changing)).status, 'unstable');
  assert.equal((await scanEquipmentSource(binding, fixtureAdapter(new Map()))).status, 'source-unavailable');

  const mismatchRevisionFixture = new Map([
    ['Equipment/L23', [folder('A', 'Equipment/L23/A'), folder('B', 'Equipment/L23/B')]],
    ['Equipment/L23/A', [file('Л23.xml', 'Equipment/L23/A/Л23.xml', `<root><system name="Л23"/><revision>A</revision></root>`)]],
    ['Equipment/L23/B', [file('Л23.xml', 'Equipment/L23/B/Л23.xml', `<root><system name="Л23"/><revision>A</revision></root>`)]],
  ]);
  const mismatchRevisionResult = await scanEquipmentSource(binding, fixtureAdapter(mismatchRevisionFixture));
  assert.equal(mismatchRevisionResult.status, 'ambiguous', 'same XML revision in mismatched folders is surfaced instead of silently ranked');
  if (mismatchRevisionResult.status === 'ambiguous') assert.match(mismatchRevisionResult.candidates.find((candidate) => candidate.fileRef.relativePath.endsWith('/B/Л23.xml'))?.revisionWarning || '', /используется ревизия из XML/u);
  const singleMismatchResult = await scanEquipmentSource(binding, fixtureAdapter(new Map([
    ['Equipment/L23', [folder('B', 'Equipment/L23/B')]],
    ['Equipment/L23/B', [file('Л23.xml', 'Equipment/L23/B/Л23.xml', `<root><system name="Л23"/><revision>A</revision></root>`)]],
  ])));
  assert.equal(singleMismatchResult.status, 'invalid', 'a single folder/XML mismatch requires explicit resolution before automatic comparison');
  if (singleMismatchResult.status === 'invalid') {
    assert.equal(singleMismatchResult.candidates[0]?.revision, 'A');
    assert.match(singleMismatchResult.message, /используется ревизия из XML/u);
  }

  const corruptNewestFixture = new Map([
    ['Equipment/L23', [folder('A', 'Equipment/L23/A'), folder('B', 'Equipment/L23/B')]],
    ['Equipment/L23/A', [file('Л23.xml', 'Equipment/L23/A/Л23.xml', xml('Л23'))]],
    ['Equipment/L23/B', [file('Л23.xml', 'Equipment/L23/B/Л23.xml', '<root><system')]],
  ]);
  const corruptNewest = await scanEquipmentSource(binding, fixtureAdapter(corruptNewestFixture));
  assert.equal(corruptNewest.status, 'invalid', 'a broken newer revision cannot silently fall back to a previous valid revision');
  if (corruptNewest.status === 'invalid') {
    assert.equal(corruptNewest.candidates.length, 1, 'valid earlier candidates remain available for explicit selection');
    assert.ok(corruptNewest.invalidFiles?.some((name) => name.includes('Л23.xml')));
  }
  console.log('✓ equipment source scanner: XML-first revisions, mismatches, damaged newest revision, exact tags, ordered revisions, ambiguity and stable reads');
}

void main();
