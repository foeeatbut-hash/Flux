import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, File as FileIcon, Folder, FolderOpen, HardDrive, Loader2, Upload } from 'lucide-react';
import { Btn, Dialog } from './ui';
import { base64ToBytes, windowsFilesRequest, type WindowsFileEntry, type WindowsFileRef, type WindowsRoot } from '../lib/windowsFiles';
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
  onFiles: (files: File[]) => void;
};
export interface ImportFileChooserHandle { open: () => void }
type Listing = { entries: WindowsFileEntry[]; nextOffset: number | null };
const acceptedExtensions = (accept: string) => accept.split(',').map(value => value.trim().toLowerCase()).filter(value => value.startsWith('.'));
const matches = (name: string, accept: string) => {
  const extensions = acceptedExtensions(accept);
  return !extensions.length || extensions.some(ext => name.toLowerCase().endsWith(ext));
};
const toFile = (item: ImportedFileRef, chunks: Uint8Array[]) => new File(chunks, item.name, { type: importFileMime(item.name), lastModified: Date.now() });
const refOf = (entry: WindowsFileEntry, rootId: string): WindowsFileRef => ({ rootId, relativePath: entry.relativePath, ...(entry.draftId ? { draftId: entry.draftId } : {}) });

/** A single import entry point for ordinary disk paths and files visible in Flux Explorer. */
const ImportFileChooser = forwardRef<ImportFileChooserHandle, Props>(function ImportFileChooser({ accept = '', multiple = false, disabled = false, className, label = 'Выбрать файл', trigger, onImportRefs, onFiles }, ref) {
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
    if (systemPicker && bridge) {
      setError('');
      setBusy(true);
      let tickets: ImportedFileRef[] = [];
      let transferred = false;
      try {
        const extensions = acceptedExtensions(accept).map(ext => ext.slice(1));
        const result = await windowsFilesRequest<{ canceled: boolean; files: ImportedFileRef[] }>({ action: 'pickImportRefs', extensions, multiple });
        if (result.ok === false) { setError(result.error.message); return; }
        tickets = result.data.files;
        if (tickets.length && onImportRefs) { onImportRefs(tickets); transferred = true; }
        else if (tickets.length) onFiles(await filesFromTickets(tickets));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Не удалось открыть окно выбора файла.');
      } finally {
        if (tickets.length && !transferred) await windowsFilesRequest({ action: 'releaseImportRefs', tickets: tickets.map(item => item.ticket) });
        setBusy(false);
      }
      return;
    }
    if (bridge) setOpen(true); else input.current?.click();
  };
  useImperativeHandle(ref, () => ({ open: () => { if (!disabled && !busy) void pickNative(); } }), [disabled, busy, systemPicker, accept, multiple]);

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
    const exists = current.some(item => item.fileId === entry.fileId);
    if (exists) return current.filter(item => item.fileId !== entry.fileId);
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
      onFiles(read);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось прочитать файл.'); }
    finally {
      if (tickets.length && !transferred) await windowsFilesRequest({ action: 'releaseImportRefs', tickets: tickets.map(item => item.ticket) });
      setBusy(false);
    }
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

  return <>
    <div className="inline-flex flex-wrap items-center gap-2">
      {trigger ? trigger(() => void pickNative(), disabled || busy) : <button type="button" className={className || 'fx-btn'} disabled={disabled || busy} onClick={() => void pickNative()}><Upload className="h-3.5 w-3.5" />{label}</button>}
      <input ref={input} type="file" accept={accept} multiple={multiple} className="hidden" disabled={disabled} onChange={event => { const files = [...(event.currentTarget.files || [])]; event.currentTarget.value = ''; if (files.length) onFiles(files); }} />
      {(window as Window & { electron?: { windowsFiles?: unknown } }).electron?.windowsFiles && <button type="button" className="fx-btn fx-btn-quiet" disabled={disabled || busy} onClick={() => setOpen(true)}><FolderOpen className="h-3.5 w-3.5" />Проводник</button>}
    </div>
    {error && !open && <span role="status" className="text-xs text-rose-600 dark:text-rose-400">{error}</span>}
    {open && <Dialog title="Выбрать файл из Проводника" label="Выбрать файл из Проводника" onClose={() => !busy && setOpen(false)} busy={busy} width="max-w-2xl" scrollBody footer={<><span className="mr-auto text-xs text-slate-500">{selected.length ? `${selected.length} · ${(selectedBytes / 1024 / 1024).toFixed(1)} МБ` : 'Файл будет прочитан частями и передан в импорт.'}</span><Btn disabled={busy || !selected.length} onClick={() => void importSelected()}>Импортировать выбранное</Btn></>}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <HardDrive className="h-4 w-4 text-slate-500" />
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
          {busy && !listing ? <div className="flex items-center justify-center gap-2 p-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Чтение папки…</div> : !listing?.entries.length ? <p className="p-8 text-center text-sm text-slate-500">В этой папке нет файлов.</p> : listing.entries.map(entry => entry.kind === 'directory' ? <button key={entry.fileId} type="button" disabled={busy} className="flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800" onClick={() => setFolder(entry.relativePath)}><Folder className="h-4 w-4 shrink-0 text-amber-500" /><span className="min-w-0 flex-1 truncate">{entry.name}</span></button> : entry.kind === 'file' && matches(entry.name, accept) ? <label key={entry.fileId} className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"><input type="checkbox" checked={selected.some(item => item.fileId === entry.fileId)} onChange={() => toggle(entry)} disabled={busy} /><FileIcon className="h-4 w-4 shrink-0 text-slate-500" /><span className="min-w-0 flex-1 truncate">{entry.name}</span><span className="shrink-0 text-xs text-slate-400">{entry.size < 1024 * 1024 ? `${Math.ceil(entry.size / 1024)} КБ` : `${(entry.size / 1024 / 1024).toFixed(1)} МБ`}</span></label> : null)}
        </div>
        {listing?.nextOffset != null && <Btn disabled={busy} onClick={() => void loadMore()}>Показать ещё</Btn>}
      </div>
    </Dialog>}
  </>;
});
ImportFileChooser.displayName = 'ImportFileChooser';
export default ImportFileChooser;
