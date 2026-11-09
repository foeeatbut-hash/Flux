import React from 'react';
import { createRoot } from 'react-dom/client';
import ModuleFrame from '../../src/components/modules/ModuleFrame';
import ConnectionGrants from '../../src/components/store/ConnectionGrants';
import ModuleJournalView from '../../src/components/store/ModuleJournalView';

// Данные Flux подставные: настоящая оболочка, мост и окно запроса, но без сервера
const data: Record<string, unknown> = { project: { id: 'p', name: 'Тестовый проект', code: 'P' }, equipment: null, tag: null, specification: { rows: [] }, catalog: { families: [] } };
const params = new URLSearchParams(location.search);
const manifestText = params.get('manifest');
const view = params.get('view');
document.body.style.background = 'var(--flux-surface)';
const root = createRoot(document.getElementById('root')!);
const toggle = <button className="fx-btn" id="theme" onClick={() => document.documentElement.classList.toggle('dark')}>Тема</button>;
if (manifestText) {
  root.render(<div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>{toggle}
    <ModuleFrame manifest={JSON.parse(manifestText)} context={{ projectId: 'p', entry: 'start', entityId: null }} theme="light"
      createReadCycle={() => async (resource: string) => data[resource] as never} /></div>);
} else if (view === 'grants') {
  root.render(<div style={{ padding: 16, background: 'var(--flux-surface)', minHeight: '100vh' }}>{toggle}<ConnectionGrants /></div>);
} else if (view === 'journal') {
  root.render(<div style={{ padding: 16, background: 'var(--flux-surface)', minHeight: '100vh' }}>{toggle}<ModuleJournalView moduleNames={{ 'connections-http': 'Расчёт на сервере' }} /></div>);
}
