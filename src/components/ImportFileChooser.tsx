import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, File as FileIcon, Folder, FolderOpen, HardDrive, Loader2, Upload } from 'lucide-react';
import { Btn, Dialog } from './ui';
import { base64ToBytes, windowsFilesRequest, type ImportedFileBytes, type WindowsFileEntry, type WindowsFileRef, type WindowsRoot } from '../lib/windowsFiles';

type Props = {
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  className?: string;
  label?: string;
  onFiles: (files: File[]) => void;
};
type Listing = { entries: WindowsFileEntry[]; nextOffset: number | null };
const acceptedExtensions = (accept: string) => accept.split(',').map(value => value.trim().toLowerCase()).filter(value => value.startsWith('.'));
const matches = (name: string, accept: string) => {
  const extensions = acceptedExtensions(accept);
  return !extensions.length || extensions.some(ext => name.toLowerCase().endsWith(ext));
};
const toFile = (item: ImportedFileBytes, bytes = base64ToBytes(item.base64)) => {
  if (bytes.byteLength !== item.size) throw new Error('Размер файла изменился при чтении. Выберите его повторно.');
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new File([buffer], item.name, { lastModified: Date.now() });
};
const toFiles = (items: ImportedFileBytes[]) => {
  let total = 0;
  return items.map(item => {
    const bytes = base64ToBytes(item.base64);
    total += bytes.byteLength;
    if (total > 64 * 1024 * 1024) throw new Error('Суммарный размер файлов для импорта не должен превышать 64 МБ.');
    return toFile(item, bytes);
  });
};
const refOf = (entry: WindowsFileEntry, rootId: string): WindowsFileRef => ({ rootId, relativePath: entry.relativePath, ...(entry.draftId ? { draftId: entry.draftId } : {}) });

/** A single import entry point for ordinary disk paths and files visible in Flux Explorer. */
export default function ImportFileChooser({ accept = '', multiple = false, disabled = false, className, label = 'Выбрать файл', onFiles }: Props) {
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
  const root = roots.find(item => item.id === rootId);
  const crumbs = useMemo(() => folder.split('/').filter(Boolean), [folder]);

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
    // Electron's native picker covers drives, UNC shares and network locations.
    const bridge = (window as Window & { electron?: { windowsFiles?: unknown } }).electron?.windowsFiles;
    if (bridge) {
      setError('');
      setBusy(true);
      try {
        const extensions = acceptedExtensions(accept).map(ext => ext.slice(1));
        const result = await windowsFilesRequest<{ canceled: boolean; files: ImportedFileBytes[] }>({ action: 'pickImport', extensions, multiple });
        if (result.ok === false) { setError(result.error.message); return; }
        if (result.data.files.length) onFiles(toFiles(result.data.files));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Не удалось открыть окно выбора файла.');
      } finally { setBusy(false); }
      return;
    }
    input.current?.click();
  };

  const toggle = (entry: WindowsFileEntry) => setSelected(current => {
    const exists = current.some(item => item.fileId === entry.fileId);
    if (exists) return current.filter(item => item.fileId !== entry.fileId);
    if (!multiple) return [entry];
    const next = [...current, entry];
    return next.length <= 20 && next.reduce((sum, item) => sum + item.size, 0) <= 64 * 1024 * 1024 ? next : current;
  });
  const selectedBytes = selected.reduce((sum, item) => sum + item.size, 0);
  const importSelected = async () => {
    if (!rootId || selected.length === 0) return;
    setBusy(true); setError('');
    try {
      const read: File[] = [];
      let total = 0;
      for (const entry of selected) {
        const response = await windowsFilesRequest<ImportedFileBytes & { base64: string }>({ action: 'read', ref: refOf(entry, rootId) });
        if (response.ok === false) throw new Error(response.error.message);
        const bytes = base64ToBytes(response.data.base64);
        total += bytes.byteLength;
        if (total > 64 * 1024 * 1024) throw new Error('Суммарный размер файлов для импорта не должен превышать 64 МБ.');
        read.push(toFile(response.data, bytes));
      }
      setOpen(false);
      onFiles(read);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось прочитать файл.'); }
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

  return <>
    <div className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className={className || 'fx-btn'} disabled={disabled || busy} onClick={() => void pickNative()}><Upload className="h-3.5 w-3.5" />{label}</button>
      <input ref={input} type="file" accept={accept} multiple={multiple} className="hidden" disabled={disabled} onChange={event => { const files = [...(event.currentTarget.files || [])]; event.currentTarget.value = ''; if (files.length) onFiles(files); }} />
      {(window as Window & { electron?: { windowsFiles?: unknown } }).electron?.windowsFiles && <button type="button" className="fx-btn fx-btn-quiet" disabled={disabled || busy} onClick={() => setOpen(true)}><FolderOpen className="h-3.5 w-3.5" />Проводник</button>}
    </div>
    {error && !open && <span role="status" className="text-xs text-rose-600 dark:text-rose-400">{error}</span>}
    {open && <Dialog title="Выбрать файл из Проводника" label="Выбрать файл из Проводника" onClose={() => !busy && setOpen(false)} busy={busy} width="max-w-2xl" scrollBody footer={<><span className="mr-auto text-xs text-slate-500">{selected.length ? `${selected.length} · ${(selectedBytes / 1024 / 1024).toFixed(1)} МБ` : 'Файл будет прочитан целиком и передан в импорт.'}</span><Btn disabled={busy || !selected.length || selected.length > 20 || selectedBytes > 64 * 1024 * 1024} onClick={() => void importSelected()}>Импортировать выбранное</Btn></>}>
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
          {busy && !listing ? <div className="flex items-center justify-center gap-2 p-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Чтение папки…</div> : !listing?.entries.length ? <p className="p-8 text-center text-sm text-slate-500">В этой папке нет файлов.</p> : listing.entries.map(entry => entry.kind === 'directory' ? <button key={entry.fileId} type="button" disabled={busy} className="flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800" onClick={() => setFolder(entry.relativePath)}><Folder className="h-4 w-4 shrink-0 text-amber-500" /><span className="min-w-0 flex-1 truncate">{entry.name}</span></button> : entry.kind === 'file' && matches(entry.name, accept) ? <label key={entry.fileId} className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"><input type="checkbox" checked={selected.some(item => item.fileId === entry.fileId)} onChange={() => toggle(entry)} disabled={busy || (selected.length >= 20 && !selected.some(item => item.fileId === entry.fileId)) || (selectedBytes + entry.size > 64 * 1024 * 1024 && !selected.some(item => item.fileId === entry.fileId))} /><FileIcon className="h-4 w-4 shrink-0 text-slate-500" /><span className="min-w-0 flex-1 truncate">{entry.name}</span><span className="shrink-0 text-xs text-slate-400">{entry.size < 1024 * 1024 ? `${Math.ceil(entry.size / 1024)} КБ` : `${(entry.size / 1024 / 1024).toFixed(1)} МБ`}</span></label> : null)}
        </div>
        {listing?.nextOffset != null && <Btn disabled={busy} onClick={() => void loadMore()}>Показать ещё</Btn>}
      </div>
    </Dialog>}
  </>;
}
