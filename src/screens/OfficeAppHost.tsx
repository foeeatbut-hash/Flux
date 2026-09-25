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
 * Правит один (держатель, server/officeRooms.ts), остальные смотрят; после
 * его сохранения у них открывается свежая версия. Одновременная правка PDF и
 * Таблицы — следующим шагом.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Empty } from '../components/ui';
import { useOfficeRoom } from '../components/collab/useOfficeRoom';
import OfficePresence from '../components/collab/OfficePresence';
import { useWindowTitle, usePaneId } from '../lib/paneTitle';
import { guardClose } from '../lib/closeGuard';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import { isOfficeMsg, targetOrigin, fromOwnFrame } from '../lib/officeBridge';

export type HostedApp = 'pdf' | 'sheets';

const TITLES: Record<HostedApp, string> = { pdf: 'PDF Flux Office', sheets: 'Таблица Flux Office' };
const HELLO_MS = 15_000;

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

export default function OfficeAppHost({ app }: { app: HostedApp }) {
  const [params] = useSearchParams();
  const fileId = params.get('file') || '';
  const paneId = usePaneId();
  const theme = useStore((s) => s.theme);
  const addToast = useToastStore((s) => s.addToast);
  const frame = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [name, setName] = useState('');
  const [failure, setFailure] = useState('');
  const [frameKey, setFrameKey] = useState(0);
  const session = useRef<Promise<number> | null>(null);
  const sessionId = useRef(0);
  const dirty = useRef(false);
  const closeWait = useRef<((ok: boolean) => void) | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const room = useOfficeRoom(fileId, () => {
    // Держатель записал — у смотрящего открыть свежее
    if (!room.holding) reopen();
  }, app);
  useWindowTitle(name);

  const send = useCallback((msg: object) => {
    frame.current?.contentWindow?.postMessage({ flux: 'office', ...msg }, targetOrigin(window.location.origin));
  }, []);

  /** Окно редактора на сервере: одно на фрейм, открывается по первому вызову */
  const ensureSession = useCallback(() => {
    if (!session.current) {
      session.current = room.request<{ session?: number; name?: string; error?: string }>('office:host-open', { app })
        .then((r) => {
          if (!r?.session) throw new Error(r?.error || 'Редактор на сервере не ответил');
          sessionId.current = r.session;
          setName(String(r.name || ''));
          return r.session;
        })
        .catch((err) => { session.current = null; throw err; });
    }
    return session.current;
  }, [room.request, app]);

  const reopen = () => {
    if (sessionId.current) room.emit('office:host-close', { session: sessionId.current });
    session.current = null;
    sessionId.current = 0;
    dirty.current = false;
    setPhase('loading');
    setFrameKey((k) => k + 1);
  };
  const reopenRef = useRef(reopen);
  reopenRef.current = reopen;

  // Редактор → сервер
  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (!fromOwnFrame(e.source, frame.current?.contentWindow, e.origin, window.location.origin)) return;
      const m = e.data;
      if (!isOfficeMsg(m)) return;
      if (m.op === 'hello') { setPhase('ready'); return; }
      const channel = String(m.payload?.channel || '');
      const args = Array.isArray(m.payload?.args) ? m.payload.args : [];
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
      if (local.hit) { send(local.error ? { reply: m.id, error: local.error } : { reply: m.id, result: local.value }); return; }
      try {
        const id = await ensureSession();
        const r = await room.request<{ result?: unknown; error?: string }>('office:ipc', { session: id, channel, args });
        if (r?.error) send({ reply: m.id, error: r.error });
        else send({ reply: m.id, result: r?.result });
      } catch (err: any) {
        const why = String(err?.message || err);
        if (/не установлен/.test(why)) setPhase('missing');
        else setFailure(why);
        send({ reply: m.id, error: why });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [send, ensureSession, room.emit, room.request]);

  // Сервер → редактор: сообщения главного процесса своему окну
  useEffect(() => room.listen('office:ipc-event', (m) => {
    if (m?.session && m.session === sessionId.current) send({ event: 'ipc', payload: { channel: m.channel, args: m.args || [] } });
  }), [room.listen, send]);

  // Тема Flux — тема редактора
  useEffect(() => { if (phase === 'ready') send({ event: 'ipc', payload: { channel: 'app:theme-changed', args: [theme] } }); }, [theme, phase, send]);

  // Окно ушло — окно редактора на сервере тоже
  useEffect(() => () => { if (sessionId.current) room.emit('office:host-close', { session: sessionId.current }); }, [room.emit]);

  const onFrameLoad = useCallback(() => {
    try {
      const title = frame.current?.contentDocument?.title;
      if (title !== undefined && title !== 'Flux Office') { setPhase('missing'); return; }
    } catch (_) { /* с диска документ фрейма закрыт — ждём приветствия */ }
    setTimeout(() => { if (phaseRef.current === 'loading') setPhase('missing'); }, HELLO_MS);
  }, []);

  // Закрытие: несохранённое сохраняется тем же путём, что в Electron
  useEffect(() => {
    if (!paneId.startsWith('win:')) return;
    return guardClose(paneId.slice(4), async () => {
      if (phaseRef.current !== 'ready' || !dirty.current) return true;
      const ok = await new Promise<boolean>((resolve) => {
        closeWait.current = resolve;
        send({ event: 'ipc', payload: { channel: app === 'pdf' ? 'pdf:close-save-request' : 'workbook:close-save-request', args: [] } });
        setTimeout(() => { if (closeWait.current === resolve) { closeWait.current = null; resolve(false); } }, 120_000);
      });
      if (ok) return true;
      addToast('Файл не сохранён. Окно оставлено открытым, чтобы правка не пропала', 'error');
      return false;
    });
  }, [paneId, send, addToast, app]);

  if (!fileId) return <Empty title="Файл не выбран" text="Откройте файл из Проводника двойным щелчком." />;
  if (phase === 'missing') {
    return <Empty title="Редактор не установлен" text="В этой сборке нет этого редактора Flux Office. Обновите программу." />;
  }
  return (
    <div className="flex h-full w-full flex-col">
      <OfficePresence roster={room.roster} clientId={room.clientId} mode={room.mode} editable={room.mode === 'edit' || room.mode === 'alone'} onTake={async () => {
        const why = await room.take();
        if (why) addToast(why, 'error'); else reopenRef.current();
      }} />
      {failure && (
        <div role="alert" className="shrink-0 border-b border-rose-200 bg-rose-50 px-3 py-1.5 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
          {failure}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <iframe key={`${fileId}:${frameKey}`} ref={frame} src={`genoffice/${app}/index.html`} title={TITLES[app]}
          onLoad={onFrameLoad} className="absolute inset-0 h-full w-full border-0 bg-white" />
        {phase === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70 dark:bg-slate-900/70 text-sm text-slate-500">Открывается…</div>
        )}
      </div>
    </div>
  );
}
