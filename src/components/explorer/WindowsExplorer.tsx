import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Clipboard, Copy, ExternalLink, Folder, FolderPlus, HardDrive, List, MoreHorizontal, RefreshCw, Search, Trash2, Grid2X2, Home, Scissors, Upload } from 'lucide-react';
import { dataService, type Project } from '../../services/dataService';
import { useStore } from '../../store/store';
import { useToastStore } from '../../store/toastStore';
import { fileRefHref, folderRefHref, windowsFilesRequest, type WindowsFileEntry, type WindowsFileMetadata, type WindowsFileRef, type WindowsRoot, type WindowsVolume } from '../../lib/windowsFiles';
import { Btn, Chip, Dialog, Empty, Field, IconBtn, Input } from '../ui';
import { NativeWindowsFileIcon } from './WindowsFileIcon';
import ContextMenu from '../ContextMenu';
import FileShareDialog from './FileShareDialog';
import { sourceBindings, sharedSourceHref } from '../../services/fileSharingService';
import { FileIcon } from '../icons/FluxIcons';
import { useCreatePanel } from '../files/CreatePanel';
import { isCreated } from '../files/createEntry';
import { folderKey, useFolder } from '../files/useFolder';
import { revealEntry, useSelection } from '../files/useSelection';
import { useFileOps } from '../files/useFileOps';
import { isTypingTarget, keyAvailable, matchKey, type KeyAction } from '../files/explorerKeys';

