import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, FolderOpen, Loader2, Upload } from 'lucide-react';
import WindowsFileIcon from './explorer/WindowsFileIcon';
import { FileIcon } from './icons/FluxIcons';
import { ICON_SIZE } from '../lib/metrics';
import { Btn, Dialog } from './ui';
import { base64ToBytes, windowsFilesRequest, type WindowsEquipmentSourceFolderPick, type WindowsEquipmentSourcePick, type WindowsFileEntry, type WindowsFileRef, type WindowsRoot, type SelectionProvenance } from '../lib/windowsFiles';
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
type Listing = { entries: WindowsFileEntry[]; nextOffset: number | null };
const MIME_EXTENSIONS: Record<string, string[]> = {
  'image/bmp': ['.bmp'], 'image/gif': ['.gif'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/svg+xml': ['.svg'], 'image/tiff': ['.tif', '.tiff'], 'image/webp': ['.webp'],
  'text/csv': ['.csv'], 'application/pdf': ['.pdf'], 'application/json': ['.json'], 'application/xml': ['.xml'],
  'application/vnd.ms-excel': ['.xls'], 'application/vnd.ms-excel.sheet.macroenabled.12': ['.xlsm'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/msword': ['.doc'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'], 'application/zip': ['.zip'], 'text/plain': ['.txt'], 'text/tab-separated-values': ['.tsv'],
};
const acceptedExtensions = (accept: string) => accept.split(',').map(value => value.trim().toLowerCase()).flatMap(value => value.startsWith('.') ? [value] : value.endsWith('/*') ? Object.entries(MIME_EXTENSIONS).filter(([mime]) => mime.startsWith(value.slice(0, -1))).flatMap(([, extensions]) => extensions) : MIME_EXTENSIONS[value] || []);
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
  const [systemPicker, setSystemPicker] = useState(false);
  const listRequest = useRef(0);
  const root = roots.find(item => item.id === rootId);
  const crumbs = useMemo(() => folder.split('/').filter(Boolean), [folder]);

  useEffect(() => {
    let alive = true;
    void fetch('/api/settings/explorer_file_picker').then(r => r.json()).then(d => {
      if (!alive) return;
      try { setSystemPicker(!!JSON.parse(d?.user || 'null')?.system); } catch { setSystemPicker(false); }
    }).catch(() => { if (alive) setSystemPicker(false); });
    const changed = (event: Event) => setSystemPicker(!!(event as CustomEvent<{ system?: boolean }>).detail?.system);
    window.addEventListener('flux:file-picker-preference', changed);
    return () => { alive = false; window.removeEventListener('flux:file-picker-preference', changed); };
  }, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBusy(true); setError(''); setSelected([]); setListing(null);
    void windowsFilesRequest<WindowsRoot[]>({ action: 'roots' }).then(result => {
      if (!alive) return;
      if (result.ok === false) { setError(result.error.message); return; }
      const available = result.data.filter(item => item.available);
      setRoots(available);
      if (available.length) { setRootId(available[0].id); setFolder(''); }
      else setError('В Проводнике нет доступных папок.');
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

  const pickNative = async () => {
    const bridge = (window as Window & { electron?: { windowsFiles?: unknown } }).electron?.windowsFiles;
    if (systemPicker && bridge && onWindowsFile) {
      setBusy(true); setError('');
      try {
        const result = await windowsFilesRequest<WindowsEquipmentSourcePick>({ action: 'pickEquipmentSource' });
        if (result.ok === false) setError(result.error.message);
        else if ('selectedFile' in result.data) onWindowsFile(result.data.selectedFile.ref, { name: result.data.selectedFile.name, relativePath: result.data.selectedFile.ref.relativePath, rootId: result.data.selectedFile.ref.rootId, storage: 'windows', kind: 'file', fileId: '', size: 0, modifiedAt: '', linked: false }, result.data.provenance || { sourceFolder: result.data.sourceFolder, suggestedTag: result.data.suggestedTag });
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось открыть окно выбора XML.'); }
      finally { setBusy(false); }
      return;
    }
    if (systemPicker && bridge && onWindowsFolder) {
      setBusy(true); setError('');
      try {
        const result = await windowsFilesRequest<WindowsEquipmentSourceFolderPick>({ action: 'pickEquipmentSourceFolder' });
        if (result.ok === false) setError(result.error.message);
        else if ('folder' in result.data) onWindowsFolder(result.data.folder, { name: result.data.folder.relativePath.split('/').filter(Boolean).pop() || 'Папка', relativePath: result.data.folder.relativePath, rootId: result.data.folder.rootId, storage: 'windows', kind: 'directory', fileId: '', size: 0, modifiedAt: '', linked: false });
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось открыть окно выбора папки.'); }
      finally { setBusy(false); }
      return;
    }
    if (systemPicker && bridge && !onWindowsFile && !selectFolder) {
      setError('');
      setBusy(true);
      let tickets: ImportedFileRef[] = [];
      let transferred = false;
      try {
        const extensions = acceptedExtensions(accept).map(ext => ext.slice(1));
        const result = await windowsFilesRequest<{ canceled: boolean; files: ImportedFileRef[] }>({ action: 'pickImportRefs', extensions, multiple });
        if (result.ok === false) { setError(result.error.message); return; }
        tickets = result.data.files;
        const accepted = tickets.filter(ticket => matches(ticket.name, accept));
        const rejected = tickets.filter(ticket => !matches(ticket.name, accept));
        if (rejected.length) { await windowsFilesRequest({ action: 'releaseImportRefs', tickets: rejected.map(item => item.ticket) }); tickets = accepted; }
        if (tickets.length && onImportRefs) { onImportRefs(tickets); transferred = true; }
        else if (tickets.length) onFiles(await filesFromTickets(tickets), tickets.map(ticket => ticket.provenance || {}));
        else if (rejected.length) setError('Выберите файл поддерживаемого типа.');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Не удалось открыть окно выбора файла.');
      } finally {
        if (tickets.length && !transferred) await windowsFilesRequest({ action: 'releaseImportRefs', tickets: tickets.map(item => item.ticket) });
        setBusy(false);
      }
      return;
    }
    if (bridge || onWindowsFile || selectFolder) setOpen(true); else input.current?.click();
  };
  // pickNative замыкает onFiles/onWindowsFile/systemPicker и прочие свойства текущего рендера; ручка с узким
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
        setOpen(false); onWindowsFile(ref, stat.data, provenance.data); transferred = true;
        return;
      }
      const response = await windowsFilesRequest<{ files: ImportedFileRef[] }>({ action: 'prepareImportRefs', refs: selected.map(entry => refOf(entry, rootId)) });
      if (response.ok === false) throw new Error(response.error.message);
      tickets = response.data.files;
      if (onImportRefs) {
        setOpen(false);
        onImportRefs(tickets);
        transferred = true;
        return;
      }
      const read = await filesFromTickets(tickets);
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
    <div className="inline-flex flex-wrap items-center gap-2">
      {triggerNode}
      <input ref={input} type="file" accept={accept} multiple={multiple} className="hidden" disabled={disabled} onChange={event => { const files = [...(event.currentTarget.files || [])]; event.currentTarget.value = ''; if (files.length) onFiles(files, files.map(() => ({}))); }} />
      {triggerNode != null && triggerNode !== false && (window as Window & { electron?: { windowsFiles?: unknown } }).electron?.windowsFiles && <button type="button" className="fx-btn fx-btn-quiet" disabled={disabled || busy} onClick={() => setOpen(true)}><FolderOpen className="h-3.5 w-3.5" />Проводник</button>}
    </div>
    {error && !open && <span role="status" className="text-xs text-rose-600 dark:text-rose-400">{error}</span>}
    {open && <Dialog title={selectFolder ? 'Выбрать папку из Проводника' : 'Выбрать файл из Проводника'} label={selectFolder ? 'Выбрать папку из Проводника' : 'Выбрать файл из Проводника'} onClose={() => !busy && setOpen(false)} busy={busy} width="max-w-2xl" scrollBody footer={<><span className="mr-auto text-xs text-slate-500">{selected.length ? `${selected.length} · ${(selectedBytes / 1024 / 1024).toFixed(1)} МБ` : selectFolder ? 'Будет выбрана открытая папка.' : 'Выберите файл для импорта.'}</span>{onWindowsFolder ? <Btn disabled={busy || !rootId} onClick={() => void chooseCurrentFolder()}>Выбрать эту папку</Btn> : <Btn disabled={busy || !selected.length} onClick={() => void importSelected()}>{onWindowsFile ? 'Выбрать файл' : 'Импортировать выбранное'}</Btn>}</>}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <FileIcon kind="drive" size={ICON_SIZE.row} />
          <select aria-label="Папка Windows" className="fx-input min-w-0 flex-1" value={rootId} disabled={busy} onChange={event => { setRootId(event.target.value); setFolder(''); }}>
            {roots.map(item => <option key={item.id} value={item.id}>{item.name}{item.network ? ' · сеть' : ''}</option>)}
          </select>
        </div>
        <nav aria-label="Путь к папке" className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
          <button type="button" className="fx-btn fx-btn-sm" disabled={!folder || busy} onClick={() => setFolder(crumbs.slice(0, -1).join('/'))}><ArrowLeft className="h-3 w-3" />Вверх</button>
          <button type="button" disabled={busy} className="rounded px-1 py-1 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800" onClick={() => setFolder('')}>{root?.name || 'Компьютер'}</button>
          {crumbs.map((part, index) => <React.Fragment key={`${index}:${part}`}><ChevronRight className="h-3 w-3 text-slate-400" /><button type="button" disabled={busy} className="max-w-40 truncate rounded px-1 py-1 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800" onClick={() => setFolder(crumbs.slice(0, index + 1).join('/'))}>{part}</button></React.Fragment>)}
        </nav>
        {error && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="max-h-[45vh] min-h-40 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
          {busy && !listing ? <div className="flex items-center justify-center gap-2 p-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Чтение папки…</div> : !listing?.entries.length ? <p className="p-8 text-center text-sm text-slate-500">В этой папке нет файлов.</p> : listing.entries.map(entry => entry.kind === 'directory' ? <button key={selectionKey(entry, rootId)} type="button" disabled={busy} className="flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800" onClick={() => setFolder(entry.relativePath)}><WindowsFileIcon entry={entry} size={ICON_SIZE.row} /><span className="min-w-0 flex-1 truncate">{entry.name}</span></button> : entry.kind === 'file' && matches(entry.name, accept) ? <label key={selectionKey(entry, rootId)} className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"><input type="checkbox" checked={selected.some(item => selectionKey(item, rootId) === selectionKey(entry, rootId))} onChange={() => toggle(entry)} disabled={busy} /><WindowsFileIcon entry={entry} size={ICON_SIZE.row} /><span className="min-w-0 flex-1 truncate">{entry.name}</span><span className="shrink-0 text-xs text-slate-400">{entry.size < 1024 * 1024 ? `${Math.ceil(entry.size / 1024)} КБ` : `${(entry.size / 1024 / 1024).toFixed(1)} МБ`}</span></label> : null)}
        </div>
        {listing?.nextOffset != null && <Btn disabled={busy} onClick={() => void loadMore()}>Показать ещё</Btn>}
      </div>
    </Dialog>}
  </>;
});
ImportFileChooser.displayName = 'ImportFileChooser';
export default ImportFileChooser;
