import React from 'react';
import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import WindowsFileHost from '../../src/screens/WindowsFileHost';
import { PaneContext } from '../../src/lib/paneTitle';
import { hasGuard, mayClose } from '../../src/lib/closeGuard';
import { useModalStore } from '../../src/store/modalStore';
import { useStore } from '../../src/store/store';
import { useTagNavigationStore } from '../../src/store/tagNavigationStore';
import { bytesToBase64 } from '../../src/lib/windowsFiles';
import type { WindowsFileContent, WindowsFileRef, WindowsFilesRequest, WindowsFilesResponse } from '../../filesystem/contracts';

const ref: WindowsFileRef = { rootId: 'mock-root', relativePath: 'Проект.docx' };
let bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x10, 0x20]);
let revision = 0;
const sha = () => `sha-${revision}`;
const content = (): WindowsFileContent => ({ fileId: 'mock-docx', name: 'Проект.docx', relativePath: ref.relativePath, storage: 'windows', kind: 'file', size: bytes.length, modifiedAt: new Date(0).toISOString(), linked: false, base64: bytesToBase64(bytes), sha256: sha() });
const calls: any[] = [];
const invoke = async (request: WindowsFilesRequest): Promise<WindowsFilesResponse<any>> => {
  calls.push(request);
  if (request.action === 'read') return { ok: true, data: content() };
  if (request.action === 'write') {
    if (disk.rejectWrites) return { ok: false, error: { code: 'CONFLICT', message: 'Test write rejected' } };
    if (request.baseSha256 !== sha()) return { ok: false, error: { code: 'CONFLICT', message: 'SHA mismatch' } };
    bytes = Uint8Array.from(atob(request.base64), (character) => character.charCodeAt(0)); revision++;
    return { ok: true, data: content() };
  }
  if (request.action === 'publish') return { ok: true, data: { ref: { rootId: ref.rootId, relativePath: request.name }, file: content() } };
  return { ok: false, error: { code: 'INVALID_ACTION', message: 'Unsupported test action' } };
};
const officeCalls: any[] = [];
const disk = { rejectWrites: false, get content() { return content(); }, get calls() { return calls; }, get officeCalls() { return officeCalls; } };
(window as any).__disk = disk;
(window as any).electron = {
  windowsFiles: { invoke, onChanged: () => () => undefined },
  localOffice: {
    invoke: async (request: any) => { officeCalls.push(request); return { ok: true, data: request.action === 'open' ? { session: 71 } : {} }; },
    onEvent: () => () => undefined,
  },
};
(useModalStore.getState() as any).openPrompt = async () => 'Проект (копия).docx';
(window as any).__fileRef = ref;
(window as any).__tagNavigation = () => useTagNavigationStore.getState().target;
useStore.setState({ activeProject: { id: 'local-project', name: 'Локальный проект' } });
(window as any).__hasCloseGuard = () => hasGuard('local-doc-test');
let closeChecks = 0;
window.addEventListener('message', (event) => {
  if (event.source === document.querySelector('iframe')?.contentWindow && event.data?.flux === 'office' && event.data?.op === 'closeCheck') closeChecks++;
});
(window as any).__tryCloseAfterIframeCheck = async () => {
  // The save guard is refreshed in a React effect after the iframe says hello.
  // Retry only while it returns before asking the iframe; resolve when the real
  // closeCheck reply proves the current callback performed the handshake.
  for (;;) {
    const before = closeChecks;
    const allowed = await mayClose('local-doc-test');
    if (closeChecks > before) return allowed;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
};

createRoot(document.getElementById('mount')!).render(<MemoryRouter initialEntries={['/windows-file?root=mock-root&path=Проект.docx']}><PaneContext.Provider value="win:local-doc-test"><WindowsFileHost /></PaneContext.Provider></MemoryRouter>);
