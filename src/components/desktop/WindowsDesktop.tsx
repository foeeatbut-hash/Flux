import React from 'react';
import { useNavigate } from 'react-router-dom';
import ContextMenu, { type MenuItem } from '../ContextMenu';
import { ArrowUpDown, FileSpreadsheet, FileText, Folder, FolderPlus,
  Monitor, MoreVertical, Palette, RefreshCw, Rows3, Shapes, Trash2, ExternalLink } from 'lucide-react';
import { useModalStore } from '../../store/modalStore';
import { useToastStore } from '../../store/toastStore';
import { blankBytes } from '../../lib/blankFiles';
import type { ShellDesktopSnapshot, ShellDesktopItem, ShellDesktopBridge } from '../../../filesystem/shellDesktop';
import FileShareDialog from '../explorer/FileShareDialog';
import { useStore } from '../../store/store';
import { sharedSourceHref } from '../../services/fileSharingService';
import {
  bytesToBase64, fileRefHref, folderRefHref, onWindowsFilesChanged, windowsFilesRequest,
  type WindowsFileEntry, type WindowsFileRef, type WindowsRoot,
} from '../../lib/windowsFiles';
import { NativeWindowsFileIcon } from '../explorer/WindowsFileIcon';

type Cell = { col: number; row: number };
type DesktopItem =
  | { id: string; kind: 'file'; entry: WindowsFileEntry }
  | { id: string; kind: 'shell'; item: ShellDesktopItem };
type CreateKind = 'windows-folder' | 'windows-doc' | 'windows-sheet' | 'windows-text';
const LAYOUT_PREFIX = 'flux_windows_desktop_cells_v1:';
const CELL_WIDTH = 104;
const CELL_HEIGHT = 100;
const ROOT_REF = (rootId: string): WindowsFileRef => ({ rootId, relativePath: '' });
const shellBridge = () => (window as any).electron?.desktopShell as ShellDesktopBridge | undefined;

