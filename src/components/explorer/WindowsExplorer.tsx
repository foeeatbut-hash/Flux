import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Clipboard, Copy, ExternalLink, FilePlus2, Folder, FolderPlus, HardDrive, List, MoreHorizontal, RefreshCw, Search, Trash2, Grid2X2, Home, Scissors, Upload } from 'lucide-react';
import { blankBytes, BLANK_NAME, type BlankKind } from '../../lib/blankFiles';
import { zip } from '../../../feedback/zip';
import { dataService, type Project } from '../../services/dataService';
import { useStore } from '../../store/store';
import { useToastStore } from '../../store/toastStore';
import { bytesToBase64, fileRefHref, folderRefHref, onWindowsFilesChanged, windowsFilesRequest, type WindowsFileEntry, type WindowsFileMetadata, type WindowsFileRef, type WindowsFilesChanged, type WindowsRoot, type WindowsVolume } from '../../lib/windowsFiles';
import { Btn, Chip, Dialog, Empty, Field, IconBtn, Input, Select } from '../ui';
import { NativeWindowsFileIcon } from './WindowsFileIcon';
import ContextMenu from '../ContextMenu';
import FileShareDialog from './FileShareDialog';
import { sourceBindings, sharedSourceHref } from '../../services/fileSharingService';
import { FileIcon } from '../icons/FluxIcons';

type Listing = { root?: WindowsRoot; entries: WindowsFileEntry[]; nextOffset: number | null; truncated: boolean };
type RenameTarget = { ref: WindowsFileRef; name: string } | null;
type ClipboardItem = { ref: WindowsFileRef; name: string; kind: WindowsFileEntry['kind']; cut: boolean; sha256?: string } | null;
type ProjectTag = { id: string; identifier: string; name?: string };
type Layout = 'list' | 'tiles';
type DraftKind = BlankKind | 'folder' | 'text' | 'archive';
const DRAFT_NAME: Record<DraftKind, string> = { ...BLANK_NAME, folder: 'Новая папка', text: 'Новый текст.txt', archive: 'Новый архив.zip' };
const LIMIT = 200;
const ROOT_LABEL: Record<WindowsRoot['kind'], string> = { desktop: 'Рабочий стол', documents: 'Документы', downloads: 'Загрузки', custom: 'Подключённые папки' };
const entryRef = (entry: WindowsFileEntry, rootId: string): WindowsFileRef => ({ rootId, relativePath: entry.relativePath, ...(entry.draftId ? { draftId: entry.draftId } : {}) });
const parentPath = (path: string) => path.split('/').slice(0, -1).join('/');
const fileSize = (size: number) => size < 1024 ? `${size} Б` : size < 1024 * 1024 ? `${(size / 1024).toFixed(0)} КБ` : `${(size / 1024 / 1024).toFixed(1)} МБ`;
const dateLabel = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' }); };
const nameWithoutExtension = (name: string) => name.replace(/\.[^.]+$/u, '');

async function requestData<T>(request: Parameters<typeof windowsFilesRequest>[0]): Promise<T> {
  const response = await windowsFilesRequest<T>(request as any);
  if ('error' in response) throw new Error(response.error.message);
  return response.data;
}

