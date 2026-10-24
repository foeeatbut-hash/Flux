import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { base64ToBytes, type WindowsFileContent, type WindowsFileRef } from '../../lib/windowsFiles';
import { isOfficeMsg, isOfficeEditorReadyMessage, fromOwnFrame, targetOrigin, pathOf } from '../../lib/officeBridge';
import { localAnswer } from './OfficeAppEditor';
import FluxPanel, { type FluxTableRow } from './FluxPanel';
import FluxOfficePanel from './FluxOfficePanel';
import { docsEditorLink, sheetsEditorLink } from './useOfficeFluxBridge';
import { useLocalFluxBridge } from './useLocalFluxBridge';
import { useFluxRibbon } from './useFluxRibbon';
import { useFluxCellActions } from './useFluxCellActions';
import { queueOfficeReply } from './officeReplyQueue';
import { carryFluxPart } from '../../../office/fluxPart';
import { openEditorTag } from '../../lib/editorTag';
import { sheetName, cellValue } from '../../../office/fieldKeys';
import { useStore } from '../../store/store';
import { usePaneId } from '../../lib/paneTitle';
import { guardClose } from '../../lib/closeGuard';
import { useToastStore } from '../../store/toastStore';
import { useModalStore } from '../../store/modalStore';
import { diagnostic } from '../../lib/diagnostics';

