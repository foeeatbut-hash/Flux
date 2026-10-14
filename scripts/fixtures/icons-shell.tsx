/**
 * Стенд значков оболочки: рабочий стол Windows с файлами разных форматов,
 * панель задач и меню «Пуск» — настоящие компоненты, мост подменён.
 * Нужен для снимков docs/stand/icons/ и для замеров размеров значков
 * (scripts/test-icons-shell-ui.ts). Сцена и тема — в адресе:
 *   ?scene=desktop|start&theme=dark
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import WindowsDesktop from '../../src/components/desktop/WindowsDesktop';
import Taskbar from '../../src/components/Taskbar';
import StartMenu from '../../src/components/StartMenu';
import '../../src/index.css';
import { useStore } from '../../src/store/store';
import { useDisplayStore } from '../../src/store/displayStore';
import { useDesktopStore } from '../../src/store/desktopStore';
import { usePolicyStore } from '../../src/store/policyStore';
import { useWindowStore } from '../../src/store/windowStore';
import type { WindowsFileEntry, WindowsRoot } from '../../filesystem/contracts';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') === 'start' ? 'start' : 'desktop';
if (params.get('theme') === 'dark') { document.documentElement.classList.add('dark'); }

const root: WindowsRoot = { id: 'desktop-id', name: 'Рабочий стол', kind: 'desktop', available: true };
const NAMES: Array<[string, 'file' | 'directory']> = [
  ['Проекты', 'directory'], ['Договор.docx', 'file'], ['Смета.xlsx', 'file'], ['Чертёж АР-01.pdf', 'file'],
  ['Схема щита.dwg', 'file'], ['Проект.e3s', 'file'], ['Заметки.md', 'file'], ['Фото узла.png', 'file'],
  ['Архив.zip', 'file'], ['Данные.json', 'file'], ['Доклад.pptx', 'file'], ['Обзор.mp4', 'file'],
  ['Setup.exe', 'file'], ['Ярлык.lnk', 'file'], ['Ведомость.csv', 'file'], ['Старый.doc', 'file'],
  ['Модель.sldprt', 'file'], ['Библиотека.dll', 'file'], ['Журнал.log', 'file'], ['Запись.wav', 'file'],
];
const entries: WindowsFileEntry[] = NAMES.map(([name, kind], index) => ({
  name, relativePath: name, storage: index === 6 ? 'flux' : 'windows', kind, fileId: `shot-${index}`, size: 1000 + index,
  modifiedAt: '2026-10-01T10:00:00.000Z', linked: false,
}));
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
};
const screen = { id: 1, label: 'Основной', primary: true, scaleFactor: 1, bounds: { x: 0, y: 0, w: 1366, h: 768 }, workArea: { x: 0, y: 0, w: 1366, h: 768 } };
useDisplayStore.setState({ workspace: { enabled: false, displays: [screen], bounds: screen.bounds, primaryId: 1, mixedScale: false }, available: false } as any);
useStore.setState({ user: { id: 'shot', name: 'Анна Смирнова', symbol: 'АС', role: 'ADMIN' }, theme: params.get('theme') === 'dark' ? 'dark' : 'light' } as any);
usePolicyStore.setState({ platform: { enabled: true, supported: true, maintenance: false, version: 1, note: '' }, permissions: null, rolePermissions: null, loaded: true } as any);
useDesktopStore.setState({
  apps: ['/registry', '/equipment', '/explorer', '/mail', '/office-doc', '/office-sheet', '/pdf', '/calendar', '/chat', '/settings'],
  bar: ['/explorer', '/mail', '/registry', '/office-doc', '/office-sheet', '/calendar', '/chat', '/settings'], groups: [],
} as any);
(window as any).fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
useWindowStore.getState().setArea({ w: 1366, h: 720 });

function Shell() {
  return <div className="fixed inset-0 flex flex-col bg-slate-100 dark:bg-dark-bg">
    <div className="relative min-h-0 flex-1"><WindowsDesktop /></div>
    <Taskbar />
    {scene === 'start' && <StartMenu onClose={() => undefined} />}
  </div>;
}
createRoot(document.getElementById('mount')!).render(<MemoryRouter initialEntries={['/']}><Shell /></MemoryRouter>);
