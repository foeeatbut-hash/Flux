/**
 * Стенд «Пуск на нескольких мониторах»: настоящий WindowsLayer с панелью задач
 * на каждом мониторе (режим «Рабочий стол на всех мониторах»). Мониторы разной
 * ширины и высоты; ?single=1 — один монитор, как в обычном окне.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import Taskbar from '../../src/components/Taskbar';
import RightDock from '../../src/components/RightDock';
import WindowsLayer from '../../src/components/WindowsLayer';
import '../../src/index.css';
import { useStore } from '../../src/store/store';
import { useDisplayStore } from '../../src/store/displayStore';
import { useDesktopStore } from '../../src/store/desktopStore';
import { usePolicyStore } from '../../src/store/policyStore';
import { useWindowStore } from '../../src/store/windowStore';
import { useNotificationStore } from '../../src/store/notificationStore';
import { useAssistantDockStore } from '../../src/store/assistantDockStore';

import { BAR_H } from '../../src/lib/metrics';
document.documentElement.style.setProperty('--flux-taskbar-h', `${BAR_H}px`);
const single = new URLSearchParams(location.search).get('single') === '1';
const monitor = (id: number, x: number, w: number, h: number) => ({ id, label: `Монитор ${id}`, primary: id === 1, scaleFactor: 1, bounds: { x, y: 0, w, h }, workArea: { x, y: 0, w, h } });
// Левый уже и ниже правого: меню второго монитора не должно ориентироваться на первый
const screens = [monitor(1, 0, 700, 600), monitor(2, 700, 900, 700)];
const whole = monitor(1, 0, 1600, 700);
useDisplayStore.setState({ workspace: single
  ? { enabled: false, displays: [whole], bounds: whole.bounds, primaryId: 1, mixedScale: false }
  : { enabled: true, displays: screens, bounds: { x: 0, y: 0, w: 1600, h: 700 }, primaryId: 1, mixedScale: false }, available: false } as any);
useStore.setState({ user: { id: 'shot', name: 'Анна Смирнова', symbol: 'АС', role: 'ADMIN' }, theme: 'light' } as any);
usePolicyStore.setState({ platform: { enabled: true, supported: true, maintenance: false, version: 1, note: '' }, permissions: null, rolePermissions: null, loaded: true } as any);
useDesktopStore.setState({ apps: ['/registry', '/notes'], bar: ['/notes', '/registry'], groups: [] } as any);
(window as any).__fx = { windows: useWindowStore, closePanels: () => { useNotificationStore.getState().setPanelOpen(false); useAssistantDockStore.getState().setOpen(false); } };

/** Как в Layout: правые панели занимают рабочую область активного монитора */
function Dock() {
  const displays = useWindowStore((s) => s.displays);
  const activeId = useWindowStore((s) => s.activeDisplayId);
  const area = displays.find((d) => d.id === activeId)?.workArea || displays[0]?.workArea;
  return <RightDock bounds={displays.length ? area : undefined} />;
}

createRoot(document.getElementById('mount')!).render(<MemoryRouter initialEntries={['/']}>
  <div className="flux-app-window flex h-full w-full overflow-hidden"><main className="flex-1 min-w-0 flex flex-col relative"><div className="flex-1 min-h-0"><WindowsLayer /></div>{single && <Taskbar />}<Dock /></main></div>
</MemoryRouter>);
