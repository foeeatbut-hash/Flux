import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import Explorer from '../../src/screens/Explorer';
import WindowsDesktop from '../../src/components/desktop/WindowsDesktop';
import '../../src/index.css';
import { useStore } from '../../src/store/store';
import { useDisplayStore } from '../../src/store/displayStore';
import { useDesktopStore } from '../../src/store/desktopStore';
import type { WindowsFileEntry, WindowsFileMetadata, WindowsFileRef, WindowsFilesRequest, WindowsFilesResponse, WindowsRoot, WindowsVolume } from '../../filesystem/contracts';

const root: WindowsRoot = { id: 'desktop-id', name: 'Рабочий стол', kind: 'desktop', available: true };
const entries: WindowsFileEntry[] = [
  { name: 'Проекты', relativePath: 'Проекты', storage: 'windows', kind: 'directory', fileId: 'folder-1', size: 0, modifiedAt: '2026-09-20T09:00:00.000Z', linked: false },
  { name: 'Инструкция.docx', relativePath: 'Инструкция.docx', storage: 'windows', kind: 'file', fileId: 'file-1', size: 1200, modifiedAt: '2026-09-21T09:00:00.000Z', linked: false },
  { name: 'Архив.bin', relativePath: 'Архив.bin', storage: 'windows', kind: 'file', fileId: 'file-2', size: 28, modifiedAt: '2026-09-19T09:00:00.000Z', linked: false },
];
const nested: WindowsFileEntry[] = [
  { name: 'Отчёт.xlsx', relativePath: 'Проекты/Отчёт.xlsx', storage: 'windows', kind: 'file', fileId: 'file-3', size: 2048, modifiedAt: '2026-09-22T09:00:00.000Z', linked: false },
  { name: 'Архив', relativePath: 'Проекты/Архив', storage: 'windows', kind: 'directory', fileId: 'folder-2', size: 0, modifiedAt: '2026-09-18T09:00:00.000Z', linked: false },
];
const diskRoot: WindowsRoot = { id: 'disk-c', name: 'Локальный диск (C:)', kind: 'custom', available: true };
const volumes: WindowsVolume[] = [{ id: 'volume-c', name: 'Локальный диск (C:)', kind: 'fixed', size: 256 * 1024 ** 3, free: 128 * 1024 ** 3, root: diskRoot }];
const metadata: WindowsFileMetadata = { fileId: 'file-3', tags: ['AHU-01'], projectIds: ['project-1'], revision: 'A', responsible: 'Иванов', history: [{ at: '2026-09-22T09:00:00.000Z', action: 'save', relativePath: 'Проекты/Отчёт.xlsx' }] };
const calls: WindowsFilesRequest[] = [];
const drafts: WindowsFileEntry[] = [];
const draftChildren = new Map<string, WindowsFileEntry[]>();
let delayedMetadataPath = '';
let failedMetadataPath = '';
let delayedListPath = '';

