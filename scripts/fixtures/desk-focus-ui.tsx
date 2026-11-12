/**
 * Стенд «стол и окна Windows»: настоящие WindowsLayer (стол Windows и окна
 * разделов), панель задач, Пуск и «Параметры → Мониторы»; мост главного
 * процесса подменён и записывает сигналы указателя в window.__deskSignals.
 * Сцена и тема — в адресе: ?scene=desk|settings&theme=dark
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import WindowsLayer from '../../src/components/WindowsLayer';
import Taskbar from '../../src/components/Taskbar';
import DisplaySettings from '../../src/components/shell/DisplaySettings';
import { useDeskPointer } from '../../src/lib/deskPointer';
import '../../src/index.css';
import { useStore } from '../../src/store/store';
import { useDisplayStore } from '../../src/store/displayStore';
import { useDesktopStore } from '../../src/store/desktopStore';
import { usePolicyStore } from '../../src/store/policyStore';
import { useWindowStore } from '../../src/store/windowStore';
import type { WindowsFileEntry, WindowsRoot } from '../../filesystem/contracts';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') === 'settings' ? 'settings' : 'desk';
const dark = params.get('theme') === 'dark';
if (dark) document.documentElement.classList.add('dark');

const root: WindowsRoot = { id: 'desktop-id', name: 'Рабочий стол', kind: 'desktop', available: true };
const entries: WindowsFileEntry[] = [['Проекты', 'directory'], ['Договор.docx', 'file'], ['Смета.xlsx', 'file']].map(([name, kind], index) => ({
  name, relativePath: name, storage: 'windows', kind, fileId: `desk-${index}`, size: 1000 + index,
  modifiedAt: '2026-10-01T10:00:00.000Z', linked: false,
} as WindowsFileEntry));
const signals: boolean[] = [];
const saved: boolean[] = [];
let deskEnabled = params.get('deskOff') !== '1';
(window as any).__deskSignals = signals;
(window as any).__deskSaved = saved;
(window as any).electron = {
  windowsFiles: {
    invoke: async (request: any) => {
      switch (request.action) {
        case 'roots': return { ok: true, data: [root] };
        case 'list': return { ok: true, data: { entries, nextOffset: null, unreadableCount: 0 } };
        case 'metadata': return { ok: true, data: { fileId: 'x', tags: [], projectIds: [], revision: '', responsible: '', history: [] } };
        default: return { ok: true, data: {} };
      }
    },
    onChanged: () => () => undefined,
  },
  displays: {
    get: async () => workspace, set: async () => workspace, onChanged: () => () => undefined,
  },
  deskFocus: {
    get: async () => ({ available: true, enabled: deskEnabled }),
    set: async (value: boolean) => { saved.push(value); deskEnabled = value; return { available: true, enabled: value }; },
    pointer: (over: boolean) => { signals.push(over); },
  },
};
const screen = { id: 1, label: 'Основной', primary: true, scaleFactor: 1, bounds: { x: 0, y: 0, w: 1366, h: 768 }, workArea: { x: 0, y: 0, w: 1366, h: 768 } };
const workspace = { enabled: false, displays: [screen], bounds: screen.bounds, primaryId: 1, mixedScale: false };
useStore.setState({ user: { id: 'shot', name: 'Анна Смирнова', symbol: 'АС', role: 'ADMIN' }, theme: dark ? 'dark' : 'light' } as any);
usePolicyStore.setState({ platform: { enabled: true, supported: true, maintenance: false, version: 1, note: '' }, permissions: null, rolePermissions: null, loaded: true } as any);
useDesktopStore.setState({
  apps: ['/registry', '/equipment', '/explorer', '/mail', '/calendar', '/chat', '/settings'],
  bar: ['/explorer', '/mail', '/registry', '/calendar', '/chat', '/settings'], groups: [],
} as any);
(window as any).fetch = async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
(window as any).__fx = { windows: useWindowStore };
useWindowStore.getState().setArea({ w: 1366, h: 720 });

function Shell() {
  React.useEffect(() => useDisplayStore.getState().init(), []);
  useDeskPointer();
  if (scene === 'settings') return <div className="fixed inset-0 overflow-auto bg-white p-6 dark:bg-dark-bg"><div className="mx-auto max-w-2xl"><DisplaySettings /></div></div>;
  return <div className="fixed inset-0 flex flex-col bg-slate-100 dark:bg-dark-bg">
    <div className="relative min-h-0 flex-1"><WindowsLayer /></div>
    <Taskbar />
  </div>;
}
createRoot(document.getElementById('mount')!).render(<MemoryRouter initialEntries={['/']}><Shell /></MemoryRouter>);