export default function WindowsExplorer() {
  const navigate = useNavigate();
  const user = useStore((state) => state.user);
  const [shareEntry, setShareEntry] = useState<WindowsFileEntry | null>(null);
  const [sharingGeneration, setSharingGeneration] = useState(0);
  const sharedSources = user?.id ? sourceBindings(user.id).filter(source => source.audience !== 'NONE') : [];
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeProject = useStore((state) => state.activeProject);
  const addToast = useToastStore((state) => state.addToast);
  const [roots, setRoots] = useState<WindowsRoot[]>([]);
  const [volumes, setVolumes] = useState<WindowsVolume[]>([]);
  const [rootId, setRootId] = useState(searchParams.get('root') || '');
  const [path, setPath] = useState(searchParams.get('path') || '');
  const [listing, setListing] = useState<Listing | null>(null);
  const [offset, setOffset] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [portable, setPortable] = useState(false);
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<Layout>('list');
  const [selected, setSelected] = useState<WindowsFileEntry | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: WindowsFileEntry } | null>(null);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [metadata, setMetadata] = useState<WindowsFileMetadata | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tags, setTags] = useState<ProjectTag[]>([]);
  const [tagQuery, setTagQuery] = useState('');
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [draftProjects, setDraftProjects] = useState<string[]>([]);
  const [revision, setRevision] = useState('');
  const [responsible, setResponsible] = useState('');
  const [rename, setRename] = useState<RenameTarget>(null);
  const [clipboard, setClipboard] = useState<ClipboardItem>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<DraftKind>('doc');
  const [freeMenu, setFreeMenu] = useState<{ x: number; y: number } | null>(null);
  const [history, setHistory] = useState<WindowsFileRef[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  // Быстрый второй переход может прийти до React-отрисовки первого.
  // Индекс и список обновляются вместе, чтобы не обрезать историю старым индексом.
  const navigationHistory = useRef<{ entries: WindowsFileRef[]; index: number }>({ entries: [], index: -1 });
  const pendingFolder = useRef<WindowsFileRef | null>(null);
  const rememberHistory = (entries: WindowsFileRef[], index: number) => {
    navigationHistory.current = { entries, index };
    setHistory(entries); setHistoryIndex(index);
  };
  const listRequest = useRef(0);
  const metadataRequest = useRef(0);
  const projectFiles = searchParams.get('projectFiles') === '1';
  const computerView = searchParams.get('computer') === '1';
  const folderRef = useMemo(() => rootId ? { rootId, relativePath: path, ...(searchParams.get('draft') ? { draftId: searchParams.get('draft')! } : {}) } : null, [rootId, path, searchParams]);
  const root = roots.find((item) => item.id === rootId);
  useEffect(() => { if (root?.network) setShareEntry(null); }, [root?.network]);
  const crumbs = path ? path.split('/').filter(Boolean) : [];
  const visibleEntries = useMemo(() => (listing?.entries || []).filter((entry) => entry.name.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))), [listing, query]);

  const syncLocation = useCallback((nextRoot: string, nextPath: string, replace = false) => {
    pendingFolder.current = { rootId: nextRoot, relativePath: nextPath };
    metadataRequest.current++;
    setRootId(nextRoot); setPath(nextPath); setOffset(null); setListing(null); setSelected(null); setQuery('');
    setPropertiesOpen(false); setMetadata(null); setBusy(false);
    const params = new URLSearchParams(); params.set('root', nextRoot); params.set('path', nextPath);
    setSearchParams(params, { replace });
  }, [setSearchParams]);

  const loadRoots = useCallback(async () => {
    try {
      const data = await requestData<WindowsRoot[]>({ action: 'roots' });
      const disks = await requestData<WindowsVolume[]>({ action: 'volumes' }).catch(() => []);
      setVolumes(disks); setRoots([...new Map([...data, ...disks.map(volume => volume.root)].map(item => [item.id, item])).values()]); setPortable(false); setError('');
      const wanted = searchParams.get('root');
      const preferred = data.find((item) => item.id === wanted && item.available) || data.find((item) => item.available);
      if (!rootId && preferred) syncLocation(preferred.id, searchParams.get('path') || '', true);
    } catch (cause: any) {
      setRoots([]); setPortable(cause?.message?.includes('установленной версии') || cause?.message?.includes('браузере') || cause?.message?.includes('недоступны') ? true : false);
      setError(cause?.message || 'Не удалось открыть папки Windows');
    }
  }, [rootId, searchParams, syncLocation]);

  const loadList = useCallback(async (nextOffset = 0, append = false) => {
    if (!folderRef) return;
    const requestId = ++listRequest.current;
    const requestedFolder = folderRef;
    setBusy(true); setError('');
    try {
      const data = await requestData<Listing>({ action: 'list', ref: requestedFolder, offset: nextOffset, limit: LIMIT });
      if (requestId !== listRequest.current) return;
      setListing((previous) => append && previous ? { ...data, entries: [...previous.entries, ...data.entries] } : data);
      setOffset(data.nextOffset); setPortable(false);
    } catch (cause: any) { if (requestId === listRequest.current) { setListing(null); setError(cause?.message || 'Не удалось прочитать папку'); } }
    finally { if (requestId === listRequest.current) setBusy(false); }
  }, [folderRef]);

  useEffect(() => { void loadRoots(); }, [loadRoots]);
  useEffect(() => { if (projectFiles) navigate('/explorer?projectFiles=1', { replace: true }); }, [projectFiles, navigate]);
  useEffect(() => { if (folderRef && root?.available) void loadList(0); }, [folderRef, root?.available, loadList]);
  useEffect(() => {
    const stop = onWindowsFilesChanged((change: WindowsFilesChanged) => {
      if (change.rootId === rootId && parentPath(change.relativePath) === path || change.rootId === rootId && change.relativePath === path) void loadList(0);
    });
    return stop;
  }, [rootId, path, loadList]);
  useEffect(() => {
    if (!folderRef || portable || !root?.available) return;
    void windowsFilesRequest({ action: 'watch', ref: folderRef });
    return () => { void windowsFilesRequest({ action: 'unwatch', ref: folderRef }); };
  }, [folderRef?.rootId, folderRef?.relativePath, portable, root?.available]);
  useEffect(() => {
    const rootFromUrl = searchParams.get('root');
    const pathFromUrl = searchParams.get('path') || '';
    // Эффект предыдущего адреса может ещё ждать после быстрого перехода.
    // Он не должен возвращать историю к старой папке поверх нового намерения.
    if (pendingFolder.current && (pendingFolder.current.rootId !== rootFromUrl || pendingFolder.current.relativePath !== pathFromUrl)) return;
    pendingFolder.current = null;
    if (rootFromUrl && (rootFromUrl !== rootId || pathFromUrl !== path)) {
      metadataRequest.current++;
      setRootId(rootFromUrl); setPath(pathFromUrl); setListing(null); setSelected(null);
      setPropertiesOpen(false); setMetadata(null); setBusy(false);
    }
    if (rootFromUrl) {
      const { entries, index: currentIndex } = navigationHistory.current;
      const matches = (item: WindowsFileRef | undefined) => item?.rootId === rootFromUrl && item.relativePath === pathFromUrl;
      const index = matches(entries[currentIndex]) ? currentIndex : entries.findIndex(matches);
      if (index >= 0 && index !== currentIndex) rememberHistory(entries, index);
      else if (index < 0) {
        const next = [...entries.slice(0, currentIndex + 1), { rootId: rootFromUrl, relativePath: pathFromUrl }];
        rememberHistory(next, next.length - 1);
      }
    }
    if (searchParams.get('properties') === '1' && selected) setPropertiesOpen(true);
  }, [location.search]);
  useEffect(() => {
    if (searchParams.get('properties') !== '1' || !listing) return;
    const wantedPath = searchParams.get('target') || searchParams.get('path') || '';
    const entry = listing.entries.find((candidate) => candidate.relativePath === wantedPath);
    if (!entry) return;
    setMetadata(null); setDraftTags([]); setDraftProjects([]); setRevision(''); setResponsible(''); setTagQuery('');
    setSelected(entry); setPropertiesOpen(true);
    const targetRef = { ...entryRef(entry, rootId), ...(searchParams.get('targetDraft') ? { draftId: searchParams.get('targetDraft')! } : {}) };
    const requestId = ++metadataRequest.current;
    void requestData<WindowsFileMetadata>({ action: 'metadata', ref: targetRef }).then((data) => {
      if (requestId !== metadataRequest.current) return;
      setMetadata(data); setDraftTags(data.tags || []); setDraftProjects(data.projectIds || []); setRevision(data.revision || ''); setResponsible(data.responsible || '');
    }).catch((cause) => { if (requestId === metadataRequest.current) setError(cause?.message || 'Не удалось загрузить свойства'); });
    const next = new URLSearchParams(searchParams); next.delete('properties'); setSearchParams(next, { replace: true });
  }, [listing, location.search]);
  useEffect(() => {
    let alive = true;
    void dataService.getProjects().then((items) => { if (alive) setProjects(items); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!activeProject?.id) { setTags([]); return; }
    let alive = true;
    void dataService.getTags(activeProject.id).then((data) => { if (alive) setTags(data.tags || []); }).catch(() => { if (alive) setTags([]); });
    return () => { alive = false; };
  }, [activeProject?.id]);

  const goTo = (ref: WindowsFileRef, replace = false) => {
    const current = navigationHistory.current;
    const next = current.entries.slice(0, current.index + 1);
    if (!next.length || next[next.length - 1].rootId !== ref.rootId || next[next.length - 1].relativePath !== ref.relativePath) next.push(ref);
    rememberHistory(next, next.length - 1); syncLocation(ref.rootId, ref.relativePath, replace);
  };
  const goBack = () => { const { entries, index } = navigationHistory.current; if (index > 0) { rememberHistory(entries, index - 1); syncLocation(entries[index - 1].rootId, entries[index - 1].relativePath); } };
  const goForward = () => { const { entries, index } = navigationHistory.current; if (index < entries.length - 1) { rememberHistory(entries, index + 1); syncLocation(entries[index + 1].rootId, entries[index + 1].relativePath); } };
  const goUp = () => { if (folderRef && path) goTo({ ...folderRef, relativePath: parentPath(path) }); };
  const selectRoot = (item: WindowsRoot) => { if (!item.available) return; goTo({ rootId: item.id, relativePath: '' }); };
  const addRoot = async () => {
    setBusy(true); setError('');
    try { const result = await requestData<WindowsRoot | { canceled: true }>({ action: 'addRoot' }); if ('id' in result) { setRoots((old) => [...old.filter((r) => r.id !== result.id), result]); goTo({ rootId: result.id, relativePath: '' }); } }
    catch (cause: any) { setError(cause?.message || 'Не удалось подключить папку'); }
    finally { setBusy(false); }
  };
  const openComputer = () => { setListing(null); setSearchParams({ computer: '1' }); };
  const openRecycleBin = async () => {
    try { await requestData({ action: 'openRecycleBin' }); addToast('Открыта системная Корзина Windows', 'success'); }
    catch (cause: any) { addToast(cause?.message || 'Не удалось открыть Корзину Windows', 'error'); }
  };
  const openEntry = (entry: WindowsFileEntry) => {
    if (!rootId) return;
    const ref = entryRef(entry, rootId);
    if (entry.kind === 'directory') goTo(ref);
    else if (entry.kind === 'file') {
      if (user?.id && !root?.network) void sharedSourceHref(user.id, ref, entry.name).then(href => navigate(href || fileRefHref(ref))).catch(cause => addToast(cause?.message || 'Не удалось проверить общий доступ', 'error'));
      else navigate(fileRefHref(ref));
    }
    else void action({ action: 'open', ref });
  };

  const action = async <T,>(request: Parameters<typeof windowsFilesRequest>[0], success?: string): Promise<T | null> => {
    setBusy(true); setError('');
    try { const result = await requestData<T>(request); if (success) addToast(success, 'success'); return result; }
    catch (cause: any) { setError(cause?.message || 'Не удалось выполнить действие'); addToast(cause?.message || 'Не удалось выполнить действие', 'error'); return null; }
    finally { setBusy(false); }
  };

  const openProperties = async (entry: WindowsFileEntry) => {
    if (!rootId) return;
    const requestId = ++metadataRequest.current;
    setMetadata(null); setDraftTags([]); setDraftProjects([]); setRevision(''); setResponsible(''); setTagQuery(''); setError('');
    setSelected(entry); setPropertiesOpen(true);
    setBusy(true);
    try {
      const result = await requestData<WindowsFileMetadata>({ action: 'metadata', ref: entryRef(entry, rootId) });
      if (requestId !== metadataRequest.current) return;
      setMetadata(result); setDraftTags(result.tags || []); setDraftProjects(result.projectIds || []); setRevision(result.revision || ''); setResponsible(result.responsible || '');
    } catch (cause: any) {
      if (requestId === metadataRequest.current) { const message = cause?.message || 'Не удалось загрузить свойства'; setError(message); addToast(message, 'error'); }
    } finally { if (requestId === metadataRequest.current) setBusy(false); }
  };
  const saveProperties = async () => {
    if (!selected || !rootId) return;
    const saved = await action({ action: 'setMetadata', ref: entryRef(selected, rootId), metadata: { tags: draftTags, projectIds: draftProjects, revision, responsible } }, 'Свойства сохранены');
    if (saved) { setMetadata({ ...(metadata as WindowsFileMetadata), tags: draftTags, projectIds: draftProjects, revision, responsible }); setPropertiesOpen(false); }
  };
  const renameSelected = async () => {
    if (!rename) return;
    const result = await action({ action: 'rename', ref: rename.ref, name: rename.name.trim() }, 'Имя изменено');
    if (result) { setRename(null); await loadList(0); }
  };
  const makeFolder = async () => {
    if (!folderRef || !newName.trim()) return;
    const result = await action({ action: 'mkdir', parent: folderRef, name: newName.trim() }, 'Папка создана');
    if (result) { setNewName(''); setNewFolderOpen(false); await loadList(0); }
  };
  const createFile = async () => {
    if (!folderRef) return;
    setBusy(true); setError('');
    try {
      const rawName = newName.trim() || DRAFT_NAME[newKind];
      const extension = newKind === 'folder' ? '' : DRAFT_NAME[newKind].slice(DRAFT_NAME[newKind].lastIndexOf('.'));
      const name = extension && !rawName.toLowerCase().endsWith(extension) ? rawName + extension : rawName;
      const result = newKind === 'folder'
        ? await requestData<{ ref: WindowsFileRef; file: WindowsFileEntry }>({ action: 'createDraftFolder', parent: folderRef, name })
        : await requestData<{ ref: WindowsFileRef; file: WindowsFileEntry }>({ action: 'createDraft', parent: folderRef, name, base64: bytesToBase64(newKind === 'text' ? new Uint8Array() : newKind === 'archive' ? zip([]) : await blankBytes(newKind)) });
      setNewName(''); setQuery(''); setNewFileOpen(false); setSelected(result.file); addToast('Черновик сохранён только в Flux', 'success'); await loadList(0); navigate(fileRefHref(result.ref, { folder: newKind === 'folder' }));
    } catch (cause: any) { setError(cause?.message || 'Не удалось создать черновик'); addToast(cause?.message || 'Не удалось создать черновик', 'error'); }
    finally { setBusy(false); }
  };
  const publishDraft = async (entry: WindowsFileEntry) => {
    if (!rootId) return;
    if (entry.kind === 'directory') {
      setBusy(true);
      try {
        const result = await requestData<{ published: number; failed: string[]; complete: boolean }>({ action: 'publishDraftTree', ref: entryRef(entry, rootId) });
        if (result.failed.length) addToast(`Опубликовано ${result.published}; ошибок: ${result.failed.join('; ')}. Черновик Flux сохранён.`, 'error');
        else addToast('Папка и вложенные файлы опубликованы в Windows', 'success');
        await loadList(0);
      } catch (cause: any) { addToast(`${cause?.message || 'Не удалось опубликовать папку'}. Черновик Flux сохранён.`, 'error'); }
      finally { setBusy(false); }
      return;
    }
    const result = await action({ action: 'publishDraft', ref: entryRef(entry, rootId) }, 'Файл опубликован в Windows');
    if (result) await loadList(0);
  };
  const trashSelected = async (entry: WindowsFileEntry) => {
    if (!rootId || !window.confirm(`Переместить «${entry.name}» в корзину Windows?`)) return;
    const ref = entryRef(entry, rootId);
    const hash = entry.kind === 'file' ? await requestData<{ sha256: string }>({ action: 'read', ref }).then((data) => data.sha256).catch(() => undefined) : undefined;
    const result = await action({ action: 'trash', ref, ...(hash ? { baseSha256: hash } : {}) }, 'Объект перемещён в корзину');
    if (result) { if (selected?.fileId === entry.fileId) setSelected(null); await loadList(0); }
  };
  const useClipboard = (entry: WindowsFileEntry, cut: boolean) => {
    if (!rootId) return;
    const ref = entryRef(entry, rootId);
    setClipboard({ ref, name: entry.name, kind: entry.kind, cut });
    if (cut && entry.kind === 'file') void requestData<{ sha256?: string }>({ action: 'read', ref }).then((data) => setClipboard((current) => current?.ref.rootId === ref.rootId && current.ref.relativePath === ref.relativePath ? { ...current, sha256: data.sha256 } : current)).catch(() => undefined);
  };
  const paste = async () => {
    if (!clipboard || !folderRef) return;
    const result = await action({ action: clipboard.cut ? 'move' : 'copy', ref: clipboard.ref, parent: folderRef, name: clipboard.name, ...(clipboard.cut && clipboard.sha256 ? { baseSha256: clipboard.sha256 } : {}) }, clipboard.cut ? 'Объект перемещён' : 'Копия создана');
    if (result) { if (clipboard.cut) setClipboard(null); await loadList(0); }
  };

  const table = <table className="w-full text-left text-xs"><thead className="sticky top-0 bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400"><tr><th className="h-7 px-2 font-medium">Имя</th><th className="h-7 px-2 font-medium hidden @[700px]:table-cell">Изменён</th><th className="h-7 px-2 font-medium text-right hidden @[620px]:table-cell">Размер</th><th className="h-7 px-2 font-medium hidden @[860px]:table-cell">Хранение</th><th className="w-8" /></tr></thead><tbody>{visibleEntries.map((entry) => <tr key={`${entry.relativePath}:${entry.draftId || ''}`} aria-selected={selected?.fileId === entry.fileId} onClick={() => setSelected(entry)} onDoubleClick={() => openEntry(entry)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSelected(entry); setContextMenu({ x: e.clientX, y: e.clientY, entry }); }} className="h-8 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 aria-selected:bg-slate-100 dark:aria-selected:bg-slate-800 cursor-default">
    <td className="px-2"><button type="button" className="flex min-w-0 items-center gap-2 text-left w-full" onClick={() => entry.kind === 'directory' && openEntry(entry)}><EntryIcon entry={entry} rootId={rootId} /><span className="truncate">{entry.name}</span>{sharedSources.some((source) => source.ref.rootId === rootId && source.ref.relativePath === entry.relativePath && source.ref.draftId === entry.draftId) && <span title="Общий файл · состояние доступа в команде «Общий доступ»" className="text-xs text-slate-500 dark:text-slate-400">общий</span>}{entry.storage === 'flux' && <Chip tone="sky">Только в Flux</Chip>}{entry.linked && <span className="text-xs text-slate-500 dark:text-slate-400">ссылка</span>}</button></td><td className="px-2 text-slate-500 dark:text-slate-400 hidden @[700px]:table-cell">{dateLabel(entry.modifiedAt)}</td><td className="px-2 text-right tabular-nums text-slate-500 dark:text-slate-400 hidden @[620px]:table-cell">{entry.kind === 'directory' ? '—' : fileSize(entry.size)}</td><td className="px-2 text-slate-500 dark:text-slate-400 hidden @[860px]:table-cell">{entry.storage === 'flux' ? 'Черновик Flux' : 'Windows'}</td><td className="px-1"><IconBtn label={`Свойства ${entry.name}`} onClick={(e) => { e.stopPropagation(); void openProperties(entry); }}><MoreHorizontal className="w-4 h-4" /></IconBtn></td></tr>)}</tbody></table>;

  return <div className="h-full min-h-0 flex flex-col @container text-slate-800 dark:text-slate-100">
    <header className="min-h-11 flex items-center gap-2 flex-wrap border-b border-slate-200 dark:border-slate-800 px-2">
      <h1 className="text-base font-semibold">Проводник</h1>
      <span className="text-xs text-slate-500 dark:text-slate-400">{computerView ? 'Этот компьютер' : root?.name || 'Файлы на этом устройстве'}</span><span className="flex-1" />
      <Btn tone="ghost" onClick={() => navigate('/explorer?projectFiles=1')}><Folder className="w-3.5 h-3.5" /> Документы проекта</Btn>
      {folderRef && <><Btn onClick={() => { setNewName(''); setNewFolderOpen(true); }} disabled={!root?.available || busy}><FolderPlus className="w-3.5 h-3.5" /> Новая папка</Btn><Btn tone="primary" onClick={() => { setNewName(''); setNewKind('doc'); setNewFileOpen(true); }} disabled={!root?.available || busy}><FilePlus2 className="w-3.5 h-3.5" /> Создать в Flux</Btn></>}
    </header>
    <div className="min-h-10 flex items-center gap-1 px-2 border-b border-slate-200 dark:border-slate-800">
      <IconBtn label="Назад" onClick={goBack} disabled={historyIndex <= 0}><ArrowLeft className="w-4 h-4" /></IconBtn><IconBtn label="Вперёд" onClick={goForward} disabled={historyIndex >= history.length - 1}><ArrowRight className="w-4 h-4" /></IconBtn>
      <IconBtn label="Вверх" onClick={goUp} disabled={!path}><ArrowUp className="w-4 h-4" /></IconBtn><IconBtn label="Обновить" onClick={() => void loadList(0)} disabled={!root?.available || busy}><RefreshCw className="w-4 h-4" /></IconBtn>
      <div aria-label="Путь" className="min-w-0 flex-1 flex items-center gap-1 overflow-auto px-1 text-xs">
        {root && <><button type="button" onClick={() => goTo({ rootId: root.id, relativePath: '' })} className="px-1.5 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">{root.name}</button>{crumbs.map((part, index) => <React.Fragment key={`${part}:${index}`}><span className="text-slate-400">›</span><button type="button" onClick={() => goTo({ rootId: root.id, relativePath: crumbs.slice(0, index + 1).join('/') })} className="px-1.5 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap">{part}</button></React.Fragment>)}</>}
      </div>
      <label className="flex items-center gap-1.5 w-40 max-w-[32vw] border border-slate-200 dark:border-slate-700 rounded-md px-2"><Search className="w-3.5 h-3.5 text-slate-400" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск в папке" aria-label="Поиск по имени" className="w-full min-w-0 bg-transparent outline-none text-xs h-7" /></label>
      <div className="fx-segctl" role="group" aria-label="Вид файлов"><button type="button" aria-pressed={layout === 'list'} onClick={() => setLayout('list')} title="Список"><List className="w-3.5 h-3.5" /></button><button type="button" aria-pressed={layout === 'tiles'} onClick={() => setLayout('tiles')} title="Плитки"><Grid2X2 className="w-3.5 h-3.5" /></button></div>
    </div>
    <div className="flex-1 min-h-0 flex">
      <aside className="w-44 shrink-0 overflow-auto border-r border-slate-200 dark:border-slate-800 py-2 px-1.5 flex flex-col gap-1" aria-label="Места Проводника">
        <button type="button" aria-current={computerView ? 'page' : undefined} onClick={openComputer} className="h-8 px-2 flex items-center gap-2 rounded text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800 aria-current:bg-slate-100 dark:aria-current:bg-slate-800"><FileIcon kind="this-pc" size={17} />Этот компьютер</button>
        {(['desktop', 'documents', 'downloads'] as const).map((kind) => { const item = roots.find((candidate) => candidate.kind === kind); return <button key={kind} type="button" disabled={!item?.available} aria-current={item?.id === rootId ? 'page' : undefined} onClick={() => item && selectRoot(item)} className="h-8 px-2 flex items-center gap-2 rounded text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800 aria-current:bg-slate-100 dark:aria-current:bg-slate-800 disabled:opacity-40"><Home className="w-4 h-4 text-slate-500 dark:text-slate-400" />{ROOT_LABEL[kind]}</button>; })}
        <button type="button" title="Открыть настоящую системную Корзину Windows" onClick={() => void openRecycleBin()} className="h-8 px-2 flex items-center gap-2 rounded text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800"><FileIcon kind="bin" size={17} />Корзина Windows</button>
        <button type="button" aria-current={searchParams.get('view') === 'shared' ? 'page' : undefined} onClick={() => { const next = new URLSearchParams({ view: 'shared', root: rootId, path }); navigate(`/explorer?${next}`); }} className="h-8 px-2 flex items-center gap-2 rounded text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800 aria-current:bg-slate-100 dark:aria-current:bg-slate-800"><Folder className="w-4 h-4 text-slate-500 dark:text-slate-400" />Общий доступ</button>
        <div className="mt-2 px-2 text-xs font-medium text-slate-500 dark:text-slate-400">Подключённые папки</div>
        {roots.filter((item) => item.kind === 'custom' && !volumes.some(volume => volume.root.id === item.id)).map((item) => <button key={item.id} type="button" disabled={!item.available} aria-current={item.id === rootId ? 'page' : undefined} onClick={() => selectRoot(item)} className="h-8 px-2 flex items-center gap-2 rounded text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800 aria-current:bg-slate-100 dark:aria-current:bg-slate-800 disabled:opacity-40"><HardDrive className="w-4 h-4 text-slate-500 dark:text-slate-400" /><span className="truncate">{item.name}</span></button>)}
        <button type="button" onClick={() => void addRoot()} disabled={busy} className="h-8 px-2 flex items-center gap-2 rounded text-left text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"><FolderPlus className="w-4 h-4" /> Подключить папку…</button>
      </aside>
      <main className="min-w-0 flex-1 flex flex-col" onContextMenu={(e) => { if (folderRef && root?.available) { e.preventDefault(); setContextMenu(null); setFreeMenu({ x: e.clientX, y: e.clientY }); } }}>
        {root?.network && <p className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400" role="status">Общая сетевая папка. Чтение и сохранение доступны по вашим правам Windows.</p>}
        {error && <div role="alert" className="m-3 px-3 py-2 rounded border border-rose-200 bg-rose-50 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">{error}</div>}
        {computerView ? <div className="flex-1 overflow-auto p-4"><h2 className="mb-3 text-sm font-medium">Диски</h2>{volumes.length ? <div className="grid grid-cols-1 @[700px]:grid-cols-2 gap-3">{volumes.map((volume) => { const size = volume.size || 0; const free = volume.free || 0; const used = Math.max(0, size - free); const percent = size ? Math.min(100, used / size * 100) : 0; return <button key={volume.id} type="button" disabled={!volume.root.available} onClick={() => selectRoot(volume.root)} className="rounded border border-slate-200 dark:border-slate-700 p-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"><span className="flex items-center gap-2"><HardDrive className="w-5 h-5 text-slate-500 dark:text-slate-400" /><span className="text-sm">{volume.name}</span></span>{volume.networkPath && <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">{volume.networkPath}</span>}<span className="mt-3 block h-2 overflow-hidden rounded bg-slate-100 dark:bg-slate-700"><span className="block h-full bg-sky-500" style={{ width: `${percent}%` }} /></span><span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">{size ? `${fileSize(free)} свободно из ${fileSize(size)}` : 'Сведения о ёмкости недоступны'} · {volume.kind === 'network' ? 'Сетевой диск' : volume.kind === 'removable' ? 'Съёмный диск' : volume.kind === 'optical' ? 'Оптический диск' : 'Локальный диск'}</span></button>; })}</div> : <Empty title="Диски не найдены" text="Windows не сообщила подключённые диски. Обновите список или откройте одну из известных папок." />}</div>
          : portable ? <div className="p-4"><Empty title="Папки Windows доступны в приложении Flux" text="В браузере здесь нет доступа к файлам устройства. Откройте архив документов проекта, чтобы продолжить работу." ><Btn onClick={() => navigate('/explorer?projectFiles=1')}><Folder className="w-3.5 h-3.5" /> Документы проекта</Btn></Empty></div>
          : !rootId ? <div className="p-4"><Empty title="Подключите папку Windows" text="Выберите Рабочий стол, Документы, Загрузки или добавьте другую папку." ><Btn onClick={() => void addRoot()}><FolderPlus className="w-3.5 h-3.5" /> Подключить папку</Btn></Empty></div>
          : !root?.available ? <div className="p-4"><Empty title="Папка недоступна" text="Проверьте, что она подключена на этом компьютере, и обновите список." ><Btn onClick={() => void loadRoots()}><RefreshCw className="w-3.5 h-3.5" /> Обновить папки</Btn></Empty></div>
          : !listing && busy ? <div className="p-4 text-xs text-slate-500 dark:text-slate-400">Открываю папку…</div>
          : !visibleEntries.length ? <div className="p-4"><Empty title={query ? 'Файлы не найдены' : 'Папка пуста'} text={query ? 'Измените поисковый запрос.' : 'Создайте черновик в Flux или добавьте файл средствами Windows.'}>{!query && <Btn tone="primary" onClick={() => setNewFileOpen(true)}><FilePlus2 className="w-3.5 h-3.5" /> Создать в Flux</Btn>}</Empty></div>
          : <div className="flex-1 min-h-0 overflow-auto">
        {layout === 'list' ? table : <div className="grid grid-cols-2 @[650px]:grid-cols-3 @[950px]:grid-cols-5 gap-1.5 p-2">{visibleEntries.map((entry) => <button type="button" key={`${entry.relativePath}:${entry.draftId || ''}`} aria-selected={selected?.fileId === entry.fileId} onClick={() => setSelected(entry)} onDoubleClick={() => openEntry(entry)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSelected(entry); setContextMenu({ x: e.clientX, y: e.clientY, entry }); }} className="min-h-20 flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-slate-50 dark:hover:bg-slate-800 aria-selected:bg-slate-100 dark:aria-selected:bg-slate-800"><EntryIcon entry={entry} rootId={rootId} large /><span className="min-w-0"><span className="block truncate text-xs">{entry.name}</span><span className="block text-xs text-slate-500 dark:text-slate-400">{entry.storage === 'flux' ? 'Только в Flux' : entry.kind === 'directory' ? 'Папка' : fileSize(entry.size)}</span></span></button>)}</div>}
            {offset !== null && <div className="flex justify-center p-3"><Btn onClick={() => void loadList(offset, true)} disabled={busy}><ArrowDown className="w-3.5 h-3.5" /> Показать ещё</Btn></div>}
          </div>}
      </main>
    </div>
    <footer className="min-h-8 border-t border-slate-200 dark:border-slate-800 px-2 py-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <span>{visibleEntries.length}{listing?.truncated ? '+' : ''} объектов{query ? ' по запросу' : ''}</span><span className="flex-1" />
      {clipboard && <><span>{clipboard.cut ? 'Вырезан' : 'Скопирован'}: {clipboard.name}</span><Btn tone="ghost" onClick={() => void paste()} disabled={!folderRef || busy}><Clipboard className="w-3.5 h-3.5" /> Вставить</Btn><Btn tone="ghost" onClick={() => setClipboard(null)}>Отмена</Btn></>}
      {selected && <div className="flex items-center gap-1 overflow-auto">{selected.kind === 'file' && user?.id && !root?.network && <Btn tone="ghost" onClick={() => setShareEntry(selected)}>Общий доступ…</Btn>}<Btn tone="ghost" onClick={() => void openProperties(selected)}>Свойства</Btn><Btn tone="ghost" onClick={() => openEntry(selected)}>Открыть</Btn><Btn tone="ghost" onClick={() => setRename({ ref: entryRef(selected, rootId), name: selected.name })}>Переименовать</Btn><Btn tone="ghost" onClick={() => useClipboard(selected, false)}><Copy className="w-3.5 h-3.5" /> Копировать</Btn><Btn tone="ghost" onClick={() => useClipboard(selected, true)}><Scissors className="w-3.5 h-3.5" /> Вырезать</Btn>{selected.storage === 'flux' && <Btn tone="ghost" onClick={() => void publishDraft(selected)}><Upload className="w-3.5 h-3.5" /> Опубликовать</Btn>}<Btn tone="ghost" onClick={() => void action({ action: 'reveal', ref: entryRef(selected, rootId) }, 'Папка открыта в Windows')}><ExternalLink className="w-3.5 h-3.5" /> Показать</Btn><Btn tone="danger" onClick={() => void trashSelected(selected)}><Trash2 className="w-3.5 h-3.5" /> В корзину</Btn></div>}
    </footer>

    {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} items={[
      { label: 'Открыть', onClick: () => openEntry(contextMenu.entry) },
      { label: 'Свойства', onClick: () => void openProperties(contextMenu.entry) },
      ...(contextMenu.entry.kind === 'file' && user?.id && !root?.network ? [{ label: 'Общий доступ…', onClick: () => setShareEntry(contextMenu.entry) }] : []),
      ...(root?.network ? [{ label: 'Общая папка в Windows', onClick: () => void action({ action: 'reveal', ref: entryRef(contextMenu.entry, rootId) }) }] : []),
      { label: 'Переименовать', onClick: () => setRename({ ref: entryRef(contextMenu.entry, rootId), name: contextMenu.entry.name }) },
      { label: 'Копировать', onClick: () => useClipboard(contextMenu.entry, false) },
      { label: 'Вырезать', onClick: () => useClipboard(contextMenu.entry, true) },
      ...(contextMenu.entry.storage === 'flux' ? [{ label: 'Опубликовать в Windows', onClick: () => void publishDraft(contextMenu.entry) }] : []),
      { label: 'Переместить в корзину', danger: true, separated: true, onClick: () => void trashSelected(contextMenu.entry) },
    ]} />}

    {freeMenu && <ContextMenu x={freeMenu.x} y={freeMenu.y} onClose={() => setFreeMenu(null)} items={[
      { label: 'Вид', items: [{ label: 'Список', onClick: () => setLayout('list') }, { label: 'Значки', onClick: () => setLayout('tiles') }] },
      { label: 'Обновить', onClick: () => void loadList(0) },
      { label: 'Создать в Flux', items: ([['folder', 'Папка'], ['doc', 'Документ Word'], ['sheet', 'Таблица Excel'], ['text', 'Текстовый файл'], ['archive', 'Архив ZIP']] as [DraftKind, string][]).map(([kind, label]) => ({ label, onClick: () => { setNewKind(kind); setNewName(DRAFT_NAME[kind]); setNewFileOpen(true); } })) },
      ...(!folderRef?.draftId ? [{ label: 'Создать папку в Windows', onClick: () => { setNewName(''); setNewFolderOpen(true); } }] : []),
      ...(clipboard ? [{ label: 'Вставить', onClick: () => void paste() }] : []),
    ]} />}

    {shareEntry && user?.id && !root?.network && <FileShareDialog actorId={user.id} source={entryRef(shareEntry, rootId)} name={shareEntry.name} onClose={() => setShareEntry(null)} onChanged={() => setSharingGeneration((value) => value + 1)} />}
    {propertiesOpen && selected && <PropertiesDialog entry={selected} rootId={rootId} metadata={metadata} projects={projects} tags={tags} activeProjectId={activeProject?.id || ''} draftTags={draftTags} setDraftTags={setDraftTags} draftProjects={draftProjects} setDraftProjects={setDraftProjects} revision={revision} setRevision={setRevision} responsible={responsible} setResponsible={setResponsible} tagQuery={tagQuery} setTagQuery={setTagQuery} busy={busy} onClose={() => { metadataRequest.current++; setPropertiesOpen(false); setMetadata(null); setBusy(false); }} onSave={() => void saveProperties()} />}
    {rename && <Dialog title="Переименовать" onClose={() => setRename(null)} footer={<><Btn onClick={() => setRename(null)}>Отмена</Btn><Btn tone="primary" onClick={() => void renameSelected()} disabled={!rename.name.trim() || busy}>Переименовать</Btn></>}><Field label="Новое имя"><Input autoFocus value={rename.name} onChange={(e) => setRename({ ...rename, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void renameSelected(); }} /></Field></Dialog>}
    {newFolderOpen && <Dialog title="Новая папка" onClose={() => setNewFolderOpen(false)} footer={<><Btn onClick={() => setNewFolderOpen(false)}>Отмена</Btn><Btn tone="primary" onClick={() => void makeFolder()} disabled={!newName.trim() || busy}>Создать папку</Btn></>}><Field label="Название папки"><Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void makeFolder(); }} placeholder="Например, Чертежи" /></Field></Dialog>}
    {newFileOpen && <Dialog title="Создать в Flux" onClose={() => setNewFileOpen(false)} footer={<><Btn onClick={() => setNewFileOpen(false)}>Отмена</Btn><Btn tone="primary" onClick={() => void createFile()} disabled={busy}>Создать черновик</Btn></>}><div className="flex flex-col gap-3"><Field label="Тип"><Select value={newKind} onChange={(v) => { const kind = v as DraftKind; setNewKind(kind); if (!newName || Object.values(DRAFT_NAME).includes(newName)) setNewName(DRAFT_NAME[kind]); }} options={[{ value: 'folder', label: 'Папка' }, { value: 'doc', label: 'Документ Word' }, { value: 'sheet', label: 'Таблица Excel' }, { value: 'text', label: 'Текстовый файл' }, { value: 'archive', label: 'Архив ZIP' }]} /></Field><Field label="Имя"><Input autoFocus value={newName || DRAFT_NAME[newKind]} onChange={(e) => setNewName(e.target.value)} placeholder={DRAFT_NAME[newKind]} /></Field><p className="text-xs text-slate-500 dark:text-slate-400">Папки и документы хранятся только в Flux до публикации. Публикация папки переносит всё вложенное дерево в Windows.</p></div></Dialog>}
  </div>;
}

