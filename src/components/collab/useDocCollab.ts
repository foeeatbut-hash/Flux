/**
 * Одновременная правка общего файла на стороне окна Flux: окно — почтальон
 * между редактором во фрейме (inject/docs-collab.ts) и сервером
 * (server/officeCollab.ts). Содержимого оно не понимает, но решает три вещи,
 * которые ни редактор, ни сервер решить не могут:
 *
 *   - когда записывать файл. Пишет держатель (server/officeRooms.ts): через
 *     QUIET_MS тишины и не реже раза в MAX_UNSAVED_MS;
 *   - что делать с Ctrl+S соавтора — попросить держателя и дождаться его
 *     «записал», а не сказать «сохранено» наугад;
 *   - что делать, если сеанс на сервере сменился (сервер перезапускался):
 *     новый сеанс мог начаться с другого исходника, и дописывать в него своё
 *     нельзя — окно сохраняет свои правки копией рядом и открывается заново.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Тишина, после которой держатель записывает файл */
export const QUIET_MS = 3000;
/** И не реже, чем раз в столько, даже если печатают без остановки */
export const MAX_UNSAVED_MS = 15_000;
/** Сколько соавтор ждёт, пока держатель запишет по его Ctrl+S */
const ASK_SAVE_MS = 20_000;

/** Когда пора записать: правки есть, тишина выдержана или ждали слишком долго */
export function dueToSave(now: number, firstUnsavedAt: number | null, lastChangeAt: number | null): boolean {
  if (firstUnsavedAt == null || lastChangeAt == null) return false;
  return now - lastChangeAt >= QUIET_MS || now - firstUnsavedAt >= MAX_UNSAVED_MS;
}

/** Байты из сокета: socket.io отдаёт в браузере ArrayBuffer, во фрейм — Uint8Array */
export const asBytes = (v: unknown): Uint8Array | null =>
  v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;

interface Room {
  emit: (event: string, payload: object) => void;
  listen: (event: string, fn: (m: any) => void) => () => void;
  holding: boolean;
  linked: boolean;
}

export function useDocCollab({ on, room, send, me, saveNow, onSessionLost }: {
  /** Сеанс идёт: общий файл, редактор готов, я в комнате */
  on: boolean;
  room: Room;
  /** Событие во фрейм */
  send: (msg: object) => void;
  me: { name: string; color: string };
  /** Попросить редактор записать файл; true — записано */
  saveNow: () => Promise<boolean>;
  /** Сеанс на сервере сменился — окно спасает своё и открывается заново */
  onSessionLost: () => void;
}) {
  const [ready, setReady] = useState(false);
  const session = useRef<string>('');
  const firstUnsaved = useRef<number | null>(null);
  const lastChange = useRef<number | null>(null);
  const saving = useRef(false);
  const fns = useRef({ saveNow, onSessionLost });
  fns.current = { saveNow, onSessionLost };
  const holdingRef = useRef(room.holding);
  holdingRef.current = room.holding;

  const changed = () => {
    const now = Date.now();
    if (firstUnsaved.current == null) firstUnsaved.current = now;
    lastChange.current = now;
  };

  // Запуск: редактору — «сеанс», дальше он сам попросит содержимое
  const started = useRef(false);
  useEffect(() => {
    // Окно открывается заново (свежий фрейм) — сеанс начинается с нуля
    if (!on) { started.current = false; session.current = ''; setReady(false); return; }
    if (started.current) return;
    started.current = true;
    send({ event: 'collab', payload: { on: true, name: me.name, color: me.color } });
  }, [on, send, me.name, me.color]);

  // Сервер → редактор
  useEffect(() => {
    if (!on) return undefined;
    const offs = [
      room.listen('office:y', (m) => {
        const u = asBytes(m.update);
        if (!u) return;
        changed();
        send({ event: 'y', payload: u });
      }),
      room.listen('office:y-aware', (m) => { const u = asBytes(m.update); if (u) send({ event: 'y-aware', payload: u }); }),
      room.listen('office:y-state', (m) => {
        const key = String(m.session || '');
        if (session.current && key && key !== session.current) { fns.current.onSessionLost(); return; }
        if (key) session.current = key;
        send({ event: 'y-state', payload: m.seed ? { seed: true } : asBytes(m.state) });
      }),
      // Соавтор нажал Ctrl+S — записываю, если держу
      room.listen('office:save-request', () => { if (holdingRef.current) void flush(); }),
      // Связь вернулась: отдать своё, забрать пропущенное
      room.listen('reconnect', () => { if (ready) send({ event: 'y-resync', payload: null }); }),
    ];
    return () => offs.forEach((off) => off());
  }, [on, room.listen, send, ready]);

  /** Редактор → сервер. Возвращает true, если сообщение было про сеанс */
  const fromFrame = useCallback((op: string, payload: any): boolean => {
    if (op === 'y') { const u = asBytes(payload); if (u) { changed(); room.emit('office:y', { update: u }); } return true; }
    if (op === 'y-aware') { const u = asBytes(payload); if (u) room.emit('office:y-aware', { update: u }); return true; }
    if (op === 'y-want') { room.emit('office:y-want', {}); return true; }
    if (op === 'collab-ready') { setReady(true); return true; }
    return false;
  }, [room.emit]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (saving.current) return false;
    saving.current = true;
    // Правки, пришедшие во время записи, отметятся заново и уйдут следующей
    const was = { first: firstUnsaved.current, last: lastChange.current };
    firstUnsaved.current = null;
    lastChange.current = null;
    try {
      const ok = await fns.current.saveNow();
      if (!ok && firstUnsaved.current == null) { firstUnsaved.current = was.first; lastChange.current = was.last; }
      return ok;
    } finally { saving.current = false; }
  }, []);

  // Держатель записывает сам
  useEffect(() => {
    if (!on || !ready) return undefined;
    const t = setInterval(() => {
      if (holdingRef.current && room.linked && dueToSave(Date.now(), firstUnsaved.current, lastChange.current)) void flush();
    }, 500);
    return () => clearInterval(t);
  }, [on, ready, room.linked, flush]);

  /** Ctrl+S соавтора: попросить держателя и ждать его «записал» */
  const askHolder = useCallback(() => new Promise<boolean>((resolve) => {
    let done = false;
    const off = room.listen('office:saved', () => { if (!done) { done = true; off(); resolve(true); } });
    room.emit('office:save-request', {});
    setTimeout(() => { if (!done) { done = true; off(); resolve(false); } }, ASK_SAVE_MS);
  }), [room.emit, room.listen]);

  /** Есть ли правки, которых ещё нет в файле */
  const unsaved = () => firstUnsaved.current != null;

  return { ready, fromFrame, flush, askHolder, unsaved, markSaved: () => { firstUnsaved.current = null; lastChange.current = null; } };
}
