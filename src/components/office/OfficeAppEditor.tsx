import { queueOfficeReply } from './officeReplyQueue';
import { useFluxCellActions } from './useFluxCellActions';
import { useFileProject } from '../../lib/useFileProject';
import { useOfficeIssued } from './useOfficeIssued';
/**
 * PDF и Таблица Flux Office: редактор GenOffice во фрейме, его главный
 * процесс — на сервере Flux (server/officeHostApps.ts).
 *
 * Окно здесь — почтальон: вызовы редактора (ipcRenderer.invoke из его
 * собственного preload, собранного для страницы, — tools/genoffice/shims/
 * electron-renderer.js) уходят по сокету на сервер, ответы и сообщения
 * главного процесса возвращаются во фрейм. Язык и тему отвечает само окно —
 * они принадлежат Flux, а не серверу.
 *
 * PDF правит один (держатель, server/officeRooms.ts), остальные смотрят;
 * после его сохранения у них открывается свежая версия.
 *
 * Общую книгу Таблицы правят все сразу: правки идут через сервер
 * (server/officeSheetCollab.ts ↔ tools/genoffice/inject/sheets-collab.ts),
 * а записывает держатель — сам, после паузы, и по Ctrl+S любого соавтора.
 *
 * В отделе у каждого сотрудника свой сервер, и держатель бывает на чужом: и
 * правки, и просьба «запиши», и «записал» ходят через общую базу
 * (server/officeBus.ts). Вопросов «что делать с моими правками» здесь нет и
 * быть не может: запись идёт на сервере, а он сам сверяется с последней записью
 * сеанса, повторяет её, если держатель успел смениться, и передаёт просьбу
 * настоящему держателю, если список окна устарел (server/officeHostApps.ts).
 */
import React, { forwardRef, useImperativeHandle, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Btn, Empty } from '../ui';
import FluxPanel from './FluxPanel';
import FluxOfficePanel from './FluxOfficePanel';
import { officeDataApi } from './fluxData';
import { sheetsEditorLink, useOfficeFluxBridge } from './useOfficeFluxBridge';
import { openEditorTag } from '../../lib/editorTag';
import FileEnglishVersion from '../translate/FileEnglishVersion';
import { sheetName, cellValue } from '../../../office/fieldKeys';
import { useOfficeRoom } from '../collab/useOfficeRoom';
import OfficePresence from '../collab/OfficePresence';
import { rememberDoc } from '../../store/recentStore';
import { editorHref } from '../../lib/officeFiles';
import { useWindowTitle, usePaneId } from '../../lib/paneTitle';
import { guardClose } from '../../lib/closeGuard';
import { useStore } from '../../store/store';
import { useModalStore } from '../../store/modalStore';
import { useToastStore } from '../../store/toastStore';
import { isOfficeMsg, isOfficeEditorReadyMessage, targetOrigin, fromOwnFrame } from '../../lib/officeBridge';
import { dueToSave } from '../collab/useDocCollab';

export type HostedApp = 'pdf' | 'sheets';

const TITLES: Record<HostedApp, string> = { pdf: 'Flux Office — PDF', sheets: 'Flux Office — Таблица' };
const EDITOR_READY_MS = 45_000;

/** На что окно отвечает само: язык, тема, ИИ (отключён) */
export function localAnswer(channel: string, theme: string): { hit: boolean; value?: unknown; error?: string } {
  if (channel === 'app:get-language') return { hit: true, value: 'ru' };
  if (channel === 'app:get-theme') return { hit: true, value: theme };
  if (channel === 'app:get-ai-panel-prefs') return { hit: true, value: { side: 'right', fontSize: 'medium', customFontSize: 14, spellcheck: false } };
  if (channel === 'app:set-ai-panel-prefs') return { hit: true, value: null };
  // Автосохранение Таблицы по умолчанию — выключено, как в Excel без облака
  if (channel === 'app:get-auto-save-default') return { hit: true, value: false };
  if (/^(ai|gsk|project|mcp):/.test(channel) || /generate-image|image-search|fetch-image/.test(channel)) {
    return { hit: true, error: 'Во Flux Office это отключено: программа работает без внешних сервисов' };
  }
  return { hit: false };
}

