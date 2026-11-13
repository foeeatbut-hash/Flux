/**
 * Окно Flux с программой из разработки («Запустить во Flux») для проверки в браузере: настоящие экраны Store и
 * ModuleHost, настоящие действия окна, а главный процесс заменён подделкой в памяти страницы (она отвечает так, как
 * electron/moduleDevRunsIpc.ts; сами проверки подписей и срока — test-modules-dev-run-host.ts и *-native.ts).
 *
 * ?view=store — Библиотека Store; ?view=host — окно программы /module/dev-prog.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import StoreScreen from '../../src/screens/StoreScreen';
import ModuleHost from '../../src/screens/ModuleHost';
import { useStore } from '../../src/store/store';
import { SECTIONS } from '../../src/workspace/sections';
import { refreshStore } from '../../src/services/moduleStoreActions';
import { watchDevRuns } from '../../src/services/moduleDevRunActions';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
useStore.setState({ user: { id: 'dev-user', name: 'Анна Сидорова', role: 'ENGINEER_AUTO', isActive: true } as any });

const manifest = (id: string, name: string) => ({ id, name, version: '0.3.0', author: 'Анна Сидорова', contractVersion: 3, entries: ['start'], reads: ['project', 'equipment'], logic: 'logic/main.ts',
  permissions: [{ kind: 'internet', does: 'Показывает курсы валют из открытых сервисов' }], store: { category: 'calc', summary: 'Проверка', color: '#2563eb' } });
const item = (id: string, name: string, accepted: boolean) => ({ moduleId: id, name, version: '0.3.0', developer: 'Анна Сидорова', live: true, accepted, sha256: 'a'.repeat(64), manifest: manifest(id, name), why: '' });
/** Что «знает» главный процесс; набор меняет это через window.__dev и сообщает событием */
const dev: any[] = [
  item('dev-prog', 'Расчёт нагрузок', false),
  item('dev-ready', 'Курсы валют', true),
  { moduleId: 'dev-broken', name: 'dev-broken', version: '', developer: '', live: false, accepted: false, sha256: '', manifest: null, why: 'Studio закрыта: запуск из разработки прекращён' },
];
const listeners: Array<() => void> = [];
const state = () => ({ ok: true, userId: 'dev-user', channels: ['production'], installed: {}, available: [], cached: [], fallbacks: {}, runnable: [], dev: dev.map((d) => ({ ...d })) });
(window as any).__calls = [] as Array<{ channel: string; data: unknown }>;
(window as any).__dev = dev;
(window as any).__fire = () => listeners.forEach((l) => l());
(window as any).electron = { ipcRenderer: {
  invoke: async (channel: string, data: any) => {
    (window as any).__calls.push({ channel, data });
    if (channel === 'modules:state' || channel === 'modules:activate' || channel === 'modules:sync') return state();
    if (channel === 'modules:devAccept') { const d = dev.find((x) => x.moduleId === data.moduleId); if (!d) return { ok: false, error: 'нет' }; d.accepted = true; return { ok: true }; }
    if (channel === 'modules:devRemove') { const i = dev.findIndex((x) => x.moduleId === data.moduleId); if (i >= 0) dev.splice(i, 1); return { ok: true }; }
    return { ok: true };
  },
  on: (channel: string, fn: () => void) => { if (channel === 'modules:devChanged') listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
} };
(window as any).__sections = () => SECTIONS.filter((x) => x.dynamic).map((x) => x.title);
watchDevRuns();

const view = params.get('view') === 'host'
  ? <MemoryRouter initialEntries={['/module/dev-prog']}><Routes><Route path="/module/:id" element={<div style={{ height: '100vh' }} className="fx-glass"><ModuleHost /></div>} /></Routes></MemoryRouter>
  : <MemoryRouter initialEntries={['/store']}><StoreScreen /></MemoryRouter>;
createRoot(document.getElementById('mount')!).render(view);
void refreshStore();
