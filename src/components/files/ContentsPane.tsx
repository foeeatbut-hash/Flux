import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { windowsFilesRequest, type WindowsFileEntry, type WindowsFileMetadata, type WindowsFileRef, type WindowsThumbnail } from '../../lib/windowsFiles';
import { NativeWindowsFileIcon } from '../explorer/WindowsFileIcon';
import { X as T, FONT_STACK } from './explorerTheme';
import { FOLDER_COLUMNS, contentsRows, extensionOf, type ContentsRow, type FolderColumn, type FolderLayout, type FolderView } from './viewModel';
import type { useSelection } from './useSelection';

type Selection = ReturnType<typeof useSelection>;
export interface ContentsPaneProps {
  entries: WindowsFileEntry[];
  rootId: string;
  selection: Selection;
  view: FolderView;
  onViewChange: (next: FolderView) => void;
  onOpen: (entry: WindowsFileEntry) => void;
  onContext: (event: React.MouseEvent, entry: WindowsFileEntry) => void;
  onDragStart?: (event: React.DragEvent, entry: WindowsFileEntry) => void;
  onDrop?: (event: React.DragEvent, entry: WindowsFileEntry) => void;
  scrollRef?: React.RefObject<HTMLDivElement>;
  loadMore?: () => void;
  hasMore?: boolean;
  busy?: boolean;
  editing?: { fileId: string; value: string; onChange: (name: string) => void; onCommit: () => void; onCancel: () => void };
}

const GRID_LAYOUTS = new Set<FolderLayout>(['extraLarge', 'large', 'medium', 'small', 'tiles']);
const COLUMN_LABEL = Object.fromEntries(FOLDER_COLUMNS.map((column) => [column.id, column.label])) as Record<FolderColumn, string>;
const THUMB_CACHE_LIMIT = 256;
const METADATA_CACHE_LIMIT = 512;
const THUMB_CONCURRENCY = 4;
type ThumbJob = { key: string; ref: WindowsFileRef; size: number; resolve: (url: string | null) => void };
type SystemProperties = { author: string; createdAt: string; hidden: boolean };
type SystemJob = { key: string; ref: WindowsFileRef; resolve: (value: SystemProperties | null) => void };
const thumbnailCache = new Map<string, Promise<string | null>>();
const metadataCache = new Map<string, WindowsFileMetadata>();
const metadataPending = new Map<string, Promise<WindowsFileMetadata | null>>();
const metadataQueue: Array<{ key: string; ref: WindowsFileRef; resolve: (value: WindowsFileMetadata | null) => void }> = [];
const systemPropertiesCache = new Map<string, SystemProperties>();
const systemPropertiesPending = new Map<string, Promise<SystemProperties | null>>();
const systemPropertiesQueue: SystemJob[] = [];
const thumbnailQueue: ThumbJob[] = [];
let activeThumbnails = 0;
let activeMetadata = 0;
let activeSystemProperties = 0;

const entryMetadataKey = (rootId: string, entry: WindowsFileEntry) => `${entry.rootId || rootId}\0${entry.relativePath}\0${entry.draftId || ''}\0${entry.modifiedAt}`;

function requestMetadata(key: string, ref: WindowsFileRef): Promise<WindowsFileMetadata | null> {
  const cached = metadataCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = metadataPending.get(key);
  if (pending) return pending;
  const result = new Promise<WindowsFileMetadata | null>((resolve) => {
    metadataQueue.push({ key, ref, resolve });
    pumpMetadata();
  });
  metadataPending.set(key, result);
  void result.finally(() => metadataPending.delete(key));
  return result;
}

function pumpMetadata() {
  while (activeMetadata < 4 && metadataQueue.length) {
    const job = metadataQueue.shift()!;
    activeMetadata++;
    void windowsFilesRequest<WindowsFileMetadata>({ action: 'metadata', ref: job.ref }).then((answer) => {
      const value = answer.ok ? answer.data : null;
      if (value) {
        metadataCache.set(job.key, value);
        if (metadataCache.size > METADATA_CACHE_LIMIT) metadataCache.delete(metadataCache.keys().next().value!);
      }
      job.resolve(value);
    }).catch(() => job.resolve(null)).finally(() => { activeMetadata--; pumpMetadata(); });
  }
}

