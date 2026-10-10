import React from 'react';
import { createRoot } from 'react-dom/client';
import EquipmentSourceImportDialog from '../../../src/components/equipment/EquipmentSourceImportDialog';
import { useStore } from '../../../src/store/store';
import './fixture.css';

const rootId = 'source-import-fixture';
const xml = '<root><system name="L23"><group name="Воздух"><param name="Расход воздуха" value="8060" unit="м³/ч"/></group></system></root>';
const base64 = btoa(unescape(encodeURIComponent(xml)));
const ref = { rootId, relativePath: 'L23/A/L23.xml' };
useStore.setState({ user: { id: 'fixture-user', role: 'ADMIN' } as any } as any);
(window as any).__importLog = [];
(window as any).electron = { windowsFiles: { invoke: async (request: any) => {
  if (request.action === 'pickEquipmentSource') return { ok: true, data: { selectedFile: { ref, name: 'L23.xml' }, sourceFolder: { rootId, relativePath: 'L23' } } };
  if (request.action === 'read') return { ok: true, data: { name: 'L23.xml', size: xml.length, modifiedAt: '2026-10-01T00:00:00.000Z', sha256: 'a'.repeat(64), base64 } };
  if (request.action === 'roots') return { ok: true, data: [{ id: rootId, name: 'Оборудование проекта', kind: 'custom', available: true }] };
  return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: `Unsupported fixture action: ${request.action}` } };
}, onChanged: () => () => {} } };
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  const method = init?.method || 'GET';
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
  return new Response(JSON.stringify({ error: `Unexpected ${method} ${url}` }), { status: 404 });
};

function Fixture() {
  const [done, setDone] = React.useState('');
  const [projectId, setProjectId] = React.useState('project-fixture');
  const width = new URLSearchParams(location.search).get('width') === 'narrow' ? 'max-w-[360px]' : 'max-w-[1100px]';
  const dark = new URLSearchParams(location.search).get('theme') === 'dark';
  return <main className={`${dark ? 'dark' : ''} h-full bg-white p-3 text-slate-900 dark:bg-slate-950 dark:text-slate-100`}><div className={`mx-auto ${width}`}>
    {new URLSearchParams(location.search).get('race') === '1' && <button type="button" className="fixed right-4 top-4 z-[200] rounded bg-slate-900 px-3 py-2 text-white" onClick={() => setProjectId('project-next')}>Переключить проект</button>}
    <EquipmentSourceImportDialog projectId={projectId} categories={[{ id: 'vent', label: 'Вентиляция' }]} canManage onClose={() => setDone('Закрыто')} onImported={result => setDone(`Импортирован: ${result.source.systemId} · ${result.tagIdentifier} · baselineApplied=${result.baselineApplied}`)} />
    <div role="status" data-testid="import-done">{done}</div>
  </div></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
