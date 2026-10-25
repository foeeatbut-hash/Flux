import React, { useEffect, useRef, useState } from 'react';
import { FolderPlus, Loader2 } from 'lucide-react';
import WindowsFileIcon from './WindowsFileIcon';
import FluxFolderNav from './FluxFolderNav';
import { ICON_SIZE } from '../../lib/metrics';
import { Btn, Dialog, Input } from '../ui';
import { windowsFilesRequest, type WindowsFileEntry, type WindowsFileRef, type WindowsRoot } from '../../lib/windowsFiles';
import { existingEntry, nameProblem, readablePath, writeIntoFolder, type SaveCollision } from '../../lib/fluxSaveWrite';
import { useFluxSaveStore, type FluxSaveRequest, type SaveFileOutcome } from '../../store/fluxSaveStore';
import { useOverlay } from '../../store/overlayStore';

type Listing = { entries: WindowsFileEntry[]; nextOffset: number | null };
const LAST_FOLDER_KEY = 'save.lastFolder';
const sizeText = (size: number) => size < 1024 * 1024 ? `${Math.ceil(size / 1024)} КБ` : `${(size / 1024 / 1024).toFixed(1)} МБ`;

/**
 * «Сохранить в Проводнике Flux»: единое окно места сохранения и выбора папки.
 *
 * Заменяет системное окно сохранения Windows. Открывается там, где человек был
 * в прошлый раз (или рядом с файлом-источником), показывает папки Windows так
 * же, как окно «Выбрать файл», проверяет занятое имя до записи и в конце
 * называет, куда файл лёг. Режим `folder` — то же окно без имени файла.
 */
