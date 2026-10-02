import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import WindowsFileHost from '../../src/screens/WindowsFileHost';
import { PaneContext } from '../../src/lib/paneTitle';
import { mayClose } from '../../src/lib/closeGuard';
import { useModalStore } from '../../src/store/modalStore';
import { bytesToBase64, base64ToBytes } from '../../src/lib/windowsFiles';
import type { WindowsFilesRequest, WindowsFileContent } from '../../filesystem/contracts';
import '../../src/index.css';

const files = new Map<string, { bytes: Uint8Array; revision: number }>([
  ['A.txt', { bytes: new TextEncoder().encode('first'), revision: 0 }],
  ['B.txt', { bytes: new TextEncoder().encode('second'), revision: 0 }],
  ['UTF.txt', { bytes: new TextEncoder().encode('\ufeffстрока\r\nвторая\r\n'), revision: 0 }],
]);
const calls: WindowsFilesRequest[] = [];
const reads: { path: string; resolve: (value: any) => void; data: WindowsFileContent }[] = [];
const writes: (() => void)[] = [];
const control = {
  holdReads: false, holdWrites: false, failWrites: false, calls, reads, writes,
  bytes: (path: string) => bytesToBase64(files.get(path)!.bytes),
  text: (path: string) => new TextDecoder().decode(files.get(path)!.bytes),
  releaseRead(path: string) { const i = reads.findIndex(item => item.path === path); if (i < 0) throw new Error('No held read'); const r = reads.splice(i, 1)[0]; r.resolve({ ok: true, data: r.data }); },
  releaseWrite() { const next = writes.shift(); if (!next) throw new Error('No held write'); next(); },
  close: () => mayClose('file-interaction'),
};
function content(path: string): WindowsFileContent {
  const f = files.get(path)!;
  return { fileId: path, name: path, relativePath: path, storage: 'windows', kind: 'file', size: f.bytes.length, modifiedAt: new Date(0).toISOString(), linked: false, base64: bytesToBase64(f.bytes), sha256: `sha-${f.revision}` };
}
(window as any).__localFiles = control;
(window as any).electron = { windowsFiles: {
  onChanged: () => () => {},
  invoke: async (request: WindowsFilesRequest) => {
    calls.push(request);
    if (request.action === 'read') {
      const data = content(request.ref.relativePath);
      return control.holdReads ? new Promise(resolve => reads.push({ path: request.ref.relativePath, resolve, data })) : { ok: true, data };
    }
    if (request.action === 'write') {
      if (control.holdWrites) await new Promise<void>(resolve => writes.push(resolve));
      const f = files.get(request.ref.relativePath)!;
      if (control.failWrites || request.baseSha256 !== `sha-${f.revision}`) return { ok: false, error: { code: 'CONFLICT', message: 'External change' } };
      f.bytes = base64ToBytes(request.base64); f.revision++;
      return { ok: true, data: content(request.ref.relativePath) };
    }
    if (request.action === 'publish') {
      files.set(request.name, { bytes: base64ToBytes(request.base64), revision: 0 });
      return { ok: true, data: { ref: { rootId: 'test-root', relativePath: request.name }, file: content(request.name) } };
    }
    return { ok: true, data: {} };
  },
} };
(useModalStore.getState() as any).openPrompt = async () => 'Copy.txt';
function Fixture() {
  const navigate = useNavigate();
  useEffect(() => { (window as any).__navigateFile = (name: string) => navigate(`/windows-file?root=test-root&path=${encodeURIComponent(name)}`); }, [navigate]);
  return <PaneContext.Provider value="win:file-interaction"><WindowsFileHost /></PaneContext.Provider>;
}
createRoot(document.getElementById('mount')!).render(<MemoryRouter initialEntries={['/windows-file?root=test-root&path=A.txt']}><Fixture /></MemoryRouter>);
