import React from 'react';
import { createRoot } from 'react-dom/client';
import EquipmentXmlSourcePanel from '../../../src/components/equipment/EquipmentXmlSourcePanel';
import { useStore } from '../../../src/store/store';
import './fixture.css';

const xml = '<root><block name="L23"><group name="Воздух"><param name="Расход воздуха" value="8060" unit="м³/ч"/><param name="Давление" value="500" unit="Па"/></group></block></root>';
const bytes = btoa(unescape(encodeURIComponent(xml)));
const rootId = 'equipment-source-fixture';
const ref = (relativePath: string) => ({ rootId, relativePath });
const file = (name: string, relativePath: string) => ({ name, relativePath, storage: 'windows', kind: 'file', fileId: relativePath, size: xml.length, modifiedAt: '2026-10-01T00:00:00.000Z', linked: false, rootId });
const directory = (name: string, relativePath: string) => ({ name, relativePath, storage: 'windows', kind: 'directory', fileId: relativePath, size: 0, modifiedAt: '2026-10-01T00:00:00.000Z', linked: false, rootId });
const candidate = { id: 'candidate-b', revision: 'B', fileName: 'L23.xml', sha256: 'b'.repeat(64), status: 'partial', changes: [
  { id: 'airflow', group: 'Воздух', key: 'Расход воздуха', kind: 'changed', current: { value: '8060', unit: 'м³/ч' }, catalogCurrent: { value: '7900', unit: 'м³/ч', source: 'catalog' as const }, proposed: { value: '8500', unit: 'м³/ч' }, manual: false },
  { id: 'pressure', group: 'Воздух', key: 'Давление', kind: 'changed', current: { value: '500', unit: 'Па' }, catalogCurrent: { value: '510', unit: 'Па', source: 'catalog' as const }, proposed: { value: '580', unit: 'Па' }, manual: true },
], structuralActions: [{ id: 'struct-engine', kind: 'added', label: 'Двигатель М2', reason: 'Новый узел расчёта добавлен в XML.', parsedKey: 'L23‖M2', elementIds: [], proposed: { code: 'M2', title: 'Электродвигатель', equipType: 'ЭЛЕКТРОДВИГАТЕЛЬ', groups: [{ title: 'Электрика', params: [{ key: 'Мощность', value: '5.5', unit: 'кВт' }] }] } }], decisions: { pressure: { action: 'keep' } }, expectedVersion: 2, createdAt: '2026-10-09T10:00:00.000Z' };
const raceMode = new URLSearchParams(location.search).get('race') === '1';
const viewerMode = new URLSearchParams(location.search).get('viewer') === '1';
let source: any = raceMode || viewerMode ? { sourceId: 'source-old', projectId: 'project-fixture', tagId: 'tag-1', elementId: 'element-1', targetType: 'component', tagIdentifier: 'L23', boundIdentifier: 'L23', revisionOrder: ['A', 'B'], selectedRule: { kind: 'exact-tag' }, lastImportedRevision: 'A', lastImportedSha256: 'a'.repeat(64) } : null;
let sourceReads = 0;
let fixtureCandidate: any = JSON.parse(JSON.stringify(candidate));
useStore.setState({ user: { id: 'fixture-user', role: 'ADMIN' } as any } as any);
(window as any).__fixtureWrites = [];
(window as any).__structuralPayloads = [];

