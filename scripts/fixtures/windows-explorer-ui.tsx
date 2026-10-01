import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import WindowsExplorer from '../../src/components/explorer/WindowsExplorer';
import { useStore } from '../../src/store/store';
import type { WindowsFileEntry, WindowsFileMetadata, WindowsFileRef, WindowsFilesRequest, WindowsFilesResponse, WindowsRoot } from '../../filesystem/contracts';

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
const metadata: WindowsFileMetadata = { fileId: 'file-3', tags: ['AHU-01'], projectIds: ['project-1'], revision: 'A', responsible: 'Иванов', history: [{ at: '2026-09-22T09:00:00.000Z', action: 'save', relativePath: 'Проекты/Отчёт.xlsx' }] };
const calls: WindowsFilesRequest[] = [];
const drafts: WindowsFileEntry[] = [];

function childPath(ref: WindowsFileRef) { return ref.relativePath === '' ? entries : ref.relativePath === 'Проекты' ? nested : []; }
async function invoke(request: WindowsFilesRequest): Promise<WindowsFilesResponse<any>> {
  calls.push(request);
  switch (request.action) {
    case 'roots': return { ok: true, data: [root, { id: 'documents-id', name: 'Документы', kind: 'documents', available: true }, { id: 'downloads-id', name: 'Загрузки', kind: 'downloads', available: true }] };
    case 'list': return { ok: true, data: { root, entries: [...childPath(request.ref), ...drafts.filter((item) => item.relativePath.startsWith(request.ref.relativePath ? `${request.ref.relativePath}/` : '') && item.relativePath.split('/').length === request.ref.relativePath.split('/').filter(Boolean).length + 1)], nextOffset: null, truncated: false } };
    case 'metadata': return { ok: true, data: { ...metadata } };
    case 'read': return { ok: true, data: { name: request.ref.relativePath, base64: 'eA==', sha256: 'a'.repeat(64) } };
    case 'createDraft': {
      const ref = { rootId: request.parent.rootId, relativePath: request.parent.relativePath ? `${request.parent.relativePath}/${request.name}` : request.name, draftId: 'draft-1' };
      const file = { name: request.name, relativePath: ref.relativePath, storage: 'flux' as const, draftId: ref.draftId, kind: 'file' as const, fileId: 'draft-file-1', size: 18, modifiedAt: '2026-10-01T10:00:00.000Z', linked: false };
      drafts.push(file); return { ok: true, data: { ref, file } };
    }
    case 'publishDraft': drafts.forEach((item) => { item.storage = 'windows'; delete item.draftId; }); return { ok: true, data: { published: true } };
    case 'mkdir': return { ok: true, data: {} };
    case 'rename': return { ok: true, data: {} };
    case 'copy': case 'move': case 'trash': case 'open': case 'reveal': case 'watch': case 'unwatch': case 'setMetadata': return { ok: true, data: {} };
    case 'addRoot': return { ok: true, data: { ...root, id: 'custom-id', kind: 'custom' } };
    default: return { ok: false, error: { code: 'INVALID_ACTION', message: 'Команда не поддержана стендом.' } };
  }
}
(window as any).__windowsFilesCalls = calls;
(window as any).electron = { windowsFiles: { invoke, onChanged: () => () => undefined } };
(window as any).fetch = async (url: string) => {
  const path = String(url);
  const body = path.includes('/tags') ? { tags: [{ id: 'tag-1', identifier: 'AHU-01' }, { id: 'tag-2', identifier: 'P-01' }] } : { projects: [{ id: 'project-1', name: 'Проект 1' }, { id: 'project-2', name: 'Проект 2' }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
useStore.getState().setActiveProject({ id: 'project-1', name: 'Проект 1' });

function LocationDebug() { const location = useLocation(); const navigate = useNavigate(); (window as any).__go = navigate; return <output data-testid="route">{location.pathname}{location.search}</output>; }
createRoot(document.getElementById('mount')!).render(<MemoryRouter initialEntries={['/windows-files?root=desktop-id&path=']}><div className="h-full"><LocationDebug /><WindowsExplorer /></div></MemoryRouter>);
