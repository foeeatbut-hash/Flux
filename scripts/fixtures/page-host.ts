// Окно-хост для проверки страницы: настоящий мост (modules/bridge.ts) вокруг настоящего iframe со страницей.
import { createModuleBridge } from '../../modules/bridge';
import { themeKeys, type ModuleManifest, type ThemeTokens } from '../../modules/contract';

const THEMES: Record<string, string[]> = {
  light: ['#ffffff', '#f8fafc', '#f1f5f9', '#e2e8f0', '#e2e8f0', '#1e293b', '#64748b', '#059669'],
  dark: ['#1e1e1e', '#121212', '#2a2a2a', '#333333', '#3a3a3a', '#e5e5e5', '#9ca3af', '#34d399'],
};
(window as any).startHost = (config: { manifest: ModuleManifest; src: string; theme: string; withPage?: boolean }) => {
  const session = 'page-session';
  const state: Record<string, unknown> = {};
  const w = window as any;
  w.__saved = []; w.__windows = []; w.__beats = 0; w.__state = state; w.__log = [];
  const tokens = (name: string) => Object.fromEntries(themeKeys.map((key, i) => [key, THEMES[name][i]])) as ThemeTokens;
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.style.cssText = 'width:800px;height:500px;border:0';
  document.body.append(frame);
  const bridge = createModuleBridge({
    frame: () => frame.contentWindow, session, manifest: config.manifest,
    context: () => ({ projectId: 'p', entry: 'start', entityId: null }), theme: () => tokens(w.__theme),
    read: (async (resource: string) => resource === 'project' ? { id: 'p', name: 'Проект 1', code: 'P1' } : null) as never,
    connect: async () => { (window as any).__connectCalls = ((window as any).__connectCalls || 0) + 1; return { ok: true as const, data: null }; },
    onLog: (level, text) => w.__log.push(`${level}:${text}`),
    page: config.withPage === false ? undefined : {
      loadState: () => state, keepState: next => { for (const k of Object.keys(state)) delete state[k]; Object.assign(state, next); },
      offerFile: async file => { w.__saved.push({ name: file.name, mime: file.mime, size: file.bytes.length }); return 'saved'; },
      // Файл пользователя (flux.openFile): ответ задаёт проверка через window.__pickNext, запросы копятся в __picks
      pickFile: async request => { (w.__picks ||= []).push(request); return w.__pickNext ?? 'cancelled'; },
      onBeat: () => { w.__beats++; },
      openWindow: (page, params) => { w.__windows.push({ page, params }); return true; },
      params: () => ({}), broadcast: () => undefined,
    },
  });
  window.addEventListener('message', event => { void bridge.handle(event); });
  w.__theme = config.theme;
  w.__bridge = bridge;
  w.__setTheme = (name: string) => { w.__theme = name; bridge.notify('changed'); };
  frame.src = config.src + '#' + session;
};
