/**
 * Комната файла Flux Office на стороне окна: кто в файле и кто его правит.
 *
 * Правила держателя — на сервере (server/officeRooms.ts). Здесь только связь
 * и одно решение, которое сервер принять не может: что делать, если связи
 * нет вовсе. Тогда окно правит по-старому — сохранение всё равно сверяет
 * хеш, и чужую работу не затрёт. Запереть человека в просмотре из-за того,
 * что сокет не поднялся, было бы хуже.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { ENV_CONFIG, getAuthToken } from '../../config/env';

export interface OfficeRoster {
  fileId: string;
  /** Файл в общем доступе: правят все сразу, держатель только записывает */
  collab?: boolean;
  holder: { socketId: string; clientId: string; userId: string; name: string; color: string; lost: boolean } | null;
  peers: Array<{ socketId: string; clientId: string; userId: string; name: string; color: string; mayWrite?: boolean }>;
}

/**
 * edit — правлю я (один); view — смотрю; alone — связи нет, правлю под
 * сверкой хеша; together — общий файл, правим все вместе
 */
export type OfficeMode = 'pending' | 'edit' | 'view' | 'alone' | 'together';

/** Сколько ждать сокет, прежде чем править без комнаты */
const NO_LINK_MS = 6000;

/**
 * Кто я в файле. Держатель узнаётся по окну (clientId), а не по сокету: после
 * переподключения сокет новый, а окно и правка — прежние.
 *
 * Без связи решает последний известный список: правил другой — смотрю
 * дальше; правил я или правку никто не держал — правлю под сверкой хеша.
 */
export function officeMode(roster: OfficeRoster | null, clientId: string, linked: boolean, gaveUp: boolean): OfficeMode {
  const holder = roster?.holder || null;
  if (linked) {
    if (!roster) return 'pending';
    if (roster.collab) {
      const me = roster.peers.find((p) => p.clientId === clientId);
      if (!me) return 'pending';
      return me.mayWrite ? 'together' : 'view';
    }
    return holder && holder.clientId === clientId ? 'edit' : 'view';
  }
  // Без связи общий файл не правится: правки не дошли бы до соавторов, а
  // сохранение шло бы мимо общего документа
  if (roster?.collab) return 'view';
  if (holder && holder.clientId !== clientId) return 'view';
  if (holder) return 'edit';
  return gaveUp ? 'alone' : 'pending';
}

export function useOfficeRoom(fileId: string, onPeerSaved: (sha256: string) => void, app: 'docs' | 'pdf' | 'sheets' = 'docs') {
  const [roster, setRoster] = useState<OfficeRoster | null>(null);
  const [linked, setLinked] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const [socketId, setSocketId] = useState('');
  const sockRef = useRef<Socket | null>(null);
  // Окно одно и то же после переподключения сокета: по нему сервер
  // возвращает правку тому, у кого она была до обрыва
  const clientId = useRef(Math.random().toString(36).slice(2, 12) + Date.now().toString(36));
  const savedRef = useRef(onPeerSaved);
  savedRef.current = onPeerSaved;
  /** Подписчики событий сокета (совместная правка): событие → обработчики */
  const subs = useRef(new Map<string, Set<(m: any) => void>>());

  useEffect(() => {
    if (!fileId) return undefined;
    const sock = io(ENV_CONFIG.socketUrl, {
      auth: { token: getAuthToken() },
      transports: ['websocket', 'polling'],
      reconnectionDelay: 800,
      reconnectionDelayMax: 4000,
    });
    sockRef.current = sock;
    const giveUp = setTimeout(() => setGaveUp(true), NO_LINK_MS);
    sock.on('connect', () => {
      setLinked(true);
      setSocketId(sock.id || '');
      sock.emit('office:join', { fileId, clientId: clientId.current, app });
    });
    sock.on('disconnect', () => { setLinked(false); setGaveUp(true); });
    sock.on('office:roster', (r: OfficeRoster) => { if (r?.fileId === fileId) setRoster(r); });
    sock.on('office:saved', (m: { fileId: string; sha256: string }) => {
      if (m?.fileId === fileId) savedRef.current(String(m.sha256 || ''));
    });
    // Совместная правка: всё остальное окно разбирает само (OfficeHost)
    for (const ev of ['office:y', 'office:y-state', 'office:y-aware', 'office:save-request', 'office:saved', 'office:saved-self']) {
      sock.on(ev, (m: any) => { if (m?.fileId === fileId) subs.current.get(ev)?.forEach((fn) => fn(m)); });
    }
    // Сообщения главного процесса редактору (PDF, Таблица) — по номеру окна
    sock.on('office:ipc-event', (m: any) => subs.current.get('office:ipc-event')?.forEach((fn) => fn(m)));
    sock.io.on('reconnect', () => subs.current.get('reconnect')?.forEach((fn) => fn(null)));
    return () => {
      clearTimeout(giveUp);
      sock.emit('office:leave', { fileId });
      sock.disconnect();
      sockRef.current = null;
      setRoster(null);
      setLinked(false);
      setGaveUp(false);
    };
  }, [fileId, app]);

  /** Взять свободную правку. '' — взял, иначе причина */
  const take = useCallback(() => new Promise<string>((resolve) => {
    const sock = sockRef.current;
    if (!sock?.connected) return resolve('Нет связи с сервером');
    sock.timeout(5000).emit('office:take', { fileId }, (err: unknown, r: { error: string }) =>
      resolve(err ? 'Сервер не ответил' : String(r?.error || '')));
  }), [fileId]);

  /** Я записал файл — зрителям пора взять свежую версию */
  const saved = useCallback((sha256: string) => {
    sockRef.current?.emit('office:saved', { fileId, sha256 });
  }, [fileId]);

  /** Сказать серверу (совместная правка) */
  const emit = useCallback((event: string, payload: object) => {
    sockRef.current?.emit(event, { fileId, ...payload });
  }, [fileId]);

  /** Спросить сервер и дождаться ответа (редакторы на сервере: PDF, Таблица) */
  const request = useCallback(<T = any,>(event: string, payload: object, ms = 120_000) => new Promise<T>((resolve, reject) => {
    const sock = sockRef.current;
    if (!sock?.connected) return reject(new Error('Нет связи с сервером'));
    sock.timeout(ms).emit(event, { fileId, ...payload }, (err: unknown, r: T) => (err ? reject(new Error('Сервер не ответил')) : resolve(r)));
  }), [fileId]);

  /** Слушать событие сервера; возвращает отписку */
  const listen = useCallback((event: string, fn: (m: any) => void) => {
    const set = subs.current.get(event) || new Set();
    set.add(fn);
    subs.current.set(event, set);
    return () => { set.delete(fn); };
  }, []);

  const mode = officeMode(roster, clientId.current, linked, gaveUp);
  /** Я записываю файл: держатель — тот, кто сохраняет за всех */
  const holding = !!roster?.holder && roster.holder.clientId === clientId.current && !roster.holder.lost;
  return { roster, socketId, clientId: clientId.current, mode, holding, linked, take, saved, emit, listen, request };
}
