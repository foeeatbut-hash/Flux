import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import ModuleHost from '../../src/screens/ModuleHost';
import ModuleLaunchActions from '../../src/components/modules/ModuleLaunchActions';
import { useStore } from '../../src/store/store';
import { moduleHref } from '../../modules/launch';
import { runModuleWorker } from '../../modules/runtime/runner';

useStore.setState({ activeProject: { id: 'p', name: 'Тестовый проект' } as any, user: { id: 'u', role: 'OWNER', name: 'Проверка' } as any });
const socket = io();
socket.on('entity:changed', detail => window.dispatchEvent(new CustomEvent('socket:entity:changed', { detail })));
socket.on('connect', () => { document.documentElement.dataset.socket = 'ready'; });
document.cookie = 'flux_parent_cookie=private; SameSite=Strict';
localStorage.setItem('flux_parent_storage', 'private');
(window as any).runModuleWorker = runModuleWorker;
function Harness() {
  const navigate = useNavigate();
  const theme = useStore(state => state.theme);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <div className="fx-tools shrink-0">
      <ModuleLaunchActions entry="equipment" entityId="e" />
      <div data-testid="tag-launch"><ModuleLaunchActions entry="tag" entityId="t" /></div>
      <button className="fx-btn" id="start" onClick={() => navigate(moduleHref('equipment-inspector'))}>Из Пуска</button>
      <button className="fx-btn" id="theme" onClick={() => { document.documentElement.classList.toggle('dark'); useStore.setState({ theme: theme === 'light' ? 'dark' : 'light' }); }}>Тема</button>
      <button className="fx-btn" id="project" onClick={() => useStore.setState({ activeProject: { id: 'p2', name: 'Другой проект' } as any })}>Сменить проект</button>
    </div>
    <div style={{ flex: 1, minHeight: 0 }}><ModuleHost /></div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={[moduleHref('equipment-inspector', { entry: 'equipment', entityId: 'e', projectId: 'p' })]}><Harness /></MemoryRouter>);