function requestSystemProperties(key: string, ref: WindowsFileRef): Promise<SystemProperties | null> {
  const cached = systemPropertiesCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = systemPropertiesPending.get(key);
  if (pending) return pending;
  const result = new Promise<SystemProperties | null>((resolve) => {
    systemPropertiesQueue.push({ key, ref, resolve });
    pumpSystemProperties();
  });
  systemPropertiesPending.set(key, result);
  void result.finally(() => systemPropertiesPending.delete(key));
  return result;
}

function pumpSystemProperties() {
  while (activeSystemProperties < 4 && systemPropertiesQueue.length) {
    const job = systemPropertiesQueue.shift()!;
    activeSystemProperties++;
    void windowsFilesRequest<SystemProperties>({ action: 'systemProperties', ref: job.ref }).then((answer) => {
      const value = answer.ok ? answer.data : null;
      if (value) {
        systemPropertiesCache.set(job.key, value);
        if (systemPropertiesCache.size > METADATA_CACHE_LIMIT) systemPropertiesCache.delete(systemPropertiesCache.keys().next().value!);
      }
      job.resolve(value);
    }).catch(() => job.resolve(null)).finally(() => { activeSystemProperties--; pumpSystemProperties(); });
  }
}

function pumpThumbnails() {
  while (activeThumbnails < THUMB_CONCURRENCY && thumbnailQueue.length) {
    const job = thumbnailQueue.shift()!;
    activeThumbnails++;
    void windowsFilesRequest<WindowsThumbnail>({ action: 'thumbnail', ref: job.ref, size: job.size }).then((answer) => {
      const value = answer.ok && answer.data.dataUrl.startsWith('data:image/') ? answer.data.dataUrl : null;
      if (!value && thumbnailCache.get(job.key)) thumbnailCache.delete(job.key);
      job.resolve(value);
    }).catch(() => { thumbnailCache.delete(job.key); job.resolve(null); }).finally(() => { activeThumbnails--; pumpThumbnails(); });
  }
}

function requestThumbnail(ref: WindowsFileRef, size: number, modifiedAt: string): Promise<string | null> {
  const key = `${ref.rootId}\0${ref.relativePath}\0${ref.draftId || ''}\0${modifiedAt}\0${size}`;
  const cached = thumbnailCache.get(key);
  if (cached) return cached;
  let resolve!: (url: string | null) => void;
  const result = new Promise<string | null>((done) => { resolve = done; });
  thumbnailCache.set(key, result);
  if (thumbnailCache.size > THUMB_CACHE_LIMIT) thumbnailCache.delete(thumbnailCache.keys().next().value!);
  thumbnailQueue.push({ key, ref, size, resolve });
  pumpThumbnails();
  return result;
}

function Thumbnail({ entry, rootId, size }: { entry: WindowsFileEntry; rootId: string; size: number }) {
  const actualRootId = entry.rootId || rootId;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (entry.kind !== 'file') return () => { alive = false; };
    void requestThumbnail({ rootId: actualRootId, relativePath: entry.relativePath, ...(entry.draftId ? { draftId: entry.draftId } : {}) }, size, entry.modifiedAt)
      .then((value) => { if (alive) setUrl(value); });
    return () => { alive = false; };
  }, [entry.kind, entry.modifiedAt, entry.relativePath, entry.draftId, actualRootId, size]);
  return url
    ? <img src={url} alt="" draggable={false} width={size} height={size} className="shrink-0 rounded-sm object-contain" />
    : <NativeWindowsFileIcon entry={entry} fileRef={{ rootId: actualRootId, relativePath: entry.relativePath, ...(entry.draftId ? { draftId: entry.draftId } : {}) }} size={size} />;
}

