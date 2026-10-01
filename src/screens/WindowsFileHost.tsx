import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { RefreshCw, Save, ExternalLink, Upload } from 'lucide-react';
import { fileRefFromSearch, windowsFilesRequest, bytesToBase64, base64ToBytes, type WindowsFileContent, type WindowsFileRef } from '../lib/windowsFiles';
import { faceOf, extOf } from '../lib/fileTypes';
import { usePaneId, useWindowTitle } from '../lib/paneTitle';
import { guardClose } from '../lib/closeGuard';
import { useToastStore } from '../store/toastStore';
import { useModalStore } from '../store/modalStore';
import LocalOfficeEditor from '../components/office/LocalOfficeEditor';
import { createSerializedStateWriter } from '../lib/serializedStateWriter';

/** Личные байты читаются локальным мостом; адрес API компании здесь не используется. */
export default function WindowsFileHost() {
  const location = useLocation();
  const initial = useMemo(() => fileRefFromSearch(location.search), [location.search]);
  const ref = useRef<WindowsFileRef | null>(initial);
  const [file, setFile] = useState<WindowsFileContent | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const textCurrent = useRef(text); textCurrent.current = text;
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [decodeError, setDecodeError] = useState(false);
  const paneId = usePaneId();
  const toast = useToastStore(s => s.addToast);
  const saveEditor = useRef<(() => Promise<boolean>) | null>(null);
  const latestFile = useRef<WindowsFileContent | null>(null);
  const queuedWrite = useRef<((bytes: Uint8Array) => Promise<WindowsFileContent>) | null>(null);
  if (!queuedWrite.current) queuedWrite.current = createSerializedStateWriter<WindowsFileContent, Uint8Array, WindowsFileContent>(
    () => latestFile.current,
    async (bytes, current) => {
      if (!ref.current) throw new Error('Файл ещё не открыт.');
      setSaving(true);
      try {
        const result = await windowsFilesRequest<WindowsFileContent>({ action: 'write', ref: ref.current, base64: bytesToBase64(bytes), baseSha256: current.sha256 });
        if ('error' in result) { setError(result.error.message); throw new Error(result.error.message); }
        latestFile.current = result.data;
        setFile(result.data); setError('');
        return result.data;
      } finally { setSaving(false); }
    },
  );
  const face = file ? faceOf(file.name) : 'binary';
  const nativeApp = file && /\.xls[xm]$/i.test(file.name) ? 'sheets' : file && /\.pdf$/i.test(file.name) ? 'pdf' : null;
  const document = file && /\.docx$/i.test(file.name);
  useWindowTitle(file?.name || 'Файл Windows');
  const load = useCallback(async () => {
    if (!ref.current) throw new Error('Не указан файл Windows.');
    const result = await windowsFilesRequest<WindowsFileContent>({ action: 'read', ref: ref.current });
    if ('error' in result) throw new Error(result.error.message);
    latestFile.current = result.data;
    setFile(result.data);
    if (faceOf(result.data.name) === 'plain') {
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(result.data.base64));
        setText(decoded); setDirty(false); setDecodeError(false);
      } catch {
        setText(''); setDirty(false); setDecodeError(true);
        setError('Этот файл не является корректным UTF‑8 текстом. Исходные байты сохранены; редактирование отключено.');
      }
    }
    return result.data;
  }, []);
  useEffect(() => {
    ref.current = initial;
    latestFile.current = null;
    setFile(null); setText(''); setDirty(false); setDecodeError(false); setError('');
    let alive = true;
    load().catch(e => { if (alive) setError(String(e.message)); });
    return () => { alive = false; };
  }, [initial, generation, load]);
  const write = queuedWrite.current;
  const copy = useCallback(async (bytes: Uint8Array, requested?: string) => {
    if (!file || !ref.current) throw new Error('Файл не открыт.');
    const name = await useModalStore.getState().openPrompt('Сохранить копию', 'Копия появится в этой же папке. Исходник останется без изменений.', 'Имя файла', requested || file.name.replace(/(\.[^.]+)$/, ' (копия)$1'));
    if (!name) return null;
    const parent = { rootId: ref.current.rootId, relativePath: ref.current.relativePath.split('/').slice(0, -1).join('/') };
    const request = file.storage === 'flux'
      ? { action: 'createDraft' as const, parent, name, base64: bytesToBase64(bytes) }
      : { action: 'publish' as const, parent, name, base64: bytesToBase64(bytes), draftId: crypto.randomUUID() };
    const result = await windowsFilesRequest<{ ref: WindowsFileRef; file: WindowsFileContent }>(request);
    if ('error' in result) throw new Error(result.error.message);
    toast(`Копия сохранена: ${name}`, 'success');
    return result.data;
  }, [file, toast]);
  const savePlain = useCallback(async () => {
    try {
      // Сохраняем преобладающие окончания строк, чтобы Windows-текст не менялся целиком.
      if (decodeError) throw new Error('Нельзя перезаписать файл с некорректным UTF‑8.');
      const old = file ? new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(file.base64)) : '';
      const next = old.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text;
      const bom = file?.base64.startsWith('77u/') ? '\ufeff' : '';
      await write(new TextEncoder().encode(bom + next));
      setDirty(textCurrent.current !== text);
      return true;
    } catch { return false; }
  }, [text, file, write, decodeError]);
  useEffect(() => {
    if (!paneId.startsWith('win:') || document || nativeApp) return;
    return guardClose(paneId.slice(4), async () => !dirty || savePlain());
  }, [paneId, document, nativeApp, dirty, savePlain]);
  const publish = async () => {
    if (!ref.current) return;
    if (saveEditor.current && !await saveEditor.current()) return;
    if (dirty && !await savePlain()) return;
    const result = await windowsFilesRequest<{ ref: WindowsFileRef }>({ action: 'publishDraft', ref: ref.current });
    if ('error' in result) { setError(result.error.message); return; }
    ref.current = result.data.ref;
    latestFile.current = null;
    await load(); toast('Файл отображается в Windows', 'success');
  };
  if (!initial) return <div className="p-6 text-sm text-slate-500 dark:text-slate-400">Откройте файл из Проводника Windows.</div>;
  return <div className="flex h-full min-h-0 min-w-0 flex-col bg-white dark:bg-slate-900">
    <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 text-xs dark:border-slate-700">
      <span className="mr-auto truncate text-slate-500 dark:text-slate-400">{file?.storage === 'flux' ? 'Только в Flux' : 'Файл Windows'}{dirty ? ' · есть изменения' : ''}</span>
      {(document || nativeApp || (face === 'plain' && !decodeError)) && <button disabled={saving || decodeError} className="fx-btn fx-btn-sm" onClick={() => void (saveEditor.current ? saveEditor.current() : savePlain())}><Save className="h-3.5 w-3.5" />Сохранить</button>}
      {file?.storage === 'flux' && <button className="fx-btn fx-btn-sm" onClick={() => void publish()}><Upload className="h-3.5 w-3.5" />Отобразить в Windows</button>}
      <button className="fx-btn fx-btn-sm" title="Обновить без потери правок" onClick={async () => {
        const save = saveEditor.current;
        if ((save && !await save()) || (dirty && !await savePlain())) return;
        setError(''); setGeneration(v => v + 1);
      }}><RefreshCw className="h-3.5 w-3.5" /></button>
      <button className="fx-btn fx-btn-sm" onClick={() => ref.current && void windowsFilesRequest({ action: 'open', ref: ref.current }).then(r => { if ('error' in r) setError(r.error.message); })}><ExternalLink className="h-3.5 w-3.5" />В Windows</button>
    </div>
    {error && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300"><span className="mr-auto">{error}</span>{file && !nativeApp && !decodeError && face === 'plain' && <button className="fx-btn fx-btn-sm" onClick={() => void copy(new TextEncoder().encode(text)).catch(e => setError(e.message))}>Сохранить мою копию</button>}</div>}
    {!file ? <div className="p-6 text-sm text-slate-500 dark:text-slate-400">Открытие файла…</div> : document || nativeApp ?
      <LocalOfficeEditor key={`${file.fileId}:${generation}`} app={nativeApp || 'docs'} file={file} fileRef={ref.current!} load={load} write={write} copy={copy} saveHandle={saveEditor} /> :
      face === 'plain' && !decodeError ? <textarea aria-label="Текст файла Windows" value={text} onChange={e => { textCurrent.current = e.target.value; setText(e.target.value); setDirty(true); }} spellCheck={false} className="min-h-0 flex-1 resize-none bg-white p-4 font-mono text-sm text-slate-800 outline-none dark:bg-slate-900 dark:text-slate-100" /> :
      <LocalImage file={file} />}
  </div>;
}

function LocalImage({ file }: { file: WindowsFileContent }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (faceOf(file.name) !== 'image') return;
    const mime = extOf(file.name) === 'svg' ? 'image/svg+xml' : `image/${extOf(file.name) === 'jpg' ? 'jpeg' : extOf(file.name)}`;
    const bytes = base64ToBytes(file.base64);
    const next = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }));
    setUrl(next); return () => URL.revokeObjectURL(next);
  }, [file]);
  return url ? <div className="min-h-0 flex-1 overflow-auto p-4"><img src={url} alt={file.name} className="mx-auto max-h-full max-w-full object-contain" /></div> : <div className="p-6 text-sm text-slate-500 dark:text-slate-400">Этот формат открывается кнопкой «В Windows». Исходный файл находится в своей папке.</div>;
}
