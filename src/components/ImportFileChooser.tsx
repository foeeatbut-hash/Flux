import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import WindowsFileIcon from './explorer/WindowsFileIcon';
import FluxFolderNav from './explorer/FluxFolderNav';
import { ICON_SIZE } from '../lib/metrics';
import { Btn, Dialog } from './ui';
import { base64ToBytes, windowsFilesRequest, type WindowsFileEntry, type WindowsFileRef, type WindowsRoot, type SelectionProvenance } from '../lib/windowsFiles';
import { WINDOWS_IMPORT_READ_BYTES, type ImportedFileRef } from '../../filesystem/contracts';
import { importFileMime } from '../lib/importFileMime';

type Props = {
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  className?: string;
  label?: string;
  trigger?: (open: () => void, disabled: boolean) => React.ReactNode;
  onImportRefs?: (files: ImportedFileRef[]) => void;
  /** Return a verified Explorer capability without reading or converting the file. */
  onWindowsFile?: (ref: WindowsFileRef, entry: WindowsFileEntry, selection?: SelectionProvenance) => void;
  /** Choose the folder currently being browsed, after a fresh identity check. */
  onWindowsFolder?: (ref: WindowsFileRef, entry: WindowsFileEntry) => void;
  selectFolder?: boolean;
  onFiles: (files: File[], provenance?: SelectionProvenance[]) => void;
};
export interface ImportFileChooserHandle { open: () => void }
const LAST_FOLDER_KEY = 'open.lastFolder';
type Listing = { entries: WindowsFileEntry[]; nextOffset: number | null };
const matches = (name: string, accept: string) => {
  const tokens = accept.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length || tokens.includes('*/*')) return true;
  const lowerName = name.toLowerCase();
  const mime = importFileMime(name).toLowerCase();
  return tokens.some(token => token.startsWith('.') ? lowerName.endsWith(token) : token.endsWith('/*') ? mime.startsWith(`${token.slice(0, -1)}`) : mime === token);
};
const toFile = (item: ImportedFileRef, chunks: Uint8Array[]) => new File(chunks, item.name, { type: importFileMime(item.name), lastModified: item.lastModified });
const refOf = (entry: WindowsFileEntry, rootId: string): WindowsFileRef => ({ rootId, relativePath: entry.relativePath, ...(entry.draftId ? { draftId: entry.draftId } : {}) });
const selectionKey = (entry: WindowsFileEntry, rootId: string) => `${rootId}\0${entry.relativePath.replace(/\\/gu, '/')}\0${entry.draftId || ''}`;

