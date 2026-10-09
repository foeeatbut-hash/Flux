import React, { useCallback, useEffect, useRef, useState } from 'react';
import { base64ToBytes, type WindowsFileContent, type WindowsFileRef } from '../../lib/windowsFiles';
import { isOfficeMsg, isOfficeEditorReadyMessage, fromOwnFrame, targetOrigin, pathOf } from '../../lib/officeBridge';
import { localAnswer } from './OfficeAppEditor';
import FluxPanel, { type FluxTableRow, type ProjectField } from './FluxPanel';
import { openEditorTag } from '../../lib/editorTag';
import { sheetName, cellValue } from '../../../office/fieldKeys';
import { useStore } from '../../store/store';
import { usePaneId } from '../../lib/paneTitle';
import { guardClose } from '../../lib/closeGuard';
import { useToastStore } from '../../store/toastStore';
import { useModalStore } from '../../store/modalStore';

type App = 'docs' | 'pdf' | 'sheets';
interface Props {
  app: App; file: WindowsFileContent; fileRef: WindowsFileRef;
  load: () => Promise<WindowsFileContent>;
  write: (bytes: Uint8Array) => Promise<WindowsFileContent>;
  copy: (bytes: Uint8Array, name?: string) => Promise<{ ref: WindowsFileRef; file: WindowsFileContent } | null>;
  saveHandle: React.MutableRefObject<(() => Promise<boolean>) | null>;
}
async function native(request: object): Promise<any> {
  const bridge = (window as any).electron?.localOffice;
  if (!bridge) throw new Error('Локальные редакторы доступны в portable Flux.');
  const result = await bridge.invoke(request);
  if ('error' in result) throw new Error(result.error.message);
  return result.data;
}
/** Тот же редактор работает с локальным capability; байты не идут на сервер компании. */
export default function LocalOfficeEditor({ app, file, fileRef, load, write, copy, saveHandle }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const io = useRef({ load, write, copy }); io.current = { load, write, copy };
  const theme = useStore(s => s.theme);
  const activeProjectId = useStore(s => s.activeProject?.id || '');
  const themeRef = useRef(theme); themeRef.current = theme;
  const pane = usePaneId();
  const session = useRef<Promise<number> | null>(null);
  const sessionId = useRef(0);
  const disposed = useRef(false);
  const closedSessions = useRef(new Set<number>());
  const dirty = useRef(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(360);
  const editorArea = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  useEffect(() => {
    const area = editorArea.current;
    if (!area) return;
    const measure = () => setAvailableWidth(area.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, []);
  const overlayPanel = availableWidth < 640;
  const maximumPanelWidth = Math.max(0, Math.min(500, availableWidth - (overlayPanel ? 12 : 280)));
  const minimumPanelWidth = Math.min(270, maximumPanelWidth);
  const visiblePanelWidth = Math.max(minimumPanelWidth, Math.min(panelWidth, maximumPanelWidth));
  const resizePanel = (width: number) => setPanelWidth(Math.max(minimumPanelWidth, Math.min(maximumPanelWidth, width)));
  const commandWaits = useRef(new Map<string, (value: any) => void>());
  const toast = useToastStore(s => s.addToast);
  const waits = useRef(new Map<string, (value: any) => void>());
  const busySave = useRef<Promise<boolean> | null>(null);
  const send = useCallback((msg: object) => frame.current?.contentWindow?.postMessage({ flux: 'office', ...msg }, targetOrigin(window.location.origin)), []);
  const ask = useCallback((event: string, answer: string, payload?: unknown) => new Promise<any>(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const done = (value: any) => { clearTimeout(timer); if (waits.current.get(answer) === done) waits.current.delete(answer); resolve(value); };
    waits.current.set(answer, done);
    timer = setTimeout(() => done(null), 30_000);
    send({ event, payload });
  }), [send]);
  const command = useCallback((channel: string, payload: unknown) => new Promise<any>(resolve => {
    const id = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const done = (value: any) => { commandWaits.current.delete(id); resolve(value); };
    commandWaits.current.set(id, done);
    send({ event: 'ipc', payload: { channel, args: [{ id, payload }] } });
    setTimeout(() => { if (commandWaits.current.get(id) === done) done({ ok: false, error: 'Редактор не ответил на команду.' }); }, 8000);
  }), [send]);
  const closeSession = useCallback(async (id: number) => {
    if (closedSessions.current.has(id)) return;
    closedSessions.current.add(id);
    try { await native({ action: 'close', session: id }); } catch { /* closing after unmount is best effort */ }
  }, []);
  const ensure = useCallback(async () => {
    if (disposed.current) throw new Error('Редактор уже закрывается.');
    if (!session.current) session.current = native({ action: 'open', app, ref: fileRef }).then(async r => {
      if (disposed.current) { await closeSession(r.session); throw new Error('Редактор уже закрывается.'); }
      sessionId.current = r.session; return r.session as number;
    }).catch(e => { session.current = null; throw e; });
    return session.current;
  }, [app, fileRef.rootId, fileRef.relativePath, fileRef.draftId, closeSession]);
  const save = useCallback(async () => {
    if (busySave.current) return busySave.current;
    if (!ready) return !dirty.current;
    // Документ сообщает dirty через свой closeCheck; локальный dirty ref
    // отслеживает только PDF и Таблицу и не может решать за Word.
    if (app !== 'docs' && !dirty.current) return true;
    const operation = (async () => {
      try {
        if (app === 'docs') {
          const state = await ask('closeCheck', 'closeCheck');
          if (!state) return false;
          if (!state.dirty) return true;
          return await ask('closeSave', 'closeSaveResult') === true;
        }
        const result = await new Promise<boolean>(resolve => {
          let timer: ReturnType<typeof setTimeout>;
          const done = (ok: any) => { clearTimeout(timer); if (waits.current.get('nativeClose') === done) waits.current.delete('nativeClose'); resolve(ok === true); };
          waits.current.set('nativeClose', done);
          timer = setTimeout(() => done(false), 120_000);
          send({ event: 'ipc', payload: { channel: app === 'pdf' ? 'pdf:close-save-request' : 'workbook:close-save-request', args: [] } });
        });
        if (result) { dirty.current = false; setError(''); }
        return result;
      } catch (e: any) { setError(e.message); return false; }
    })();
    busySave.current = operation;
    try { return await operation; } finally { if (busySave.current === operation) busySave.current = null; }
  }, [ready, app, ask, send]);
  useEffect(() => { saveHandle.current = save; return () => { if (saveHandle.current === save) saveHandle.current = null; }; }, [save, saveHandle]);
  useEffect(() => {
    if (!pane.startsWith('win:')) return;
    return guardClose(pane.slice(4), async () => {
      const ok = await save();
      if (!ok) toast('Правки не сохранены. Окно оставлено открытым.', 'error');
      return ok;
    });
  }, [pane, save, toast]);
  useEffect(() => {
    const receive = async (event: MessageEvent) => {
      if (!fromOwnFrame(event.source, frame.current?.contentWindow, event.origin, window.location.origin) || !isOfficeMsg(event.data)) return;
      const m = event.data;
      if (isOfficeEditorReadyMessage(app, m)) { setReady(true); return; }
      if (m.op === 'flux:open-panel') { setPanelOpen(true); return; }
      if (m.op === 'flux:tag-click') { if (activeProjectId) void openEditorTag(activeProjectId, m.payload); return; }
      const waiting = waits.current.get(m.op);
      if (waiting) { waiting(m.payload); return; }
      const channel = String(m.payload?.channel || '');
      const args = Array.isArray(m.payload?.args) ? m.payload.args : [];
      const reply = (result: unknown) => send({ reply: m.id, result });
      try {
        if (app === 'docs') {
          if (m.op === 'open') { const f = await io.current.load(); reply({ fileId: f.fileId, name: f.name, sha256: f.sha256, bytes: base64ToBytes(f.base64).slice().buffer as ArrayBuffer }); }
          else if (m.op === 'theme') reply(themeRef.current);
          else if (m.op === 'isBlank') reply(false);
          else if (m.op === 'save') { await io.current.write(new Uint8Array(m.payload.bytes)); dirty.current = false; setError(''); reply({ ok: true }); }
          else if (m.op === 'saveCopy') {
            const made = await io.current.copy(new Uint8Array(m.payload.bytes), m.payload.name);
            reply(made ? { ok: true, path: pathOf(file.fileId) } : { ok: false, canceled: true });
          } else if (m.id !== undefined) reply(null);
          return;
        }
        if (m.op === 'ipc-send') {
          if (channel === 'flux:tag-click') { if (activeProjectId) void openEditorTag(activeProjectId, args[0]); return; }
          if (channel === 'flux:command-result') { const result = args[0]; const done = commandWaits.current.get(result?.id); if (done) done(result); return; }
          if (channel === 'flux:field-inserted') { waits.current.get(channel)?.(args[0] || null); return; }
          if (/dirty-changed$/.test(channel)) dirty.current = args[0] === true;
          if (channel === 'workbook:pending-edits') dirty.current = Number(args[0]) > 0;
          if (/close-save-result$/.test(channel)) {
            await native({ action: 'send', session: await ensure(), channel, args });
            waits.current.get('nativeClose')?.(args[0]); return;
          }
          if (!channel.startsWith('flux:')) await native({ action: 'send', session: await ensure(), channel, args });
          return;
        }
        if (m.op === 'flux:save-as' && app === 'pdf') {
          send({ event: 'ipc', payload: { channel: 'pdf:save-as-flow', args: [true] } });
          try {
            const name = await useModalStore.getState().openPrompt('Сохранить копию PDF', 'Копия появится в этой же папке. Исходник останется без изменений.', 'Имя файла', file.name.replace(/\.pdf$/i, ' (копия).pdf'));
            if (!name) return;
            const result = await native({ action: 'copy', session: await ensure(), name });
            if (result?.copy?.file?.name) { setError(''); toast(`Копия сохранена: ${result.copy.file.name}`, 'success'); }
            else if (!result?.canceled) throw new Error('Копия PDF не была создана. Правки остались в редакторе.');
          } catch (e: any) { setError(e.message); toast('Копия не сохранена. Правки остаются в редакторе.', 'error'); }
          finally {
            send({ event: 'ipc', payload: { channel: 'pdf:save-as-flow', args: [false] } });
            frame.current?.contentWindow?.focus();
          }
          return;
        }
        if (m.op !== 'ipc' || m.id === undefined) return;
        const local = localAnswer(channel, themeRef.current);
        if (local.hit) { send(local.error ? { reply: m.id, error: local.error } : { reply: m.id, result: local.value }); return; }
        if (channel === 'flux:x-config') { reply({ collab: false, key: '' }); return; }
        const isCopy = channel === 'workbook:save' && args[0]?.mode === 'save-as';
        const copyName = isCopy ? await useModalStore.getState().openPrompt('Сохранить копию книги', 'Копия появится в этой же папке.', 'Имя файла', file.name.replace(/(\.[^.]+)$/, ' (копия)$1')) : undefined;
        if (isCopy && !copyName) { reply({ canceled: true }); return; }
        const result = await native({ action: 'invoke', session: await ensure(), channel, args, ...(copyName ? { copyName } : {}) });
        const confirmed = !!result && result.ok !== false && (!result.canceled || result.fluxCopySaved === true);
        if ((channel === 'pdf:save' || channel === 'workbook:save') && confirmed) {
          setError('');
          if (!isCopy) dirty.current = false;
        }
        reply(result);
      } catch (e: any) {
        setError(String(e.message));
        if (m.id !== undefined) send({ reply: m.id, error: String(e.message) });
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [app, ensure, send, file.fileId, file.name, toast, activeProjectId]);
  useEffect(() => {
    const bridge = (window as any).electron?.localOffice;
    const off = bridge?.onEvent((event: any) => { if (event.session === sessionId.current) send({ event: 'ipc', payload: { channel: event.channel, args: event.args } }); });
    disposed.current = false;
    return () => {
      disposed.current = true; off?.();
      for (const done of waits.current.values()) done(null);
      waits.current.clear();
      const id = sessionId.current; sessionId.current = 0;
      if (id) void closeSession(id);
      else if (session.current) void session.current.then(closeSession).catch(() => {});
    };
  }, [send, closeSession]);
  useEffect(() => { if (ready) send({ event: 'theme', payload: theme }); }, [theme, ready, send]);
  const insertTable = async (rows: FluxTableRow[]) => {
    if (app === 'docs') return !!(await ask('insertTable', 'flux:table-inserted', { rows }))?.ok;
    if (app === 'sheets') return !!(await command('flux:insert-table', { rows }))?.ok;
    return false;
  };
  const insertField = async (field: ProjectField) => {
    if (app !== 'sheets') return;
    const answer = new Promise<any>(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const done = (value: any) => { clearTimeout(timer); if (waits.current.get('flux:field-inserted') === done) waits.current.delete('flux:field-inserted'); resolve(value); };
      waits.current.set('flux:field-inserted', done);
      timer = setTimeout(() => done(null), 8000);
    });
    send({ event: 'ipc', payload: { channel: 'flux:insert-field', args: [{ name: sheetName(field.key), value: cellValue(field.value === '—' ? '' : field.value) }] } });
    const result = await answer;
    if (!result?.ok) toast(result?.error || 'Поле не вставлено.', 'error');
  };
  const insertText = async (text: string) => {
    if (app !== 'docs') return;
    const result = await ask('insertText', 'flux:text-inserted', text);
    if (!result?.ok) toast(result?.error || 'Редактор не готов — текст не вставлен', 'error');
  };
  return <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
    {error && <div role="alert" className="shrink-0 border-b border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">{error} Правки остаются в редакторе. Используйте «Сохранить как», чтобы создать отдельную копию.</div>}
    <div ref={editorArea} className="relative flex min-h-0 min-w-0 flex-1">
      <iframe ref={frame} src={`genoffice/${app}/index.html`} title={`Flux Office — ${app === 'docs' ? 'Документ' : app === 'pdf' ? 'PDF' : 'Таблица'}`} className="min-h-0 min-w-0 flex-1 border-0" />
      {panelOpen && <div className={`flex min-h-0 shrink-0 ${overlayPanel ? 'absolute bottom-0 right-0 top-0 z-20' : ''}`} style={{ width: visiblePanelWidth + 4 }}>
        <div role="separator" aria-label="Изменить ширину панели Flux" aria-orientation="vertical" tabIndex={0} className="w-1 shrink-0 cursor-col-resize touch-none bg-slate-200 hover:bg-sky-500 focus:bg-sky-500 dark:bg-slate-700" onPointerDown={event => {
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={event => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const edge = editorArea.current?.getBoundingClientRect().right;
          if (edge !== undefined) resizePanel(edge - event.clientX);
        }} onPointerUp={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }} onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault(); resizePanel(visiblePanelWidth + (event.key === 'ArrowLeft' ? 20 : -20));
        }} />
        <div className="min-h-0 min-w-0 flex-1"><FluxPanel fileId="" fileName={file.name} projectId={activeProjectId} editorKind={app} readOnly={app === 'pdf'} localFile onClose={() => setPanelOpen(false)} onInsertTable={app === 'pdf' ? undefined : insertTable} onInsertField={app === 'sheets' ? insertField : undefined} onInsertText={app === 'docs' ? insertText : undefined} /></div>
      </div>}
    </div>
    {!ready && <div className="absolute inset-0 flex items-center justify-center bg-white/80 text-sm text-slate-500 dark:bg-slate-900/80 dark:text-slate-400">Открывается локальный редактор…</div>}
  </div>;
}
