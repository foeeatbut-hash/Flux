import React from 'react';
import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import WindowsFileHost from '../../src/screens/WindowsFileHost';
import { PaneContext } from '../../src/lib/paneTitle';
import { bytesToBase64 } from '../../src/lib/windowsFiles';
import { useStore } from '../../src/store/store';
import type { WindowsFileContent, WindowsFileRef, WindowsFilesRequest, WindowsFilesResponse } from '../../filesystem/contracts';

const params = new URLSearchParams(location.search);
const app = params.get('app') === 'sheets' ? 'sheets' : 'docs';
const name = app === 'sheets' ? 'Проба.xlsx' : 'Проба.docx';
const ref: WindowsFileRef = { rootId: 'mock-root', relativePath: name, draftId: 'mock-draft' };
let revision = 0;
let bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const calls: any[] = [];
const content = (): WindowsFileContent => ({ fileId: 'mock-office-file', name, relativePath: name, storage: 'flux', draftId: ref.draftId, kind: 'file', size: bytes.length, modifiedAt: new Date(0).toISOString(), linked: false, base64: bytesToBase64(bytes), sha256: `sha-${revision}` });
const invokeFiles = async (request: WindowsFilesRequest): Promise<WindowsFilesResponse<any>> => {
  calls.push({ area: 'files', request });
  if (request.action === 'read') return { ok: true, data: content() };
  if (request.action === 'write') { bytes = Uint8Array.from(atob(request.base64), c => c.charCodeAt(0)); revision++; return { ok: true, data: content() }; }
  if (request.action === 'publish') return { ok: true, data: { ref, file: content() } };
  return { ok: false, error: { code: 'INVALID_ACTION', message: 'Unsupported test action' } };
};
let nativeListener: ((event: any) => void) | null = null;
(window as any).__lifecycle = {
  app, calls, get content() { return content(); },
  get nativeCalls() { return calls.filter(call => call.area === 'native'); },
};
(window as any).electron = {
  windowsFiles: { invoke: invokeFiles, onChanged: () => () => undefined },
  localOffice: {
    invoke: async (request: any) => {
      calls.push({ area: 'native', request });
      return { ok: true, data: request.action === 'open' ? { session: 91 } : {} };
    },
    onEvent: (callback: (event: any) => void) => { nativeListener = callback; return () => { nativeListener = null; }; },
  },
};
(window as any).__notifyNative = (channel: string, args: unknown[]) => nativeListener?.({ session: 91, channel, args });
useStore.setState({ activeProject: { id: 'local-project', name: 'Локальный проект' } });

createRoot(document.getElementById('mount')!).render(
  <MemoryRouter initialEntries={[`/windows-file?root=${ref.rootId}&path=${encodeURIComponent(name)}&draft=${ref.draftId}&app=${app}`]}>
    <PaneContext.Provider value={`win:lifecycle-${app}`}><WindowsFileHost /></PaneContext.Provider>
  </MemoryRouter>,
);
