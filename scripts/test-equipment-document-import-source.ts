import assert from 'node:assert/strict';
import { canonicalDocumentSourceFolder, equipmentDocumentImportSource, equipmentDocumentRevisionFolder, findExistingEquipmentDocumentBinding, findLatestBoundDocument, getLocalEquipmentDocumentRef, resolveEquipmentSourceBinding, saveLocalEquipmentDocumentRef } from '../src/lib/equipmentDocumentBindings';
import { saveEquipmentSourceBinding } from '../src/lib/equipmentSourcesLocal';
import { useStore } from '../src/store/store';

const locator = { folderKey: 'a'.repeat(64), anchors: [{ key: 'b'.repeat(64), relativePath: 'R2' }] };
const source = equipmentDocumentImportSource({
  id: 'shared-document-binding-1',
  expectedLedgerRevision: 7,
  locator,
  fileName: 'L23.xlsx',
  rule: { kind: 'document-name', fileName: 'L23.xlsx' },
  revision: 'R2',
  sha256: 'c'.repeat(64),
});

assert.equal(source.kind, 'document', 'the import API discriminator must always be explicit');
assert.equal(source.id, 'shared-document-binding-1', 'reimports retain their shared binding identity');
assert.equal(source.expectedLedgerRevision, 7, 'the reviewed plan carries its ledger CAS');
assert.deepEqual(source.locator, locator, 'portable source provenance survives into the reviewed plan');
assert.equal(source.revision, 'R2');
assert.equal(source.sha256, 'c'.repeat(64));

const revisionFolder = { rootId: 'equipment-root', relativePath: 'Plant/B' };
const revisionFile = { rootId: 'equipment-root', relativePath: 'Plant/B/doc.pdf' };
const canonicalRevisionSource = canonicalDocumentSourceFolder(revisionFolder, revisionFile);
assert.deepEqual(canonicalRevisionSource, {
  sourceFolder: { rootId: 'equipment-root', relativePath: 'Plant' }, revision: 'B',
}, 'a document selected inside revision B maps to the existing parent source binding');
saveLocalEquipmentDocumentRef({
  projectId: 'project-fixture', bindingId: 'document-root-binding', sourceFolder: { rootId: 'equipment-root', relativePath: 'Plant' },
});
const existingDocumentBinding = {
  id: 'document-root-binding', projectId: 'project-fixture', kind: 'document', fileName: 'doc.pdf',
} as any;
assert.equal(findExistingEquipmentDocumentBinding(
  [existingDocumentBinding],
  { sourceFolder: revisionFolder, fileRef: revisionFile },
  'doc.pdf',
), existingDocumentBinding, 'wizard lookup reuses the binding attached to the revision parent folder');
assert.equal(equipmentDocumentRevisionFolder('B'), true);
assert.equal(equipmentDocumentRevisionFolder('2026'), true);
assert.equal(equipmentDocumentRevisionFolder('Archive'), false, 'ordinary folder names are not revisions');

const draftRevisionRoot = canonicalDocumentSourceFolder(
  { rootId: 'draft-root', relativePath: 'B', draftId: 'draft-7' },
  { rootId: 'draft-root', relativePath: 'B/doc.pdf', draftId: 'draft-7' },
);
assert.deepEqual(draftRevisionRoot, {
  sourceFolder: { rootId: 'draft-root', relativePath: '', draftId: 'draft-7' }, revision: 'B',
}, 'revision B directly below a draft root maps to the empty root path and keeps its capability');

const localValues = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => localValues.get(key) ?? null,
  setItem: (key: string, value: string) => { localValues.set(key, value); },
  removeItem: (key: string) => { localValues.delete(key); },
} });
useStore.setState({ user: { id: 'equipment-source-fixture-user' } as any });

const rootCapability = { projectId: 'project-fixture', bindingId: 'root-binding', sourceFolder: { rootId: 'local-root', relativePath: '' } };
saveLocalEquipmentDocumentRef(rootCapability);
const rootRoundTrip = getLocalEquipmentDocumentRef('project-fixture', 'root-binding');
assert.equal(rootRoundTrip?.sourceFolder.rootId, 'local-root', 'root-folder capability preserves its root ID');
assert.equal(rootRoundTrip?.sourceFolder.relativePath, '', 'an empty relative path is a valid root-folder capability');

