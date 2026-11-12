/**
 * Стенд окон программ: настоящие WindowsLayer, ModuleHost, ModuleFrame и мост; программа-страница отдаётся
 * обычным http-сервером проверки (?page=<порт>), поэтому в Chromium работает без протокола Electron.
 * Тема — ?theme=dark. Хранилища окон открыты проверке как window.__fx.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import WindowsLayer from '../../src/components/WindowsLayer';
import '../../src/index.css';
import { useStore } from '../../src/store/store';
import { useDisplayStore } from '../../src/store/displayStore';
import { usePolicyStore } from '../../src/store/policyStore';
import { useWindowStore } from '../../src/store/windowStore';
import { useModuleStore } from '../../src/store/moduleStoreState';
import { syncInstalledSections } from '../../src/workspace/sections';
import { clearGuards, prepareSessionClose } from '../../src/lib/closeGuard';
import { PAGE_MIN_FLUX } from '../../modules/page/model';
import { pageTimings } from '../../src/services/modulePage';

const params = new URLSearchParams(location.search);
const dark = params.get('theme') === 'dark';
if (dark) document.documentElement.classList.add('dark');
const port = params.get('page');
// Порог «не отвечает» короче рабочего: полминуты ждать незачем, механизм тот же
pageTimings.hangMs = Number(params.get('hang') || pageTimings.hangMs);

// В обычном Chromium нет протокола flux-module://: кадр читает ту же страницу с http-сервера проверки
const fixtureSrc = (value: string) => value.replace(/^flux-module:\/\/[^/]+\//, `http://127.0.0.1:${port}/`);
const proto = HTMLIFrameElement.prototype;
const nativeSetAttribute = proto.setAttribute;
const srcDescriptor = Object.getOwnPropertyDescriptor(proto, 'src')!;
proto.setAttribute = function (name, value) { nativeSetAttribute.call(this, name, name.toLowerCase() === 'src' ? fixtureSrc(String(value)) : value); };
Object.defineProperty(proto, 'src', { ...srcDescriptor, set(value: string) { srcDescriptor.set!.call(this, fixtureSrc(String(value))); } });

// Сервера нет: ответы на служебные запросы стола пустые, чтобы в консоли и на экране не было шума
(window as any).fetch = async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });

const screen = { id: 1, label: 'Основной', primary: true, scaleFactor: 1, bounds: { x: 0, y: 0, w: 1366, h: 768 }, workArea: { x: 0, y: 0, w: 1366, h: 768 } };
useDisplayStore.setState({ workspace: { enabled: false, displays: [screen], bounds: screen.bounds, primaryId: 1, mixedScale: false }, available: false } as any);
useStore.setState({ user: { id: 'shot', name: 'Анна Смирнова', symbol: 'АС', role: 'ADMIN' }, theme: dark ? 'dark' : 'light' } as any);
usePolicyStore.setState({ platform: { enabled: true, supported: true, maintenance: false, version: 1, note: '' }, permissions: null, rolePermissions: null, loaded: true } as any);

const manifest = { id: 'win-demo', name: 'Ведомость', version: '1.0.0', author: 'Flux', contractVersion: 2, entries: ['start'], reads: ['project'], logic: 'logic/main.ts', ui: 'page', pages: ['detail.html'],
  store: { category: 'calc', summary: 'x', requires: { flux: PAGE_MIN_FLUX } } } as any;
useModuleStore.getState().set({ local: { ok: true, userId: 'test', channels: ['production'], installed: {}, available: [], fallbacks: {}, runnable: [], revoked: { releases: [], keys: [] }, channelCaps: {} } } as any);
syncInstalledSections([{ manifest, version: '1.0.0', channel: 'production', author: 'key-a' }]);
(window as any).__fx = { windows: useWindowStore, prepareSessionClose, clearGuards };

createRoot(document.getElementById('mount')!).render(<MemoryRouter initialEntries={['/']}>
  <div className="flux-app-window flex h-full w-full bg-slate-50 dark:bg-dark-bg overflow-hidden">
    <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-100 dark:bg-dark-bg relative"><div className="flex-1 min-h-0"><WindowsLayer /></div></main>
  </div>
</MemoryRouter>);
