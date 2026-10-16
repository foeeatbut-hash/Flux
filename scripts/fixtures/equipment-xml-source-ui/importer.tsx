import React from 'react';
import { createRoot } from 'react-dom/client';
import EquipmentSourceImportDialog from '../../../src/components/equipment/EquipmentSourceImportDialog';
import EquipmentImportPreview from '../../../src/components/EquipmentImportPreview';
import { equipmentDocumentImportSource } from '../../../src/lib/equipmentDocumentBindings';
import { useStore } from '../../../src/store/store';
import './fixture.css';

const rootId = 'source-import-fixture';
const xml = '<root><system name="L23"><group name="Воздух"><param name="Расход воздуха" value="8060" unit="м³/ч"/></group></system></root>';
const base64 = btoa(unescape(encodeURIComponent(xml)));
const ref = { rootId, relativePath: 'L23/A/L23.xml' };
useStore.setState({ user: { id: 'fixture-user', role: 'ADMIN' } as any } as any);
(window as any).__importLog = [];
const documentSource = equipmentDocumentImportSource({ id: 'shared-document-binding-1', expectedLedgerRevision: 7, locator: { folderKey: 'a'.repeat(64), anchors: [{ key: 'b'.repeat(64), relativePath: 'R2' }] }, fileName: 'L23.xlsx', rule: { kind: 'document-name', fileName: 'L23.xlsx' }, revision: 'R2', sha256: 'c'.repeat(64) });
(window as any).electron = { windowsFiles: { invoke: async (request: any) => {
  if (request.action === 'pickEquipmentSource') return { ok: true, data: { selectedFile: { ref, name: 'L23.xml' }, sourceFolder: { rootId, relativePath: 'L23' } } };
  if (request.action === 'read') return { ok: true, data: { name: 'L23.xml', size: xml.length, modifiedAt: '2026-10-01T00:00:00.000Z', sha256: 'a'.repeat(64), base64 } };
  if (request.action === 'roots') return { ok: true, data: [{ id: rootId, name: 'Оборудование проекта', kind: 'custom', available: true }] };
  return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: `Unsupported fixture action: ${request.action}` } };
}, onChanged: () => () => {} } };
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  const method = init?.method || 'GET';
  // Настройка «системное окно выбора файла»: без неё ImportFileChooser открывает компактный выбор Flux вместо замоканного нативного.
  if (url.endsWith('/api/settings/explorer_file_picker')) return new Response(JSON.stringify({ user: JSON.stringify({ system: true }) }), { status: 200 });
  (window as any).__importLog.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (url.endsWith('/equipment/source-import/preview')) {
    if (new URLSearchParams(location.search).get('race') === '1') await new Promise(resolve => setTimeout(resolve, 500));
    return new Response(JSON.stringify({ success: true, fileName: 'L23.xml', sha256: 'a'.repeat(64), revision: 'A', previewToken: 'fixture-preview-token', unitTag: { identifier: 'L23', action: 'create' }, plan: {
    systems: [{ name: 'L23', title: 'L23', action: 'create' }],
    blocks: [{ key: 'L23‖B1', systemName: 'L23', title: 'Вентилятор', equipType: 'ВЕНТИЛЯТОР', action: 'create', params: [{ group: 'Воздух', key: 'Расход воздуха', value: '8060', unit: 'м³/ч', status: 'new' }], changedCount: 1, overrideImpact: 1 }],
    tagLinks: [{ blockKey: 'L23‖‖__unit__', identifier: 'L23', action: 'create' }], matches: [], systemRows: [], missing: [], totals: { systems: 1, newBlocks: 1, updatedBlocks: 0, unchangedBlocks: 0, overrides: 1 },
    } }), { status: 200 });
  }
  if (url.endsWith('/equipment/source-import/apply')) {
    if (new URLSearchParams(location.search).get('race') === '1') await new Promise(resolve => setTimeout(resolve, 500));
    return new Response(JSON.stringify({ success: true, baselineApplied: false, source: { sourceId: 'source-1', tagId: 'tag-1', targetType: 'system', systemId: 'system-1', elementId: 'element-1', revision: 'A', sha256: 'a'.repeat(64), fileName: 'L23.xml' } }), { status: 200 });
  }
  if (url.endsWith('/equipment/import-draft-plan')) return new Response(JSON.stringify({ plan: {
    systems: [{ name: 'L23', title: 'L23', action: 'match' }],
    blocks: [{ key: 'L23‖B1', systemName: 'L23', monoblockName: 'Вентиляция', itemCode: 'B1', title: 'Вентилятор', equipType: 'ВЕНТИЛЯТОР', action: 'update', params: [{ group: 'Воздух', key: 'Расход воздуха', value: '8060', unit: 'м³/ч', status: 'changed', oldValue: '8000' }], changedCount: 1, newCount: 0, overrideImpact: 1, elementId: 'element-1' }],
    tagLinks: [], matches: [], systemRows: [], missing: [], totals: { systems: 1, newBlocks: 0, updatedBlocks: 1, unchangedBlocks: 0, conflicts: 0, warnings: 0, overrides: 0 },
  } }), { status: 200 });
  if (url.endsWith('/equipment/import-draft')) return new Response(JSON.stringify({ batchId: 'batch-doc-r2', conflictsCount: 0, associations: { bindingId: 'shared-document-binding-1' } }), { status: 200 });
  return new Response(JSON.stringify({ error: `Unexpected ${method} ${url}` }), { status: 404 });
};

function Fixture() {
  const [done, setDone] = React.useState('');
  const [projectId, setProjectId] = React.useState('project-fixture');
  const width = new URLSearchParams(location.search).get('width') === 'narrow' ? 'max-w-[360px]' : 'max-w-[1100px]';
  const dark = new URLSearchParams(location.search).get('theme') === 'dark';
  const documentMode = new URLSearchParams(location.search).get('document') === '1';
  return <main className={`${dark ? 'dark' : ''} h-full bg-white p-3 text-slate-900 dark:bg-slate-950 dark:text-slate-100`}><div className={`mx-auto ${width}`}>
    {new URLSearchParams(location.search).get('race') === '1' && <button type="button" className="fixed right-4 top-4 z-[200] rounded bg-slate-900 px-3 py-2 text-white" onClick={() => setProjectId('project-next')}>Переключить проект</button>}
    {documentMode ? <EquipmentImportPreview draft={{ units: [{ name: 'L23', monoblocks: [{ name: 'Вентиляция', blocks: [{ code: 'B1', name: 'Вентилятор', equipType: 'ВЕНТИЛЯТОР', parameters: [] }] }] }], fileName: 'L23.xlsx', sourceBinding: documentSource }} category="vent" categoryLabel="Вентиляция" projectId={projectId} embedded onClose={() => setDone('Закрыто')} onDone={result => setDone(`Документ импортирован · ${result.bindingId || 'нет привязки'}`)} /> : <EquipmentSourceImportDialog projectId={projectId} categories={[{ id: 'vent', label: 'Вентиляция' }]} canManage onClose={() => setDone('Закрыто')} onImported={result => setDone(`Импортирован: ${result.source.systemId} · ${result.tagIdentifier} · baselineApplied=${result.baselineApplied}`)} />}
    <div role="status" data-testid="import-done">{done}</div>
  </div></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