type RenameTarget = { ref: WindowsFileRef; name: string } | null;
type ProjectTag = { id: string; identifier: string; name?: string };
type Layout = 'list' | 'tiles';
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
  // «Занят» — это действие над файлами; чтение списка считает useFolder (loading)
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');
  const [portable, setPortable] = useState(false);
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<Layout>('list');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: WindowsFileEntry } | null>(null);
  // Объект, чьи свойства открыты: выделение теперь может быть из нескольких, а окно свойств — про один
  const [propsEntry, setPropsEntry] = useState<WindowsFileEntry | null>(null);
  const [metadata, setMetadata] = useState<WindowsFileMetadata | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tags, setTags] = useState<ProjectTag[]>([]);
  const [tagQuery, setTagQuery] = useState('');
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [draftProjects, setDraftProjects] = useState<string[]>([]);
  const [revision, setRevision] = useState('');
  const [responsible, setResponsible] = useState('');
  const [rename, setRename] = useState<RenameTarget>(null);
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
  const metadataRequest = useRef(0);
  const projectFiles = searchParams.get('projectFiles') === '1';
  const computerView = searchParams.get('computer') === '1';
  const folderRef = useMemo(() => rootId ? { rootId, relativePath: path, ...(searchParams.get('draft') ? { draftId: searchParams.get('draft')! } : {}) } : null, [rootId, path, searchParams]);
  const root = roots.find((item) => item.id === rootId);
  useEffect(() => { if (root?.network) setShareEntry(null); }, [root?.network]);
  const crumbs = path ? path.split('/').filter(Boolean) : [];
  // Список папки: страницы, наблюдатель и тихое обновление — в useFolder
  const folder = useFolder(folderRef, !!folderRef && !portable && !!root?.available);
  const names = useMemo(() => folder.entries.map((entry) => entry.name), [folder.entries]);
  // Буфер, вставка и корзина над несколькими объектами — files/fileOps через мост
  const ops = useFileOps({ rootId, folder: folderRef, names, reload: folder.reload });
  const busy = acting || folder.loading || ops.working;
  const visibleEntries = useMemo(() => folder.entries.filter((entry) => entry.name.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))), [folder.entries, query]);
  // Выбор переживает обновление списка и сбрасывается при смене папки
  const selection = useSelection(visibleEntries, folderKey(folderRef));
  const single = selection.selected.length === 1 ? selection.selected[0] : null;
  const pendingSelect = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const wanted = pendingSelect.current;
    const found = wanted ? visibleEntries.find((entry) => entry.name === wanted) : undefined;
    if (found) { pendingSelect.current = null; selection.only(found); }
  }, [visibleEntries]);

  const syncLocation = useCallback((nextRoot: string, nextPath: string, replace = false) => {
    pendingFolder.current = { rootId: nextRoot, relativePath: nextPath };
    metadataRequest.current++;
    setRootId(nextRoot); setPath(nextPath); setQuery('');
    setPropsEntry(null); setMetadata(null); setActing(false);
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

  // Создание — общая панель с рабочим столом (components/files). Родитель — открытая
  // папка, в том числе папка-черновик Flux: в ней настоящего каталога Windows нет,
  // поэтому раздел «В Windows» в ней не показывается.
  const panel = useCreatePanel({
    parent: root?.available ? folderRef : null,
    windows: !folderRef?.draftId,
    where: 'в Windows',
    onCreated: async (outcome) => { setQuery(''); if (isCreated(outcome)) pendingSelect.current = outcome.name; await folder.reload(); },
  });

  useEffect(() => { void loadRoots(); }, [loadRoots]);
  useEffect(() => { if (projectFiles) navigate('/explorer?projectFiles=1', { replace: true }); }, [projectFiles, navigate]);
  useEffect(() => {
    const rootFromUrl = searchParams.get('root');
    const pathFromUrl = searchParams.get('path') || '';
    // Эффект предыдущего адреса может ещё ждать после быстрого перехода.
    // Он не должен возвращать историю к старой папке поверх нового намерения.
    if (pendingFolder.current && (pendingFolder.current.rootId !== rootFromUrl || pendingFolder.current.relativePath !== pathFromUrl)) return;
    pendingFolder.current = null;
    if (rootFromUrl && (rootFromUrl !== rootId || pathFromUrl !== path)) {
      metadataRequest.current++;
      setRootId(rootFromUrl); setPath(pathFromUrl);
      setPropsEntry(null); setMetadata(null); setActing(false);
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
  }, [location.search]);
  useEffect(() => {
    if (searchParams.get('properties') !== '1' || !folder.listing) return;
    const wantedPath = searchParams.get('target') || searchParams.get('path') || '';
    const entry = folder.entries.find((candidate) => candidate.relativePath === wantedPath);
    if (!entry) return;
    setMetadata(null); setDraftTags([]); setDraftProjects([]); setRevision(''); setResponsible(''); setTagQuery('');
    selection.only(entry); setPropsEntry(entry);
    const targetRef = { ...entryRef(entry, rootId), ...(searchParams.get('targetDraft') ? { draftId: searchParams.get('targetDraft')! } : {}) };
    const requestId = ++metadataRequest.current;
    void requestData<WindowsFileMetadata>({ action: 'metadata', ref: targetRef }).then((data) => {
      if (requestId !== metadataRequest.current) return;
      setMetadata(data); setDraftTags(data.tags || []); setDraftProjects(data.projectIds || []); setRevision(data.revision || ''); setResponsible(data.responsible || '');
    }).catch((cause) => { if (requestId === metadataRequest.current) setError(cause?.message || 'Не удалось загрузить свойства'); });
    const next = new URLSearchParams(searchParams); next.delete('properties'); setSearchParams(next, { replace: true });
  }, [folder.listing, location.search]);
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
    setActing(true); setError('');
    try { const result = await requestData<WindowsRoot | { canceled: true }>({ action: 'addRoot' }); if ('id' in result) { setRoots((old) => [...old.filter((r) => r.id !== result.id), result]); goTo({ rootId: result.id, relativePath: '' }); } }
    catch (cause: any) { setError(cause?.message || 'Не удалось подключить папку'); }
    finally { setActing(false); }
  };
  const openComputer = () => { setSearchParams({ computer: '1' }); };
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
    setActing(true); setError('');
    try { const result = await requestData<T>(request); if (success) addToast(success, 'success'); return result; }
    catch (cause: any) { setError(cause?.message || 'Не удалось выполнить действие'); addToast(cause?.message || 'Не удалось выполнить действие', 'error'); return null; }
    finally { setActing(false); }
  };

  const openProperties = async (entry: WindowsFileEntry) => {
    if (!rootId) return;
    const requestId = ++metadataRequest.current;
    setMetadata(null); setDraftTags([]); setDraftProjects([]); setRevision(''); setResponsible(''); setTagQuery(''); setError('');
    selection.only(entry); setPropsEntry(entry);
    setActing(true);
    try {
      const result = await requestData<WindowsFileMetadata>({ action: 'metadata', ref: entryRef(entry, rootId) });
      if (requestId !== metadataRequest.current) return;
      setMetadata(result); setDraftTags(result.tags || []); setDraftProjects(result.projectIds || []); setRevision(result.revision || ''); setResponsible(result.responsible || '');
    } catch (cause: any) {
      if (requestId === metadataRequest.current) { const message = cause?.message || 'Не удалось загрузить свойства'; setError(message); addToast(message, 'error'); }
    } finally { if (requestId === metadataRequest.current) setActing(false); }
  };
  const saveProperties = async () => {
    if (!propsEntry || !rootId) return;
    const saved = await action({ action: 'setMetadata', ref: entryRef(propsEntry, rootId), metadata: { tags: draftTags, projectIds: draftProjects, revision, responsible } }, 'Свойства сохранены');
    if (saved) { setMetadata({ ...(metadata as WindowsFileMetadata), tags: draftTags, projectIds: draftProjects, revision, responsible }); setPropsEntry(null); }
  };
  const renameSelected = async () => {
    if (!rename) return;
    const result = await action({ action: 'rename', ref: rename.ref, name: rename.name.trim() }, 'Имя изменено');
    if (result) { setRename(null); await folder.reload(); }
  };
  const publishDraft = async (entry: WindowsFileEntry) => {
    if (!rootId) return;
    if (entry.kind === 'directory') {
      setActing(true);
      try {
        const result = await requestData<{ published: number; failed: string[]; complete: boolean }>({ action: 'publishDraftTree', ref: entryRef(entry, rootId) });
        if (result.failed.length) addToast(`Опубликовано ${result.published}; ошибок: ${result.failed.join('; ')}. Черновик Flux сохранён.`, 'error');
        else addToast('Папка и вложенные файлы опубликованы в Windows', 'success');
        await folder.reload();
      } catch (cause: any) { addToast(`${cause?.message || 'Не удалось опубликовать папку'}. Черновик Flux сохранён.`, 'error'); }
      finally { setActing(false); }
      return;
    }
    const result = await action({ action: 'publishDraft', ref: entryRef(entry, rootId) }, 'Файл опубликован в Windows');
    if (result) await folder.reload();
  };
  // Стрелки вверх и вниз в плитках идут на ряд, а не на объект: число столбцов берём у самой сетки
  // Щелчок по строке не уводит фокус на кнопку внутри неё (имя, «Свойства»): после перехода
  // в папку кнопка исчезает, фокус падает на страницу, и клавиши Проводника замолкают
  const keepFocus = (event: React.MouseEvent) => { event.preventDefault(); rootRef.current?.focus({ preventScroll: true }); };
  const gridColumns = () => {
    const grid = folder.scrollRef.current?.querySelector('[data-entries-grid]');
    return grid ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length) : 1;
  };
  useEffect(() => { revealEntry(folder.scrollRef.current, selection.focused?.fileId ?? null); }, [selection.focused?.fileId]);

  /** Что делает каждая клавиша из таблицы explorerKeys; нет обработчика — клавиша не объявлена. */
  const keyActions: Record<KeyAction, () => void> = {
    open: () => { if (single) openEntry(single); },
    properties: () => { if (single) void openProperties(single); },
    rename: () => { if (single) setRename({ ref: entryRef(single, rootId), name: single.name }); },
    trash: () => void ops.trash(selection.selected),
    copy: () => void ops.copy(selection.selected),
    cut: () => void ops.cut(selection.selected),
    paste: () => void ops.paste(),
    selectAll: () => selection.all(),
    create: () => { const rect = mainRef.current?.getBoundingClientRect(); panel.openByKey((rect?.left ?? 0) + 24, (rect?.top ?? 0) + 24); },
    back: () => goBack(),
    clear: () => selection.clear(),
    down: () => selection.move(layout === 'tiles' ? gridColumns() : 1),
    up: () => selection.move(layout === 'tiles' ? -gridColumns() : -1),
    right: () => { if (layout === 'tiles') selection.move(1); },
    left: () => { if (layout === 'tiles') selection.move(-1); },
    extendDown: () => selection.move(layout === 'tiles' ? gridColumns() : 1, true),
    extendUp: () => selection.move(layout === 'tiles' ? -gridColumns() : -1, true),
  };
  // Пока открыто окно или меню, клавиши принадлежат им, а не списку позади
  const overlayOpen = !!(panel.open || rename || propsEntry || shareEntry || contextMenu || freeMenu);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.defaultPrevented || isTypingTarget(event.target) || overlayOpen || computerView || !folderRef) return;
    const binding = matchKey(event.nativeEvent);
    if (!binding || !keyAvailable(binding, selection.selected.length)) return;
    // Enter на кнопке — её собственное нажатие; исключение — имя в строке, оно не про Enter
    const target = event.target as HTMLElement;
    if (binding.key === 'Enter' && target.closest('button') && !target.closest('[data-entry-name]')) return;
    event.preventDefault();
    keyActions[binding.action]();
  };

  const table = <table className="w-full text-left text-xs select-none"><thead className="sticky top-0 bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400"><tr><th className="h-7 px-2 font-medium">Имя</th><th className="h-7 px-2 font-medium hidden @[700px]:table-cell">Изменён</th><th className="h-7 px-2 font-medium text-right hidden @[620px]:table-cell">Размер</th><th className="h-7 px-2 font-medium hidden @[860px]:table-cell">Хранение</th><th className="w-8" /></tr></thead><tbody>{visibleEntries.map((entry) => <tr key={`${entry.relativePath}:${entry.draftId || ''}`} data-entry-key={entry.fileId} onMouseDown={keepFocus} aria-selected={selection.isSelected(entry)} onClick={(e) => selection.click(entry, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })} onDoubleClick={() => openEntry(entry)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); selection.context(entry); setContextMenu({ x: e.clientX, y: e.clientY, entry }); }} className="h-8 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 aria-selected:bg-slate-100 dark:aria-selected:bg-slate-800 cursor-default">
    <td className="px-2"><button type="button" data-entry-name className="flex min-w-0 items-center gap-2 text-left w-full" onClick={(e) => entry.kind === 'directory' && !e.ctrlKey && !e.metaKey && !e.shiftKey && openEntry(entry)}><EntryIcon entry={entry} rootId={rootId} /><span className="truncate">{entry.name}</span>{sharedSources.some((source) => source.ref.rootId === rootId && source.ref.relativePath === entry.relativePath && source.ref.draftId === entry.draftId) && <span title="Общий файл · состояние доступа в команде «Общий доступ»" className="text-xs text-slate-500 dark:text-slate-400">общий</span>}{entry.storage === 'flux' && <Chip tone="sky">Только в Flux</Chip>}{entry.linked && <span className="text-xs text-slate-500 dark:text-slate-400">ссылка</span>}</button></td><td className="px-2 text-slate-500 dark:text-slate-400 hidden @[700px]:table-cell">{dateLabel(entry.modifiedAt)}</td><td className="px-2 text-right tabular-nums text-slate-500 dark:text-slate-400 hidden @[620px]:table-cell">{entry.kind === 'directory' ? '—' : fileSize(entry.size)}</td><td className="px-2 text-slate-500 dark:text-slate-400 hidden @[860px]:table-cell">{entry.storage === 'flux' ? 'Черновик Flux' : 'Windows'}</td><td className="px-1"><IconBtn label={`Свойства ${entry.name}`} onClick={(e) => { e.stopPropagation(); void openProperties(entry); }}><MoreHorizontal className="w-4 h-4" /></IconBtn></td></tr>)}</tbody></table>;

  // Фокус на корне — только чтобы ловить клавиши; кольцо вокруг всего окна не нужно, а общее правило
  // :focus-visible (index.css, без слоя) перебивает классы Tailwind, поэтому снимается встроенным стилем
  return <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} style={{ outline: 'none' }} className="h-full min-h-0 flex flex-col @container text-slate-800 dark:text-slate-100">
    <header className="min-h-11 flex items-center gap-2 flex-wrap border-b border-slate-200 dark:border-slate-800 px-2">
      <h1 className="text-base font-semibold">Проводник</h1>
      <span className="text-xs text-slate-500 dark:text-slate-400">{computerView ? 'Этот компьютер' : root?.name || 'Файлы на этом устройстве'}</span><span className="flex-1" />
      <Btn tone="ghost" onClick={() => navigate('/explorer?projectFiles=1')}><Folder className="w-3.5 h-3.5" /> Документы проекта</Btn>
    </header>
    <div className="min-h-10 flex items-center gap-1 px-2 border-b border-slate-200 dark:border-slate-800">
      <IconBtn label="Назад" onClick={goBack} disabled={historyIndex <= 0}><ArrowLeft className="w-4 h-4" /></IconBtn><IconBtn label="Вперёд" onClick={goForward} disabled={historyIndex >= history.length - 1}><ArrowRight className="w-4 h-4" /></IconBtn>
      <IconBtn label="Вверх" onClick={goUp} disabled={!path}><ArrowUp className="w-4 h-4" /></IconBtn><IconBtn label="Обновить" onClick={() => void folder.reload()} disabled={!root?.available || busy}><RefreshCw className="w-4 h-4" /></IconBtn>
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
      <main ref={mainRef} className="min-w-0 flex-1 flex flex-col" onContextMenu={(e) => { if (folderRef && root?.available) { e.preventDefault(); setContextMenu(null); setFreeMenu({ x: e.clientX, y: e.clientY }); } }}>
        {root?.network && <p className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400" role="status">Общая сетевая папка. Чтение и сохранение доступны по вашим правам Windows.</p>}
        {(error || folder.error) && <div role="alert" className="m-3 px-3 py-2 rounded border border-rose-200 bg-rose-50 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">{error || folder.error}</div>}
        {computerView ? <div className="flex-1 overflow-auto p-4"><h2 className="mb-3 text-sm font-medium">Диски</h2>{volumes.length ? <div className="grid grid-cols-1 @[700px]:grid-cols-2 gap-3">{volumes.map((volume) => { const size = volume.size || 0; const free = volume.free || 0; const used = Math.max(0, size - free); const percent = size ? Math.min(100, used / size * 100) : 0; return <button key={volume.id} type="button" disabled={!volume.root.available} onClick={() => selectRoot(volume.root)} className="rounded border border-slate-200 dark:border-slate-700 p-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"><span className="flex items-center gap-2"><HardDrive className="w-5 h-5 text-slate-500 dark:text-slate-400" /><span className="text-sm">{volume.name}</span></span>{volume.networkPath && <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">{volume.networkPath}</span>}<span className="mt-3 block h-2 overflow-hidden rounded bg-slate-100 dark:bg-slate-700"><span className="block h-full bg-sky-500" style={{ width: `${percent}%` }} /></span><span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">{size ? `${fileSize(free)} свободно из ${fileSize(size)}` : 'Сведения о ёмкости недоступны'} · {volume.kind === 'network' ? 'Сетевой диск' : volume.kind === 'removable' ? 'Съёмный диск' : volume.kind === 'optical' ? 'Оптический диск' : 'Локальный диск'}</span></button>; })}</div> : <Empty title="Диски не найдены" text="Windows не сообщила подключённые диски. Обновите список или откройте одну из известных папок." />}</div>
          : portable ? <div className="p-4"><Empty title="Папки Windows доступны в приложении Flux" text="В браузере здесь нет доступа к файлам устройства. Откройте архив документов проекта, чтобы продолжить работу." ><Btn onClick={() => navigate('/explorer?projectFiles=1')}><Folder className="w-3.5 h-3.5" /> Документы проекта</Btn></Empty></div>
          : !rootId ? <div className="p-4"><Empty title="Подключите папку Windows" text="Выберите Рабочий стол, Документы, Загрузки или добавьте другую папку." ><Btn onClick={() => void addRoot()}><FolderPlus className="w-3.5 h-3.5" /> Подключить папку</Btn></Empty></div>
          : !root?.available ? <div className="p-4"><Empty title="Папка недоступна" text="Проверьте, что она подключена на этом компьютере, и обновите список." ><Btn onClick={() => void loadRoots()}><RefreshCw className="w-3.5 h-3.5" /> Обновить папки</Btn></Empty></div>
          : !folder.listing && busy ? <div className="p-4 text-xs text-slate-500 dark:text-slate-400">Открываю папку…</div>
          : !visibleEntries.length ? <div className="p-4"><Empty title={query ? 'Файлы не найдены' : 'Папка пуста'} text={query ? 'Измените поисковый запрос.' : 'Нажмите правую кнопку мыши и выберите «Создать» или добавьте файл средствами Windows.'} /></div>
          : <div ref={folder.scrollRef} className="flex-1 min-h-0 overflow-auto">
        {layout === 'list' ? table : <div data-entries-grid className="grid grid-cols-2 @[650px]:grid-cols-3 @[950px]:grid-cols-5 gap-1.5 p-2">{visibleEntries.map((entry) => <button type="button" key={`${entry.relativePath}:${entry.draftId || ''}`} data-entry-key={entry.fileId} data-entry-name onMouseDown={keepFocus} aria-selected={selection.isSelected(entry)} onClick={(e) => selection.click(entry, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })} onDoubleClick={() => openEntry(entry)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); selection.context(entry); setContextMenu({ x: e.clientX, y: e.clientY, entry }); }} className="select-none min-h-20 flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-slate-50 dark:hover:bg-slate-800 aria-selected:bg-slate-100 dark:aria-selected:bg-slate-800"><EntryIcon entry={entry} rootId={rootId} large /><span className="min-w-0"><span className="block truncate text-xs">{entry.name}</span><span className="block text-xs text-slate-500 dark:text-slate-400">{entry.storage === 'flux' ? 'Только в Flux' : entry.kind === 'directory' ? 'Папка' : fileSize(entry.size)}</span></span></button>)}</div>}
            {folder.nextOffset !== null && <div className="flex justify-center p-3"><Btn onClick={() => void folder.loadMore()} disabled={busy}><ArrowDown className="w-3.5 h-3.5" /> Показать ещё</Btn></div>}
          </div>}
      </main>
    </div>
    <footer className="min-h-8 border-t border-slate-200 dark:border-slate-800 px-2 py-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <span>{visibleEntries.length}{folder.listing?.truncated ? '+' : ''} объектов{selection.selected.length > 1 ? ` · выбрано ${selection.selected.length}` : ''}{query ? ' по запросу' : ''}</span><span className="flex-1" />
      {ops.clip && <><span>{ops.clip.cut ? 'Вырезан' : 'Скопирован'}{ops.clip.items.length > 1 ? `о объектов: ${ops.clip.items.length}` : `: ${ops.clip.items[0].name}`}</span><Btn tone="ghost" onClick={() => void ops.paste()} disabled={!folderRef || busy}><Clipboard className="w-3.5 h-3.5" /> Вставить</Btn><Btn tone="ghost" onClick={ops.clear}>Отмена</Btn></>}
      {selection.selected.length > 0 && <div className="flex items-center gap-1 overflow-auto">{single && single.kind === 'file' && user?.id && !root?.network && <Btn tone="ghost" onClick={() => setShareEntry(single)}>Общий доступ…</Btn>}{single && <Btn tone="ghost" onClick={() => void openProperties(single)}>Свойства</Btn>}{single && <Btn tone="ghost" onClick={() => openEntry(single)}>Открыть</Btn>}{single && <Btn tone="ghost" onClick={() => setRename({ ref: entryRef(single, rootId), name: single.name })}>Переименовать</Btn>}<Btn tone="ghost" onClick={() => void ops.copy(selection.selected)}><Copy className="w-3.5 h-3.5" /> Копировать</Btn><Btn tone="ghost" onClick={() => void ops.cut(selection.selected)}><Scissors className="w-3.5 h-3.5" /> Вырезать</Btn>{single && single.storage === 'flux' && <Btn tone="ghost" onClick={() => void publishDraft(single)}><Upload className="w-3.5 h-3.5" /> Опубликовать</Btn>}{single && <Btn tone="ghost" onClick={() => void action({ action: 'reveal', ref: entryRef(single, rootId) }, 'Папка открыта в Windows')}><ExternalLink className="w-3.5 h-3.5" /> Показать</Btn>}<Btn tone="danger" onClick={() => void ops.trash(selection.selected)}><Trash2 className="w-3.5 h-3.5" /> В корзину</Btn></div>}
    </footer>

    {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} items={selection.selected.length > 1 && selection.isSelected(contextMenu.entry) ? [
      // Выбрано несколько: единичные действия (открыть, переименовать, свойства) не показываем
      { label: 'Копировать', onClick: () => void ops.copy(selection.selected) },
      { label: 'Вырезать', onClick: () => void ops.cut(selection.selected) },
      { label: `Переместить в корзину (${selection.selected.length})`, danger: true, separated: true, onClick: () => void ops.trash(selection.selected) },
    ] : [
      { label: 'Открыть', onClick: () => openEntry(contextMenu.entry) },
      { label: 'Свойства', onClick: () => void openProperties(contextMenu.entry) },
      ...(contextMenu.entry.kind === 'file' && user?.id && !root?.network ? [{ label: 'Общий доступ…', onClick: () => setShareEntry(contextMenu.entry) }] : []),
      ...(root?.network ? [{ label: 'Общая папка в Windows', onClick: () => void action({ action: 'reveal', ref: entryRef(contextMenu.entry, rootId) }) }] : []),
      { label: 'Переименовать', onClick: () => setRename({ ref: entryRef(contextMenu.entry, rootId), name: contextMenu.entry.name }) },
      { label: 'Копировать', onClick: () => void ops.copy([contextMenu.entry]) },
      { label: 'Вырезать', onClick: () => void ops.cut([contextMenu.entry]) },
      ...(contextMenu.entry.storage === 'flux' ? [{ label: 'Опубликовать в Windows', onClick: () => void publishDraft(contextMenu.entry) }] : []),
      { label: 'Переместить в корзину', danger: true, separated: true, onClick: () => void ops.trash([contextMenu.entry]) },
    ]} />}

    {freeMenu && <ContextMenu x={freeMenu.x} y={freeMenu.y} onClose={() => setFreeMenu(null)} items={[
      { label: 'Вид', items: [{ label: 'Список', onClick: () => setLayout('list') }, { label: 'Значки', onClick: () => setLayout('tiles') }] },
      { label: 'Обновить', onClick: () => void folder.reload() },
      panel.menuItem(),
      ...(ops.clip ? [{ label: 'Вставить', onClick: () => void ops.paste() }] : []),
    ]} />}

    {shareEntry && user?.id && !root?.network && <FileShareDialog actorId={user.id} source={entryRef(shareEntry, rootId)} name={shareEntry.name} onClose={() => setShareEntry(null)} onChanged={() => setSharingGeneration((value) => value + 1)} />}
    {propsEntry && <PropertiesDialog entry={propsEntry} rootId={rootId} metadata={metadata} projects={projects} tags={tags} activeProjectId={activeProject?.id || ''} draftTags={draftTags} setDraftTags={setDraftTags} draftProjects={draftProjects} setDraftProjects={setDraftProjects} revision={revision} setRevision={setRevision} responsible={responsible} setResponsible={setResponsible} tagQuery={tagQuery} setTagQuery={setTagQuery} busy={busy} onClose={() => { metadataRequest.current++; setPropsEntry(null); setMetadata(null); setActing(false); }} onSave={() => void saveProperties()} />}
    {rename && <Dialog title="Переименовать" onClose={() => setRename(null)} footer={<><Btn onClick={() => setRename(null)}>Отмена</Btn><Btn tone="primary" onClick={() => void renameSelected()} disabled={!rename.name.trim() || busy}>Переименовать</Btn></>}><Field label="Новое имя"><Input autoFocus value={rename.name} onChange={(e) => setRename({ ...rename, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void renameSelected(); }} /></Field></Dialog>}
    {panel.element}
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
