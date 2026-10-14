import React from 'react';
import { createRoot } from 'react-dom/client';
import EquipmentXmlSourcePanel from '../../../src/components/equipment/EquipmentXmlSourcePanel';
import EquipmentXmlUpdatesDialog from '../../../src/components/equipment/EquipmentXmlUpdatesDialog';
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
const untaggedMode = new URLSearchParams(location.search).get('untagged') === '1';
const rebindMode = new URLSearchParams(location.search).get('rebind') === '1';
const updatesMode = new URLSearchParams(location.search).get('updates') === '1';
const projectSwitchMode = new URLSearchParams(location.search).get('switch') === '1';
let source: any = raceMode || viewerMode || rebindMode ? { sourceId: 'source-old', projectId: 'project-fixture', tagId: 'tag-1', elementId: 'element-1', targetType: 'component', tagIdentifier: 'L23', boundIdentifier: 'L23', revisionOrder: ['A', 'B'], selectedRule: { kind: 'exact-tag' }, lastImportedRevision: 'A', lastImportedSha256: 'a'.repeat(64), updatedAt: '2026-10-01T00:00:00.000Z', latestCandidate: { id: 'candidate-b', revision: 'B', status: 'pending', updatedAt: '2026-10-02T00:00:00.000Z' } } : null;
const updateSources: any[] = [
  { sourceId: 'source-old', projectId: 'project-fixture', tagId: 'tag-1', tagIdentifier: 'L23', elementId: 'element-1', targetType: 'component', revisionOrder: ['A', 'B'], selectedRule: { kind: 'exact-tag' }, lastImportedRevision: 'A', updatedAt: '2026-10-01T00:00:00.000Z', latestCandidate: { id: 'candidate-b', revision: 'B', status: 'pending', updatedAt: '2026-10-02T00:00:00.000Z', changes: [{ id: 'airflow' }], structuralCount: 1 } },
  { sourceId: 'source-2', projectId: 'project-fixture', tagId: 'tag-2', tagIdentifier: 'L24', elementId: 'element-2', targetType: 'component', revisionOrder: ['A', 'C'], selectedRule: { kind: 'exact-tag' }, lastImportedRevision: 'A', updatedAt: '2026-10-01T00:00:00.000Z', latestCandidate: { id: 'candidate-c', revision: 'C', status: 'partial', updatedAt: '2026-10-03T00:00:00.000Z', changes: [{ id: 'pressure' }], structuralCount: 0 } },
  { sourceId: 'source-error', projectId: 'project-fixture', tagId: 'tag-3', tagIdentifier: 'L25', elementId: 'element-3', targetType: 'component', revisionOrder: ['A'], selectedRule: { kind: 'exact-tag' }, lastImportedRevision: 'A', updatedAt: '2026-10-01T00:00:00.000Z', latestCandidate: null },
  { sourceId: 'source-blue', projectId: 'project-fixture', elementId: 'element-4', targetType: 'component', xmlTargetIdentity: { version: 1, targetType: 'component', unitIndex: 0, componentIndex: 0, fingerprint: { name: 'Заслонка', title: 'Воздушная заслонка' } }, revisionOrder: ['A', 'B'], selectedRule: { kind: 'selected-name', fileName: 'untagged-damper.xml' }, lastImportedRevision: 'A', updatedAt: '2026-10-01T00:00:00.000Z', latestCandidate: { id: 'candidate-blue', revision: 'B', status: 'pending', updatedAt: '2026-10-04T00:00:00.000Z', changes: [], structuralCount: 0 } },
];
const otherProjectSources: any[] = [{ sourceId: 'source-other', projectId: 'project-other', tagId: 'tag-9', tagIdentifier: 'Q90', elementId: 'element-9', targetType: 'component', revisionOrder: ['A', 'B'], selectedRule: { kind: 'exact-tag' }, lastImportedRevision: 'A', updatedAt: '2026-10-05T00:00:00.000Z', latestCandidate: { id: 'candidate-other', revision: 'B', status: 'pending', updatedAt: '2026-10-06T00:00:00.000Z', changes: [{ id: 'q90' }], structuralCount: 0 } }];
let sourceReads = 0;
let fixtureCandidate: any = JSON.parse(JSON.stringify(candidate));
useStore.setState({ user: { id: 'fixture-user', role: 'ADMIN' } as any } as any);
(window as any).__fixtureWrites = [];
(window as any).__structuralPayloads = [];
(window as any).__sourcePayloads = [];
(window as any).__sourceRemapPayloads = [];
(window as any).__rebindPayloads = [];
(window as any).__rebindUrls = [];
let targetPreviewCalls = 0;