export function sortWindowsDesktopEntries(entries: WindowsFileEntry[], by: 'name' | 'type' | 'modified'): WindowsFileEntry[] {
  const compare = (a: WindowsFileEntry, b: WindowsFileEntry) => by === 'modified'
    ? b.modifiedAt.localeCompare(a.modifiedAt)
    : by === 'type'
      ? (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return [...entries].sort(compare);
}

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
export default function WindowsDesktop({ screenOrigin }: { screenOrigin?: { x: number; y: number } } = {}) {
  const navigate = useNavigate();
  const openConfirm = useModalStore((state) => state.openConfirm);
  const addToast = useToastStore((state) => state.addToast);
  const userId = useStore((state) => state.user?.id);
  const areaRef = React.useRef<HTMLDivElement>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const [root, setRoot] = React.useState<WindowsRoot | null>(null);
  const [entries, setEntries] = React.useState<WindowsFileEntry[]>([]);
  const [shellDesktop, setShellDesktop] = React.useState<ShellDesktopSnapshot | null>(null);
  const [cells, setCells] = React.useState<Record<string, Cell>>({});
  const [area, setArea] = React.useState({ width: 900, height: 600 });
  const [areaOffset, setAreaOffset] = React.useState({ x: 0, y: 0 });
  const [selected, setSelected] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [creating, setCreating] = React.useState<CreateKind | null>(null);
  const [name, setName] = React.useState('');
  const [menu, setMenu] = React.useState<{ x: number; y: number; itemId: string | null } | null>(null);
  const [sortBy, setSortBy] = React.useState<'name' | 'type' | 'modified'>('name');
  const [iconScale, setIconScale] = React.useState<'small' | 'medium' | 'large'>('medium');
  const [shareEntry, setShareEntry] = React.useState<WindowsFileEntry | null>(null);
  const dragged = React.useRef<string | null>(null);
  const refreshEpoch = React.useRef(0);
  const refreshFlight = React.useRef<{ pending: boolean; rootId?: string; promise: Promise<void> } | null>(null);

  const refresh = React.useCallback(async (rootId?: string) => {
    if (refreshFlight.current) {
      refreshFlight.current.pending = true;
      refreshFlight.current.rootId = rootId;
      refreshEpoch.current++;
      return refreshFlight.current.promise;
    }
    setLoading(true);
    setError('');
    const flight: { pending: boolean; rootId?: string; epoch: number; promise: Promise<void> } = { pending: false, rootId, epoch: ++refreshEpoch.current, promise: Promise.resolve() };
    flight.promise = (async () => {
      try {
        const rootsResult = await windowsFilesRequest<WindowsRoot[]>({ action: 'roots' });
        if ('error' in rootsResult) { setError(rootsResult.error.message); return; }
        const desktop = rootsResult.data.find((item) => item.kind === 'desktop');
        if (!desktop) { setError('Папка «Рабочий стол» Windows не подключена.'); return; }
        if (!desktop.available) { setError('Папка «Рабочий стол» Windows сейчас недоступна.'); return; }
        const allEntries: WindowsFileEntry[] = [];
        let offset = 0;
        while (true) {
          const listed = await windowsFilesRequest<{ entries: WindowsFileEntry[]; nextOffset: number | null }>({ action: 'list', ref: ROOT_REF(desktop.id), offset, limit: 500 });
          if ('error' in listed) { setError(listed.error.message); return; }
          allEntries.push(...(listed.data.entries || []));
          if (listed.data.nextOffset === null) break;
          offset = listed.data.nextOffset;
        }
        // Swap only a complete scan into view; a failed refresh leaves the last
        // known list, including Flux drafts, visible.
        if (refreshEpoch.current !== flight.epoch) return;
        setRoot(desktop);
        if (rootId !== desktop.id) setCells(readCells(desktop.id));
        setEntries(allEntries);
      } catch (cause: any) {
        if (refreshEpoch.current === flight.epoch) setError(cause?.message || 'Не удалось обновить Рабочий стол Windows.');
      } finally {
        if (!flight.pending && refreshEpoch.current === flight.epoch) setLoading(false);
        if (refreshFlight.current === flight) {
          refreshFlight.current = null;
          if (flight.pending) queueMicrotask(() => { void refresh(flight.rootId); });
        }
      }
    })();
    refreshFlight.current = flight;
    return flight.promise;
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);
  React.useEffect(() => {
    const element = areaRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      setArea({ width: rect.width, height: rect.height });
      setAreaOffset({ x: rect.left, y: rect.top });
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
    const api = shellBridge();
    if (!api) { setShellDesktop({ status: 'unsupported', message: 'Native shell bridge unavailable', revision: 'unavailable', items: [], view: null }); return; }
    let alive = true;
    let epoch = 0;
    const load = () => {
      const request = ++epoch;
      void api.snapshot().then((snapshot) => { if (alive && request === epoch) setShellDesktop(snapshot); }).catch(() => { if (alive && request === epoch) setShellDesktop({ status: 'unavailable', message: 'Native shell snapshot unavailable', revision: 'unavailable', items: [], view: null }); });
    };
    load();
    const off = api.onChanged(load);
    return () => { alive = false; off(); };
  }, []);
  React.useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); };
  }, []);

  const shellReady = !!screenOrigin && shellDesktop?.status === 'ready' && !!shellDesktop.view?.iconsVisible;
  const nativeIconsHidden = shellDesktop?.status === 'ready' && !!screenOrigin && !shellDesktop.view?.iconsVisible;
  const fluxEntries = shellReady || nativeIconsHidden ? entries.filter((entry) => entry.storage === 'flux') : entries;
  const fileItems: Extract<DesktopItem, { kind: 'file' }>[] = sortWindowsDesktopEntries(fluxEntries, sortBy).map((entry) => ({ id: entry.fileId, kind: 'file', entry }));
  // Старые ярлыки приложений остаются файлами Windows на диске, но не
  // захламляют зеркальный стол: запуск программы теперь живёт в Пуске/задачах.
  const shellItems: Extract<DesktopItem, { kind: 'shell' }>[] = shellReady
    ? shellDesktop!.items.filter((item) => !item.isFluxAppShortcut).map((item) => ({ id: `shell:${item.id}`, kind: 'shell', item }))
    : [];
  // Windows shell entries stay at their exact reported coordinates. Flux
  // programs are available from Start and the taskbar, never from the desktop.
  const items = fileItems;
  const contextualItems: DesktopItem[] = [...items, ...shellItems];

  const placeCells = (patch: Record<string, Cell>) => {
    if (!root) return;
    const next = { ...cells, ...patch };
    setCells(next);
    writeCells(root.id, next);
  };

  const openItem = (item: DesktopItem) => {
    if (item.kind === 'shell') {
      if (item.item.fileRef) {
        const ref = item.item.fileRef;
        if (item.item.kind === 'directory') navigate(folderRefHref(ref));
        else if (userId) void sharedSourceHref(userId, ref, item.item.name).then((href) => navigate(href || fileRefHref(ref)))
          .catch((cause: any) => addToast(cause?.message || 'Не удалось проверить общий доступ', 'error'));
        else navigate(fileRefHref(ref));
        return;
      }
      void shellBridge()?.open(item.item.id).then((result) => { if (result && !result.ok) addToast(result.message || 'Не удалось открыть элемент рабочего стола Windows', 'error'); });
      return;
    }
    if (!root) return;
    const ref = entryRef(root.id, item.entry);
    if (item.entry.kind === 'directory') navigate(folderRefHref(ref));
    else if (item.entry.kind === 'file') {
      if (userId) void sharedSourceHref(userId, ref, item.entry.name).then((href) => navigate(href || fileRefHref(ref)))
        .catch((cause: any) => addToast(cause?.message || 'Не удалось проверить общий доступ', 'error'));
      else navigate(fileRefHref(ref));
    }
    else void windowsFilesRequest({ action: 'open', ref }).then((result) => { if ('error' in result) addToast(result.error.message, 'error'); });
  };

  const invoke = async (request: Parameters<typeof windowsFilesRequest>[0]) => {
    const result = await windowsFilesRequest(request);
    if ('error' in result) { addToast(result.error.message, 'error'); return null; }
    return result.data;
  };

  const beginCreate = (kind: CreateKind) => {
    setMenu(null);
    const defaults: Record<CreateKind, string> = {
      'windows-folder': 'Новая папка', 'windows-doc': 'Новый документ.docx',
      'windows-sheet': 'Новая таблица.xlsx', 'windows-text': 'Новый текстовый документ.txt',
    };
    setName(defaults[kind]);
    setCreating(kind);
  };

  const create = async () => {
    if (!root || !creating) return;
    const cleanName = name.trim();
    if (!cleanName || /[\\/:*?"<>|]/u.test(cleanName)) { addToast('Укажите имя без символов \\/ : * ? " < > |', 'error'); return; }
    const parent = ROOT_REF(root.id);
    try {
      if (creating === 'windows-folder') {
        const result = await invoke({ action: 'mkdir', parent, name: cleanName });
        if (result) { setCreating(null); await refresh(root.id); addToast('Папка создана на рабочем столе Windows', 'success'); }
        return;
      }
      const kind = creating.endsWith('doc') ? 'doc' : creating.endsWith('sheet') ? 'sheet' : null;
      const extension = creating.endsWith('doc') ? '.docx' : creating.endsWith('sheet') ? '.xlsx' : '.txt';
      const finalName = cleanName.toLowerCase().endsWith(extension) ? cleanName : `${cleanName}${extension}`;
      const bytes = kind ? await blankBytes(kind) : new TextEncoder().encode('');
      let result: any;
      // Документы публикуются в выбранной папке Windows, поэтому остаются
      // обычными файлами и получают значок программы, назначенной в системе.
      const draft = await invoke({ action: 'createDraft', parent, name: finalName, base64: bytesToBase64(bytes) }) as { ref?: WindowsFileRef } | null;
      if (!draft?.ref) return;
      result = await invoke({ action: 'publishDraft', ref: draft.ref });
      result = result as { ref?: WindowsFileRef } | null;
      if (result?.ref) {
        setCreating(null);
        await refresh(root.id);
        navigate(fileRefHref(result.ref));
        addToast('Файл создан на рабочем столе Windows', 'success');
      } else {
        // Публикация могла завершиться ошибкой после создания черновика; он
        // остаётся видимым, чтобы повторная попытка не затёрла пользовательские данные.
        setCreating(null);
        await refresh(root.id);
      }
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
    setMenu({ x: event.clientX, y: event.clientY, itemId });
  };
  const current = contextualItems.find((item) => item.id === menu?.itemId);
  const select = (event: React.MouseEvent, item: DesktopItem) => {
    setSelected((old) => event.ctrlKey || event.metaKey ? old === item.id ? null : item.id : item.id);
  };
  const arrange = (by: 'name' | 'type' | 'modified') => {
    setSortBy(by);
    if (!root) return;
    const ordered = sortWindowsDesktopEntries(fluxEntries, by).map((entry) => entry.fileId);
    placeCells(Object.fromEntries(ordered.map((id, index) => [id, { col: index % columns, row: Math.floor(index / columns) }])));
  };

  const contents = items.length === 0 && shellItems.length === 0 && !loading && !error;
  const cellSize = iconScale === 'small' ? { width: 88, height: 84, icon: 24 } : iconScale === 'large' ? { width: 120, height: 116, icon: 44 } : { width: CELL_WIDTH, height: CELL_HEIGHT, icon: 32 };
  const columns = Math.max(1, Math.floor((area.width - 24) / cellSize.width));
  const positions = React.useMemo(() => layoutWindowsDesktop(items.map((item) => item.id), cells, columns), [items.map((item) => item.id).join('|'), cells, columns]);
  const filesHiddenByShell = nativeIconsHidden && fluxEntries.length === 0;

  return (
    <section className="relative h-full min-h-0 w-full overflow-hidden bg-slate-100 text-slate-800 dark:bg-dark-bg dark:text-slate-100" aria-label="Рабочий стол Windows">
      {error && <div role="status" className="absolute left-3 top-3 z-10 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">{error}</div>}
      {screenOrigin && shellDesktop?.status !== 'ready' && shellDesktop && <div role="status" className="pointer-events-none absolute bottom-3 left-3 z-[2] rounded-md border border-slate-300/70 bg-white/80 px-2.5 py-1.5 text-xs text-slate-600 shadow-sm backdrop-blur dark:border-dark-border dark:bg-dark-surface/80 dark:text-slate-300">Расположение Windows недоступно. Отображаются файлы.</div>}
      {loading && <div className="absolute left-4 top-3 z-10 text-sm text-slate-500 dark:text-slate-400">Читаем Рабочий стол Windows…</div>}
      <div className="relative h-full min-h-0 w-full">
      <div ref={areaRef} className="absolute inset-0 overflow-hidden" onContextMenu={(event) => contextMenu(event, null)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = dragged.current || event.dataTransfer.getData('text/plain'); dragged.current = null; const rect = areaRef.current?.getBoundingClientRect(); if (!id || !rect) return; const col = Math.min(columns - 1, Math.max(0, Math.floor((event.clientX - rect.left) / cellSize.width))); const row = Math.max(0, Math.floor((event.clientY - rect.top) / cellSize.height)); const occupied = Object.entries(positions).find(([otherId, at]) => otherId !== id && at.col === col && at.row === row)?.[0]; const patch: Record<string, Cell> = { [id]: { col, row } }; if (occupied) patch[occupied] = positions[id] || { col: 0, row: 0 }; placeCells(patch); }}>
        {!error && !loading && contents && !filesHiddenByShell && <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-slate-500 dark:text-slate-400">На Рабочем столе Windows пока пусто. Создайте папку или документ.</div>}
        {shellItems.map((desktopItem) => {
          const left = desktopItem.item.position.x - screenOrigin!.x - areaOffset.x;
          const top = desktopItem.item.position.y - screenOrigin!.y - areaOffset.y;
          return <button key={desktopItem.id} type="button" aria-label={desktopItem.item.name} title={desktopItem.item.name}
            onDoubleClick={() => openItem(desktopItem)} onContextMenu={(event) => contextMenu(event, desktopItem.id)}
            className="absolute z-[1] flex flex-col items-center gap-1 rounded-md p-1 text-center text-xs hover:bg-sky-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-sky-900/40"
            style={{ left, top, width: Math.max(60, desktopItem.item.cell?.width || 96), minHeight: (desktopItem.item.icon?.height || 32) + 40 }}>
            {desktopItem.item.fileRef ? <NativeWindowsFileIcon entry={{ fileId: desktopItem.item.id, name: desktopItem.item.name, relativePath: desktopItem.item.fileRef.relativePath, kind: desktopItem.item.kind === 'directory' ? 'directory' : 'file', modifiedAt: '', size: 0, storage: 'windows' } as WindowsFileEntry} fileRef={desktopItem.item.fileRef} size={shellDesktop?.view?.iconSize || 32} /> : desktopItem.item.icon ? <img src={desktopItem.item.icon.dataUrl} alt="" draggable={false} style={{ width: desktopItem.item.icon.width, height: desktopItem.item.icon.height, objectFit: 'contain' }} /> : <Shapes size={shellDesktop?.view?.iconSize || 32} />}
            <span className="line-clamp-2 break-words leading-4 [text-shadow:0_1px_2px_white] dark:[text-shadow:0_1px_2px_black]">{desktopItem.item.name}</span>
          </button>;
        })}
        {!error && !loading && items.length > 0 && (
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${columns}, ${cellSize.width}px)`, gridAutoRows: `${cellSize.height}px` }}>
            {items.map((item) => {
              const cell = positions[item.id] || { col: 0, row: 0 };
              const title = fileTitle(item.entry.name);
              const isSelected = selected === item.id;
              return <div key={item.id} role="button" tabIndex={0} draggable onClick={(event) => select(event, item)} onDoubleClick={() => openItem(item)} onContextMenu={(event) => contextMenu(event, item.id)} onKeyDown={(event) => { if (event.key === 'Enter') openItem(item); if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) contextMenu(event as any, item.id); }} onDragStart={(event) => { dragged.current = item.id; event.dataTransfer.setData('text/plain', item.id); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const id = dragged.current || event.dataTransfer.getData('text/plain'); dragged.current = null; if (!id || id === item.id) return; const from = positions[id]; const to = positions[item.id]; if (from && to) placeCells({ [id]: to, [item.id]: from }); }} className={`group flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-2 text-center outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${isSelected ? 'bg-sky-100 ring-1 ring-sky-400 dark:bg-sky-950/50 dark:ring-sky-700' : 'hover:bg-slate-200/70 dark:hover:bg-dark-surface/70'}`} style={{ gridColumn: cell.col + 1, gridRow: cell.row + 1 }}>
                <NativeWindowsFileIcon entry={item.entry} fileRef={entryRef(root!.id, item.entry)} size={cellSize.icon} />
                <span className="line-clamp-2 w-full break-words text-xs leading-4" title={item.entry.name}>{title}</span>
                {item.entry.draftId && <span className="text-xs text-slate-500 dark:text-slate-400">Черновик Flux</span>}
              </div>;
            })}
          </div>
        )}
      </div>
      </div>

      {creating && <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreating(null); }}><div role="dialog" aria-modal="true" aria-labelledby="windows-create-title" className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-md dark:border-dark-border dark:bg-dark-surface"><h2 id="windows-create-title" className="text-lg font-semibold">{creating === 'windows-folder' ? 'Новая папка Windows' : 'Новый файл Windows'}</h2><p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Файл появится в настоящем каталоге Windows.</p><label className="mt-4 block text-sm">Имя<input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void create(); if (event.key === 'Escape') setCreating(null); }} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-dark-border dark:bg-dark-bg" /></label><div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setCreating(null)} className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-dark-border">Отмена</button><button type="button" onClick={() => void create()} className="rounded-md bg-slate-700 px-3 py-2 text-sm text-white hover:bg-slate-600">Создать</button></div></div></div>}

      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={current?.kind === 'file' ? [
        { label: current.entry.kind === 'directory' ? 'Открыть папку' : 'Открыть в Flux', icon: <ExternalLink />, onClick: () => openItem(current) },
        { label: 'Открыть в Windows', icon: <ExternalLink />, onClick: () => void invoke({ action: 'open', ref: entryRef(root!.id, current.entry) }) },
        { label: 'Показать в Проводнике', icon: <Folder />, onClick: () => void invoke({ action: 'reveal', ref: entryRef(root!.id, current.entry) }) },
        { label: 'Свойства файла', icon: <MoreVertical />, onClick: () => void doProperties(current.entry) },
        ...(current.entry.kind === 'file' ? [{ label: 'Общий доступ…', icon: <Folder />, onClick: () => setShareEntry(current.entry) }] : []),
        { label: current.entry.draftId ? 'Удалить черновик' : 'В Корзину Windows', icon: <Trash2 />, danger: true, onClick: () => void doTrash(current.entry) },
      ] satisfies MenuItem[] : current?.kind === 'shell' ? [
        { label: 'Открыть', icon: <ExternalLink />, onClick: () => openItem(current) },
      ] : [
        { label: 'Вид', icon: <Rows3 />, items: [
          ...(['small', 'medium', 'large'] as const).map((size) => ({ label: size === 'small' ? 'Мелкие значки' : size === 'large' ? 'Крупные значки' : 'Обычные значки', checked: iconScale === size, onClick: () => setIconScale(size) })),
        ] },
        { label: 'Сортировка', icon: <ArrowUpDown />, items: [
          ...([{ key: 'name', label: 'По имени' }, { key: 'type', label: 'По типу' }, { key: 'modified', label: 'По дате изменения' }] as const).map(({ key, label }) => ({ label, checked: sortBy === key, onClick: () => arrange(key) })),
        ] },
        { label: 'Обновить', icon: <RefreshCw />, onClick: () => { setMenu(null); void refresh(root?.id); } },
        { label: 'Создать Windows', icon: <FolderPlus />, items: [
          { label: 'Папку', icon: <Folder />, onClick: () => beginCreate('windows-folder') },
          { label: 'Документ Word', icon: <FileText />, onClick: () => beginCreate('windows-doc') },
          { label: 'Книгу Excel', icon: <FileSpreadsheet />, onClick: () => beginCreate('windows-sheet') },
          { label: 'Текстовый файл', icon: <FileText />, onClick: () => beginCreate('windows-text') },
        ] },
        { label: 'Параметры экрана', icon: <Monitor />, onClick: () => navigate('/settings?section=general#monitors') },
        { label: 'Персонализация', icon: <Palette />, onClick: () => navigate('/settings?section=general#appearance') },
      ]} />}
      {shareEntry && userId && root && <FileShareDialog actorId={userId} name={shareEntry.name} source={entryRef(root.id, shareEntry)} onClose={() => setShareEntry(null)} onChanged={() => void refresh(root.id)} />}
    </section>
  );
}