(window as any).electron = { windowsFiles: { invoke: async (request: any) => {
  if (request.action === 'pickEquipmentSource') return { ok: true, data: { canceled: false, selectedFile: { ref: ref('L23/A/L23.xml'), name: 'L23.xml' }, sourceFolder: ref('L23') } };
  if (request.action === 'pickEquipmentSourceFolder') return { ok: true, data: { canceled: false, folder: ref('L23') } };
  if (request.action === 'roots') return { ok: true, data: [{ id: rootId, name: 'Проектное оборудование', kind: 'custom', available: true }] };
  if (request.action === 'list') {
    const entries = request.ref.relativePath === 'L23' ? [directory('A', 'L23/A'), directory('B', 'L23/B')] : request.ref.relativePath === 'L23/A' ? [file('L23.xml', 'L23/A/L23.xml')] : request.ref.relativePath === 'L23/B' ? [file('L23.xml', 'L23/B/L23.xml')] : [];
    return { ok: true, data: { entries, nextOffset: null } };
  }
  if (request.action === 'read') return { ok: true, data: { name: request.ref.relativePath.split('/').pop(), size: xml.length, modifiedAt: '2026-10-01T00:00:00.000Z', sha256: request.ref.relativePath.includes('/B/') ? 'b'.repeat(64) : 'a'.repeat(64), base64: bytes } };
  if (request.action === 'open' || request.action === 'reveal') return { ok: true, data: { opened: true } };
  return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: `Unsupported fixture action: ${request.action}` } };
}, onChanged: () => () => {} } };

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  if (init?.method && ['POST', 'PUT', 'DELETE'].includes(init.method.toUpperCase())) (window as any).__fixtureWrites.push(init.method.toUpperCase());
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  if (url.endsWith('/equipment/projects/project-fixture/sources') && !init?.method) {
    sourceReads += 1;
    if (raceMode && sourceReads === 1) await new Promise(resolve => setTimeout(resolve, 500));
    return new Response(JSON.stringify({ sources: source ? [source] : [] }), { status: 200 });
  }
  if (url.endsWith('/equipment/projects/project-fixture/sources') && init?.method === 'POST') {
    const body = JSON.parse(String(init.body));
    source = { sourceId: 'source-1', projectId: 'project-fixture', tagId: 'tag-1', elementId: 'element-1', targetType: 'component', tagIdentifier: 'L23', boundIdentifier: 'L23', revisionOrder: ['A', 'B'], selectedRule: body.selectedRule, lastImportedRevision: body.revision, lastImportedSha256: 'a'.repeat(64), lastImportedAt: '2026-10-01T00:00:00.000Z' };
    return new Response(JSON.stringify({ source }), { status: 201 });
  }
  if (url.endsWith('/candidates')) return new Response(JSON.stringify({ candidates: [fixtureCandidate] }), { status: 200 });
  if (url.endsWith('/sources/source-1/check')) return new Response(JSON.stringify({ candidate: fixtureCandidate }), { status: 201 });
  if (url.includes('/decisions')) {
    const body = JSON.parse(String(init?.body || '{}'));
    if (body.structuralDecisions) (window as any).__structuralPayloads.push(body.structuralDecisions);
    for (const decision of body.structuralDecisions || []) fixtureCandidate.decisions[decision.id] = { action: decision.action };
    fixtureCandidate.undoBatchId = 'undo-1';
    return new Response(JSON.stringify({ status: 'partial', batchId: 'undo-1' }), { status: 200 });
  }
  if (url.includes('/import-undo/')) return new Response(JSON.stringify({ action: 'restore' }), { status: 200 });
  if (url.endsWith('/equipment/import-undo')) { delete fixtureCandidate.decisions['struct-engine']; delete fixtureCandidate.undoBatchId; return new Response(JSON.stringify({ restored: true }), { status: 200 }); }
  if (url.endsWith('/sources/source-1') && init?.method === 'DELETE') { source = null; return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
  return originalFetch(input, init);
};

function Fixture() {
  const params = new URLSearchParams(location.search);
  const narrow = params.get('width') === 'narrow';
  const dark = params.get('theme') === 'dark';
  const [tagTwo, setTagTwo] = React.useState(false);
  return <main className={`${dark ? 'dark' : ''} h-full bg-white p-3 text-slate-900 dark:bg-slate-950 dark:text-slate-100`}><div className={`mx-auto flex h-full min-h-0 flex-col ${narrow ? 'max-w-[360px]' : 'max-w-[1100px]'}`}>
    <h1 className="mb-2 text-sm font-semibold">Пробная карточка · Л23</h1>
    {raceMode && <button type="button" onClick={() => setTagTwo(true)}>Переключить тег</button>}
    <EquipmentXmlSourcePanel projectId="project-fixture" tag={tagTwo ? { id: 'tag-2', identifier: 'L24' } : { id: 'tag-1', identifier: 'L23' }} elementId="element-1" targetType="component" canManage={!viewerMode} />
    <div className="mt-3 flex-1 overflow-auto rounded border border-slate-200 p-3 dark:border-slate-800"><p>Демонстрационные характеристики позиции остаются доступны под панелью источника.</p><div className="mt-3 grid grid-cols-2 gap-2"><div>Расход воздуха · 8 060 м³/ч</div><div>Давление · 500 Па</div></div></div>
  </div></main>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