function EntryIcon({ entry, rootId, large = false }: { entry: WindowsFileEntry; rootId: string; large?: boolean }) {
  return <NativeWindowsFileIcon entry={entry} fileRef={entryRef(entry, rootId)} size={large ? 36 : 20} />;
}

function PropertiesDialog({ entry, rootId, metadata, projects, tags, activeProjectId, draftTags, setDraftTags, draftProjects, setDraftProjects, revision, setRevision, responsible, setResponsible, tagQuery, setTagQuery, busy, onClose, onSave }: {
  entry: WindowsFileEntry; rootId: string; metadata: WindowsFileMetadata | null; projects: Project[]; tags: ProjectTag[]; activeProjectId: string;
  draftTags: string[]; setDraftTags: (tags: string[]) => void; draftProjects: string[]; setDraftProjects: (projects: string[]) => void;
  revision: string; setRevision: (value: string) => void; responsible: string; setResponsible: (value: string) => void;
  tagQuery: string; setTagQuery: (value: string) => void; busy: boolean; onClose: () => void; onSave: () => void;
}) {
  const allTags = [...new Map([...tags.map((item) => [item.identifier, item.identifier] as const), ...draftTags.map((item) => [item, item] as const)]).values()];
  return <Dialog title={`Свойства · ${entry.name}`} onClose={onClose} width="max-w-2xl" footer={<><Btn onClick={onClose}>Закрыть</Btn><Btn tone="primary" onClick={onSave} disabled={busy}>Сохранить свойства</Btn></>}>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
      <ReadOnly label="Тип" value={entry.kind === 'directory' ? 'Папка' : entry.name.split('.').pop()?.toUpperCase() || 'Файл'} />
      <ReadOnly label="Размер" value={entry.kind === 'directory' ? '—' : fileSize(entry.size)} />
      <ReadOnly label="Изменён" value={dateLabel(entry.modifiedAt)} />
      <ReadOnly label="Хранение" value={entry.storage === 'flux' ? 'Только в Flux' : 'Windows'} />
      <Field label="Ревизия"><Input value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="Например, 2" /></Field>
      <Field label="Ответственный"><Input value={responsible} onChange={(e) => setResponsible(e.target.value)} placeholder="Фамилия Имя" /></Field>
      <Field label="Проекты" className="sm:col-span-2"><div className="max-h-28 overflow-auto flex flex-wrap gap-x-3 gap-y-1">{projects.map((project) => <label key={project.id} className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={draftProjects.includes(project.id)} onChange={(e) => setDraftProjects(e.target.checked ? [...new Set([...draftProjects, project.id])] : draftProjects.filter((id) => id !== project.id))} />{project.name}{project.id === activeProjectId ? ' · текущий' : ''}</label>)}</div>{!projects.length && <span className="text-xs text-slate-500 dark:text-slate-400">Проекты недоступны.</span>}</Field>
      <Field label="Теги" className="sm:col-span-2"><Input value={tagQuery} onChange={(e) => setTagQuery(e.target.value)} placeholder="Найти тег текущего проекта" />
        <div className="max-h-32 overflow-auto flex flex-wrap gap-x-3 gap-y-1">{allTags.filter((tag) => tag.toLocaleLowerCase('ru').includes(tagQuery.trim().toLocaleLowerCase('ru'))).slice(0, 100).map((tag) => <label key={tag} className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={draftTags.includes(tag)} onChange={(e) => setDraftTags(e.target.checked ? [...new Set([...draftTags, tag])] : draftTags.filter((value) => value !== tag))} />{tag}</label>)}</div>
        {activeProjectId ? <span className="text-xs text-slate-500 dark:text-slate-400">Теги берутся из текущего проекта; связь хранится только в свойствах файла.</span> : <span className="text-xs text-slate-500 dark:text-slate-400">Выберите проект, чтобы показать его теги.</span>}
      </Field>
    </div>
    {metadata?.history?.length ? <details className="mt-3"><summary className="cursor-pointer text-xs text-slate-500 dark:text-slate-400">История файла · {metadata.history.length}</summary><div className="max-h-24 overflow-auto mt-1 text-xs text-slate-500 dark:text-slate-400">{metadata.history.slice(-8).reverse().map((item, index) => <div key={`${item.at}:${index}`}>{dateLabel(item.at)} · {item.action} · {item.relativePath}</div>)}</div></details> : null}
  </Dialog>;
}

function ReadOnly({ label, value }: { label: string; value: string }) { return <div className="fx-field"><span className="fx-label">{label}</span><span className="text-xs">{value}</span></div>; }
