/**
 * Стенд панели задач и правых панелей: настоящие WindowsLayer, Taskbar и
 * RightDock в той же раскладке, что у Layout, мост Electron подменён.
 * Окна открывает проверка (window.__fx — хранилища). Тема — ?theme=dark.
 *
 * Мост снимков отвечает картинкой, нарисованной на canvas: так проверяется
 * вся цепочка «наведение → запрос → карточка» без настоящего capturePage.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import WindowsLayer from '../../src/components/WindowsLayer';
import Taskbar from '../../src/components/Taskbar';
import RightDock from '../../src/components/RightDock';
import '../../src/index.css';
import { BAR_H } from '../../src/lib/metrics';
import { useStore } from '../../src/store/store';
import { useDisplayStore } from '../../src/store/displayStore';
import { useDesktopStore } from '../../src/store/desktopStore';
import { usePolicyStore } from '../../src/store/policyStore';
import { useWindowStore } from '../../src/store/windowStore';
import { useNotificationStore } from '../../src/store/notificationStore';
import { useAssistantDockStore } from '../../src/store/assistantDockStore';

const params = new URLSearchParams(location.search);
const dark = params.get('theme') === 'dark';
if (dark) document.documentElement.classList.add('dark');
document.documentElement.style.setProperty('--flux-taskbar-h', `${BAR_H}px`);

/** Сколько раз просили снимок — проверка читает счётчик */
const thumbCalls: Array<{ x: number; y: number; width: number; height: number }> = [];
const withBridge = params.get('bridge') !== '0';
if (withBridge) {
  (window as any).electron = {
    ipcRenderer: {
      invoke: async (channel: string, rect: any) => {
        if (channel !== 'taskbar:window-thumb') return { ok: false };
        thumbCalls.push(rect);
        const c = document.createElement('canvas');
        c.width = 320; c.height = Math.max(40, Math.round(320 * rect.height / rect.width));
        const g = c.getContext('2d')!;
        const grad = g.createLinearGradient(0, 0, c.width, c.height);
        grad.addColorStop(0, '#dbeafe'); grad.addColorStop(1, '#a7f3d0');
        g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = '#064e3b'; g.font = '20px sans-serif'; g.fillText('снимок окна', 16, 40);
        return { ok: true, dataUrl: c.toDataURL('image/jpeg', 0.7), width: c.width, height: c.height };
      },
    },
  };
}

const screen = { id: 1, label: 'Основной', primary: true, scaleFactor: 1, bounds: { x: 0, y: 0, w: 1366, h: 768 }, workArea: { x: 0, y: 0, w: 1366, h: 768 } };
useDisplayStore.setState({ workspace: { enabled: false, displays: [screen], bounds: screen.bounds, primaryId: 1, mixedScale: false }, available: false } as any);
useStore.setState({ user: { id: 'shot', name: 'Анна Смирнова', symbol: 'АС', role: 'ADMIN' }, theme: dark ? 'dark' : 'light' } as any);
usePolicyStore.setState({ platform: { enabled: true, supported: true, maintenance: false, version: 1, note: '' }, permissions: null, rolePermissions: null, loaded: true } as any);
useDesktopStore.setState({
  apps: ['/registry', '/notes', '/calendar', '/guide'],
  bar: ['/notes', '/registry', '/calendar', '/guide'], groups: [],
} as any);
// Уведомления нескольких программ — для снимка центра уведомлений
const at = (min: number) => new Date(Date.now() - min * 60000).toISOString();
const NOTIFICATIONS = [
  { id: 'n1', userId: 'shot', category: 'ЧАТ', title: 'Игорь Петров: проверьте ведомость', body: 'Нужна сверка до обеда', targetRoute: '/chat?from=u1', isRead: false, createdAt: at(3) },
  { id: 'n2', userId: 'shot', category: 'ЧАТ', title: 'Мария Орлова: готово', body: '', targetRoute: '/chat?from=u2', isRead: false, createdAt: at(9) },
  { id: 'n3', userId: 'shot', category: 'ДОКУМЕНТЫ', title: 'Вам назначен документ «Смета щита»', body: 'Срок: пятница', targetRoute: '/management', isRead: true, createdAt: at(50) },
];
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
(window as any).fetch = async (input: any) => {
  const url = String(input?.url || input);
  if (url.includes('/notifications?')) return json({ notifications: NOTIFICATIONS });
  return json([]);
};
(window as any).__fx = { windows: useWindowStore, notif: useNotificationStore, assistant: useAssistantDockStore, thumbCalls };

function Shell() {
  return <div className="flux-app-window flex h-full w-full bg-slate-50 dark:bg-dark-bg overflow-hidden">
    <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-100 dark:bg-dark-bg relative">
      <div className="flex-1 min-h-0"><WindowsLayer /></div>
      <Taskbar />
    </main>
    <RightDock />
  </div>;
}
createRoot(document.getElementById('mount')!).render(<MemoryRouter initialEntries={['/']}><Shell /></MemoryRouter>);
