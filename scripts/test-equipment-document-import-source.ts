import assert from 'node:assert/strict';
import { equipmentDocumentImportSource, getLocalEquipmentDocumentRef, resolveEquipmentSourceBinding, saveLocalEquipmentDocumentRef } from '../src/lib/equipmentDocumentBindings';
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
console.log('Equipment document/XML source helpers: typed import identity, root-folder persistence, second-PC resolution, local override, and unavailable state passed.');
}
void checkPortableSourceResolution().catch(error => { console.error(error); process.exitCode = 1; });
