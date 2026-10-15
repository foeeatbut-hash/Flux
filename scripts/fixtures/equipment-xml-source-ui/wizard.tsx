import React from 'react';
import { createRoot } from 'react-dom/client';
import DocImportWizard from '../../../src/components/DocImportWizard';
import type { EquipmentDocumentBinding } from '../../../equipment/documentBindings';
import type { WindowsFileRef } from '../../../src/lib/windowsFiles';
import './fixture.css';

const rootId = 'wizard-fixture-root';
const projectId = 'wizard-fixture-project';
const sourceFolder: WindowsFileRef = { rootId, relativePath: 'Equipment' };
const cadXml = '<Root><Revision>A</Revision><Unit name="L23"/><Elements cfnElement="cadVentilation"><Element name="L23"/></Elements></Root>';
const csvA = 'Tag,Name,Type,Parameter,Value,Unit\nFAN-A,Вентилятор A,Вентилятор,Расход воздуха,1000,м³/ч\n';
const csvB = 'Tag,Name,Type,Parameter,Value,Unit\nFAN-B,Вентилятор B,Вентилятор,Расход воздуха,1200,м³/ч\n';
const bytes = (text: string) => new TextEncoder().encode(text);
const base64 = (text: string) => btoa(String.fromCharCode(...bytes(text)));
const binding = (id: string, fileName: string, revision: string): EquipmentDocumentBinding => ({
  id, projectId, kind: 'document', equipmentIds: [], fileName, rule: { kind: 'document-name', fileName },
  latestRevision: { revision, sha256: (id === 'doc-a' ? 'a' : id === 'doc-b' ? 'b' : 'c').repeat(64), updatedAt: '2026-10-01T00:00:00.000Z' },
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  locator: { folderKey: 'd'.repeat(64), anchors: [{ key: 'e'.repeat(64), relativePath: 'Equipment' }] },
});
const ref = (fileName: string): WindowsFileRef => ({ rootId, relativePath: `Equipment/${fileName}` });
const initialFor = (id: 'doc-a' | 'doc-b' | 'cad') => {
  const fileName = id === 'cad' ? 'L23.xml' : `${id}.csv`;
  const documentBinding = binding(id, fileName, id === 'doc-a' ? 'R1' : id === 'doc-b' ? 'R2' : 'R3');
  return { binding: documentBinding, fileRef: ref(fileName), sourceFolder, revision: documentBinding.latestRevision!.revision, sha256: documentBinding.latestRevision!.sha256 };
};

