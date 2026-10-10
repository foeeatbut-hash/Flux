/** Стабильный стенд панели переноса с ответами API в памяти. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import EntityIdMigrationPanel from '../../src/components/settings/EntityIdMigrationPanel';
import { useStore } from '../../src/store/store';
import { applyEntityIdMappingsLocally } from '../../src/lib/entityIdLocalMigration';
import { syncEntityIdMigrationHistory } from '../../src/lib/entityIdLocalMigration';
import '../../src/index.css';

const mappings = [
  { model: 'Project', oldId: 'legacy-p1', newId: 'PRJ-000014', projectId: 'legacy-p1' },
  { model: 'Project', oldId: 'legacy-p2', newId: 'PRJ-000015', projectId: 'legacy-p2' },
  { model: 'EquipmentSystem', oldId: 'same-system', newId: 'PRJ-000014-SYS-000001', projectId: 'legacy-p1' },
  { model: 'EquipmentSystem', oldId: 'same-system', newId: 'PRJ-000015-SYS-000001', projectId: 'legacy-p2' },
  { model: 'ComponentElement', oldId: 'same-position', newId: 'PRJ-000014-EQ-000001', projectId: 'legacy-p1' },
  { model: 'ComponentElement', oldId: 'same-position', newId: 'PRJ-000015-EQ-000001', projectId: 'legacy-p2' },
  { model: 'Tag', oldId: 'same-tag', newId: 'PRJ-000014-TAG-000001', projectId: 'legacy-p1' },
  { model: 'Tag', oldId: 'same-tag', newId: 'PRJ-000015-TAG-000001', projectId: 'legacy-p2' },
];
let historyRows: Array<{ migrationId: string; state: 'APPLIED' | 'UNDONE'; createdAt: string; mappings: typeof mappings }> = [];
let historyFetches = 0;

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method || 'GET';
  if (url.endsWith('/history')) { historyFetches++; return new Response(JSON.stringify({ migrations: historyRows }), { status: 200 }); }
  if (url.endsWith('/preview')) return new Response(JSON.stringify({
    planToken: 'fixture-plan-token', mappings,
    counts: { projects: 2, equipmentSystems: 2, monoblocks: 2, componentElements: 2, tags: 2, dictionaries: 0, dictionaryItems: 0, scalarReferences: 8, jsonReferences: 4 },
    blockers: new URLSearchParams(location.search).get('blocked') ? [{ code: 'E3_PROJECT_BOUND', message: 'Проект PRJ-000014 связан со схемой E3 и требует ручной проверки.', projectId: 'PRJ-000014' }] : [],
  }), { status: 200 });
  if (url.endsWith('/apply') && method === 'POST') return new Response(JSON.stringify({ migrationId: 'migration-000000000000000000000000', mappings, undoAvailable: true, state: 'APPLIED' }), { status: 200 });
  if (url.endsWith('/undo') && method === 'POST') return new Response(JSON.stringify({ migrationId: 'migration-000000000000000000000000', state: 'UNDONE' }), { status: 200 });
  return new Response(JSON.stringify({ error: 'fixture: unexpected API request' }), { status: 404 });
}) as typeof window.fetch;

if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.classList.add('dark');
const binding = (projectId: string, rootId: string, tagless = false) => ({
  userId: 'fixture-owner', projectId, sourceId: 'source-1', systemId: 'same-system', elementId: 'same-position', ...(tagless ? {} : { tagId: 'same-tag' }),
  targetType: 'component', rootId, relativePath: `Plans/${rootId}/Source`, selectedFileRef: { rootId, relativePath: `Plans/${rootId}/Source/equipment.xml` }, revisionOrder: ['R1'],
  ...(tagless ? { xmlTargetIdentity: { version: 1, targetType: 'component', unitIndex: 0, componentIndex: 1, fingerprint: { name: 'Тегless position', role: 'POSITION' } } } : {}),
});
const sourceKey = (projectId: string) => ['fixture-owner', projectId, 'source-1', 'same-position'].map(encodeURIComponent).join(':');
localStorage.setItem('flux.equipmentSources.local.v1', JSON.stringify({ [sourceKey('legacy-p1')]: binding('legacy-p1', 'capability-one'), [sourceKey('legacy-p2')]: binding('legacy-p2', 'capability-two', true) }));
localStorage.setItem('max_active_project_fixture-owner', JSON.stringify({ id: 'legacy-p1', name: 'П-1' }));
useStore.setState({ user: { id: 'fixture-owner', role: 'OWNER', name: 'Владелец', symbol: 'В' } as any, activeProject: { id: 'legacy-p1', name: 'П-1' } as any });
syncEntityIdMigrationHistory('http://fixture/api');
(window as any).__migrationFixtureCheck = () => {
  const values = Object.values(JSON.parse(localStorage.getItem('flux.equipmentSources.local.v1') || '{}')) as any[];
  return {
    activeProjectId: useStore.getState().activeProject?.id,
    savedProjectId: JSON.parse(localStorage.getItem('max_active_project_fixture-owner') || 'null')?.id,
    bindings: values.map((x) => ({ projectId: x.projectId, systemId: x.systemId, elementId: x.elementId, tagId: x.tagId, rootId: x.rootId, relativePath: x.relativePath, selectedFileRef: x.selectedFileRef, xmlTargetIdentity: x.xmlTargetIdentity })).sort((a, b) => a.projectId.localeCompare(b.projectId)),
  };
};
(window as any).__migrationFixtureReplay = () => applyEntityIdMappingsLocally(mappings);
(window as any).__migrationFixtureNotify = (state: 'APPLIED' | 'UNDONE') => {
  historyRows = [{ migrationId: 'migration-fixture', state, createdAt: '2026-10-10T00:00:00.000Z', mappings }];
  window.dispatchEvent(new CustomEvent('socket:entity:ids:migrated', { detail: { migrationId: 'migration-fixture', state } }));
};
(window as any).__migrationFixtureHistoryFetches = () => historyFetches;

createRoot(document.getElementById('mount')!).render(
  <main className="min-h-screen bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 p-4 sm:p-6">
    <div className="max-w-lg mx-auto"><h1 className="text-lg font-semibold mb-4">База данных</h1><EntityIdMigrationPanel /></div>
  </main>,
);
