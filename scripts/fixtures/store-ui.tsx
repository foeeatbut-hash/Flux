/**
 * Экран Flux Store для проверки в браузере: настоящий экран и настоящие
 * действия, но главный процесс заменён небольшой подделкой в памяти страницы
 * (она делает то же, что electron/moduleStoreIpc.ts, без проверки подписей —
 * подписи проверяет scripts/test-modules-store.ts), а сервер — перехватом
 * запросов в самом наборе.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import StoreScreen from '../../src/screens/StoreScreen';
import { SECTIONS } from '../../src/workspace/sections';
import { useStore } from '../../src/store/store';
import { refreshStore } from '../../src/services/moduleStoreActions';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
useStore.setState({ user: { id: 'ann', name: 'Анна Сидорова', role: params.get('role') || 'ENGINEER_AUTO', isActive: true } as any });

// Подделка главного процесса: проверенные версии хранятся в памяти страницы
const verified: Array<{ moduleId: string; version: string; channel: string; author: string; manifest: any }> = JSON.parse(sessionStorage.getItem('stx-verified') || '[]');
const installed: Record<string, { version: string; at: number; dirty?: boolean; noAuto?: boolean }> = JSON.parse(sessionStorage.getItem('stx-installed') || '{}');
const save = () => { sessionStorage.setItem('stx-verified', JSON.stringify(verified)); sessionStorage.setItem('stx-installed', JSON.stringify(installed)); };
const state = () => ({
  ok: true, userId: 'ann', channels: ['production'], installed, available: verified, cached: [], fallbacks: {},
  runnable: Object.entries(installed).map(([id, e]) => { const v = verified.find((a) => a.moduleId === id && a.version === e.version)!; return { manifest: v.manifest, version: v.version, channel: v.channel, author: v.author }; }),
});
const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
(window as any).__calls = [] as string[];
// Каналы вместе с данными: наборы проверяют, что именно окно просит у главного процесса
(window as any).__ipcLog = [] as Array<{ channel: string; data: unknown }>;
(window as any).electron = { ipcRenderer: { invoke: async (channel: string, data: any) => {
  (window as any).__calls.push(channel);
  (window as any).__ipcLog.push({ channel, data });
  if (channel === 'modules:state' || channel === 'modules:activate') return state();
  if (channel === 'modules:sync') {
    for (const r of data.releases || []) if (!verified.some((v) => v.moduleId === r.moduleId && v.version === r.version)) verified.push({ moduleId: r.moduleId, version: r.version, channel: 'production', author: 'k', manifest: JSON.parse(atob(r.chunks[0])) });
    save(); return { ...state(), broken: [] };
  }
  if (channel === 'modules:install') {
    if (!verified.some((v) => v.moduleId === data.moduleId && v.version === data.version)) return { ok: false, error: 'Эта версия не прошла проверку' };
    installed[data.moduleId] = { version: data.version, at: Date.now(), dirty: true, noAuto: data.noAuto }; save(); return { ...state(), at: installed[data.moduleId].at };
  }
  if (channel === 'modules:remove') { delete installed[data.moduleId]; save(); return state(); }
  if (channel === 'modules:rollback') {
    const cur = installed[data.moduleId];
    const prev = verified.filter((v) => v.moduleId === data.moduleId && (data.version ? v.version === data.version : cmp(v.version, cur.version) < 0)).sort((a, b) => cmp(b.version, a.version))[0];
    if (!prev) return { ok: false, error: 'Прошлой проверенной версии на этом компьютере нет.' };
    installed[data.moduleId] = { version: prev.version, at: Date.now(), dirty: true, noAuto: true }; save(); return { ...state(), at: installed[data.moduleId].at, version: prev.version };
  }
  if (channel === 'modules:synced') { if (installed[data.moduleId]) delete installed[data.moduleId].dirty; save(); return { ok: true }; }
  return { ok: true };
} } };
(window as any).__sections = () => SECTIONS.filter((s) => s.dynamic).map((s) => s.path);

createRoot(document.getElementById('mount')!).render(<MemoryRouter initialEntries={[params.get('module') ? `/store?module=${params.get('module')}` : '/store']}><StoreScreen /></MemoryRouter>);
void refreshStore();