(window as any).electron = { windowsFiles: { invoke: async (request: any) => {
  if (request.action === 'pickEquipmentSource') return { ok: true, data: { canceled: false, selectedFile: { ref: ref('L23/A/L23.xml'), name: 'L23.xml' }, sourceFolder: ref('L23') } };
  if (request.action === 'pickEquipmentSourceFolder') return { ok: true, data: { canceled: false, folder: ref(rebindMode ? 'NewRoot' : updatesMode ? 'CommonRoot' : 'L23') } };
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
    if (updatesMode && projectSwitchMode && sourceReads === 1) await new Promise(resolve => setTimeout(resolve, 500));
    if (updatesMode) return new Response(JSON.stringify({ sources: updateSources }), { status: 200 });
    return new Response(JSON.stringify({ sources: source ? [source] : [] }), { status: 200 });
  }
  if (updatesMode && url.endsWith('/equipment/projects/project-other/sources') && !init?.method) return new Response(JSON.stringify({ sources: otherProjectSources }), { status: 200 });
  if (url.endsWith('/sources/rebind-folder') && init?.method === 'POST') {
    const body = JSON.parse(String(init.body));
    (window as any).__rebindPayloads.push(body);
    (window as any).__rebindUrls.push(url);
    if (updatesMode) for (const item of body.sources) { const target = updateSources.find(row => row.sourceId === item.sourceId); if (target?.latestCandidate && ['pending', 'partial'].includes(target.latestCandidate.status)) target.latestCandidate.status = 'stale'; }
    if (source) source = { ...source, updatedAt: '2026-10-03T00:00:00.000Z', latestCandidate: source.latestCandidate ? { ...source.latestCandidate, status: 'stale' } : null };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (url.endsWith('/equipment/projects/project-fixture/sources') && init?.method === 'POST') {
    const body = JSON.parse(String(init.body));
    (window as any).__sourcePayloads.push(body);
    source = { sourceId: 'source-1', projectId: 'project-fixture', ...(body.tagId ? { tagId: body.tagId, tagIdentifier: 'L23', boundIdentifier: 'L23' } : {}), ...(body.xmlTargetIdentity ? { xmlTargetIdentity: body.xmlTargetIdentity } : {}), elementId: 'element-1', targetType: 'component', revisionOrder: ['A', 'B'], selectedRule: body.selectedRule, lastImportedRevision: body.revision, lastImportedSha256: 'a'.repeat(64), lastImportedAt: '2026-10-01T00:00:00.000Z' };
    return new Response(JSON.stringify({ source }), { status: 201 });
  }
  if (url.endsWith('/equipment/projects/project-fixture/source-targets/preview')) {
    targetPreviewCalls += 1;
    const moved = targetPreviewCalls > 1;
    return new Response(JSON.stringify({ targets: [{ label: moved ? 'Позиция · L23 · установка 1 · проверенный новый узел' : 'Позиция · L23 · установка 1', identity: { version: 1, targetType: 'component', unitIndex: 0, componentIndex: moved ? 1 : 0, fingerprint: { name: 'L23', code: moved ? 'L23-remapped' : 'L23', title: 'L23', equipType: 'ПРОЧЕЕ' } } }] }), { status: 200 });
  }
  if (url.endsWith('/equipment/projects/project-fixture/sources/source-1/rebind') && init?.method === 'PUT') {
    const body = JSON.parse(String(init.body));
    (window as any).__sourceRemapPayloads.push(body);
    source = { ...source, xmlTargetIdentity: body.xmlTargetIdentity, selectedRule: body.selectedRule };
    return new Response(JSON.stringify({ source }), { status: 200 });
  }
  if (url.endsWith('/candidates')) return new Response(JSON.stringify({ candidates: [url.includes('source-2') ? { ...fixtureCandidate, id: 'candidate-c', revision: 'C', status: 'partial' } : fixtureCandidate] }), { status: 200 });
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
  const [projectId, setProjectId] = React.useState('project-fixture');
  const [tagTwo, setTagTwo] = React.useState(false);
  return <main className={`${dark ? 'dark' : ''} h-full bg-white p-3 text-slate-900 dark:bg-slate-950 dark:text-slate-100`}><div className={`mx-auto flex h-full min-h-0 flex-col ${narrow ? 'max-w-[360px]' : 'max-w-[1100px]'}`}>
    <h1 className="mb-2 text-sm font-semibold">Пробная карточка · Л23</h1>
    {raceMode && <button type="button" onClick={() => setTagTwo(true)}>Переключить тег</button>}
    {projectSwitchMode && <button type="button" onClick={() => setProjectId('project-other')}>Сменить проект</button>}
    {updatesMode ? <EquipmentXmlUpdatesDialog projectId={projectId} canManage={!viewerMode} localStatuses={{ 'tag-3:element-3': { status: 'invalid' } }} sourceLabels={{ 'element-4': 'Заслонка без тега' }} onClose={() => {}} onChanged={() => {}} /> : <EquipmentXmlSourcePanel projectId="project-fixture" tag={untaggedMode ? undefined : tagTwo ? { id: 'tag-2', identifier: 'L24' } : { id: 'tag-1', identifier: 'L23' }} elementId="element-1" targetType="component" canManage={!viewerMode} />}
    <div className="mt-3 flex-1 overflow-auto rounded border border-slate-200 p-3 dark:border-slate-800"><p>Демонстрационные характеристики позиции остаются доступны под панелью источника.</p><div className="mt-3 grid grid-cols-2 gap-2"><div>Расход воздуха · 8 060 м³/ч</div><div>Давление · 500 Па</div></div></div>
  </div></main>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