function displayName(entry: WindowsFileEntry, extensions: boolean) {
  if (extensions || entry.kind !== 'file') return entry.name;
  const dot = entry.name.lastIndexOf('.');
  return dot > 0 ? entry.name.slice(0, dot) : entry.name;
}
function typeName(entry: WindowsFileEntry) { return entry.kind === 'directory' ? 'Папка' : entry.kind === 'link' ? 'Ссылка' : entry.kind === 'other' ? 'Другой объект' : extensionOf(entry.name).toLocaleUpperCase('ru') || 'Файл'; }
function formatSize(size: number) { return size < 1024 ? `${size} Б` : size < 1024 * 1024 ? `${(size / 1024).toFixed(0)} КБ` : `${(size / 1024 / 1024).toFixed(1)} МБ`; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }); }

function rowsForView(entries: WindowsFileEntry[], view: FolderView, columns: number): ContentsRow[][] {
  const source = contentsRows(entries, view);
  if (!GRID_LAYOUTS.has(view.layout)) return source.map((row) => [row]);
  const rows: ContentsRow[][] = [];
  let batch: ContentsRow[] = [];
  for (const row of source) {
    if (row.kind === 'group') {
      if (batch.length) { rows.push(batch); batch = []; }
      rows.push([row]);
    } else {
      batch.push(row);
      if (batch.length === columns) { rows.push(batch); batch = []; }
    }
  }
  if (batch.length) rows.push(batch);
  return rows;
}

function displayWidth(view: FolderView, id: FolderColumn) { return Math.min(800, Math.max(60, view.widths[id] ?? 140)); }