function childPath(ref: WindowsFileRef) {
  if (ref.draftId) return draftChildren.get(ref.draftId) || [];
  if (ref.rootId === 'disk-c') return ref.relativePath === '' ? [{ name: 'Fluxdraftfolders', relativePath: 'Fluxdraftfolders', storage: 'windows', kind: 'directory', fileId: 'disk-folder', size: 0, modifiedAt: '2026-10-01T10:00:00.000Z', linked: false }] : [];
  return ref.relativePath === '' ? entries : ref.relativePath === 'Проекты' ? nested : [];
}
async function invoke(request: WindowsFilesRequest): Promise<WindowsFilesResponse<any>> {
  calls.push(request);
  if (request.action === 'list' && request.ref.relativePath === delayedListPath) await new Promise((resolve) => setTimeout(resolve, 350));
  if (request.action === 'metadata' && request.ref.relativePath === delayedMetadataPath) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (request.ref.relativePath === failedMetadataPath) return { ok: false, error: { code: 'READ_FAILED', message: 'Тестовая ошибка устаревшего запроса.' } };
  }
  switch (request.action) {
    case 'roots': return { ok: true, data: [root, { id: 'documents-id', name: 'Документы', kind: 'documents', available: true }, { id: 'downloads-id', name: 'Загрузки', kind: 'downloads', available: true }] };
    case 'volumes': return { ok: true, data: volumes };
    case 'list': return { ok: true, data: { root, entries: [...childPath(request.ref), ...(!request.ref.draftId ? drafts.filter((item) => item.relativePath.startsWith(request.ref.relativePath ? `${request.ref.relativePath}/` : '') && item.relativePath.split('/').length === request.ref.relativePath.split('/').filter(Boolean).length + 1) : [])], nextOffset: null, truncated: false } };
    case 'metadata': return { ok: true, data: { ...metadata, revision: request.ref.relativePath } };
    case 'read': return { ok: true, data: { name: request.ref.relativePath, base64: 'eA==', sha256: 'a'.repeat(64) } };
    case 'createDraft': {
      const ref = { rootId: request.parent.rootId, relativePath: request.parent.relativePath ? `${request.parent.relativePath}/${request.name}` : request.name, draftId: 'draft-1' };
      const file = { name: request.name, relativePath: ref.relativePath, storage: 'flux' as const, draftId: ref.draftId, kind: 'file' as const, fileId: 'draft-file-1', size: 18, modifiedAt: '2026-10-01T10:00:00.000Z', linked: false };
      drafts.push(file); if (request.parent.draftId) draftChildren.set(request.parent.draftId, [...(draftChildren.get(request.parent.draftId) || []), file]);
      return { ok: true, data: { ref, file } };
    }
    case 'createDraftFolder': {
      const ref = { rootId: request.parent.rootId, relativePath: request.parent.relativePath ? `${request.parent.relativePath}/${request.name}` : request.name, draftId: `draft-folder-${drafts.length + 1}` };
      (window as any).__draftFolderIds.push(ref.draftId);
      const file: WindowsFileEntry = { name: request.name, relativePath: ref.relativePath, storage: 'flux', draftId: ref.draftId, kind: 'directory', fileId: `draft-folder-file-${drafts.length + 1}`, size: 0, modifiedAt: '2026-10-01T10:00:00.000Z', linked: false };
      drafts.push(file); draftChildren.set(ref.draftId, []);
      return { ok: true, data: { ref, file } };
    }
    case 'publishDraft': drafts.forEach((item) => { item.storage = 'windows'; delete item.draftId; }); return { ok: true, data: { published: true } };
    case 'publishDraftTree': return { ok: true, data: { published: draftChildren.get(request.ref.draftId || '')?.length || 0, failed: [], complete: true } };
    case 'mkdir': return { ok: true, data: {} };
    case 'rename': return { ok: true, data: {} };
    case 'copy': case 'move': case 'trash': case 'open': case 'reveal': case 'watch': case 'unwatch': case 'setMetadata': return { ok: true, data: {} };
    case 'addRoot': return { ok: true, data: { ...root, id: 'custom-id', kind: 'custom' } };
    default: return { ok: false, error: { code: 'INVALID_ACTION', message: 'Команда не поддержана стендом.' } };
  }
}
(window as any).__windowsFilesCalls = calls;
(window as any).__draftFolderIds = [];
(window as any).__delayMetadataPath = (path: string) => { delayedMetadataPath = path; };
(window as any).__failMetadataPath = (path: string) => { failedMetadataPath = path; };
(window as any).__delayListPath = (path: string) => { delayedListPath = path; };
(window as any).__nativeAppOpenCalls = [];
(window as any).electron = {
  windowsFiles: { invoke, getIcon: async () => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#2563eb'; context.fillRect(6, 3, 20, 26);
    context.fillStyle = '#fff'; context.fillRect(10, 10, 12, 2); context.fillRect(10, 16, 12, 2);
    return canvas.toDataURL('image/png');
  }, onChanged: () => () => undefined },
  desktopShell: {
    snapshot: async () => ({ status: 'ready', revision: 'fixture', items: [
      { id: 'shell-folder', name: 'Системная папка', kind: 'directory', position: { x: -1200, y: -100 }, icon: null, monitorId: 2 },
      { id: 'shell-file', name: 'План.xlsx', kind: 'file', position: { x: -1104, y: -100 }, icon: null, monitorId: 2, fileRef: { rootId: 'desktop-id', relativePath: 'План.xlsx' } },
    ], view: { physicalBounds: { x: -1920, y: -300, width: 4800, height: 1920 }, iconSize: 32, spacing: { x: 96, y: 104 }, iconsVisible: true } }),
    open: async () => ({ ok: true }), onChanged: () => () => undefined,
  },
  nativeApps: { open: async (href: string) => { (window as any).__nativeAppOpenCalls.push(href); return 'native-window-1'; }, list: async () => [], action: async () => true, onChanged: () => () => undefined },
};
useDisplayStore.setState({ workspace: { enabled: true, displays: [
  { id: 2, label: 'Слева', primary: false, scaleFactor: 1.5, bounds: { x: -1280, y: -200, w: 1280, h: 1024 }, workArea: { x: -1280, y: -200, w: 1280, h: 984 } },
  { id: 1, label: 'Основной', primary: true, scaleFactor: 1, bounds: { x: 0, y: 0, w: 1920, h: 1080 }, workArea: { x: 0, y: 0, w: 1920, h: 1040 } },
], bounds: { x: -1280, y: -200, w: 3200, h: 1280 }, primaryId: 1, mixedScale: true }, available: true });
useDesktopStore.getState().pinApp('/registry');
(window as any).fetch = async (url: string) => {
  const path = String(url);
  const body = path.includes('/file-sharing/received') ? { files: [] }
    : path.includes('/tags') ? { tags: [{ id: 'tag-1', identifier: 'AHU-01' }, { id: 'tag-2', identifier: 'P-01' }] }
      : { projects: [{ id: 'project-1', name: 'Проект 1' }, { id: 'project-2', name: 'Проект 2' }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
useStore.getState().setActiveProject({ id: 'project-1', name: 'Проект 1' });

function LocationDebug() { const location = useLocation(); const navigate = useNavigate(); (window as any).__go = navigate; return <output data-testid="route">{location.pathname}{location.search}</output>; }
function Fixture() {
  const [desktop, setDesktop] = useState(false);
  (window as any).__showWindowsDesktop = () => setDesktop(true);
  return <div style={{ position: 'absolute', inset: 0, width: '100vw', height: '100vh' }}>
    {desktop ? <WindowsDesktop screenOrigin={{ x: -1280, y: -200 }} /> : <div className="h-full"><LocationDebug /><Explorer /></div>}
  </div>;
}
createRoot(document.getElementById('mount')!).render(<MemoryRouter initialEntries={['/explorer?root=desktop-id&path=']}><Fixture /></MemoryRouter>);
