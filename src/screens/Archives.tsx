import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useStore } from '../store/store';
import { Btn, Empty, Input, SectionHead, Select } from '../components/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { formatSize } from '../components/explorer/FileItems';
import { Download, Folder, FolderOpen, Search, ShieldCheck } from 'lucide-react';
import { openHref } from '../lib/fileTypes';

type ArchiveEntry = { path: string; size: number; directory: boolean; encrypted?: boolean };
type ArchiveFile = { id: string; name: string; type?: string; folderId?: string | null; folderName?: string; size?: number };
type FolderNode = { id: string; name: string; parentId?: string | null; files?: ArchiveFile[] };
type ArchiveTab = 'open' | 'create';
type EditPreview = { baseSha256: string; previewSha256: string; outputName: string; encrypted: boolean; entries: ArchiveEntry[] };

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(body?.error || body?.message || `Ошибка сервера: ${response.status}`));
  return body as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить запрос';
}

export default function Archives() {
  const activeProject = useStore((s: any) => s.activeProject) as { id?: string; name?: string } | null;
  const projectId = activeProject?.id || 'default';
  const [params, setParams] = useSearchParams();
  const fileId = params.get('file') || '';
  const [tab, setTab] = useState<ArchiveTab>('open');
  const [capabilities, setCapabilities] = useState<any>(null);
  const [archiveTitle, setArchiveTitle] = useState('');
  const [createName, setCreateName] = useState('');
  const [format, setFormat] = useState<'zip' | '7z'>('zip');
  const [level, setLevel] = useState(5);
  const [openPassword, setOpenPassword] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [deleteEntries, setDeleteEntries] = useState<Set<string>>(new Set());
  const [renameEntries, setRenameEntries] = useState<Record<string, string>>({});
  const [editAddFiles, setEditAddFiles] = useState<Set<string>>(new Set());
  const [editPasswordOut, setEditPasswordOut] = useState('');
  const [editPreview, setEditPreview] = useState<EditPreview | null>(null);
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [checkedEntries, setCheckedEntries] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [files, setFiles] = useState<ArchiveFile[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState<{ sha256: string; totalSize: number; count: number; destinationName: string } | null>(null);
  const [destinationFolder, setDestinationFolder] = useState<{ folderId: string; name: string; files: ArchiveFile[] } | null>(null);
  const [createdArchive, setCreatedArchive] = useState<{ id: string; name: string } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);
  const navigate = useNavigate();
  const createIds = params.get('create') || '';
  const createFolderIds = params.get('folderIds') || '';

  useEffect(() => {
    const fileIds = createIds.split(',').map((id) => id.trim()).filter(Boolean);
    const folderIds = createFolderIds.split(',').map((id) => id.trim()).filter(Boolean);
    if (!fileIds.length && !folderIds.length) return;
    setSelectedFiles(new Set(fileIds));
    setSelectedFolders(new Set(folderIds));
    setTab('create');
  }, [createIds, createFolderIds]);

  useEffect(() => {
    let cancelled = false;
    jsonRequest<any>('/api/archives/capabilities').then((value) => { if (!cancelled) setCapabilities(value); })
      .catch((e) => { if (!cancelled) setError(errorText(e)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setFiles([]); setFolders([]);
    jsonRequest<any>(`/api/projects/${encodeURIComponent(projectId)}/folders`)
      .then((data) => {
        if (cancelled) return;
        const nextFolders: FolderNode[] = (data?.folders || []).map((f: any) => ({ id: String(f.id), name: String(f.name || 'Папка'), parentId: f.parentId || null }));
        const nextFiles: ArchiveFile[] = [];
        for (const folder of data?.folders || []) for (const f of folder.files || []) if (f?.id && !f.deletedAt) nextFiles.push({ id: String(f.id), name: String(f.name || 'Файл'), type: f.type, folderId: folder.id, folderName: folder.name, size: Number(f.size || 0) });
        for (const f of data?.rootFiles || []) if (f?.id && !f.deletedAt) nextFiles.push({ id: String(f.id), name: String(f.name || 'Файл'), type: f.type, folderId: null, folderName: '', size: Number(f.size || 0) });
        setFolders(nextFolders); setFiles(nextFiles);
      }).catch((e) => { if (!cancelled) setError(errorText(e)); });
    return () => { cancelled = true; };
  }, [projectId]);

  const loadArchive = useCallback(async (id: string, secret = '') => {
    if (!id) return;
    const seq = ++requestSeq.current;
    setBusy('Открываю архив…'); setError(''); setStatus(''); setEntries([]); setCheckedEntries(new Set()); setCurrentPath(''); setPreview(null); setDestinationFolder(null); setEditPreview(null); setEditMode(false); setDeleteEntries(new Set()); setRenameEntries({}); setEditAddFiles(new Set()); setEditPasswordOut('');
    try {
      const [result, metadata] = await Promise.all([
        jsonRequest<{ entries: ArchiveEntry[]; format?: string }>(`/api/archives/${encodeURIComponent(id)}/list`, post({ password: secret })),
        jsonRequest<{ id: string; name?: string }>(`/api/office/files/${encodeURIComponent(id)}/meta`).catch(() => null),
      ]);
      if (seq !== requestSeq.current) return;
      setEntries(Array.isArray(result.entries) ? result.entries : []);
      setCheckedEntries(new Set((result.entries || []).filter((entry) => !entry.directory).map((entry) => entry.path)));
      setArchiveTitle(String(metadata?.name || (result.format ? `${id} · ${result.format}` : id)));
      setStatus('Содержимое архива загружено');
    } catch (e) { if (seq === requestSeq.current) setError(errorText(e)); }
    finally { if (seq === requestSeq.current) setBusy(''); }
  }, []);

  useEffect(() => {
    setOpenPassword('');
    if (fileId) void loadArchive(fileId);
  }, [fileId, loadArchive]);

  const shownEntries = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('ru');
    if (q) return entries.filter((entry) => entry.path.toLocaleLowerCase('ru').includes(q));
    const prefix = currentPath ? `${currentPath.replace(/\/$/, '')}/` : '';
    return entries.filter((entry) => {
      const path = entry.path.replace(/\/$/, '');
      if (!path.startsWith(prefix)) return false;
      return !path.slice(prefix.length).includes('/');
    });
  }, [entries, query, currentPath]);
  const virtual = useVirtualizer({ count: shownEntries.length, getScrollElement: () => bodyRef.current, estimateSize: () => 32, overscan: 12 });
  const folderLabel = useCallback((id?: string | null) => {
    if (!id) return 'Корень';
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const parts: string[] = [];
    const seen = new Set<string>();
    let current = byId.get(id);
    while (current && !seen.has(current.id)) {
      seen.add(current.id); parts.unshift(current.name); current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return parts.join(' / ') || 'Папка';
  }, [folders]);

  const runArchiveAction = async (action: 'test' | 'extract-preview', label: string) => {
    if (!fileId || busy) return;
    const seq = ++requestSeq.current;
    setBusy(label); setError(''); setStatus('');
    try {
      if (action === 'test') {
        await jsonRequest(`/api/archives/${encodeURIComponent(fileId)}/test`, post({ password: openPassword }));
        if (seq !== requestSeq.current) return;
        setStatus('Архив проверен: ошибок не найдено');
      } else {
        const result = await jsonRequest<{ sha256: string; folderName: string; entries: ArchiveEntry[] }>(`/api/archives/${encodeURIComponent(fileId)}/extract-preview`, post({ paths: [...checkedEntries], password: openPassword }));
        if (seq !== requestSeq.current) return;
        const selectedFiles = (result.entries || []).filter((entry) => !entry.directory);
        setPreview({ sha256: result.sha256, totalSize: selectedFiles.reduce((sum, entry) => sum + Number(entry.size || 0), 0), count: selectedFiles.length, destinationName: result.folderName });
        setStatus(`Будет создана папка «${result.folderName}»`);
      }
    } catch (e) { if (seq === requestSeq.current) setError(errorText(e)); }
    finally { if (seq === requestSeq.current) setBusy(''); }
  };

  const archiveCanEdit = /\.(zip|7z)$/i.test(archiveTitle);
  const selectedEditEntries = entries.filter((entry) => checkedEntries.has(entry.path));
  const editPayload = () => ({
    passwordIn: openPassword,
    passwordOut: editPasswordOut,
    deletePaths: [...deleteEntries],
    rename: Object.fromEntries(Object.entries(renameEntries).filter(([from, to]) => to.trim() && to.trim() !== from)),
    addFileIds: [...editAddFiles],
  });
  const previewEdit = async () => {
    if (!fileId || busy) return;
    const seq = ++requestSeq.current;
    setBusy('Проверяю правки…'); setError(''); setStatus(''); setEditPreview(null);
    try {
      const result = await jsonRequest<EditPreview>(`/api/archives/${encodeURIComponent(fileId)}/edit-preview`, post(editPayload()));
      if (seq === requestSeq.current) { setEditPreview(result); setStatus(`Предпросмотр: ${result.outputName}, ${result.entries.length} элементов`); }
    } catch (e) { if (seq === requestSeq.current) setError(errorText(e)); }
    finally { if (seq === requestSeq.current) setBusy(''); }
  };
  const applyEdit = async () => {
    if (!fileId || !editPreview || busy) return;
    const seq = ++requestSeq.current;
    setBusy('Создаю копию…'); setError(''); setStatus('');
    try {
      const result = await jsonRequest<{ id: string; name: string }>(`/api/archives/${encodeURIComponent(fileId)}/edit-apply`, post({ ...editPayload(), baseSha256: editPreview.baseSha256, previewSha256: editPreview.previewSha256 }));
      if (seq === requestSeq.current) { setCreatedArchive(result); setStatus(`Создана копия «${result.name}»`); setEditPreview(null); setParams({ file: result.id }); }
    } catch (e) { if (seq === requestSeq.current) setError(errorText(e)); }
    finally { if (seq === requestSeq.current) setBusy(''); }
  };

  const applyExtraction = async () => {
    if (!fileId || !preview || !checkedEntries.size || busy) return;
    const seq = ++requestSeq.current;
    setBusy('Распаковываю…'); setError(''); setStatus('');
    try {
      const result = await jsonRequest<{ folderId: string; folderName: string; files: Array<{ id: string; name: string; size: number }> }>(`/api/archives/${encodeURIComponent(fileId)}/extract`, post({ paths: [...checkedEntries], password: openPassword, previewSha256: preview.sha256 }));
      if (seq !== requestSeq.current) return;
      setDestinationFolder({ folderId: String(result.folderId), name: String(result.folderName || preview.destinationName), files: result.files || [] });
      setPreview(null); setStatus('Файлы распакованы в новую папку');
    } catch (e) { if (seq === requestSeq.current) setError(errorText(e)); }
    finally { if (seq === requestSeq.current) setBusy(''); }
  };

  const createArchive = async () => {
    if ((!selectedFiles.size && !selectedFolders.size) || busy) return;
    const seq = ++requestSeq.current;
    setBusy('Создаю архив…'); setError(''); setStatus('');
    try {
      const result = await jsonRequest<{ id: string; name: string }>('/api/archives/create', post({ fileIds: [...selectedFiles], folderIds: [...selectedFolders], name: createName.trim() || `Архив.${format}`, format, level, password: createPassword || undefined, recurse: true }));
      if (seq !== requestSeq.current) return;
      setCreatedArchive(result); setParams({ file: result.id }); setTab('open'); setCreatePassword(''); setStatus(`Создан архив «${result.name}»`);
    } catch (e) { if (seq === requestSeq.current) setError(errorText(e)); }
    finally { if (seq === requestSeq.current) setBusy(''); }
  };

  const flipEntry = (path: string) => setCheckedEntries((prev) => { const next = new Set(prev); next.has(path) ? next.delete(path) : next.add(path); setPreview(null); return next; });
  const toggleSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) => setter((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const visibleFiles = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('ru');
    return files.filter((file) => !q || `${file.name} ${file.folderName || ''}`.toLocaleLowerCase('ru').includes(q));
  }, [files, query]);

  return (
    <main className="flex h-full min-h-0 flex-col bg-white text-slate-800 dark:bg-dark-bg dark:text-dark-text-main">
      <SectionHead title="Архивы" count={tab === 'open' ? `${entries.length} элементов` : `${selectedFiles.size + selectedFolders.size} выбрано`} actions={<div className="flex items-center gap-2"><Btn onClick={() => setTab('open')} aria-pressed={tab === 'open'}>Открыть архив</Btn><Btn onClick={() => setTab('create')} aria-pressed={tab === 'create'}>Создать архив</Btn></div>} />
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {tab === 'open' ? <>
          {!fileId ? <Empty title="Выберите архив в Проводнике" text="Откройте файл архива, чтобы посмотреть содержимое, проверить его или распаковать." /> : <>
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 py-2 dark:border-dark-border">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={archiveTitle}>{archiveTitle}</span>
              <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-dark-text-muted">Пароль <input type="password" value={openPassword} onChange={(e) => { requestSeq.current++; setBusy(''); setPreview(null); setOpenPassword(e.target.value); }} className="fx-input w-40" autoComplete="off" /></label>
              <Btn disabled={!!busy} onClick={() => void loadArchive(fileId, openPassword)}>Открыть</Btn>
              <Btn disabled={!!busy || !entries.length} onClick={() => void runArchiveAction('test', 'Проверяю…')}><ShieldCheck size={14} className="mr-1 inline" />Проверить</Btn>
              <Btn disabled={!!busy || !checkedEntries.size} onClick={() => void runArchiveAction('extract-preview', 'Сверяю распаковку…')}>Распаковать выбранное</Btn>
              <Btn disabled={!!busy || !archiveCanEdit} aria-pressed={editMode} onClick={() => { setEditMode((value) => !value); setEditPreview(null); }}>Изменить копию</Btn>
            </div>
            {!archiveCanEdit && <p className="mt-2 text-xs text-slate-500 dark:text-dark-text-muted">RAR можно просматривать и распаковывать. Правка доступна для ZIP и 7z.</p>}
            {editMode && archiveCanEdit && <section className="mt-3 border-b border-slate-200 pb-3 dark:border-dark-border" aria-label="Правка архива">
              <h2 className="mb-2 text-[13px] font-semibold">Изменения копии</h2>
              <p className="mb-2 text-xs text-slate-500 dark:text-dark-text-muted">Выберите записи ниже, чтобы удалить их. Для переименования укажите новое имя или путь.</p>
              <div className="max-h-40 overflow-auto">
                {selectedEditEntries.map((entry) => <div key={entry.path} className="grid min-h-8 grid-cols-[minmax(120px,1fr)_minmax(140px,280px)_auto] items-center gap-2 border-b border-slate-100 dark:border-dark-border">
                  <span className="truncate text-xs" title={entry.path}>{entry.path}</span>
                  <Input aria-label={`Новое имя для ${entry.path}`} value={renameEntries[entry.path] ?? entry.path} onChange={(e) => { setRenameEntries((prev) => ({ ...prev, [entry.path]: e.target.value })); setEditPreview(null); }} />
                  <label className="flex items-center gap-1 text-xs text-slate-600 dark:text-dark-text-muted"><input type="checkbox" checked={deleteEntries.has(entry.path)} onChange={() => setDeleteEntries((prev) => { const next = new Set(prev); next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path); return next; })} />Удалить</label>
                </div>)}
                {!selectedEditEntries.length && <p className="py-2 text-xs text-slate-500 dark:text-dark-text-muted">Отметьте записи в списке архива.</p>}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Select aria-label="Добавить файл Flux" value="" onChange={(id) => { if (id) setEditAddFiles((prev) => new Set([...prev, id])); setEditPreview(null); }} options={[{ value: '', label: 'Добавить файл Flux…' }, ...files.filter((file) => !editAddFiles.has(file.id)).map((file) => ({ value: file.id, label: `${file.name} · ${folderLabel(file.folderId)}` }))]} className="max-w-[360px]" />
                {[...editAddFiles].map((id) => <button key={id} type="button" className="text-xs text-slate-600 hover:underline dark:text-dark-text-muted" onClick={() => { setEditAddFiles((prev) => { const next = new Set(prev); next.delete(id); return next; }); setEditPreview(null); }}>{files.find((file) => file.id === id)?.name || id} ×</button>)}
                <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-dark-text-muted">Пароль копии <input type="password" autoComplete="new-password" value={editPasswordOut} onChange={(e) => { setEditPasswordOut(e.target.value); setEditPreview(null); }} className="fx-input w-36" placeholder="Без пароля" /></label>
                <Btn disabled={!!busy || (!deleteEntries.size && !Object.entries(renameEntries).some(([from, to]) => to.trim() && to.trim() !== from) && !editAddFiles.size)} onClick={() => void previewEdit()}>Предпросмотр</Btn>
              </div>
              {editPreview && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><span className="min-w-0 flex-1 text-slate-600 dark:text-dark-text-muted">Будет создана копия «{editPreview.outputName}», {editPreview.entries.length} элементов{editPreview.encrypted ? ', с паролем' : ', без пароля'}.</span><Btn disabled={!!busy} onClick={() => setEditPreview(null)}>Отмена</Btn><Btn tone="primary" disabled={!!busy} onClick={() => void applyEdit()}>Сохранить копию</Btn></div>}
            </section>}
            <div className="fx-tools mt-2">
              <label className="relative flex max-w-[360px] flex-1 items-center"><Search size={14} className="absolute left-2 text-slate-400" /><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти внутри архива" className="pl-7" /></label>
              <span className="ml-auto text-xs text-slate-500 dark:text-dark-text-muted">Выбрано: {checkedEntries.size}</span>
            </div>
            <nav aria-label="Путь в архиве" className="flex min-h-8 items-center gap-1 overflow-x-auto whitespace-nowrap border-b border-slate-200 text-xs dark:border-dark-border">
              <button type="button" className="text-slate-600 hover:text-slate-900 dark:text-dark-text-muted dark:hover:text-white" onClick={() => setCurrentPath('')}>Архив</button>
              {currentPath.split('/').filter(Boolean).map((part, index, all) => {
                const path = all.slice(0, index + 1).join('/');
                return <React.Fragment key={path}><span className="text-slate-400">/</span><button type="button" className="text-slate-600 hover:text-slate-900 dark:text-dark-text-muted dark:hover:text-white" onClick={() => setCurrentPath(path)}>{part}</button></React.Fragment>;
              })}
            </nav>
            <div className="mt-2 min-w-[560px] overflow-hidden border-y border-slate-200 dark:border-dark-border">
              <div className="grid h-7 grid-cols-[32px_minmax(260px,1fr)_120px_100px] items-center bg-slate-50 px-2 text-xs font-medium text-slate-500 dark:bg-dark-surface dark:text-dark-text-muted"><span /><span>Имя</span><span>Размер</span><span>Тип</span></div>
              <div ref={bodyRef} className="h-[min(58vh,620px)] overflow-auto" role="grid" aria-label="Содержимое архива">
                <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
                  {virtual.getVirtualItems().map((row) => { const entry = shownEntries[row.index]; return <div key={`${entry.path}-${row.index}`} role="row" className="grid h-8 grid-cols-[32px_minmax(260px,1fr)_120px_100px] items-center border-b border-slate-100 px-2 text-[13px] hover:bg-slate-50 dark:border-dark-border dark:hover:bg-dark-panel" style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start}px)` }}>
                    <input type="checkbox" aria-label={`Выбрать ${entry.path}`} checked={checkedEntries.has(entry.path)} onChange={() => flipEntry(entry.path)} />
                    <span className="flex min-w-0 items-center gap-2" title={entry.path}>{entry.directory ? <Folder size={15} className="shrink-0 text-slate-400" /> : <span className="w-[15px] shrink-0" />}{entry.directory ? <button type="button" className="truncate text-left hover:underline" onClick={() => { if (!query.trim()) setCurrentPath(entry.path.replace(/\/$/, '')); else setQuery(''); }}>{entry.path.split('/').filter(Boolean).at(-1)}</button> : <span className="truncate">{entry.path.split('/').filter(Boolean).at(-1)}</span>}{entry.encrypted && <span className="text-xs text-amber-700 dark:text-amber-300">Зашифрован</span>}</span>
                    <span className="tabular-nums text-slate-500 dark:text-dark-text-muted">{entry.directory ? '—' : formatSize(entry.size)}</span><span className="text-slate-500 dark:text-dark-text-muted">{entry.directory ? 'Папка' : 'Файл'}</span>
                  </div>; })}
                </div>
                {!shownEntries.length && <Empty title="В архиве нет элементов" text="Измените поиск или откройте другой архив." />}
              </div>
            </div>
            {preview && <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-200 pt-3 dark:border-dark-border"><span className="flex-1 text-xs text-slate-600 dark:text-dark-text-muted">Проверка завершена: {preview.count} файлов, {formatSize(preview.totalSize)}. Будет создана новая папка «{preview.destinationName}».</span><Btn disabled={!!busy} onClick={() => setPreview(null)}>Отмена</Btn><Btn tone="primary" disabled={!!busy} onClick={() => void applyExtraction()}>Распаковать</Btn></div>}
            {destinationFolder && <div className="mt-3 flex flex-wrap items-center gap-2 text-xs"><FolderOpen size={16} /><span>Создана папка «{destinationFolder.name}», файлов: {destinationFolder.files.length}</span><button type="button" className="text-emerald-700 hover:underline dark:text-emerald-300" onClick={() => navigate(`/explorer?folder=${encodeURIComponent(destinationFolder.folderId)}`)}>Открыть папку</button>{destinationFolder.files.length === 1 && /\.(docx|xlsx|xlsm|xls|csv|pdf|md|markdown)$/i.test(destinationFolder.files[0].name) && <button type="button" className="text-emerald-700 hover:underline dark:text-emerald-300" onClick={() => navigate(openHref({ id: destinationFolder.files[0].id, name: destinationFolder.files[0].name, folderId: destinationFolder.folderId }))}>Открыть файл</button>}</div>}
          </>}
        </> : <>
          <div className="grid grid-cols-[minmax(260px,1fr)_minmax(260px,360px)] gap-6 max-[800px]:grid-cols-1">
            <section className="min-w-0">
              <div className="flex min-h-10 flex-wrap items-center gap-2 border-b border-slate-200 py-2 dark:border-dark-border"><label className="relative flex max-w-[360px] flex-1 items-center"><Search size={14} className="absolute left-2 text-slate-400" /><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти файл или папку" className="pl-7" /></label><span className="text-xs text-slate-500 dark:text-dark-text-muted">{activeProject?.name || 'Файлы проекта'}</span></div>
              <div className="max-h-[min(58vh,620px)] min-h-48 overflow-auto border-b border-slate-200 dark:border-dark-border">
                {folders.map((folder) => <label key={`folder:${folder.id}`} className="flex min-h-8 items-center gap-2 border-b border-slate-100 px-2 text-[13px] hover:bg-slate-50 dark:border-dark-border dark:hover:bg-dark-panel"><input type="checkbox" checked={selectedFolders.has(folder.id)} onChange={() => toggleSet(setSelectedFolders, folder.id)} /><Folder size={15} className="text-slate-400" /><span className="truncate" title={folderLabel(folder.id)}>{folderLabel(folder.id)}</span><span className="ml-auto text-xs text-slate-500">Папка</span></label>)}
                {visibleFiles.map((file) => <label key={file.id} className="flex min-h-8 items-center gap-2 border-b border-slate-100 px-2 text-[13px] hover:bg-slate-50 dark:border-dark-border dark:hover:bg-dark-panel"><input type="checkbox" checked={selectedFiles.has(file.id)} onChange={() => toggleSet(setSelectedFiles, file.id)} /><span className="w-[15px]" /><span className="min-w-0 flex-1 truncate" title={`${folderLabel(file.folderId)} / ${file.name}`}>{file.name}</span><span className="max-w-44 truncate text-xs text-slate-500 dark:text-dark-text-muted">{folderLabel(file.folderId)}</span></label>)}
                {!folders.length && !visibleFiles.length && <Empty title="В проекте нет файлов" text="Загрузите файл в Проводнике или выберите другой проект." />}
              </div>
            </section>
            <section className="min-w-0">
              <h2 className="mb-3 border-b border-slate-200 pb-2 text-[13px] font-semibold dark:border-dark-border">Параметры архива</h2>
              <label className="mb-3 block"><span className="fx-label">Имя архива</span><Input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="Архив материалов" className="mt-1 w-full" /></label>
              <label className="mb-3 block"><span className="fx-label">Формат</span><Select value={format} onChange={(v) => setFormat(v as 'zip' | '7z')} className="mt-1 w-full" options={[{ value: 'zip', label: 'ZIP', disabled: !!capabilities && !capabilities.formats?.create?.includes('zip') }, { value: '7z', label: '7z', disabled: !!capabilities && !capabilities.formats?.create?.includes('7z') }]} /></label>
              <label className="mb-3 block"><span className="fx-label">Сжатие</span><Select value={String(level)} onChange={(v) => setLevel(Number(v))} className="mt-1 w-full" options={Array.from({ length: 10 }, (_, n) => ({ value: String(n), label: n === 0 ? 'Без сжатия' : String(n) }))} /></label>
              <label className="mb-3 block"><span className="fx-label">Пароль</span><input type="password" autoComplete="new-password" value={createPassword} onChange={(e) => setCreatePassword(e.target.value)} placeholder="Необязательно" className="fx-input mt-1 w-full" /></label>
              <p className="mb-2 text-xs text-slate-500 dark:text-dark-text-muted">Создание: ZIP и 7z. Чтение и распаковка: ZIP, 7z и RAR.</p>
              <p className="mb-4 text-xs text-slate-500 dark:text-dark-text-muted">Распаковка всегда создаёт новую папку. Существующие файлы не перезаписываются.</p>
              <Btn tone="primary" disabled={!!busy || !capabilities?.available || !capabilities?.formats?.create?.includes(format) || (!selectedFiles.size && !selectedFolders.size)} onClick={() => void createArchive()}><Download size={14} className="mr-1 inline" />Создать архив</Btn>
              {createdArchive && <p className="mt-3 text-xs text-slate-600 dark:text-dark-text-muted">Создан файл «{createdArchive.name}». Откройте его во вкладке «Открыть архив».</p>}
            </section>
          </div>
        </>}
        {(busy || error || status) && <div aria-live="polite" className={`mt-3 text-xs ${error ? 'text-rose-700 dark:text-rose-300' : 'text-slate-600 dark:text-dark-text-muted'}`}>{busy || error || status}</div>}
        {capabilities?.available === false && <p className="mt-3 text-xs text-rose-700 dark:text-rose-300">Архивный модуль недоступен на сервере.</p>}
      </div>
    </main>
  );
}