const portableSource = {
  sourceId: 'source-shared-xml', projectId: 'project-fixture', tagId: 'tag-23', tagIdentifier: 'L23',
  elementId: 'element-23', targetType: 'component' as const, revisionOrder: ['A', 'B'], selectedRule: { kind: 'exact-tag' as const },
};
const resolveRequests: unknown[] = [];
Object.defineProperty(globalThis, 'window', { configurable: true, value: { electron: { windowsFiles: {
  invoke: async (request: any) => {
    resolveRequests.push(request);
    return { ok: true, data: { rootId: 'second-pc-root', relativePath: 'Engineering/Equipment/L23' } };
  },
  onChanged: () => () => {},
} } } });
async function checkPortableSourceResolution() {
const portableBinding = await resolveEquipmentSourceBinding('project-fixture', portableSource, {
  id: 'source-shared-xml', projectId: 'project-fixture', kind: 'cad-xml', xmlSourceId: 'source-shared-xml',
  equipmentIds: ['element-23'], tag: 'L23', locator: { folderKey: 'd'.repeat(64), anchors: [{ key: 'e'.repeat(64), relativePath: 'Engineering/Equipment/L23' }] },
  fileName: 'L23.xml', rule: { kind: 'exact-tag' }, createdAt: '', updatedAt: '',
});
assert.equal(resolveRequests.length, 1, 'second device resolves the shared locator once');
assert.equal((resolveRequests[0] as any).action, 'resolvePortableFolder');
assert.equal(portableBinding?.rootId, 'second-pc-root', 'resolution uses the current device root ID');
assert.equal(portableBinding?.relativePath, 'Engineering/Equipment/L23');
assert.equal(portableBinding?.selectedRule?.kind, 'exact-tag');

saveEquipmentSourceBinding({ ...portableSource, rootId: 'existing-local-root', relativePath: 'LocalOverride', revisionOrder: ['A', 'B'] });
const callsBeforeLocal = resolveRequests.length;
const localWins = await resolveEquipmentSourceBinding('project-fixture', portableSource, {
  id: 'source-shared-xml', projectId: 'project-fixture', kind: 'cad-xml', xmlSourceId: 'source-shared-xml', equipmentIds: ['element-23'],
  locator: { folderKey: 'f'.repeat(64), anchors: [] }, fileName: 'L23.xml', createdAt: '', updatedAt: '',
});
assert.equal(localWins?.relativePath, 'LocalOverride', 'an existing per-user local capability takes precedence');
assert.equal(resolveRequests.length, callsBeforeLocal, 'existing local capabilities do not trigger root discovery');

Object.defineProperty(globalThis, 'window', { configurable: true, value: { electron: { windowsFiles: {
  invoke: async () => ({ ok: true, data: null }), onChanged: () => () => {},
} } } });
const unavailable = await resolveEquipmentSourceBinding('project-fixture', { ...portableSource, sourceId: 'source-unavailable-xml', elementId: 'element-unavailable' }, {
  id: 'source-unavailable-xml', projectId: 'project-fixture', kind: 'cad-xml', xmlSourceId: 'source-unavailable-xml', equipmentIds: ['element-unavailable'],
  locator: { folderKey: '0'.repeat(64), anchors: [] }, fileName: 'L24.xml', createdAt: '', updatedAt: '',
});
assert.equal(unavailable, null, 'an unavailable portable locator remains unavailable without guessing another folder');

Object.defineProperty(globalThis, 'window', { configurable: true, value: { electron: { windowsFiles: {
  invoke: async (request: any) => {
    if (request.action === 'resolvePortableFolder') return { ok: true, data: { rootId: 'scan-root', relativePath: 'source' } };
    if (request.action === 'list') {
      const entries = request.ref.relativePath === 'source'
        ? Array.from({ length: 81 }, (_, index) => ({ kind: 'directory', name: `folder-${index}`, relativePath: `source/folder-${index}` }))
        : [];
      return { ok: true, data: { entries, nextOffset: null } };
    }
    return { ok: false, error: { code: 'NOT_SUPPORTED', message: 'unexpected request' } };
  }, onChanged: () => () {},
} } } });
await assert.rejects(
  () => findLatestBoundDocument('project-fixture', {
    id: 'scan-binding', projectId: 'project-fixture', kind: 'document', locator,
    fileName: 'doc.pdf', createdAt: '', updatedAt: '',
  } as any),
  /больше 80 папок/u,
  'scanner reports when the 80-folder safety limit would truncate results',
);
console.log('Equipment document/XML source helpers: typed import identity, root-folder persistence, second-PC resolution, local override, and unavailable state passed.');
}
void checkPortableSourceResolution().catch(error => { console.error(error); process.exitCode = 1; });