type App = 'docs' | 'pdf' | 'sheets';
let nextLifecycleInstance = 0;
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
  const [refreshingFields, setRefreshingFields] = useState(false);
  const [editorGeneration, setEditorGeneration] = useState(0);
  const awaitingFieldReload = useRef(false);
  const lifecycleInstance = useRef(0);
  if (!lifecycleInstance.current) lifecycleInstance.current = ++nextLifecycleInstance;
  const lifecycleSequence = useRef(0);
  const frameLoadCount = useRef(0);
  const lifecycleState = useRef({ ready: false, dirtyKnown: false, dirty: false });
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null);
  const flowProjectId = pickedProjectId ?? activeProjectId;
  /** Последнее известное содержимое файла: из него берётся часть Flux при сохранении из редактора. */
  const latest = useRef(file); latest.current = file;
  const fluxEventWaits = useRef(new Map<string, (payload: any) => void>());
  const fluxReplyQueue = useRef(new Map<string, Promise<unknown>>());
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
  const logLifecycle = useCallback((stage: string, extra: { outcome?: 'ok' | 'error' | 'cancelled' | 'conflict' | 'skipped'; timeout?: boolean } = {}) => {
    const rect = frame.current?.getBoundingClientRect();
    const state = lifecycleState.current;
    diagnostic('office.lifecycle', {
      app, stage, instance: lifecycleInstance.current, sequence: ++lifecycleSequence.current,
      frameLoad: frameLoadCount.current,
      width: rect ? Math.round(rect.width) : 0, height: rect ? Math.round(rect.height) : 0,
      ready: state.ready, dirtyKnown: state.dirtyKnown,
      ...(state.dirtyKnown ? { dirty: state.dirty } : {}), ...extra,
    });
  }, [app]);
  const setDirtyState = useCallback((value: boolean) => {
    const state = lifecycleState.current;
    if (state.dirtyKnown && state.dirty === value) return;
    state.dirtyKnown = true;
    state.dirty = value;
    dirty.current = value;
    logLifecycle('dirty-state');
  }, [logLifecycle]);
  const ask = useCallback((event: string, answer: string, payload?: unknown, ms = 30_000) => new Promise<any>(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const done = (value: any) => { clearTimeout(timer); if (waits.current.get(answer) === done) waits.current.delete(answer); resolve(value); };
    waits.current.set(answer, done);
    timer = setTimeout(() => {
      if (event === 'closeCheck' || event === 'closeSave') logLifecycle(event === 'closeCheck' ? 'close-check-timeout' : 'close-save-timeout', { outcome: 'error', timeout: true });
      done(null);
    }, ms);
    send({ event, payload });
  }), [send, logLifecycle]);
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
  const save = useCallback(async (force = false) => {
    if (busySave.current) return busySave.current;
    if (!ready) return !dirty.current;
    // Документ сообщает dirty через свой closeCheck; локальный dirty ref
    // отслеживает только PDF и Таблицу и не может решать за Word.
    // Правку панели Flux редактор Таблицы признаёт «изменённой» позже записи: force считает её несохранённой
    if (force && app !== 'docs') setDirtyState(true);
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
          timer = setTimeout(() => { logLifecycle('close-save-timeout', { outcome: 'error', timeout: true }); done(false); }, 120_000);
          send({ event: 'ipc', payload: { channel: app === 'pdf' ? 'pdf:close-save-request' : 'workbook:close-save-request', args: [] } });
        });
        if (result) { setDirtyState(false); setError(''); }
        return result;
      } catch (e: any) { setError(e.message); return false; }
    })();
    busySave.current = operation;
    try { return await operation; } finally { if (busySave.current === operation) busySave.current = null; }
  }, [ready, app, ask, send, logLifecycle, setDirtyState]);
  const saveHandler = useCallback(() => save(), [save]);
  useEffect(() => { saveHandle.current = saveHandler; return () => { if (saveHandle.current === saveHandler) saveHandle.current = null; }; }, [saveHandler, saveHandle]);
  useEffect(() => {
    if (!pane.startsWith('win:')) return;
    return guardClose(pane.slice(4), async () => {
      const ok = await save();
      logLifecycle('close-guard', { outcome: ok ? 'ok' : 'error' });
      if (!ok) toast('Правки не сохранены. Окно оставлено открытым.', 'error');
      return ok;
    });
  }, [pane, save, toast, logLifecycle]);
  useEffect(() => { logLifecycle('mount'); return () => logLifecycle('unmount'); }, [logLifecycle]);
  // Мост панели Flux: Word говорит с редактором событиями окна, Таблица — каналами ipc
  const askFrame = useCallback(<T,>(event: string, answer: string, ms: number, payload?: unknown): Promise<T | null> => {
    const expectedFrame = frame.current?.contentWindow;
    return queueOfficeReply(fluxReplyQueue.current, answer, async () => expectedFrame && expectedFrame === frame.current?.contentWindow ? await ask(event, answer, payload, ms) as T | null : null);
  }, [ask]);
  const callFluxEvent = useCallback((channel: string, payload: unknown, responseChannel: string, timeout = 15_000) => {
    const expectedFrame = frame.current?.contentWindow;
    return queueOfficeReply(fluxReplyQueue.current, responseChannel, () => new Promise<any>(resolve => {
      if (!expectedFrame || expectedFrame !== frame.current?.contentWindow) { resolve(null); return; }
      const finish = (value: any) => { clearTimeout(timer); if (fluxEventWaits.current.get(responseChannel) === finish) fluxEventWaits.current.delete(responseChannel); resolve(value); };
      fluxEventWaits.current.set(responseChannel, finish);
      send({ event: 'ipc', payload: { channel, args: [payload] } });
      const timer = setTimeout(() => finish(null), timeout);
    }));
  }, [send]);
  const editorLink = useMemo(() => app === 'docs' ? docsEditorLink(askFrame) : sheetsEditorLink(callFluxEvent), [app, askFrame, callFluxEvent]);
  const flux = useLocalFluxBridge({
    app: app === 'docs' ? 'docs' : 'sheets', fileKey: file.fileId, projectId: flowProjectId, editor: editorLink, latest,
    load: () => io.current.load(), write: bytes => io.current.write(bytes), save, ready: () => lifecycleState.current.ready,
    rebase: app === 'sheets' ? async sha256 => { await native({ action: 'rebase', session: await ensure(), sha256 }); } : undefined,
  });
  const refreshProjectFields = useCallback(async () => {
    const projectId = flowProjectId;
    setRefreshingFields(true);
    try {
      const result = await flux.refreshFields(projectId);
      if (!result.unchanged) {
        const oldSession = await session.current?.catch(() => null);
        if (oldSession) await closeSession(oldSession);
        session.current = null;
        sessionId.current = 0;
        lifecycleState.current.ready = false;
        awaitingFieldReload.current = true;
        setReady(false);
        setDirtyState(false);
        setEditorGeneration((value) => value + 1);
      }
      const updated = result.changed.length;
      const skipped = result.skipped.length;
      toast(updated ? `Обновлено полей: ${updated}${skipped ? `, пропущено: ${skipped}` : ''}.` : skipped ? `Поля не изменены; пропущено: ${skipped}.` : 'Данные в файле уже актуальны.', updated || skipped ? 'success' : 'info');
    } catch (cause: any) {
      const message = String(cause?.message || cause || 'Не удалось обновить поля.');
      setError(message);
      toast(message, 'error');
    } finally {
      if (!awaitingFieldReload.current) setRefreshingFields(false);
    }
  }, [flowProjectId, flux.refreshFields, closeSession, setDirtyState, toast]);
  const cellActions = useFluxCellActions({ fileId: file.fileId, projectId: flowProjectId, readOnly: !ready || refreshingFields,
    requestState: flux.requestState, updateSchema: flux.updateSchema, insertBinding: flux.insertBinding, isInlineEditing: () => flux.inlineEditingRef.current,
    resumeFocus: app === 'docs' ? (anchorId, schema) => { void editorLink.native('formula', { anchorId, schema, preserveText: true }); } : undefined,
    requestNative: async (operation, payload) => {
      const result = await editorLink.native(operation, payload);
      if (operation === 'formula' && result?.ok && app === 'sheets') flux.inlineEditingRef.current = true;
      return result;
    },
    onError: message => toast(message, 'error') });
  // Обработчик сообщений редактора живёт дольше одной отрисовки и берёт свежее отсюда
  // Выпуск ревизий для файлов Проводника — отдельный этап позже (решение владельца)
  const ribbon = useFluxRibbon({ send, peek: flowProjectId ? flux.peekState : undefined, issueAvailable: false, issueHint: 'Выпуск ревизий для файлов Проводника появится позже', projectFile: false, projectFields: true });
  const panelOpen = ribbon.open;
  const fluxHost = useRef({ flux, cellActions, ribbon }); fluxHost.current = { flux, cellActions, ribbon };
  useEffect(() => {
    const receive = async (event: MessageEvent) => {
      if (!fromOwnFrame(event.source, frame.current?.contentWindow, event.origin, window.location.origin) || !isOfficeMsg(event.data)) return;
      const m = event.data;
      if (isOfficeEditorReadyMessage(app, m)) {
        if (!lifecycleState.current.ready) { lifecycleState.current.ready = true; logLifecycle('editor-ready'); }
        setReady(true);
        if (awaitingFieldReload.current) { awaitingFieldReload.current = false; setRefreshingFields(false); }
        return;
      }
      if (fluxHost.current.ribbon.handle(m)) return;
      if (m.op === 'flux:tag-click') { if (flowProjectId) void openEditorTag(flowProjectId, m.payload); return; }
      if (m.op === 'flux:cell-actions') { void fluxHost.current.cellActions.open(m.payload); return; }
      if (m.op === 'flux:begin-cell-edit') { void fluxHost.current.cellActions.beginEdit(m.payload); return; }
      if (m.op === 'flux:formula-edited') { void fluxHost.current.cellActions.syncFromNative(); return; }
      if (m.op === 'flux:header-schema-edited') { void fluxHost.current.cellActions.edited(m.payload); return; }
      if (m.op === 'flux:history-step') { void fluxHost.current.flux.historyStep(m.payload); return; }
      if (m.op === 'flux:anchor-selected') { fluxHost.current.flux.setActiveAnchor(m.payload || null); return; }
      const waiting = waits.current.get(m.op);
      if (waiting) {
        if (m.op === 'closeCheck') {
          const state = m.payload;
          if (state && typeof state.dirty === 'boolean') setDirtyState(state.dirty);
          logLifecycle('close-check-result', { outcome: state ? 'ok' : 'error' });
        } else if (m.op === 'closeSaveResult') logLifecycle('close-save-result', { outcome: m.payload === true ? 'ok' : 'error' });
        waiting(m.payload); return;
      }
      const channel = String(m.payload?.channel || '');
      const args = Array.isArray(m.payload?.args) ? m.payload.args : [];
      const reply = (result: unknown) => send({ reply: m.id, result });
      try {
        if (app === 'docs') {
          if (m.op === 'open') { const f = await io.current.load(); reply({ fileId: f.fileId, name: f.name, sha256: f.sha256, bytes: base64ToBytes(f.base64).slice().buffer as ArrayBuffer }); }
          else if (m.op === 'theme') reply(themeRef.current);
          else if (m.op === 'isBlank') reply(false);
          else if (m.op === 'save') {
            // Редактор открыл пакет до записи схемы Flux: часть Flux переносится из файла, иначе связи пропали бы при первом же сохранении
            const body = await carryFluxPart(base64ToBytes(latest.current.base64), new Uint8Array(m.payload.bytes));
            latest.current = await io.current.write(body);
            setDirtyState(false); setError(''); reply({ ok: true });
          }
          else if (m.op === 'saveCopy') {
            const made = await io.current.copy(new Uint8Array(m.payload.bytes), m.payload.name);
            reply(made ? { ok: true, path: pathOf(file.fileId) } : { ok: false, canceled: true });
          } else if (m.id !== undefined) reply(null);
          return;
        }
        if (m.op === 'ipc-send') {
          if (channel === 'flux:tag-click') { if (flowProjectId) void openEditorTag(flowProjectId, args[0]); return; }
          if (channel === 'flux:cell-actions') { void fluxHost.current.cellActions.open(args[0]); return; }
          if (channel === 'flux:header-formula-edit-started' && args[0]?.ok) fluxHost.current.flux.inlineEditingRef.current = true;
          if (channel === 'flux:header-formula-edit-cancelled') { fluxHost.current.flux.inlineEditingRef.current = false; return; }
          if (channel === 'flux:history-step') { void fluxHost.current.flux.historyStep(args[0]); return; }
          if (channel === 'flux:begin-cell-edit') { void fluxHost.current.cellActions.beginEdit(args[0]); return; }
          if (channel === 'flux:header-schema-edited') { fluxHost.current.flux.inlineEditingRef.current = false; void fluxHost.current.cellActions.edited(args[0]); return; }
          if (channel === 'flux:anchor-selected') { fluxHost.current.flux.setActiveAnchor(args[0] || null); return; }
          if (channel.startsWith('flux:')) { const wait = fluxEventWaits.current.get(channel); if (wait) { fluxEventWaits.current.delete(channel); wait(args[0] || null); } }
          if (channel === 'flux:command-result') { const result = args[0]; const done = commandWaits.current.get(result?.id); if (done) done(result); return; }
          if (channel === 'flux:field-inserted') { waits.current.get(channel)?.(args[0] || null); return; }
          if (/dirty-changed$/.test(channel)) setDirtyState(args[0] === true);
          if (channel === 'workbook:pending-edits') setDirtyState(Number(args[0]) > 0);
          if (/close-save-result$/.test(channel)) {
            await native({ action: 'send', session: await ensure(), channel, args });
            logLifecycle('close-save-result', { outcome: args[0] === true ? 'ok' : 'error' });
            if (args[0] === true) setDirtyState(false);
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
  }, [app, ensure, send, file.fileId, file.name, toast, flowProjectId, logLifecycle, setDirtyState]);
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
    const result = app === 'docs' ? await ask('insertTable', 'flux:table-inserted', { rows }) : app === 'sheets' ? await command('flux:insert-table', { rows }) : null;
    // Причину отказа редактора (нет выделенной ячейки, только чтение) видит сотрудник, а не только «не смог»
    if (app !== 'pdf' && !result?.ok) toast(result?.error || 'Таблица не вставлена', 'error');
    return !!result?.ok;
  };
  const insertText = async (text: string) => {
    if (app !== 'docs') return;
    const result = await ask('insertText', 'flux:text-inserted', text);
    if (!result?.ok) toast(result?.error || 'Редактор не готов — текст не вставлен', 'error');
  };
  const insertProjectField = async (field: { key: string; title: string; value: string }) => {
    if (app === 'docs') {
      const result = await ask('insertText', 'flux:text-inserted', `{{${field.key}}}`);
      if (!result?.ok) toast(result?.error || 'Поле не вставлено: установите курсор в документ.', 'error');
      else toast(`Поле «${field.title}» вставлено. Обновите поля, чтобы подставить значение.`, 'success');
      return;
    }
    const result = await command('flux:insert-field', { name: sheetName(field.key), value: cellValue(field.value === '-' ? '' : field.value) });
    if (!result?.ok) toast(result?.error || 'Поле не вставлено: выберите ячейку.', 'error');
    else toast(`Поле «${field.title}» вставлено в ${result.cell}.`, 'success');
  };
  return <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
    {error && <div role="alert" className="shrink-0 border-b border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">{error} Правки остаются в редакторе. Используйте «Сохранить как», чтобы создать отдельную копию.</div>}
    <div ref={editorArea} className="relative flex min-h-0 min-w-0 flex-1" aria-busy={refreshingFields}>
      <iframe key={editorGeneration} ref={frame} inert={refreshingFields} src={`genoffice/${app}/index.html`} title={`Flux Office — ${app === 'docs' ? 'Документ' : app === 'pdf' ? 'PDF' : 'Таблица'}`} onLoad={() => { frameLoadCount.current++; logLifecycle('frame-load'); }} onError={() => logLifecycle('frame-error', { outcome: 'error' })} className="min-h-0 min-w-0 flex-1 border-0" />
      {refreshingFields && <div className="absolute inset-0 z-30 flex items-center justify-center bg-white/75 text-sm font-medium text-slate-700 dark:bg-slate-950/75 dark:text-slate-300" role="status">Сохраняем файл и обновляем поля…</div>}
      {panelOpen && app !== 'pdf' && <FluxOfficePanel fileId="" localSource={flux.source} projectId={flowProjectId} onProjectChange={setPickedProjectId} fileName={file.name} editorKind={app}
        readOnly={!ready || refreshingFields} schemaWriteAvailable={ready && !refreshingFields} activeAnchor={flux.activeAnchor} isInlineEditing={() => flux.inlineEditingRef.current}
        requestState={flux.requestState} insertBinding={flux.insertBinding} applyWrites={flux.applyWrites} updateSchema={flux.updateSchema}
        command={ribbon.command} onInsertTable={insertTable} onInsertText={app === 'docs' ? insertText : undefined} onInsertField={insertProjectField} onUpdateFields={refreshProjectFields} onTemplateChange={ribbon.setTemplate} onClose={ribbon.close} />}
      {cellActions.dialog}
      {panelOpen && app === 'pdf' && <div className={`flex min-h-0 shrink-0 ${overlayPanel ? 'absolute bottom-0 right-0 top-0 z-20' : ''}`} style={{ width: visiblePanelWidth + 4 }}>
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
        <div className="min-h-0 min-w-0 flex-1"><FluxPanel fileId="" fileName={file.name} projectId={flowProjectId} editorKind={app} readOnly={app === 'pdf'} localFile onClose={ribbon.close} /></div>
      </div>}
    </div>
    {!ready && <div className="absolute inset-0 flex items-center justify-center bg-white/80 text-sm text-slate-500 dark:bg-slate-900/80 dark:text-slate-400">Открывается локальный редактор…</div>}
  </div>;
}
