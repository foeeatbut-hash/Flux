import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import WindowsLayer from '../../src/components/WindowsLayer';
import '../../src/index.css';
import { useStore } from '../../src/store/store';
import { useDesktopStore } from '../../src/store/desktopStore';
import { useDisplayStore } from '../../src/store/displayStore';
import { useWindowStore } from '../../src/store/windowStore';
import { bytesToBase64 } from '../../src/lib/windowsFiles';
import { rendererEvents } from '../../src/lib/diagnostics';

const params = new URLSearchParams(location.search);
const app = params.get('app') === 'sheets' ? 'sheets' : 'docs';
const rootId = params.get('root') || 'mock-root';
const seedNames = app === 'sheets' ? ['one.xlsx', 'two.xlsx'] : ['one.docx', 'two.docx'];
const screen = { id: 1, label: 'Тестовый экран', primary: true, scaleFactor: 1, bounds: { x: 0, y: 0, w: 1440, h: 1000 }, workArea: { x: 0, y: 0, w: 1440, h: 960 } };
useDisplayStore.setState({ workspace: { enabled: true, showWindowsTaskbar: true, displays: [screen], bounds: screen.bounds, primaryId: 1, mixedScale: false }, available: true } as any);
useStore.setState({ user: { id: 'windows-file-office-workspace', name: 'Проверка', symbol: 'ПР', role: 'admin' }, activeProject: { id: 'local-project', name: 'Локальный проект' } } as any);
useDesktopStore.setState({ apps: [] } as any);

const files = new Map<string, Uint8Array>();
let revision = 0;
const officeCalls: any[] = [];
const fileCalls: any[] = [];
const fileName = (ref: any) => decodeURIComponent(String(ref?.relativePath || '').split('/').pop() || 'Проект.docx');
const fileContent = (ref: any) => {
  const name = fileName(ref);
  const data = files.get(name) || new Uint8Array();
  return { fileId: `office-${name}`, name, relativePath: ref.relativePath, storage: 'flux', kind: 'file', size: data.length, modifiedAt: new Date(0).toISOString(), linked: false, base64: bytesToBase64(data), sha256: `sha-${revision}` };
};
(window as any).__workspaceFiles = files;
(window as any).__workspaceSeedNames = (window as any).__workspaceSeedNames || seedNames;
for (const name of (window as any).__workspaceSeedNames as string[]) {
  const base64 = name.endsWith('.xlsx') ? (window as any).__workspaceXlsxBase64 : (window as any).__workspaceDocxBase64;
  if (typeof base64 === 'string') files.set(name, Uint8Array.from(atob(base64), (c: string) => c.charCodeAt(0)));
}
(window as any).__workspaceOfficeCalls = officeCalls;
(window as any).__workspaceFileCalls = fileCalls;
(window as any).__workspaceDiagnosticEvents = rendererEvents;
(window as any).__windowStore = useWindowStore;
(window as any).electron = {
  windowsFiles: {
    invoke: async (request: any) => {
      fileCalls.push(request);
      if (request.action === 'read') return { ok: true, data: fileContent(request.ref) };
      if (request.action === 'write') { files.set(fileName(request.ref), Uint8Array.from(atob(request.base64), (c: string) => c.charCodeAt(0))); revision++; return { ok: true, data: fileContent(request.ref) }; }
      if (request.action === 'publishDraft') return { ok: true, data: { ref: request.ref } };
      return { ok: false, error: { code: 'UNSUPPORTED_TEST_ACTION', message: 'Unsupported fixture request' } };
    },
    onChanged: () => () => undefined,
  },
  localOffice: {
    invoke: async (request: any) => {
      officeCalls.push(request);
      const endpoint = (window as any).__localOfficeEndpoint as string | undefined;
      if (!endpoint) return { ok: true, data: request.action === 'open' ? { session: officeCalls.length + 70 } : {} };
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      return response.json();
    },
    onEvent: (callback: (event: any) => void) => {
      const endpoint = (window as any).__localOfficeEndpoint as string | undefined;
      if (!endpoint) return () => undefined;
      let active = true;
      const poll = async () => {
        try { const response = await fetch(`${endpoint}/events`); const body = await response.json(); if (active) for (const event of body.events || []) callback(event); }
        catch { /* стенд может закончиться между опросами */ }
      };
      const timer = window.setInterval(() => void poll(), 80);
      void poll();
      return () => { active = false; window.clearInterval(timer); };
    },
  },
};

createRoot(document.getElementById('mount')!).render(<HashRouter><WindowsLayer /></HashRouter>);
