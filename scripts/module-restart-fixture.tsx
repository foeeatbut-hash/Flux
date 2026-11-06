import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import Host from '../src/screens/ModuleHost';
import { useModuleStore } from '../src/store/moduleStoreState';
import { useSectionsVersion } from '../src/workspace/installedSections';
// В обычном Chromium нет Electron-протокола; пустая страница сохраняет настоящий
// iframe и позволяет проверять его жизненный цикл без посторонней ошибки навигации.
const iframePrototype = HTMLIFrameElement.prototype;
const nativeSetAttribute = iframePrototype.setAttribute;
const srcDescriptor = Object.getOwnPropertyDescriptor(iframePrototype, 'src')!;
const fixtureSrc = (value: string) => value.startsWith('flux-module://') ? 'about:blank' : value;
iframePrototype.setAttribute = function (name, value) {
  nativeSetAttribute.call(this, name, name.toLowerCase() === 'src' ? fixtureSrc(String(value)) : value);
};
Object.defineProperty(iframePrototype, 'src', {
  ...srcDescriptor,
  set(value: string) { srcDescriptor.set!.call(this, fixtureSrc(String(value))); },
});
const manifest = (version: string) => ({ id:'restart-test', name:'Расчёт', version, author:'Flux', contractVersion:1 as const, entries:['start' as const], reads:[], logic:'logic/main.ts' });
(window as any).update = (version: string | null, revoked = { releases: [], keys: [] }, channelCaps = {}) => {
  useModuleStore.getState().set({ local: { ok: true, userId: 'test', channels: ['production'], installed: {}, available: [], fallbacks: {}, runnable: [], revoked, channelCaps } });
  useSectionsVersion.getState().bump(version ? [{ manifest:manifest(version) as any, version, channel:'production', author:'key-a' }] : []);
};
(window as any).install = (version: string) => (window as any).update(version);
(window as any).install('1.0.0');
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/module/restart-test']}><Host /></MemoryRouter>);
