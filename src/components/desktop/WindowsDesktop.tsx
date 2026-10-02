import React from 'react';
import { useNavigate } from 'react-router-dom';
import ContextMenu, { type MenuItem } from '../ContextMenu';
import {
  Archive, FileSpreadsheet, FileText, Folder, FolderPlus, MoreVertical,
  Plus, RefreshCw, Shapes, Trash2, ExternalLink,
} from 'lucide-react';
import { SECTIONS } from '../../workspace/sections';
import { visibleSections } from '../../lib/appPolicy';
import { useAppContext } from '../../store/policyStore';
import { useDesktopStore } from '../../store/desktopStore';
import { useModalStore } from '../../store/modalStore';
import { useToastStore } from '../../store/toastStore';
import { blankBytes } from '../../lib/blankFiles';
import {
  bytesToBase64, fileRefHref, folderRefHref, onWindowsFilesChanged, windowsFilesRequest,
  type WindowsFileEntry, type WindowsFileRef, type WindowsRoot,
} from '../../lib/windowsFiles';

type Cell = { col: number; row: number };
type DesktopItem =
  | { id: string; kind: 'app'; path: string; title: string; icon?: React.ComponentType<any> }
  | { id: string; kind: 'file'; entry: WindowsFileEntry };
type CreateKind = 'folder' | 'doc' | 'sheet' | 'markdown';
const LAYOUT_PREFIX = 'flux_windows_desktop_cells_v1:';
const CELL_WIDTH = 104;
const CELL_HEIGHT = 100;
const ROOT_REF = (rootId: string): WindowsFileRef => ({ rootId, relativePath: '' });

/** Клетки принадлежат локальной раскладке этого корня, ключ элемента — только fileId. */
export function layoutWindowsDesktop(ids: string[], saved: Record<string, Cell>, columns: number): Record<string, Cell> {
  const cols = Math.max(1, Math.floor(columns));
  const result: Record<string, Cell> = {};
  const taken = new Set<string>();
  const freeCell = (): Cell => {
    let index = 0;
    while (taken.has(`${index % cols}:${Math.floor(index / cols)}`)) index++;
    return { col: index % cols, row: Math.floor(index / cols) };
  };
  for (const id of ids) {
    const cell = saved[id];
    const key = cell ? `${cell.col}:${cell.row}` : '';
    if (cell && Number.isInteger(cell.col) && cell.col >= 0 && cell.col < cols && Number.isInteger(cell.row) && cell.row >= 0 && !taken.has(key)) {
      result[id] = cell;
      taken.add(key);
    } else {
      const next = freeCell();
      result[id] = next;
      taken.add(`${next.col}:${next.row}`);
    }
  }
  return result;
}

