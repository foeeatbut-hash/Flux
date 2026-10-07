/**
 * Стенд слоя окон: настоящий WindowsLayer с обычными разделами. Нужен, чтобы
 * сравнить заголовок окна до и после появления слота и чтобы проверить слот
 * на живом окне (scripts/test-explorer-shell-ui.ts).
 *
 * Слот занимает «зонд»: компонент, который снаружи раздела вставляет вкладки в
 * заголовок указанного окна — слот привязан к номеру окна, а не к разделу.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import WindowsLayer from '../../../src/components/WindowsLayer';
import ExplorerTabs from '../../../src/components/files/ExplorerTabs';
import { useExplorerTabs } from '../../../src/components/files/useExplorerTabs';
import { useWindowTitleBar } from '../../../src/lib/windowTitleBar';
import '../../../src/index.css';
import { useStore } from '../../../src/store/store';
import { useDisplayStore } from '../../../src/store/displayStore';
import { useDesktopStore } from '../../../src/store/desktopStore';
import { useWindowStore } from '../../../src/store/windowStore';

const screen = { id: 1, label: 'Тестовый экран', primary: true, scaleFactor: 1, bounds: { x: 0, y: 0, w: 1280, h: 800 }, workArea: { x: 0, y: 0, w: 1280, h: 760 } };
useDisplayStore.setState({ workspace: { enabled: true, showWindowsTaskbar: true, displays: [screen], bounds: screen.bounds, primaryId: 1, mixedScale: false }, available: true } as any);
useStore.setState({ user: { id: 'shell-fixture', name: 'Проверка', symbol: 'ПР', role: 'admin' } } as any);
useDesktopStore.setState({ apps: [] } as any);
(window as any).__windowStore = useWindowStore;
(window as any).fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.classList.add('dark');

function Probe({ winId }: { winId: string }) {
  const tabs = useExplorerTabs({ storageKey: 'probe.tabs' });
  return <>{useWindowTitleBar(
    <ExplorerTabs tabs={tabs.tabs} activeId={tabs.activeId} onPick={tabs.pick} onClose={tabs.close} onNew={() => tabs.open()} onMove={tabs.move} />,
    { winId, height: 38, className: 'bg-[#e9e9e9] dark:bg-[#202020]' },
  )}</>;
}

function Stand() {
  const [probe, setProbe] = React.useState<string | null>(null);
  (window as any).__probe = setProbe;
  return <>
    <MemoryRouter initialEntries={['/']}><WindowsLayer /></MemoryRouter>
    {probe && <Probe winId={probe} />}
  </>;
}
// Страница сама ничего не открывает: окна заводит проверка, чтобы кадр «до» и «после» был одинаковым
createRoot(document.getElementById('mount')!).render(<Stand />);