export interface OfficeAppEditorHandle { command: (channel: string, payload?: unknown) => Promise<any>; save: (force?: boolean) => Promise<boolean> }
interface EditorProps { app: HostedApp; fileId?: string; embedded?: boolean }
const OfficeAppEditor = forwardRef<OfficeAppEditorHandle, EditorProps>(function OfficeAppEditor({ app, fileId: explicitFileId, embedded }, ref) {
  const [params] = useSearchParams();
  const fileId = explicitFileId || params.get('file') || '';
  const navigate = useNavigate();
  const { issued, markIssued } = useOfficeIssued(fileId);
  const activeProjectId = useFileProject(fileId);
  const paneId = usePaneId();
  const theme = useStore((s) => s.theme);
  const addToast = useToastStore((s) => s.addToast);
  const frame = useRef<HTMLIFrameElement>(null);
  const cellActionsRef = useRef<{ open: (payload: any) => Promise<void>; beginEdit: (payload: any) => Promise<void>; edited: (payload: any) => Promise<void> } | null>(null);
  const obsoleteFrames = useRef(new WeakSet<object>());
  const [phase, setPhase] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [name, setName] = useState('');
  const [failure, setFailure] = useState('');
  const [frameKey, setFrameKey] = useState(0);
  const session = useRef<Promise<number> | null>(null);
  const sessionId = useRef(0);
  const dirty = useRef(false);
  const savePending = useRef<Promise<boolean> | null>(null);
  const savedHashRef = useRef('');
  const closeWait = useRef<((ok: boolean) => void) | null>(null);
  const fieldWait = useRef<((r: { ok: boolean; cell?: string; error?: string } | null) => void) | null>(null);
  const commandWaits = useRef(new Map<string, (r: any) => void>());
  const officeEventWaits = useRef(new Map<string, (payload: any) => void>());
  const replyQueue = useRef(new Map<string, Promise<unknown>>());
  const command = (channel: string, payload?: unknown): Promise<any> => new Promise(resolve => {
    const id = crypto.randomUUID(); commandWaits.current.set(id, resolve);
    send({ event: 'ipc', payload: { channel, args: [{ id, payload }] } });
    setTimeout(() => { if (commandWaits.current.delete(id)) resolve({ ok: false, error: 'Редактор не ответил' }); }, 15000);
  });
  const [dataOpen, setDataOpen] = useState(false);
  const [legacyPanelOpen, setLegacyPanelOpen] = useState(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  /** Общая книга: опознаватель сеанса правок на сервере; '' — правит один */
  const collabKey = useRef('');
  const [together, setTogether] = useState(false);
  /** Незаписанное в общей книге: когда появилось и когда менялось последний раз */
  const unsaved = useRef<{ first: number | null; last: number | null }>({ first: null, last: null });
  const autoSave = useRef(false);
  const savingNow = useRef(0);
  const room = useOfficeRoom(fileId, () => {
    // Держатель записал — у смотрящего открыть свежее. В общей книге свежее
    // и так уже на экране: правки пришли по одной
    if (!room.holding && !collabKey.current) reopen();
  }, app);
  useEffect(() => room.listen('office:saved-self', (message: any) => {
    if (message?.session !== undefined && message.session !== sessionId.current) return;
    if (message?.fileId === fileId && typeof message.sha256 === 'string') savedHashRef.current = message.sha256;
  }), [room.listen, fileId]);
  const holdingRef = useRef(room.holding);
  holdingRef.current = room.holding;
  const touched = () => {
    const now = Date.now();
    unsaved.current = { first: unsaved.current.first ?? now, last: now };
  };
  useWindowTitle(embedded ? '' : name);
  // Недавние: открытый файл попадает в Пуск тем же адресом, что у двойного щелчка
  useEffect(() => {
    if (!embedded && fileId && name) rememberDoc({ href: editorHref({ id: fileId, name }), title: name, kind: app === 'pdf' ? 'pdf' : 'sheet', at: Date.now() });
  }, [fileId, name, embedded]);

  const send = useCallback((msg: object) => {
    frame.current?.contentWindow?.postMessage({ flux: 'office', ...msg }, targetOrigin(window.location.origin));
  }, []);

  /** Окно редактора на сервере: одно на фрейм, открывается по первому вызову */
  const ensureSession = useCallback(() => {
    if (!session.current) {
      session.current = room.request<{ session?: number; name?: string; sha256?: string; error?: string }>('office:host-open', { app })
        .then((r) => {
          if (!r?.session) throw new Error(r?.error || 'Редактор на сервере не ответил');
          sessionId.current = r.session;
          savedHashRef.current = r.sha256 || '';
          collabKey.current = String((r as any).collab?.key || '');
          setName(String(r.name || ''));
          return r.session;
        })
        .catch((err) => { session.current = null; throw err; });
    }
    return session.current;
  }, [room.request, app]);

  const reopen = () => {
    inlineEditingRef.current = false;
    // Старый фрейм ещё может послать запись до React commit. Его сообщения
    // не должны обращаться к новому сеансу с уже обновлёнными метаданными.
    if (frame.current?.contentWindow) obsoleteFrames.current.add(frame.current.contentWindow);
    phaseRef.current = 'loading';
    if (sessionId.current) room.emit('office:host-close', { session: sessionId.current });
    session.current = null;
    sessionId.current = 0;
    collabKey.current = '';
    setTogether(false);
    unsaved.current = { first: null, last: null };
    dirty.current = false;
    setPhase('loading');
    setFrameKey((k) => k + 1);
  };
  const reopenRef = useRef(reopen);
  reopenRef.current = reopen;

  const copyPending = useRef(false);
  const savePdfCopy = async () => {
    if (copyPending.current) return;
    copyPending.current = true;
    // Открытие диалога не должно запускать автосохранение исходного PDF.
    send({ event: 'ipc', payload: { channel: 'pdf:save-as-flow', args: [true] } });
    try {
      const wanted = await useModalStore.getState().openPrompt('Сохранить копию PDF', 'Копия появится рядом. Исходный файл останется без изменений.', 'Имя файла', name.replace(/\.pdf$/i, ' (копия).pdf'));
      if (!wanted) return;
      const r = await room.request<{ copy?: { name: string }; error?: string }>('office:save-copy', { session: await ensureSession(), name: wanted }, 120_000);
      addToast(r?.copy ? `Копия сохранена: ${r.copy.name}` : r?.error || 'Копия не сохранена', r?.copy ? 'success' : 'error');
    } catch (_) { addToast('Копия не сохранена. Правки остаются в окне', 'error'); }
    finally {
      copyPending.current = false;
      send({ event: 'ipc', payload: { channel: 'pdf:save-as-flow', args: [false] } });
      frame.current?.contentWindow?.focus();
    }
  };

  // Редактор → сервер
  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (!fromOwnFrame(e.source, frame.current?.contentWindow, e.origin, window.location.origin)) return;
      if (e.source && obsoleteFrames.current.has(e.source)) return;
      const currentFrame = () => e.source === frame.current?.contentWindow && !!e.source && !obsoleteFrames.current.has(e.source);
      const respond = (value: object) => { if (currentFrame()) send(value); };
      const m = e.data;
      if (!isOfficeMsg(m)) return;
      if (isOfficeEditorReadyMessage(app, m)) { phaseRef.current = 'ready'; setPhase('ready'); return; }
      if (m.op === 'flux:open-panel') { setLegacyPanelOpen(false); setDataOpen(true); return; }
      const channel = String(m.payload?.channel || '');
      const args = Array.isArray(m.payload?.args) ? m.payload.args : [];
      if (m.op === 'ipc-send' && channel.startsWith('flux:')) {
        if (channel === 'flux:cell-actions') { void cellActionsRef.current?.open(args[0]); return; }
        if (channel === 'flux:begin-cell-edit') { void cellActionsRef.current?.beginEdit(args[0]); return; }
        if (channel === 'flux:begin-cell-edit') { void cellActionsRef.current?.beginEdit(args[0]); return; }
        if (channel === 'flux:header-schema-edited') { inlineEditingRef.current = false; void cellActionsRef.current?.edited(args[0]); return; }
        if (channel === 'flux:anchor-selected') { setActiveFluxAnchor(args[0] || null); return; }
        const officeWait = officeEventWaits.current.get(channel);
        if (officeWait) { officeEventWaits.current.delete(channel); officeWait(args[0] || null); }
        if (channel === 'flux:tag-click') void openEditorTag(activeProjectId, args[0]);
        if (channel === 'flux:command-result') { const r = args[0]; const wait = commandWaits.current.get(r?.id); if (wait) { commandWaits.current.delete(r.id); wait(r); } }
        // Общая книга: свои правки — на сервер, номер — обратно редактору
        if (channel === 'flux:x-op' && collabKey.current) {
          touched();
          const [local, op] = args;
          room.request<{ seq?: number; error?: string }>('office:x-op', { key: collabKey.current, op }, 30_000).then((r) => {
            if (!currentFrame()) return;
            if (typeof r?.seq === 'number') respond({ event: 'ipc', payload: { channel: 'flux:x-ack', args: [local, r.seq] } });
            else if (r?.error === 'session') {
              addToast('Связь с общей книгой прервалась: сервер перезапускался. Книга открыта заново', 'error');
              reopenRef.current();
            } else if (r?.error) setFailure(r.error);
          }).catch(() => { if (currentFrame()) setFailure('Правка не дошла до сервера: нет связи. Соавторы её не видят'); });
        }
        if (channel === 'flux:x-applied') touched();
        if (channel === 'flux:x-ready') setTogether(true);
        if (channel === 'flux:field-inserted' && fieldWait.current) { const w = fieldWait.current; fieldWait.current = null; w(args[0] || null); }
        return;
      }
      if (m.op === 'flux:save-as' && app === 'pdf') { await savePdfCopy(); return; }
      if (m.op === 'ipc-send') {
        // Признак «изменено» и ответ на «сохрани перед закрытием» — окну
        if (/dirty-changed$/.test(channel)) dirty.current = args[0] === true;
        if (channel === 'workbook:pending-edits') dirty.current = Number(args[0]) > 0;
        if (/close-save-result$/.test(channel) && closeWait.current) { closeWait.current(args[0] === true); closeWait.current = null; }
        try { room.emit('office:ipc-send', { session: await ensureSession(), channel, args }); } catch (_) {}
        return;
      }
      if (m.op !== 'ipc' || m.id === undefined) return;
      const local = localAnswer(channel, themeRef.current);
      if (local.hit) { respond(local.error ? { reply: m.id, error: local.error } : { reply: m.id, result: local.value }); return; }
      try {
        const id = await ensureSession();
        // Общая книга: сеанс правок и журнал с начала сеанса
        if (channel === 'flux:x-config') { respond({ reply: m.id, result: { collab: !!collabKey.current, key: collabKey.current } }); return; }
        if (channel === 'flux:x-want') {
          const r = await room.request<{ key?: string; ops?: unknown[]; error?: string }>('office:x-want', { from: Number(args[0]) || 0 });
          if (r?.error) respond({ reply: m.id, error: r.error }); else respond({ reply: m.id, result: r });
          return;
        }
        // Записывает держатель: Ctrl+S соавтора — просьба к нему. Редактору —
        // «отменено», чтобы он не счёл правки записанными и не забыл их
        if (channel === 'workbook:save' && args[0]?.mode !== 'save-as' && collabKey.current && !holdingRef.current) {
          room.emit('office:save-request', {});
          respond({ reply: m.id, result: { canceled: true } });
          return;
        }
        const isCopy = channel === 'workbook:save' && args[0]?.mode === 'save-as';
        const copyName = isCopy ? await useModalStore.getState().openPrompt('Сохранить копию книги', 'Копия появится рядом. Исходный файл останется без изменений.', 'Имя файла', name.replace(/(\.[^.]+)$/, ' (копия)$1')) : undefined;
        if (isCopy && !copyName) { respond({ reply: m.id, result: { canceled: true } }); return; }
        const auto = channel === 'workbook:save' && autoSave.current;
        if (channel === 'workbook:save') { autoSave.current = false; savingNow.current = Date.now(); }
        const r = await room.request<{ result?: unknown; error?: string; copy?: { name: string } }>('office:ipc', { session: id, channel, args, auto, copyName });
        if (!currentFrame()) return;
        if (channel === 'workbook:save') {
          const done = r && !r.error && (r.result as any)?.canceled === false;
          // Записано всё, что было до начала записи; пришедшее позже ждёт следующей
          if (done && (unsaved.current.last ?? 0) <= savingNow.current) { unsaved.current = { first: null, last: null }; dirty.current = false; }
          else if (done) unsaved.current = { first: unsaved.current.last, last: unsaved.current.last };
          savingNow.current = 0;
        }
        if (r?.copy) addToast(`Копия сохранена: ${r.copy.name}`, 'success');
        if (r?.error) respond({ reply: m.id, error: r.error });
        else respond({ reply: m.id, result: r?.result });
      } catch (err: any) {
        if (!currentFrame()) return;
        const why = String(err?.message || err);
        if (/не установлен/.test(why)) setPhase('missing');
        else setFailure(why);
        respond({ reply: m.id, error: why });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [send, ensureSession, room.emit, room.request, activeProjectId, name]);

  // Сервер → редактор: сообщения главного процесса своему окну
  useEffect(() => room.listen('office:ipc-event', (m) => {
    if (m?.session && m.session === sessionId.current) send({ event: 'ipc', payload: { channel: m.channel, args: m.args || [] } });
  }), [room.listen, send]);

  // Общая книга: чужие правки — редактору по одной, в порядке сервера
  useEffect(() => room.listen('office:x-op', (m) => {
    if (collabKey.current) send({ event: 'ipc', payload: { channel: 'flux:x-op', args: [{ seq: m.seq, op: m.op }] } });
  }), [room.listen, send]);

  // Держатель общей книги записывает сам: после паузы и не реже раза в 15 с,
  // и сразу — по Ctrl+S соавтора. Запись — тем же путём, что Ctrl+S в Таблице
  useEffect(() => {
    if (app !== 'sheets') return;
    const saveNow = () => {
      if (!collabKey.current || !holdingRef.current || savingNow.current) return;
      autoSave.current = true;
      send({ event: 'ipc', payload: { channel: 'menu:action', args: ['save'] } });
    };
    const timer = setInterval(() => {
      if (dueToSave(Date.now(), unsaved.current.first, unsaved.current.last)) saveNow();
    }, 1000);
    const off = room.listen('office:save-request', () => { touched(); saveNow(); });
    return () => { clearInterval(timer); off(); };
  }, [app, room.listen, send]);

  useEffect(() => { if (phase === 'ready' && app === 'sheets') send({ event: 'ipc', payload: { channel: 'flux:set-read-only', args: [{ readOnly: issued }] } }); }, [phase, app, issued, send]);

  // Тема Flux — тема редактора
  useEffect(() => { if (phase === 'ready') send({ event: 'ipc', payload: { channel: 'app:theme-changed', args: [theme] } }); }, [theme, phase, send]);

  // Окно ушло — окно редактора на сервере тоже
  useEffect(() => () => { if (sessionId.current) room.emit('office:host-close', { session: sessionId.current }); }, [room.emit]);

  const onFrameLoad = useCallback(() => {
    try {
      const title = frame.current?.contentDocument?.title;
      if (title !== undefined && title !== 'Flux Office') { setPhase('missing'); return; }
    } catch (_) { /* с диска документ фрейма закрыт — ждём приветствия */ }
    setTimeout(() => { if (phaseRef.current === 'loading') setPhase('missing'); }, EDITOR_READY_MS);
  }, []);

  // Закрытие: несохранённое сохраняется тем же путём, что в Electron
  useEffect(() => {
    if (embedded || !paneId.startsWith('win:')) return;
    return guardClose(paneId.slice(4), async () => {
      if (phaseRef.current !== 'ready' || !dirty.current) return true;
      // Общую книгу записывает держатель: у соавтора всё уже у него
      if (collabKey.current && !holdingRef.current) return true;
      const ok = await saveNow();
      if (ok) return true;
      addToast('Файл не сохранён. Окно оставлено открытым, чтобы правка не пропала', 'error');
      return false;
    });
  }, [paneId, send, addToast, app]);

  // Данные проекта (только Таблица): значение — в выделенную ячейку, на ней
  // имя FLUX_<ключ>; «Обновить поля» — записать книгу, дать серверу подставить
  // значения по именам (server/routes/projectData.ts) и открыть её заново
  const [englishOpen, setEnglishOpen] = useState(false);
  const saveNow = useCallback(function saveNow(waitingSince = Date.now(), force = false): Promise<boolean> {
    if (Date.now() - waitingSince > 120_000) return Promise.resolve(false);
    // Закрытие ждёт уже начатую запись: второй вызов не должен ответить «нет правок» раньше первого.
    if (app === 'sheets' && savingNow.current) return new Promise(resolve => setTimeout(() => { void saveNow(waitingSince, force).then(resolve); }, 100));
    // Программное обновление отвечает раньше уведомления Univer «изменено».
    // Его сохранение не должно вернуть успех со старыми байтами файла.
    if (!dirty.current && !force) return Promise.resolve(true);
    if (phaseRef.current !== 'ready') return Promise.resolve(false);
    if (savePending.current) return savePending.current;
    const pending = new Promise<boolean>((resolve) => {
      closeWait.current = resolve;
      send({ event: 'ipc', payload: { channel: app === 'pdf' ? 'pdf:close-save-request' : 'workbook:close-save-request', args: [] } });
      setTimeout(() => { if (closeWait.current === resolve) { closeWait.current = null; resolve(false); } }, 120_000);
    });
    savePending.current = pending;
    void pending.finally(() => { if (savePending.current === pending) savePending.current = null; });
    return pending;
  }, [app, send]);
  const insertField = (f: { key: string; title: string; value: string }) => new Promise<void>((resolve) => {
    fieldWait.current = (r) => {
      if (r?.ok) addToast(`Поле «${f.title}» — в ячейке ${r.cell}`, 'success');
      else addToast(r?.error || 'Поле не вставлено', 'error');
      resolve();
    };
    send({ event: 'ipc', payload: { channel: 'flux:insert-field', args: [{ name: sheetName(f.key), value: cellValue(f.value === '—' ? '' : f.value) }] } });
    setTimeout(() => { if (fieldWait.current) { fieldWait.current = null; addToast('Редактор не ответил — поле не вставлено', 'error'); resolve(); } }, 8000);
  });
  const callFluxEvent = (channel: string, payload: unknown, responseChannel: string, timeout = 15_000) => {
    const expectedFrame = frame.current?.contentWindow;
    return queueOfficeReply(replyQueue.current, responseChannel, () => new Promise<any>((resolve) => {
      if (!expectedFrame || expectedFrame !== frame.current?.contentWindow) { resolve(null); return; }
      const finish = (value: any) => { if (officeEventWaits.current.get(responseChannel) === finish) officeEventWaits.current.delete(responseChannel); resolve(value); };
      officeEventWaits.current.set(responseChannel, finish);
      send({ event: 'ipc', payload: { channel, args: [payload] } });
      setTimeout(() => finish(null), timeout);
    }));
  };
  const flux = useOfficeFluxBridge(sheetsEditorLink(callFluxEvent), {
    state: () => officeDataApi.state(fileId),
    updateState: (body) => officeDataApi.updateState(fileId, body),
    // В общей книге записывает держатель: у соавтора всё уже у него
    flush: async () => (!!collabKey.current && !holdingRef.current) || saveNow(),
    committed: async () => {
      // Хеш относится к байтам открытого сеанса или его последней записи.
      // Не стираем подтверждение, если редактор уже сохранил книгу автоматически.
      if (!(await saveNow(Date.now(), true))) throw new Error('Изменения не записаны. Повторите сохранение.');
      const savedHash = savedHashRef.current;
      if (!savedHash) throw new Error('Редактор не подтвердил версию файла после сохранения. Повторите действие.');
      const current = await officeDataApi.state(fileId);
      if (current.baseHash !== savedHash) throw new Error('Документ изменился после сохранения. Обновите его и повторите действие.');
      return { current, savedHash };
    },
    remember: (hash) => { savedHashRef.current = hash; },
    writeBlocked: (kind) => collabKey.current && !holdingRef.current
      ? (kind === 'plan' ? 'Только держатель общей книги может завершить заполнение.' : 'Только держатель общей книги может записать схему; запросите запись у держателя.') : '',
    messages: { notSaved: 'Книга не записана. Сначала сохраните правки.', rowsMissing: 'Редактор не вернул сведения о заполненных строках. Сохраните книгу и проверьте результат.' },
  }, fileId);
  const { activeAnchor: activeFluxAnchor, setActiveAnchor: setActiveFluxAnchor, inlineEditingRef, requestState: requestOfficeState, insertBinding: insertOfficeBinding, applyWrites: applyOfficeWrites, updateSchema: updateOfficeSchema } = flux;
  const cellActions = useFluxCellActions({ fileId, projectId: activeProjectId,
    readOnly: issued || phase !== 'ready' || (!!collabKey.current && !room.holding) || !(room.mode === 'edit' || room.mode === 'alone' || (room.mode === 'together' && together)),
    requestState: requestOfficeState, updateSchema: updateOfficeSchema, insertBinding: insertOfficeBinding, isInlineEditing: () => inlineEditingRef.current,
    requestNative: async (operation, payload) => {
      const result = await callFluxEvent(operation === 'merge' ? 'flux:merge-header-columns' : 'flux:edit-header-formula', payload, operation === 'merge' ? 'flux:header-columns-merged' : 'flux:header-formula-edit-started', 30_000);
      if (operation === 'formula' && result?.ok) inlineEditingRef.current = true;
      return result;
    },
    onError: (message) => addToast(message, 'error'),
  });
  cellActionsRef.current = cellActions;
  const updateFields = async () => {
    if (!(collabKey.current && !holdingRef.current) && !(await saveNow())) { addToast('Книга не записана — поля не обновлены', 'error'); return; }
    const r = await fetch(`/api/project-data/files/${encodeURIComponent(fileId)}/update`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromEditor: true }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { addToast(d?.error || 'Поля не обновлены', 'error'); return; }
    const miss = (d.skipped || []).length;
    addToast(d.unchanged ? 'Поля уже актуальны' : `Обновлено полей: ${(d.changed || []).length}${miss ? `, без значения: ${miss}` : ''}`, miss ? 'info' : 'success');
    if (!d.unchanged) reopenRef.current();
  };

  useImperativeHandle(ref, () => ({ command, save: (force = false) => saveNow(Date.now(), force) }));
  const insertTable = async (rows: (string | number)[][]) => {
    const result = await command('flux:insert-table', { rows });
    if (!result?.ok) addToast(result?.error || 'Таблица не вставлена', 'error');
    return !!result?.ok;
  };
  if (!fileId) return <Empty title="Файл не выбран" text="Откройте файл из Проводника двойным щелчком." />;
  if (phase === 'missing') {
    return <Empty title="Редактор не установлен" text="В этой сборке нет редактора Flux Office. Обновите программу или запустите её сборку с GenOffice." />;
  }
  return (
    <div className="flex h-full w-full flex-col">
      <OfficePresence roster={room.roster} clientId={room.clientId} mode={room.mode}
        editable={room.mode === 'edit' || room.mode === 'alone' || (room.mode === 'together' && together)} onTake={async () => {
        const why = await room.take();
        if (why) addToast(why, 'error'); else reopenRef.current();
      }} />
      {app === 'pdf' && phase === 'ready' && <div className="flex shrink-0 justify-end border-b border-slate-200 px-3 py-1 dark:border-dark-border">
        <Btn onClick={() => void savePdfCopy()} title="Ctrl+Shift+S">Сохранить копию</Btn>
      </div>}
      {failure && (
        <div role="alert" className="shrink-0 border-b border-rose-200 bg-rose-50 px-3 py-1.5 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
          {failure}
        </div>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1">
      <div className="relative min-h-0 flex-1">
        <iframe key={`${fileId}:${frameKey}`} ref={frame} src={`genoffice/${app}/index.html`} title={TITLES[app]}
          onLoad={onFrameLoad} className="absolute inset-0 h-full w-full border-0 bg-white" />
        {phase === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70 dark:bg-slate-900/70 text-sm text-slate-500">Открывается…</div>
        )}
      </div>
      {cellActions.dialog}
      {dataOpen && (
        app === 'sheets' && !legacyPanelOpen ? <FluxOfficePanel fileId={fileId} projectId={activeProjectId} editorKind="sheets" fileName={name}
          readOnly={issued || phase !== 'ready' || (!!collabKey.current && !room.holding) || !(room.mode === 'edit' || room.mode === 'alone' || (room.mode === 'together' && together))} activeAnchor={activeFluxAnchor}
          isInlineEditing={() => inlineEditingRef.current} onIssued={() => { markIssued(); reopenRef.current(); }} onDraftCreated={(id) => navigate(editorHref({ id, name }))} requestState={requestOfficeState} insertBinding={insertOfficeBinding} applyWrites={applyOfficeWrites} updateSchema={updateOfficeSchema}
          schemaWriteAvailable={!issued && (room.mode !== 'together' || room.holding)}
          onOpenLegacy={() => setLegacyPanelOpen(true)} onClose={() => setDataOpen(false)} />
          : <FluxPanel fileId={fileId} projectId={activeProjectId} editorKind={app} fileName={name} onClose={() => setDataOpen(false)}
          readOnly={issued || !(room.mode === 'edit' || room.mode === 'alone' || (room.mode === 'together' && together))}
          onInsertField={app === 'sheets' ? insertField : undefined} onInsertTable={app === 'sheets' ? insertTable : undefined}
          onUpdateFields={updateFields} beforeTranslate={async () => { if (!(await saveNow())) throw new Error('Файл не записан'); }} />
      )}
      </div>

    </div>
  );
});
export default OfficeAppEditor;