function readCells(rootId: string): Record<string, Cell> {
  try {
    const raw = localStorage.getItem(`${LAYOUT_PREFIX}${rootId}`);
    const value = raw ? JSON.parse(raw) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writeCells(rootId: string, cells: Record<string, Cell>) {
  try { localStorage.setItem(`${LAYOUT_PREFIX}${rootId}`, JSON.stringify(cells)); } catch { /* Локальная раскладка необязательна в приватном режиме. */ }
}

const entryRef = (rootId: string, entry: WindowsFileEntry): WindowsFileRef => ({ rootId, relativePath: entry.relativePath, ...(entry.draftId ? { draftId: entry.draftId } : {}) });
const fileTitle = (name: string) => name.replace(/\.[^.]+$/u, '');
const fileIcon = (entry: WindowsFileEntry) => {
  if (entry.kind === 'directory') return Folder;
  const extension = entry.name.split('.').pop()?.toLowerCase();
  if (['doc', 'docx', 'odt', 'rtf', 'md', 'txt'].includes(extension || '')) return FileText;
  if (['xls', 'xlsx', 'csv', 'ods'].includes(extension || '')) return FileSpreadsheet;
  return Archive;
};

export default function WindowsDesktop() {
  const navigate = useNavigate();
  const context = useAppContext();
  const allowedSections = React.useMemo(() => visibleSections(SECTIONS, context).filter((section) => !section.fileOnly), [context]);
  const apps = useDesktopStore((state) => state.apps);
  const pinApp = useDesktopStore((state) => state.pinApp);
  const unpinApp = useDesktopStore((state) => state.unpinApp);
  const openConfirm = useModalStore((state) => state.openConfirm);
  const addToast = useToastStore((state) => state.addToast);
  const areaRef = React.useRef<HTMLDivElement>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const [root, setRoot] = React.useState<WindowsRoot | null>(null);
  const [entries, setEntries] = React.useState<WindowsFileEntry[]>([]);
  const [cells, setCells] = React.useState<Record<string, Cell>>({});
  const [area, setArea] = React.useState({ width: 900, height: 600 });
  const [selected, setSelected] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [creating, setCreating] = React.useState<CreateKind | null>(null);
  const [name, setName] = React.useState('');
  const [menu, setMenu] = React.useState<{ x: number; y: number; itemId: string | null } | null>(null);
  const dragged = React.useRef<string | null>(null);

  const refresh = React.useCallback(async (rootId?: string) => {
    setLoading(true);
    setError('');
    const rootsResult = await windowsFilesRequest<WindowsRoot[]>({ action: 'roots' });
    if ('error' in rootsResult) { setError(rootsResult.error.message); setLoading(false); return; }
    const desktop = rootsResult.data.find((item) => item.kind === 'desktop');
    if (!desktop) { setRoot(null); setEntries([]); setError('Папка «Рабочий стол» Windows не подключена.'); setLoading(false); return; }
    if (!desktop.available) { setRoot(desktop); setEntries([]); setError('Папка «Рабочий стол» Windows сейчас недоступна.'); setLoading(false); return; }
    setRoot(desktop);
    if (rootId !== desktop.id) setCells(readCells(desktop.id));
    const allEntries: WindowsFileEntry[] = [];
    let offset = 0;
    while (true) {
      const listed = await windowsFilesRequest<{ entries: WindowsFileEntry[]; nextOffset: number | null }>({ action: 'list', ref: ROOT_REF(desktop.id), offset, limit: 500 });
      if ('error' in listed) { setError(listed.error.message); setEntries([]); setLoading(false); return; }
      allEntries.push(...(listed.data.entries || []));
      if (listed.data.nextOffset === null) break;
      offset = listed.data.nextOffset;
    }
    setEntries(allEntries);
    setLoading(false);
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);
  React.useEffect(() => {
    const element = areaRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      setArea({ width: rect.width, height: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  React.useEffect(() => {
    if (!root) return;
    let alive = true;
    const ref = ROOT_REF(root.id);
    void windowsFilesRequest({ action: 'watch', ref });
    const off = onWindowsFilesChanged((change) => {
      if (alive && change.rootId === root.id) void refresh(root.id);
    });
    return () => { alive = false; off(); void windowsFilesRequest({ action: 'unwatch', ref }); };
  }, [root?.id, refresh]);
  React.useEffect(() => {
    if (creating) nameRef.current?.focus();
  }, [creating]);
  React.useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); };
  }, []);

  const allowedByPath = React.useMemo(() => new Map(allowedSections.map((section) => [section.path, section])), [allowedSections]);
  const pinnedApps = apps.filter((path) => allowedByPath.has(path));
  const fileItems: DesktopItem[] = entries.map((entry) => ({ id: entry.fileId, kind: 'file', entry }));
  const appItems: DesktopItem[] = pinnedApps.map((path) => {
    const section = allowedByPath.get(path)!;
    return { id: `app:${path}`, kind: 'app', path, title: section.title, icon: section.icon as React.ComponentType<any> };
  });
  const items = [...appItems, ...fileItems];
  const columns = Math.max(1, Math.floor((area.width - 24) / CELL_WIDTH));
  const positions = React.useMemo(() => layoutWindowsDesktop(items.map((item) => item.id), cells, columns), [items.map((item) => item.id).join('|'), cells, columns]);

  const placeCells = (patch: Record<string, Cell>) => {
    if (!root) return;
    const next = { ...cells, ...patch };
    setCells(next);
    writeCells(root.id, next);
  };

  const openItem = (item: DesktopItem) => {
    if (item.kind === 'app') { navigate(item.path); return; }
    if (!root) return;
    const ref = entryRef(root.id, item.entry);
    if (item.entry.kind === 'directory') navigate(folderRefHref(ref));
    else if (item.entry.kind === 'file') navigate(fileRefHref(ref));
    else void windowsFilesRequest({ action: 'open', ref }).then((result) => { if ('error' in result) addToast(result.error.message, 'error'); });
  };

  const invoke = async (request: Parameters<typeof windowsFilesRequest>[0]) => {
    const result = await windowsFilesRequest(request);
    if ('error' in result) { addToast(result.error.message, 'error'); return null; }
    return result.data;
  };

  const beginCreate = (kind: CreateKind) => {
    setMenu(null);
    const defaults: Record<CreateKind, string> = { folder: 'Новая папка', doc: 'Новый документ.docx', sheet: 'Новая таблица.xlsx', markdown: 'Новая заметка.md' };
    setName(defaults[kind]);
    setCreating(kind);
  };

  const create = async () => {
    if (!root || !creating) return;
    const cleanName = name.trim();
    if (!cleanName || /[\\/:*?"<>|]/u.test(cleanName)) { addToast('Укажите имя без символов \\/ : * ? " < > |', 'error'); return; }
    const parent = ROOT_REF(root.id);
    try {
      if (creating === 'folder') {
        const result = await invoke({ action: 'mkdir', parent, name: cleanName });
        if (result) { setCreating(null); await refresh(root.id); addToast('Папка создана на рабочем столе Windows', 'success'); }
        return;
      }
      const extension = creating === 'doc' ? '.docx' : creating === 'sheet' ? '.xlsx' : '.md';
      const finalName = cleanName.toLowerCase().endsWith(extension) ? cleanName : `${cleanName}${extension}`;
      const bytes = creating === 'doc' ? await blankBytes('doc') : creating === 'sheet' ? await blankBytes('sheet') : new TextEncoder().encode('# Новая заметка\n');
      const result = await invoke({ action: 'createDraft', parent, name: finalName, base64: bytesToBase64(bytes) }) as { ref?: WindowsFileRef } | null;
      if (result?.ref) { setCreating(null); await refresh(root.id); navigate(fileRefHref(result.ref)); addToast('Черновик создан в Flux', 'success'); }
    } catch (cause: any) { addToast(cause?.message || 'Не удалось создать файл', 'error'); }
  };

  const doProperties = async (entry: WindowsFileEntry) => {
    if (!root) return;
    const ref = entryRef(root.id, entry);
    const result = await invoke({ action: 'metadata', ref });
    if (result) navigate(fileRefHref(ref, { properties: true }));
    setMenu(null);
  };

  const doTrash = async (entry: WindowsFileEntry) => {
    if (!root) return;
    const fromFlux = !!entry.draftId;
    const noun = entry.kind === 'directory' ? 'папку' : 'файл';
    const ok = await openConfirm(fromFlux ? 'Удалить черновик Flux?' : `Переместить ${noun} в Корзину Windows?`, fromFlux ? `Черновик «${entry.name}» будет удалён из локального списка Flux.` : `«${entry.name}» будет отправлен в системную корзину.`, { confirmLabel: fromFlux ? 'Удалить' : 'В Корзину', tone: 'danger' });
    if (!ok) return;
    const result = await invoke({ action: 'trash', ref: entryRef(root.id, entry) });
    if (result) { setSelected(null); await refresh(root.id); addToast(fromFlux ? 'Черновик удалён' : `${entry.kind === 'directory' ? 'Папка' : 'Файл'} перемещён в Корзину Windows`, 'success'); }
    setMenu(null);
  };

  const contextMenu = (event: React.MouseEvent, itemId: string | null) => {
    event.preventDefault(); event.stopPropagation();
    if (itemId) setSelected(itemId);
    setMenu({ x: Math.min(event.clientX, window.innerWidth - 230), y: Math.min(event.clientY, window.innerHeight - 240), itemId });
  };
  const current = items.find((item) => item.id === menu?.itemId);
  const select = (event: React.MouseEvent, item: DesktopItem) => {
    setSelected((old) => event.ctrlKey || event.metaKey ? old === item.id ? null : item.id : item.id);
  };

  const addableApps = allowedSections.filter((section) => !section.fileOnly && !pinnedApps.includes(section.path));
  const contents = items.length === 0 && !loading && !error;

  return (
    <section className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50 text-slate-800 dark:border-dark-border dark:bg-dark-bg dark:text-slate-100" aria-label="Рабочий стол Windows">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white/80 px-3 py-2 dark:border-dark-border dark:bg-dark-surface/80">
        <div className="mr-auto min-w-0"><h1 className="truncate text-base font-semibold">Рабочий стол</h1><p className="truncate text-xs text-slate-500 dark:text-slate-400">{root?.name || 'Файлы с этого компьютера'}</p></div>
        <button type="button" onClick={() => void refresh(root?.id)} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-sm hover:bg-slate-100 dark:border-dark-border dark:hover:bg-dark-surface" aria-label="Обновить файлы Windows"><RefreshCw size={15} />Обновить</button>
        <button type="button" onClick={(event) => contextMenu(event as any, null)} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-sm hover:bg-slate-100 dark:border-dark-border dark:hover:bg-dark-surface"><Plus size={15} />Создать</button>
      </header>
      {error && <div role="status" className="m-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">{error}</div>}
      {loading && <div className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">Читаем Рабочий стол Windows…</div>}
      <div ref={areaRef} className="relative min-h-0 flex-1 overflow-auto p-3" onContextMenu={(event) => contextMenu(event, null)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = dragged.current || event.dataTransfer.getData('text/plain'); dragged.current = null; const rect = areaRef.current?.getBoundingClientRect(); if (!id || !rect) return; const col = Math.min(columns - 1, Math.max(0, Math.floor((event.clientX - rect.left - 12) / CELL_WIDTH))); const row = Math.max(0, Math.floor((event.clientY - rect.top - 12) / CELL_HEIGHT)); const occupied = Object.entries(positions).find(([otherId, at]) => otherId !== id && at.col === col && at.row === row)?.[0]; const patch: Record<string, Cell> = { [id]: { col, row } }; if (occupied) patch[occupied] = positions[id] || { col: 0, row: 0 }; placeCells(patch); }}>
        {!error && !loading && contents && <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-slate-500 dark:text-slate-400">На Рабочем столе Windows пока пусто. Создайте папку или документ либо закрепите ярлык Flux.</div>}
        {!error && !loading && items.length > 0 && (
          <div className="grid min-h-full auto-rows-[92px] gap-1" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, ${CELL_WIDTH}px))`, gridAutoRows: `${CELL_HEIGHT}px` }}>
            {items.map((item) => {
              const cell = positions[item.id] || { col: 0, row: 0 };
              const Icon = item.kind === 'app' ? item.icon || Shapes : fileIcon(item.entry);
              const title = item.kind === 'app' ? item.title : fileTitle(item.entry.name);
              const isSelected = selected === item.id;
              return <div key={item.id} role="button" tabIndex={0} draggable onClick={(event) => select(event, item)} onDoubleClick={() => openItem(item)} onContextMenu={(event) => contextMenu(event, item.id)} onKeyDown={(event) => { if (event.key === 'Enter') openItem(item); if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) contextMenu(event as any, item.id); }} onDragStart={(event) => { dragged.current = item.id; event.dataTransfer.setData('text/plain', item.id); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const id = dragged.current || event.dataTransfer.getData('text/plain'); dragged.current = null; if (!id || id === item.id) return; const from = positions[id]; const to = positions[item.id]; if (from && to) placeCells({ [id]: to, [item.id]: from }); }} className={`group flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-2 text-center outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${isSelected ? 'bg-sky-100 ring-1 ring-sky-400 dark:bg-sky-950/50 dark:ring-sky-700' : 'hover:bg-slate-200/70 dark:hover:bg-dark-surface/70'}`} style={{ gridColumn: cell.col + 1, gridRow: cell.row + 1 }}>
                <Icon size={32} className={`shrink-0 ${item.kind === 'app' ? 'text-slate-600 dark:text-slate-300' : item.entry.kind === 'directory' ? 'text-amber-600 dark:text-amber-400' : 'text-sky-700 dark:text-sky-300'}`} />
                <span className="line-clamp-2 w-full break-words text-xs leading-4" title={item.kind === 'app' ? item.title : item.entry.name}>{title}</span>
                {item.kind === 'file' && item.entry.draftId && <span className="text-xs text-slate-500 dark:text-slate-400">Черновик Flux</span>}
              </div>;
            })}
          </div>
        )}
      </div>

      {creating && <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreating(null); }}><div role="dialog" aria-modal="true" aria-labelledby="windows-create-title" className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-md dark:border-dark-border dark:bg-dark-surface"><h2 id="windows-create-title" className="text-lg font-semibold">{creating === 'folder' ? 'Новая папка Windows' : 'Новый файл на рабочем столе'}</h2><p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{creating === 'folder' ? 'Папка появится в настоящем каталоге Windows.' : 'Flux создаст зашифрованно отслеживаемый черновик и откроет его в редакторе.'}</p><label className="mt-4 block text-sm">Имя<input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void create(); if (event.key === 'Escape') setCreating(null); }} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-dark-border dark:bg-dark-bg" /></label><div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setCreating(null)} className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-dark-border">Отмена</button><button type="button" onClick={() => void create()} className="rounded-md bg-slate-700 px-3 py-2 text-sm text-white hover:bg-slate-600">Создать</button></div></div></div>}

      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={current?.kind === 'file' ? [
        { label: current.entry.kind === 'directory' ? 'Открыть папку' : 'Открыть в Flux', icon: <ExternalLink />, onClick: () => openItem(current) },
        { label: 'Открыть в Windows', icon: <ExternalLink />, onClick: () => void invoke({ action: 'open', ref: entryRef(root!.id, current.entry) }) },
        { label: 'Показать в Проводнике', icon: <Folder />, onClick: () => void invoke({ action: 'reveal', ref: entryRef(root!.id, current.entry) }) },
        { label: 'Свойства файла', icon: <MoreVertical />, onClick: () => void doProperties(current.entry) },
        { label: current.entry.draftId ? 'Удалить черновик' : 'В Корзину Windows', icon: <Trash2 />, danger: true, onClick: () => void doTrash(current.entry) },
      ] satisfies MenuItem[] : current?.kind === 'app' ? [
        { label: 'Убрать ярлык Flux', icon: <Trash2 />, onClick: () => unpinApp(current.path) },
      ] : [
        { label: 'Создать папку', icon: <FolderPlus />, onClick: () => beginCreate('folder') },
        { label: 'Документ Flux', icon: <FileText />, onClick: () => beginCreate('doc') },
        { label: 'Таблица Flux', icon: <FileSpreadsheet />, onClick: () => beginCreate('sheet') },
        { label: 'Заметка Markdown', icon: <FileText />, onClick: () => beginCreate('markdown') },
        ...addableApps.slice(0, 12).map((section, index) => ({ label: section.title, separated: index === 0, onClick: () => pinApp(section.path) })),
      ]} />}
    </section>
  );
}