function FluxSaveDialog({ request }: { request: FluxSaveRequest }) {
  const finish = useFluxSaveStore(state => state.done);
  const file = request.mode === 'file' ? request : null;
  const [roots, setRoots] = useState<WindowsRoot[]>([]);
  const [rootId, setRootId] = useState('');
  const [folder, setFolder] = useState('');
  const [listing, setListing] = useState<Listing | null>(null);
  const [name, setName] = useState(file?.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const listRequest = useRef(0);
  const settled = useRef(false);
  const root = roots.find(item => item.id === rootId);

  const close = (outcome?: SaveFileOutcome, picked?: WindowsFileRef) => {
    if (settled.current) return;
    settled.current = true;
    if (request.mode === 'file') request.resolve(outcome || { ok: false, path: '', canceled: true, error: '' });
    else request.resolve(picked || null);
    finish(request.id);
  };
  const cancel = () => close();

  // Окно открывается и поверх других окон с собственной клавишей Esc (выгрузка таблицы, мастера):
  // перехват в фазе погружения не даёт одному нажатию закрыть оба сразу.
  const escape = useRef<() => void>(() => undefined);
  escape.current = () => { if (!busy) cancel(); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); escape.current(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Стартовая папка: рядом с источником файла → последняя, где сохраняли → первый диск.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = await windowsFilesRequest<WindowsRoot[]>({ action: 'roots' });
      if (!alive) return;
      if (list.ok === false) { setError(list.error.message); setReady(true); return; }
      const available = list.data.filter(item => item.available);
      setRoots(available);
      let start: WindowsFileRef | null = null;
      if (file?.dir) {
        const resolved = await windowsFilesRequest<WindowsFileRef | null>({ action: 'resolveAddress', text: file.dir });
        if (resolved.ok && resolved.data) start = { rootId: resolved.data.rootId, relativePath: resolved.data.relativePath };
      }
      if (!start) {
        const stored = await windowsFilesRequest<Record<string, WindowsFileRef | undefined>>({ action: 'viewStateGet', keys: [LAST_FOLDER_KEY] });
        const last = stored.ok ? stored.data[LAST_FOLDER_KEY] : undefined;
        if (last && typeof last.rootId === 'string' && available.some(item => item.id === last.rootId)) start = { rootId: last.rootId, relativePath: String(last.relativePath || '') };
      }
      if (!alive) return;
      if (start) { setRootId(start.rootId); setFolder(start.relativePath); }
      else if (available.length) { setRootId(available[0].id); setFolder(''); }
      else setError('В Проводнике нет доступных папок.');
      setReady(true);
    })();
    return () => { alive = false; };
    // Старт один раз на окно: request не меняется за время его жизни
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async (offset = 0) => {
    if (!rootId) return;
    const id = ++listRequest.current;
    setBusy(true);
    const answer = await windowsFilesRequest<Listing>({ action: 'list', ref: { rootId, relativePath: folder }, offset, limit: 200 }).catch(() => null);
    if (id !== listRequest.current) return;
    if (!answer) setError('Не удалось прочитать папку.');
    else if (answer.ok === false) {
      setError(answer.error.message);
      // Запомненная папка могла исчезнуть: возвращаемся на корень диска, а не оставляем пустое окно
      if (folder && offset === 0) setFolder('');
    } else {
      setError('');
      setListing(current => offset && current ? { ...answer.data, entries: [...current.entries, ...answer.data.entries] } : answer.data);
    }
    setBusy(false);
  };
  useEffect(() => { setListing(null); setConflict(false); if (ready && rootId) void load(0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ready, rootId, folder]);

  const here: WindowsFileRef = { rootId, relativePath: folder };
  const where = root ? readablePath(root.name, folder) : '';
  const remember = () => { void windowsFilesRequest({ action: 'viewStateSet', entries: { [LAST_FOLDER_KEY]: here } }); };

  const makeFolder = async () => {
    const wanted = (creating || '').trim();
    const problem = nameProblem(wanted);
    if (problem) { setError(problem); return; }
    setBusy(true);
    const answer = await windowsFilesRequest<WindowsFileEntry>({ action: 'mkdir', parent: here, name: wanted });
    setBusy(false);
    if (answer.ok === false) { setError(answer.error.message); return; }
    setCreating(null); setError('');
    setFolder(answer.data.relativePath);
  };

  const submit = async (collision?: SaveCollision) => {
    if (!file || !rootId) return;
    const wanted = name.trim();
    const problem = nameProblem(wanted);
    if (problem) { setError(problem); return; }
    setBusy(true); setError('');
    try {
      let mode = collision;
      if (!mode) {
        const taken = await existingEntry(windowsFilesRequest, here, wanted);
        if (taken) {
          if (taken.kind !== 'file') { setError(`«${wanted}» — это папка. Введите другое имя.`); return; }
          setConflict(true); return;
        }
        mode = 'new';
      }
      const written = await writeIntoFolder(windowsFilesRequest, here, wanted, file.bytes, mode);
      remember();
      const path = readablePath(root?.name || '', written.ref.relativePath);
      close({ ok: true, path, canceled: false, error: '' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить файл.');
    } finally { setBusy(false); }
  };

  const chooseFolder = async () => {
    if (!rootId) return;
    setBusy(true); setError('');
    const stat = await windowsFilesRequest<WindowsFileEntry>({ action: 'stat', ref: here });
    setBusy(false);
    if (stat.ok === false) { setError(stat.error.message); return; }
    if (stat.data.kind !== 'directory') { setError('Папка изменилась после выбора. Выберите её повторно.'); return; }
    remember();
    close(undefined, here);
  };

  const shown = (listing?.entries || []).filter(entry => entry.kind === 'directory' || (file && entry.kind === 'file'));
  const footer = conflict
    ? <>
      <span role="alert" className="mr-auto min-w-0 truncate text-xs text-amber-700 dark:text-amber-400">Файл «{name.trim()}» уже есть в этой папке.</span>
      <Btn disabled={busy} onClick={() => setConflict(false)}>Отмена</Btn>
      <Btn disabled={busy} onClick={() => void submit('keepBoth')}>Оставить оба</Btn>
      <Btn tone="danger" disabled={busy} onClick={() => void submit('replace')}>Заменить</Btn>
    </>
    : <>
      <span className="mr-auto min-w-0 truncate text-xs text-slate-500" title={where}>{where ? `Папка: ${where}` : ''}</span>
      <Btn disabled={busy} onClick={cancel}>Отмена</Btn>
      {file
        ? <Btn tone="primary" disabled={busy || !rootId || !name.trim()} onClick={() => void submit()}>Сохранить</Btn>
        : <Btn tone="primary" disabled={busy || !rootId} onClick={() => void chooseFolder()}>{request.mode === 'folder' ? request.confirmLabel : ''}</Btn>}
    </>;

  return <Dialog title={request.title} label={request.title} onClose={cancel} busy={busy} width="max-w-xl" scrollBody footer={footer}>
    <div className="flex flex-col gap-2">
      <FluxFolderNav roots={roots} rootId={rootId} folder={folder} busy={busy} onRoot={id => { setRootId(id); setFolder(''); }} onFolder={setFolder}
        extra={<Btn size="sm" disabled={busy || !rootId} onClick={() => setCreating(creating === null ? 'Новая папка' : null)}><FolderPlus className="h-3.5 w-3.5" />Новая папка</Btn>} />
      {creating !== null && <div className="flex items-center gap-2">
        <Input aria-label="Имя новой папки" value={creating} autoFocus onChange={event => setCreating(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void makeFolder(); } }} />
        <Btn disabled={busy} onClick={() => void makeFolder()}>Создать</Btn>
      </div>}
      {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      <div className="max-h-56 min-h-28 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700" aria-label="Содержимое папки">
        {!listing ? <div className="flex items-center justify-center gap-2 p-6 text-sm text-slate-500">{busy ? <><Loader2 className="h-4 w-4 animate-spin" />Чтение папки…</> : ''}</div>
          : !shown.length ? <p className="p-6 text-center text-sm text-slate-500">{file ? 'В этой папке пока ничего нет.' : 'Вложенных папок нет — можно выбрать эту.'}</p>
          : shown.map(entry => entry.kind === 'directory'
            ? <button key={entry.relativePath + (entry.draftId || '')} type="button" disabled={busy} className="flex w-full items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-left text-sm hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800" onClick={() => setFolder(entry.relativePath)}><WindowsFileIcon entry={entry} size={ICON_SIZE.row} /><span className="min-w-0 flex-1 truncate">{entry.name}</span></button>
            : <button key={entry.relativePath + (entry.draftId || '')} type="button" disabled={busy} title="Подставить это имя" className="flex w-full items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-left text-sm text-slate-500 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800" onClick={() => setName(entry.name)}><WindowsFileIcon entry={entry} size={ICON_SIZE.row} /><span className="min-w-0 flex-1 truncate">{entry.name}</span><span className="shrink-0 text-xs text-slate-400">{sizeText(entry.size)}</span></button>)}
        {listing?.nextOffset != null && <div className="p-2"><Btn size="sm" disabled={busy} onClick={() => void load(listing.nextOffset!)}>Показать ещё</Btn></div>}
      </div>
      {file && <label className="flex items-center gap-2 text-sm">
        <span className="shrink-0 text-slate-500">Имя файла</span>
        <Input aria-label="Имя файла" value={name} autoFocus onChange={event => { setName(event.target.value); setConflict(false); setError(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (!conflict && !busy) void submit(); } }} />
      </label>}
    </div>
  </Dialog>;
}

/** Один узел на всю оболочку: показывает первый запрос очереди */
export default function FluxSaveHost() {
  const current = useFluxSaveStore(state => state.queue[0]);
  // Родной слой браузера лежит выше любой разметки — пока окно открыто, он уступает место
  useOverlay(!!current);
  // Обёртка со своим слоем: выгрузка часто вызывается из окон с z-index выше обычного диалога
  return current ? <div className="relative z-[300]"><FluxSaveDialog key={current.id} request={current} /></div> : null;
}