export default function ContentsPane({ entries, rootId, selection, view, onViewChange, onOpen, onContext, onDragStart, onDrop, scrollRef, loadMore, hasMore = false, busy = false, editing }: ContentsPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [containerHeight, setContainerHeight] = useState(500);
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number } | null>(null);
  const [rubberband, setRubberband] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const rubberStart = useRef<{ x: number; y: number } | null>(null);
  const resize = useRef<{ column: FolderColumn; x: number; width: number } | null>(null);
  const typeahead = useRef('');
  const typeaheadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedMoreAt = useRef<number | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => { setContainerWidth(element.clientWidth); setContainerHeight(element.clientHeight); };
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => { if (typeaheadTimer.current) clearTimeout(typeaheadTimer.current); }, []);

  const tileWidth = view.layout === 'extraLarge' ? 176 : view.layout === 'large' ? 142 : view.layout === 'medium' ? 124 : view.layout === 'small' || view.layout === 'tiles' ? 220 : 1;
  const gridColumns = GRID_LAYOUTS.has(view.layout) ? Math.max(1, Math.floor(containerWidth / tileWidth)) : 1;
  const shownEntries = useMemo(() => entries.filter((entry) => view.hidden || !(entry as WindowsFileEntry & { hidden?: boolean }).hidden), [entries, view.hidden]);
  const listRowsPerColumn = Math.max(1, Math.floor(containerHeight / 32));
  const listColumns = useMemo(() => {
    if (view.layout !== 'list') return [];
    const source = contentsRows(shownEntries, view);
    const columns: ContentsRow[][] = [];
    for (let offset = 0; offset < source.length; offset += listRowsPerColumn) columns.push(source.slice(offset, offset + listRowsPerColumn));
    return columns;
  }, [shownEntries, view, listRowsPerColumn]);
  const rows = useMemo(() => rowsForView(shownEntries, view, gridColumns), [shownEntries, view, gridColumns]);
  const rowSize = view.layout === 'extraLarge' ? 168 : view.layout === 'large' ? 132 : view.layout === 'medium' ? 104 : view.layout === 'small' ? 32 : view.layout === 'tiles' ? 76 : view.layout === 'content' ? 70 : view.layout === 'details' ? 34 : 30;
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => containerRef.current, estimateSize: (index) => rows[index]?.[0]?.kind === 'group' ? 30 : rowSize, overscan: 8 });
  const listVirtualizer = useVirtualizer({ count: listColumns.length, getScrollElement: () => containerRef.current, horizontal: true, estimateSize: () => 196, overscan: 2 });
  const visibleRows = view.layout === 'list' ? listVirtualizer.getVirtualItems() : virtualizer.getVirtualItems();
  const columns = view.columns;
  const iconSize = view.layout === 'extraLarge' ? 112 : view.layout === 'large' ? 72 : view.layout === 'medium' ? 48 : view.layout === 'small' ? 20 : 32;
  const thumbnailSize = Math.max(32, Math.min(256, iconSize * 2));
  const ordered = useMemo(() => contentsRows(shownEntries, view).flatMap((row) => row.kind === 'entry' ? [row.entry] : []), [shownEntries, view]);

  const [metadataValues, setMetadataValues] = useState<Record<string, WindowsFileMetadata | null>>({});
  const [systemValues, setSystemValues] = useState<Record<string, SystemProperties | null>>({});
  const wantsMetadata = view.layout === 'details' && view.columns.some((column) => ['tags', 'project', 'revision', 'responsible'].includes(column));
  const wantsSystemProperties = view.layout === 'details' && view.columns.some((column) => ['created', 'author'].includes(column));
  useEffect(() => {
    if (!wantsMetadata) return;
    for (const virtualRow of visibleRows) for (const item of rows[virtualRow.index] || []) {
      if (item.kind !== 'entry') continue;
      const entry = item.entry;
      const key = entryMetadataKey(rootId, entry);
      if (metadataCache.has(key) || metadataValues[key] !== undefined || entry.metadata) continue;
      void requestMetadata(key, { rootId: entry.rootId || rootId, relativePath: entry.relativePath, ...(entry.draftId ? { draftId: entry.draftId } : {}) })
        .then((metadata) => setMetadataValues((current) => current[key] === metadata ? current : { ...current, [key]: metadata }));
    }
  }, [wantsMetadata, visibleRows, rows, rootId, metadataValues]);

  useEffect(() => {
    if (!wantsSystemProperties) return;
    for (const virtualRow of visibleRows) for (const item of rows[virtualRow.index] || []) {
      if (item.kind !== 'entry') continue;
      const entry = item.entry;
      const key = entryMetadataKey(rootId, entry);
      if (systemPropertiesCache.has(key) || systemValues[key] !== undefined || (entry.author && entry.createdAt)) continue;
      void requestSystemProperties(key, { rootId: entry.rootId || rootId, relativePath: entry.relativePath, ...(entry.draftId ? { draftId: entry.draftId } : {}) })
        .then((properties) => setSystemValues((current) => current[key] === properties ? current : { ...current, [key]: properties }));
    }
  }, [wantsSystemProperties, visibleRows, rows, rootId, systemValues]);

  const choose = (entry: WindowsFileEntry, event: React.MouseEvent | React.PointerEvent) => selection.click(entry, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey });
  const renderName = (entry: WindowsFileEntry, large = false) => <span className={`flex min-w-0 items-center ${large ? 'flex-col justify-center gap-2 text-center' : 'gap-2'}`}>
    <Thumbnail entry={entry} rootId={rootId} size={large ? iconSize : view.layout === 'tiles' ? 48 : 20} />
    <span className={`min-w-0 truncate ${large ? 'max-w-full whitespace-normal line-clamp-2' : ''}`} title={entry.name}>{editing?.fileId === entry.fileId ? <input autoFocus aria-label="Новое имя" value={editing.value} onFocus={(e) => { const dot = editing.value.lastIndexOf('.'); e.currentTarget.setSelectionRange(0, dot > 0 ? dot : editing.value.length); }} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onChange={(e) => editing.onChange(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') editing.onCommit(); if (e.key === 'Escape') editing.onCancel(); }} className="h-6 max-w-full border border-[#0067c0] bg-white px-1 text-xs text-[#1b1b1b] outline-none dark:border-[#4cc2ff] dark:bg-[#383838] dark:text-white" /> : displayName(entry, view.extensions)}</span>
    {entry.storage === 'flux' && !large && <span className={`shrink-0 text-[11px] ${T.faint}`}>Только в Flux</span>}
  </span>;

  const cellValue = (entry: WindowsFileEntry, column: FolderColumn) => {
    const metadata = metadataValues[entryMetadataKey(rootId, entry)];
    switch (column) {
      case 'name': return renderName(entry);
      case 'modified': return formatDate(entry.modifiedAt);
      case 'type': return typeName(entry);
      case 'size': return entry.kind === 'directory' ? '' : formatSize(entry.size);
      case 'created': return formatDate(entry.createdAt || systemValues[entryMetadataKey(rootId, entry)]?.createdAt || '');
      case 'author': return entry.author || systemValues[entryMetadataKey(rootId, entry)]?.author || '—';
      case 'storage': return entry.storage === 'flux' ? 'Только в Flux' : 'Windows';
      case 'tags': return entry.metadata?.tags?.join(', ') || metadata?.tags?.join(', ') || '—';
      case 'project': return entry.projectNames?.join(', ') || entry.metadata?.projectIds?.join(', ') || metadata?.projectIds?.join(', ') || '—';
      case 'revision': return entry.metadata?.revision || metadata?.revision || '—';
      case 'responsible': return entry.metadata?.responsible || metadata?.responsible || '—';
    }
  };

  const moveColumn = (column: FolderColumn, direction: -1 | 1) => onViewChange({ ...view, columns: (() => {
    const next = [...view.columns]; const at = next.indexOf(column); const target = at + direction;
    if (at <= 0 || target <= 0 || target >= next.length) return next;
    [next[at], next[target]] = [next[target], next[at]]; return next;
  })() });
  const toggleColumn = (column: FolderColumn) => {
    if (column === 'name') return;
    const columns = view.columns.includes(column) ? view.columns.filter((item) => item !== column) : [...view.columns, column];
    onViewChange({ ...view, columns });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-entry-key], [data-column-header], [data-pane-control]')) return;
    const box = event.currentTarget.getBoundingClientRect();
    const start = { x: event.clientX - box.left, y: event.clientY - box.top + event.currentTarget.scrollTop };
    rubberStart.current = start;
    event.currentTarget.setPointerCapture(event.pointerId);
    setRubberband({ x: start.x, y: start.y, width: 0, height: 0 });
  };
  const resizeColumn = (event: React.PointerEvent<HTMLElement>) => {
    if (resize.current) {
      const active = resize.current;
      onViewChange({ ...view, widths: { ...view.widths, [active.column]: Math.max(60, Math.min(800, Math.round(active.width + event.clientX - active.x))) } });
    }
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!rubberStart.current) return;
    const box = event.currentTarget.getBoundingClientRect();
    const end = { x: event.clientX - box.left, y: event.clientY - box.top + event.currentTarget.scrollTop };
    const start = rubberStart.current;
    setRubberband({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) });
  };
  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = rubberStart.current;
    if (!start) return;
    const box = event.currentTarget.getBoundingClientRect();
    const end = { x: event.clientX - box.left, y: event.clientY - box.top + event.currentTarget.scrollTop };
    const selectionBox = { left: Math.min(start.x, end.x), right: Math.max(start.x, end.x), top: Math.min(start.y, end.y), bottom: Math.max(start.y, end.y) };
    const hits = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-entry-key]')).filter((node) => {
      const rect = node.getBoundingClientRect();
      const top = rect.top - box.top + event.currentTarget.scrollTop; const left = rect.left - box.left;
      return rect.width > 0 && rect.height > 0 && left <= selectionBox.right && left + rect.width >= selectionBox.left && top <= selectionBox.bottom && top + rect.height >= selectionBox.top;
    });
    if (rubberband && (rubberband.width > 3 || rubberband.height > 3)) {
      selection.clear();
      const byId = new Map(shownEntries.map((entry) => [entry.fileId, entry]));
      for (const hit of hits) { const entry = byId.get(hit.dataset.entryKey || ''); if (entry) selection.click(entry, { ctrl: true }); }
    } else selection.clear();
    rubberStart.current = null; setRubberband(null);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || (event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) return;
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.key.trim() === '') return;
    typeahead.current += event.key.toLocaleLowerCase('ru');
    if (typeaheadTimer.current) clearTimeout(typeaheadTimer.current);
    typeaheadTimer.current = setTimeout(() => { typeahead.current = ''; }, 800);
    const focusedIndex = ordered.findIndex((entry) => entry.fileId === selection.focused?.fileId);
    const rotated = [...ordered.slice(Math.max(0, focusedIndex + 1)), ...ordered.slice(0, Math.max(0, focusedIndex + 1))];
    const found = rotated.find((entry) => displayName(entry, view.extensions).toLocaleLowerCase('ru').startsWith(typeahead.current));
    if (found) {
      event.preventDefault(); selection.only(found);
    }
  };

  useEffect(() => {
    const focusedId = selection.focused?.fileId;
    if (!focusedId) return;
    if (view.layout === 'list') {
      const columnIndex = listColumns.findIndex((column) => column.some((item) => item.kind === 'entry' && item.entry.fileId === focusedId));
      if (columnIndex >= 0) listVirtualizer.scrollToIndex(columnIndex, { align: 'auto' });
    } else {
      const rowIndex = rows.findIndex((row) => row.some((item) => item.kind === 'entry' && item.entry.fileId === focusedId));
      if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: 'auto' });
    }
  }, [selection.focused?.fileId, rows, listColumns, view.layout, virtualizer, listVirtualizer]);

  useEffect(() => {
    if (!hasMore || !loadMore || busy || !containerRef.current) return;
    const last = visibleRows[visibleRows.length - 1];
    const count = view.layout === 'list' ? listColumns.length : rows.length;
    if (last && last.index >= count - 4 && loadedMoreAt.current !== entries.length) {
      loadedMoreAt.current = entries.length;
      loadMore();
    }
  }, [visibleRows, rows.length, listColumns.length, view.layout, entries.length, hasMore, loadMore, busy]);

  const rowContent = (items: ContentsRow[], index: number) => {
    const first = items[0];
    if (!first) return null;
    if (first.kind === 'group') return <div className={`flex h-full items-center border-b px-3 text-xs font-semibold ${T.line} ${T.muted}`} role="heading">{first.label}</div>;
    if (GRID_LAYOUTS.has(view.layout)) return <div className="grid h-full gap-1 px-2 py-1" style={{ gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))` }}>{items.filter((item): item is Extract<ContentsRow, { kind: 'entry' }> => item.kind === 'entry').map(({ entry }) => (
      <div key={entry.fileId} className="relative min-w-0" onDragOver={(event) => { if (entry.kind === 'directory' && onDrop) event.preventDefault(); }} onDrop={(event) => { if (entry.kind === 'directory') { event.stopPropagation(); onDrop?.(event, entry); } }}>
        {view.checkboxes && <input type="checkbox" aria-label={`Выбрать ${entry.name}`} checked={selection.isSelected(entry)} onClick={(event) => event.stopPropagation()} onChange={() => selection.click(entry, { ctrl: true })} className="absolute left-1 top-1 z-10" />}
        <button type="button" data-entry-key={entry.fileId} draggable={!!onDragStart} onDragStart={(event) => onDragStart?.(event, entry)} onMouseDown={(event) => { if (!(event.target as HTMLElement).closest('input')) containerRef.current?.focus(); }} onClick={(event) => choose(entry, event)} onDoubleClick={() => onOpen(entry)} onContextMenu={(event) => onContext(event, entry)} aria-selected={selection.isSelected(entry)} className={`h-full w-full min-w-0 rounded px-2 text-xs ${T.text} ${T.paneHover} aria-selected:bg-[#e5e5e5] aria-selected:dark:bg-[#333333]`}>
          {renderName(entry, view.layout !== 'small' && view.layout !== 'tiles')}{view.layout === 'tiles' && <span className={`block truncate text-xs ${T.muted}`}>{typeName(entry)} · {entry.kind === 'directory' ? '' : formatSize(entry.size)}</span>}
        </button>
      </div>
    ))}</div>;
    const row = first;
    if (row.kind !== 'entry') return null;
    const entry = row.entry;
    const compact = view.layout === 'list';
    const content = view.layout === 'content';
    return <div key={entry.fileId} role="row" data-entry-key={entry.fileId} draggable={!!onDragStart} onDragStart={(event) => onDragStart?.(event, entry)} onDragOver={(event) => { if (entry.kind === 'directory' && onDrop) event.preventDefault(); }} onDrop={(event) => { if (entry.kind === 'directory') { event.stopPropagation(); onDrop?.(event, entry); } }} aria-selected={selection.isSelected(entry)} onMouseDown={(event) => { if (!(event.target as HTMLElement).closest('input,button')) containerRef.current?.focus(); }} onClick={(event) => choose(entry, event)} onDoubleClick={() => onOpen(entry)} onContextMenu={(event) => onContext(event, entry)} className={`group flex h-full min-w-0 items-center border-b text-xs ${T.line} ${T.text} ${T.paneHover} aria-selected:bg-[#e5e5e5] aria-selected:dark:bg-[#333333]`}>
      {view.checkboxes && <span className="flex justify-center"><input type="checkbox" aria-label={`Выбрать ${entry.name}`} checked={selection.isSelected(entry)} onClick={(event) => event.stopPropagation()} onChange={(event) => selection.click(entry, { ctrl: true })} /></span>}
      {view.layout === 'details' ? columns.map((column) => <div key={column} role="cell" className={`h-full min-w-0 overflow-hidden border-r px-2 ${T.line} ${column === 'size' ? 'text-right tabular-nums' : ''}`} style={{ width: displayWidth(view, column), flex: `0 0 ${displayWidth(view, column)}px`, lineHeight: '32px' }}>{cellValue(entry, column)}</div>)
        : <div className={`flex min-w-0 flex-1 items-center gap-3 px-2 ${compact ? 'gap-2' : 'py-1'}`}>
          {compact || content ? renderName(entry) : <Thumbnail entry={entry} rootId={rootId} size={48} />}
          {content && <span className={`min-w-0 flex-1 truncate ${T.muted}`}>{typeName(entry)} · {entry.kind === 'directory' ? '' : formatSize(entry.size)} · {formatDate(entry.modifiedAt)}</span>}
          {view.layout === 'list' && <span className={`ml-auto shrink-0 ${T.muted}`}>{typeName(entry)}</span>}
        </div>}
    </div>;
  };

  return <section tabIndex={-1} className={`flex min-h-0 min-w-0 flex-1 flex-col ${T.pane} ${T.text}`} style={{ fontFamily: FONT_STACK }} onKeyDown={onKeyDown}>
    {view.layout === 'details' && <div role="row" className={`sticky top-0 z-10 flex h-[30px] shrink-0 border-b text-xs ${T.line} ${T.surface} ${T.muted}`} style={{ paddingLeft: view.checkboxes ? 28 : 0 }}>
      {columns.map((column) => <div key={column} role="columnheader" data-column-header className={`group relative flex h-full min-w-0 items-center border-r px-2 ${T.line}`} style={{ width: displayWidth(view, column), flex: `0 0 ${displayWidth(view, column)}px` }} onContextMenu={(event) => { event.preventDefault(); setColumnMenu({ x: event.clientX, y: event.clientY }); }}>
        <button type="button" disabled={!(['name', 'modified', 'type', 'size'] as FolderColumn[]).includes(column)} className="min-w-0 flex-1 truncate text-left disabled:cursor-default" onClick={() => { const sort = column === 'modified' ? 'modified' : column === 'size' ? 'size' : column === 'type' ? 'type' : 'name'; onViewChange({ ...view, sort, descending: view.sort === sort ? !view.descending : false }); }}>{COLUMN_LABEL[column]}</button>
        <span role="separator" aria-orientation="vertical" aria-label={`Ширина столбца ${COLUMN_LABEL[column]}`} className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-[#0067c0]/50" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); resize.current = { column, x: event.clientX, width: displayWidth(view, column) }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => resizeColumn(event)} onPointerUp={() => { resize.current = null; }} />
      </div>)}
    </div>}
    <div ref={(node) => { containerRef.current = node; if (scrollRef) (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = node; }} className="relative min-h-0 flex-1 overflow-auto outline-none" tabIndex={0} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}>
      {view.layout === 'list' ? <div className="relative h-full" style={{ width: listVirtualizer.getTotalSize(), minWidth: '100%' }}>
        {visibleRows.map((virtualRow) => <div key={virtualRow.key} data-virtual-column={virtualRow.index} className="absolute top-0 h-full w-[196px]" style={{ left: virtualRow.start }}>
          <div data-entries-grid data-entry-flow="column-major" data-flow-row-count={listRowsPerColumn} className="flex h-full flex-col overflow-hidden border-r px-1" style={{ width: 196 }}>
            {(listColumns[virtualRow.index] || []).map((item) => item.kind === 'group'
              ? <div key={item.key} role="heading" className={`flex h-8 shrink-0 items-center overflow-hidden px-1 text-[11px] font-semibold ${T.muted}`} title={item.label}>{item.label}</div>
              : <div key={item.key} className="relative flex h-8 shrink-0 items-center" onDragOver={(event) => { if (item.entry.kind === 'directory' && onDrop) event.preventDefault(); }} onDrop={(event) => { if (item.entry.kind === 'directory') { event.stopPropagation(); onDrop?.(event, item.entry); } }}>
                {view.checkboxes && <input type="checkbox" aria-label={`Выбрать ${item.entry.name}`} checked={selection.isSelected(item.entry)} onClick={(event) => event.stopPropagation()} onChange={() => selection.click(item.entry, { ctrl: true })} className="mr-1" />}
                <button type="button" role="row" data-entry-key={item.entry.fileId} draggable={!!onDragStart} onDragStart={(event) => onDragStart?.(event, item.entry)} onMouseDown={() => containerRef.current?.focus()} onClick={(event) => choose(item.entry, event)} onDoubleClick={() => onOpen(item.entry)} onContextMenu={(event) => onContext(event, item.entry)} aria-selected={selection.isSelected(item.entry)} className={`flex h-full min-w-0 flex-1 items-center gap-1 rounded px-1 text-left text-xs ${T.text} ${T.paneHover} aria-selected:bg-[#e5e5e5] aria-selected:dark:bg-[#333333]`}>
                  <Thumbnail entry={item.entry} rootId={rootId} size={20} /><span className="min-w-0 truncate">{displayName(item.entry, view.extensions)}</span>
                </button>
              </div>)}
          </div>
        </div>)}
      </div> : <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {visibleRows.map((virtualRow) => <div key={virtualRow.key} data-virtual-row={virtualRow.index} className="absolute left-0 top-0 w-full" style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}>
          {rowContent(rows[virtualRow.index] || [], virtualRow.index)}
        </div>)}
      </div>}
      {rubberband && <div aria-hidden className="pointer-events-none absolute z-20 border border-[#0067c0] bg-[#0067c0]/15" style={{ left: rubberband.x, top: rubberband.y - containerRef.current!.scrollTop, width: rubberband.width, height: rubberband.height }} />}
      {!entries.length && <div className={`p-4 text-sm ${T.muted}`}>Папка пуста</div>}
    </div>
    {columnMenu && <div role="dialog" aria-label="Столбцы и порядок" className={`fixed z-[120] w-64 rounded-md p-2 shadow-md ${T.menu} ${T.text}`} style={{ left: columnMenu.x, top: columnMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
      <div className={`mb-1 px-2 text-xs font-semibold ${T.muted}`}>Столбцы таблицы</div>
      {FOLDER_COLUMNS.map(({ id, label }) => <div key={id} className="flex h-8 items-center gap-2 px-2 text-xs">
        <label className="flex min-w-0 flex-1 items-center gap-2"><input type="checkbox" checked={columns.includes(id)} disabled={id === 'name'} onChange={() => toggleColumn(id)} /><span className="truncate">{label}</span></label>
        {columns.includes(id) && <><button type="button" aria-label={`Переместить ${label} влево`} onClick={() => moveColumn(id, -1)} className="rounded px-1 hover:bg-black/10 dark:hover:bg-white/10">←</button><button type="button" aria-label={`Переместить ${label} вправо`} onClick={() => moveColumn(id, 1)} className="rounded px-1 hover:bg-black/10 dark:hover:bg-white/10">→</button></>}
      </div>)}
      <button type="button" onClick={() => setColumnMenu(null)} className={`mt-1 h-7 w-full rounded text-xs ${T.iconButton}`}>Готово</button>
    </div>}
  </section>;
}