/** A single import entry point for ordinary disk paths and files visible in Flux Explorer. */
const ImportFileChooser = forwardRef<ImportFileChooserHandle, Props>(function ImportFileChooser({ accept = '', multiple = false, disabled = false, className, label = 'Выбрать файл', trigger, onImportRefs, onWindowsFile, onWindowsFolder, selectFolder = false, onFiles }, ref) {
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [roots, setRoots] = useState<WindowsRoot[]>([]);
  const [rootId, setRootId] = useState('');
  const [folder, setFolder] = useState('');
  const [listing, setListing] = useState<Listing | null>(null);
  const [selected, setSelected] = useState<WindowsFileEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const listRequest = useRef(0);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBusy(true); setError(''); setSelected([]); setListing(null);
    void windowsFilesRequest<WindowsRoot[]>({ action: 'roots' }).then(async result => {
      if (!alive) return;
      if (result.ok === false) { setError(result.error.message); return; }
      const available = result.data.filter(item => item.available);
      setRoots(available);
      if (!available.length) { setError('В Проводнике нет доступных папок.'); return; }
      // Окно открывается там, где человек выбирал в прошлый раз (как «Сохранить в…»)
      const stored = await windowsFilesRequest<Record<string, WindowsFileRef | undefined>>({ action: 'viewStateGet', keys: [LAST_FOLDER_KEY] }).catch(() => null);
      const last = stored?.ok ? stored.data[LAST_FOLDER_KEY] : undefined;
      if (!alive) return;
      if (last && typeof last.rootId === 'string' && available.some(item => item.id === last.rootId)) { setRootId(last.rootId); setFolder(String(last.relativePath || '')); }
      else { setRootId(available[0].id); setFolder(''); }
    }).catch(() => { if (alive) setError('Не удалось открыть Проводник.'); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [open]);

  useEffect(() => {
    if (!open || !rootId) return;
    let alive = true;
    const requestId = ++listRequest.current;
    setBusy(true); setError(''); setListing(null); setSelected([]);
    void windowsFilesRequest<Listing>({ action: 'list', ref: { rootId, relativePath: folder }, offset: 0, limit: 200 }).then(result => {
      if (!alive || requestId !== listRequest.current) return;
      if (result.ok === false) { setError(result.error.message); return; }
      setListing(result.data);
    }).catch(() => { if (alive && requestId === listRequest.current) setError('Не удалось прочитать папку.'); }).finally(() => { if (alive && requestId === listRequest.current) setBusy(false); });
    return () => { alive = false; };
  }, [open, rootId, folder]);

  // Выбор файла всегда идёт через Проводник Flux; обычное окно файлов браузера — только там, где моста к
  // папкам компьютера нет (страница в браузере), иначе выбирать было бы не из чего.
  const pickNative = async () => {
    const bridge = (window as Window & { electron?: { windowsFiles?: unknown } }).electron?.windowsFiles;
    if (bridge || onWindowsFile || selectFolder) setOpen(true); else input.current?.click();
  };
  // pickNative замыкает onFiles/onWindowsFile и прочие свойства текущего рендера; ручка с узким
  // списком зависимостей держала бы старый рендер и вызывала бы устаревшие обработчики, поэтому читаем через ref.
  const latest = useRef({ pickNative, disabled, busy });
  latest.current = { pickNative, disabled, busy };
  useImperativeHandle(ref, () => ({ open: () => { const cur = latest.current; if (!cur.disabled && !cur.busy) void cur.pickNative(); } }), []);

  const filesFromTickets = async (tickets: ImportedFileRef[]) => {
    const files: File[] = [];
    for (const ticket of tickets) {
      const chunks: Uint8Array[] = [];
      for (let offset = 0; offset < ticket.size; offset += WINDOWS_IMPORT_READ_BYTES) {
        const response = await windowsFilesRequest<{ size: number; offset: number; base64: string }>({ action: 'readImportRef', ticket: ticket.ticket, offset, length: Math.min(WINDOWS_IMPORT_READ_BYTES, ticket.size - offset) });
        if (response.ok === false) throw new Error(response.error.message);
        if (response.data.size !== ticket.size || response.data.offset !== offset) throw new Error('Размер файла изменился при чтении. Выберите его повторно.');
        chunks.push(base64ToBytes(response.data.base64));
      }
      if (chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) !== ticket.size) throw new Error('Размер файла изменился при чтении. Выберите его повторно.');
      files.push(toFile(ticket, chunks));
    }
    return files;
  };

  const toggle = (entry: WindowsFileEntry) => setSelected(current => {
    const key = selectionKey(entry, rootId);
    const exists = current.some(item => selectionKey(item, rootId) === key);
    if (exists) return current.filter(item => selectionKey(item, rootId) !== key);
    if (!multiple) return [entry];
    return [...current, entry];
  });
  const remember = () => { void windowsFilesRequest({ action: 'viewStateSet', entries: { [LAST_FOLDER_KEY]: { rootId, relativePath: folder } } }).catch(() => undefined); };
  const selectedBytes = selected.reduce((sum, item) => sum + item.size, 0);
  const importSelected = async () => {
    if (!rootId || selected.length === 0) return;
    setBusy(true); setError('');
    let tickets: ImportedFileRef[] = [];
    let transferred = false;
    try {
      if (onWindowsFile) {
        if (selected.length !== 1) throw new Error('Выберите один файл.');
        const entry = selected[0];
        const ref = refOf(entry, rootId);
        const stat = await windowsFilesRequest<WindowsFileEntry>({ action: 'stat', ref });
        if (stat.ok === false) throw new Error(stat.error.message);
        if (stat.data.kind !== 'file' || stat.data.fileId !== entry.fileId || selectionKey(stat.data, rootId) !== selectionKey(entry, rootId)) throw new Error('Файл изменился после выбора. Выберите его повторно.');
        const sourceFolder = { rootId, relativePath: ref.relativePath.split('/').slice(0, -1).join('/') };
        const provenance = await windowsFilesRequest<SelectionProvenance>({ action: 'selectionProvenance', ref: sourceFolder, fileRef: ref });
        if (provenance.ok === false) throw new Error(provenance.error.message);
        remember();
        setOpen(false); onWindowsFile(ref, stat.data, provenance.data); transferred = true;
        return;
      }
      const response = await windowsFilesRequest<{ files: ImportedFileRef[] }>({ action: 'prepareImportRefs', refs: selected.map(entry => refOf(entry, rootId)) });
      if (response.ok === false) throw new Error(response.error.message);
      tickets = response.data.files;
      if (onImportRefs) {
        remember();
        setOpen(false);
        onImportRefs(tickets);
        transferred = true;
        return;
      }
      const read = await filesFromTickets(tickets);
      remember();
      setOpen(false);
      onFiles(read, tickets.map(ticket => ticket.provenance || {}));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось прочитать файл.'); }
    finally {
      if (tickets.length && !transferred) await windowsFilesRequest({ action: 'releaseImportRefs', tickets: tickets.map(item => item.ticket) });
      setBusy(false);
    }
  };
  const chooseCurrentFolder = async () => {
    if (!rootId || !onWindowsFolder) return;
    setBusy(true); setError('');
    try {
      const ref: WindowsFileRef = { rootId, relativePath: folder };
      const stat = await windowsFilesRequest<WindowsFileEntry>({ action: 'stat', ref });
      if (stat.ok === false) throw new Error(stat.error.message);
      if (stat.data.kind !== 'directory' || stat.data.relativePath.replace(/\\/gu, '/') !== folder.replace(/\\/gu, '/')) throw new Error('Папка изменилась после выбора. Выберите её повторно.');
      remember();
      setOpen(false); onWindowsFolder(ref, stat.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось проверить папку.'); }
    finally { setBusy(false); }
  };
  const loadMore = async () => {
    if (!rootId || listing?.nextOffset == null) return;
    const requestId = listRequest.current;
    setBusy(true);
    try {
      const response = await windowsFilesRequest<Listing>({ action: 'list', ref: { rootId, relativePath: folder }, offset: listing.nextOffset, limit: 200 });
      if (requestId !== listRequest.current) return;
      if (response.ok === false) setError(response.error.message);
      else setListing(current => current ? { ...response.data, entries: [...current.entries, ...response.data.entries] } : response.data);
    } catch (cause) {
      if (requestId === listRequest.current) setError(cause instanceof Error ? cause.message : 'Не удалось прочитать папку.');
    } finally {
      if (requestId === listRequest.current) setBusy(false);
    }
  };

  // Кнопка «Проводник» — часть видимого триггера: у выборщиков с trigger={() => null} (вызов только через ref.open())
  // она не должна появляться отдельно от интерфейса экрана.
  const triggerNode = trigger ? trigger(() => void pickNative(), disabled || busy) : <button type="button" className={className || 'fx-btn'} disabled={disabled || busy} onClick={() => void pickNative()}><Upload className="h-3.5 w-3.5" />{label}</button>;
  return <>
    {/* Без видимого триггера обёртка не должна занимать строку: три таких выборщика давали пустую полосу над панелью */}
    <div className={triggerNode == null ? 'hidden' : 'inline-flex flex-wrap items-center gap-2'}>
      {triggerNode}
      <input ref={input} type="file" accept={accept} multiple={multiple} className="hidden" disabled={disabled} onChange={event => { const files = [...(event.currentTarget.files || [])]; event.currentTarget.value = ''; if (files.length) onFiles(files, files.map(() => ({}))); }} />
    </div>
    {error && !open && <span role="status" className="text-xs text-rose-600 dark:text-rose-400">{error}</span>}
    {/* Свой слой: выбор файла зовут и из окон с z-index выше обычного диалога (мастера импорта) */}
    {open && <div className="relative z-[300]"><Dialog title={selectFolder ? 'Выбрать папку из Проводника' : 'Выбрать файл из Проводника'} label={selectFolder ? 'Выбрать папку из Проводника' : 'Выбрать файл из Проводника'} onClose={() => !busy && setOpen(false)} busy={busy} width="max-w-2xl" scrollBody footer={<><span className="mr-auto text-xs text-slate-500">{selected.length ? `${selected.length} · ${(selectedBytes / 1024 / 1024).toFixed(1)} МБ` : selectFolder ? 'Будет выбрана открытая папка.' : 'Выберите файл для импорта.'}</span>{onWindowsFolder ? <Btn disabled={busy || !rootId} onClick={() => void chooseCurrentFolder()}>Выбрать эту папку</Btn> : <Btn disabled={busy || !selected.length} onClick={() => void importSelected()}>{onWindowsFile ? 'Выбрать файл' : 'Импортировать выбранное'}</Btn>}</>}>
      <div className="flex flex-col gap-2">
        <FluxFolderNav roots={roots} rootId={rootId} folder={folder} busy={busy} onRoot={id => { setRootId(id); setFolder(''); }} onFolder={setFolder} />
        {error && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="max-h-[45vh] min-h-40 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
          {busy && !listing ? <div className="flex items-center justify-center gap-2 p-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Чтение папки…</div> : !listing?.entries.length ? <p className="p-8 text-center text-sm text-slate-500">В этой папке нет файлов.</p> : listing.entries.map(entry => entry.kind === 'directory' ? <button key={selectionKey(entry, rootId)} type="button" disabled={busy} className="flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800" onClick={() => setFolder(entry.relativePath)}><WindowsFileIcon entry={entry} size={ICON_SIZE.row} /><span className="min-w-0 flex-1 truncate">{entry.name}</span></button> : entry.kind === 'file' && matches(entry.name, accept) ? <label key={selectionKey(entry, rootId)} className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"><input type="checkbox" checked={selected.some(item => selectionKey(item, rootId) === selectionKey(entry, rootId))} onChange={() => toggle(entry)} disabled={busy} /><WindowsFileIcon entry={entry} size={ICON_SIZE.row} /><span className="min-w-0 flex-1 truncate">{entry.name}</span><span className="shrink-0 text-xs text-slate-400">{entry.size < 1024 * 1024 ? `${Math.ceil(entry.size / 1024)} КБ` : `${(entry.size / 1024 / 1024).toFixed(1)} МБ`}</span></label> : null)}
        </div>
        {listing?.nextOffset != null && <Btn disabled={busy} onClick={() => void loadMore()}>Показать ещё</Btn>}
      </div>
    </Dialog></div>}
  </>;
});
ImportFileChooser.displayName = 'ImportFileChooser';
export default ImportFileChooser;