const query = new URLSearchParams(location.search);
document.documentElement.classList.toggle('dark', query.get('theme') === 'dark');
(window as any).__wizardLog = [];
(window as any).__wizardState = { ledgerRevision: 41, draftWrites: 0, secondDraftPending: false, resolveSecondDraft: null as null | ((response: Response) => void) };
(window as any).electron = { windowsFiles: { invoke: async (request: any) => {
  if (request.action === 'read') {
    const path = String(request.ref?.relativePath || '');
    const content = path.endsWith('.xml') ? cadXml : path.endsWith('doc-b.csv') ? csvB : csvA;
    return { ok: true, data: { name: path.split('/').at(-1), size: bytes(content).length, modifiedAt: '2026-10-01T00:00:00.000Z', sha256: 'f'.repeat(64), base64: base64(content) } };
  }
  if (request.action === 'roots') return { ok: true, data: [{ id: rootId, name: 'Fixture', kind: 'custom', available: true }] };
  if (request.action === 'pickEquipmentSource') return { ok: true, data: { selectedFile: { ref: ref('L23.xml'), name: 'L23.xml' }, sourceFolder } };
  return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: `Unsupported fixture action: ${request.action}` } };
}, onChanged: () => () => {} } };

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  const path = new URL(url, location.href).pathname;
  const method = String(init?.method || 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  const log = (data: any = null) => (window as any).__wizardLog.push({ path, method, body, data });
  if (path.endsWith('/settings/explorer_file_picker')) return new Response(JSON.stringify({ user: JSON.stringify({ system: true }) }), { status: 200 });
  if (path.includes('/document-bindings')) {
    const state = (window as any).__wizardState;
    log({ revision: state.ledgerRevision });
    return new Response(JSON.stringify({ revision: state.ledgerRevision, bindings: [], canManage: true }), { status: 200 });
  }
  if (path.endsWith('/equipment/parse-calc')) {
    log();
    return new Response(JSON.stringify({ units: [{ name: 'L23', title: 'L23', monoblocks: [{ name: 'Вентиляция', blocks: [{ code: 'B1', name: 'Вентилятор', equipType: 'ВЕНТИЛЯТОР', parameters: [{ group: 'Воздух', key: 'Расход воздуха', value: '8060', unit: 'м³/ч' }] }] }] }] }), { status: 200 });
  }
  if (path.endsWith('/equipment/source-import/preview')) {
    log();
    return new Response(JSON.stringify({ success: true, fileName: 'L23.xml', sha256: 'c'.repeat(64), revision: 'A', previewToken: 'wizard-cad-preview', unitTag: { identifier: 'L23', action: 'create' }, plan: {
      systems: [{ name: 'L23', title: 'L23', action: 'create' }], blocks: [{ key: 'L23‖B1', systemName: 'L23', title: 'Вентилятор', equipType: 'ВЕНТИЛЯТОР', action: 'create', params: [{ group: 'Воздух', key: 'Расход воздуха', value: '8060', unit: 'м³/ч', status: 'new' }], changedCount: 1, overrideImpact: 1 }],
      tagLinks: [{ blockKey: 'L23‖‖__unit__', identifier: 'L23', action: 'create' }], matches: [], systemRows: [], missing: [], totals: { systems: 1, newBlocks: 1, updatedBlocks: 0, unchangedBlocks: 0, overrides: 1 },
    } }), { status: 200 });
  }
  if (path.endsWith('/equipment/source-import/apply')) {
    log();
    return new Response(JSON.stringify({ success: true, baselineApplied: false, source: { sourceId: 'cad-source-1', tagId: 'tag-l23', targetType: 'system', systemId: 'system-l23', elementId: 'element-l23', revision: 'A', sha256: 'c'.repeat(64), fileName: 'L23.xml' }, bindingId: 'cad-binding-1' }), { status: 200 });
  }
  if (path.endsWith('/equipment/import-draft-plan')) {
    log();
    return new Response(JSON.stringify({ plan: { systems: [{ name: 'L23', title: 'L23', action: 'match' }], blocks: [{ key: 'L23‖B1', systemName: 'L23', monoblockName: 'Вентиляция', itemCode: 'B1', title: 'Вентилятор', equipType: 'ВЕНТИЛЯТОР', action: 'update', params: [{ group: 'Воздух', key: 'Расход воздуха', value: '1000', unit: 'м³/ч', status: 'changed', oldValue: '900' }], changedCount: 1, newCount: 0, overrideImpact: 1, elementId: 'element-l23' }], tagLinks: [], matches: [], systemRows: [], missing: [], totals: { systems: 1, newBlocks: 0, updatedBlocks: 1, unchangedBlocks: 0, conflicts: 0, warnings: 0, overrides: 0 } } }), { status: 200 });
  }
  if (path.endsWith('/equipment/import-draft')) {
    const state = (window as any).__wizardState;
    log();
    state.draftWrites++;
    if (state.draftWrites === 2) {
      state.secondDraftPending = true;
      return new Promise(resolve => { state.resolveSecondDraft = resolve; });
    }
    state.ledgerRevision++;
    return new Response(JSON.stringify({ batchId: `doc-batch-${state.draftWrites}`, conflictsCount: 0, associations: { bindingId: `doc-binding-${state.draftWrites}` } }), { status: 200 });
  }
  log();
  return new Response(JSON.stringify({ error: `Unexpected ${method} ${path}` }), { status: 404 });
};

function Fixture() {
  const [initialDocument, setInitialDocument] = React.useState<any>(() => initialFor(query.get('cad') === '1' ? 'cad' : 'doc-a'));
  const [done, setDone] = React.useState('');
  (window as any).__wizardLoadSecondDocument = () => { setDone(''); setInitialDocument(initialFor('doc-b')); };
  (window as any).__wizardResolveSecondDraft = () => {
    const state = (window as any).__wizardState;
    state.ledgerRevision++;
    state.resolveSecondDraft?.(new Response(JSON.stringify({ batchId: 'doc-batch-2', conflictsCount: 0, associations: { bindingId: 'doc-binding-2' } }), { status: 200 }));
    state.resolveSecondDraft = null;
    state.secondDraftPending = false;
  };
  return <main className="h-full bg-white dark:bg-slate-950">
    <div role="status" data-testid="wizard-done">{done}</div>
    <DocImportWizard projectId={projectId} categories={[{ id: 'vent', label: 'Вентиляция' }]} canManage onClose={() => setDone('wizard-closed')} onImported={() => setDone('wizard-imported')} initialDocument={initialDocument} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
