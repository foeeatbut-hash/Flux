/**
 * Сеанс совместной правки файла Flux Office: правят все сразу.
 *
 * Только для файлов в общем доступе — личный правит один хозяин. Сервер не
 * понимает Word: он держит общий Y-документ (тело документа и состояние вне
 * тела — inject/docs-collab.ts), раздаёт обновления и курсоры и помнит
 * исходник сеанса. Файл записывает держатель (server/officeRooms.ts) — его
 * же редактор, с тем же исходником, что у всех.
 *
 * Почему исходник сеанса, а не текущий файл: редактор помнит абзацы
 * номерами блоков того файла, с которого начал. Держатель уже записал в
 * файл сегодняшние правки, а опоздавший открыл бы этот новый файл и
 * получил бы другие номера — его сохранение (он станет держателем, когда
 * первый уйдёт) перемешало бы абзацы. Поэтому все участники сеанса
 * открывают один и тот же исходник, а свежее содержимое берут из Y.
 *
 * Засевающий — ровно один: первый, кто может писать, переносит свой
 * документ в Y; остальные ждут и рисуют из Y. Двое засевающих дали бы
 * документ дважды.
 *
 * Сеанс живёт в памяти, пока в нём есть люди, и ещё IDLE_MS после ухода
 * последнего — если всё записано. Незаписанное не выбрасывается: сеанс
 * ждёт, пока кто-нибудь откроет файл и держатель его запишет.
 */
import type { Server, Socket } from 'socket.io';
import { createHash, randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { officeRooms } from './officeRooms.js';

/** Сколько живёт записанный сеанс без людей: переоткрыли — продолжили */
export const IDLE_MS = 10 * 60_000;

export interface CollabSession {
  fileId: string;
  /** Опознаватель сеанса: сменился (сервер перезапускался) — окно открывает документ заново */
  key: string;
  baseBytes: Buffer;
  baseSha: string;
  ydoc: Y.Doc;
  awareness: Awareness;
  seeded: boolean;
  /** Сокет, которому поручено засеять; null — пока никому */
  seeder: string | null;
  /** Ждут содержимого, пока засевающий не засеял */
  waiting: Set<string>;
  /** Какие курсоры чьи: при уходе окна его курсор убирается у всех */
  awarenessOf: Map<string, Set<number>>;
  /** Состояние на момент последней записи — есть ли незаписанное */
  savedVector: Uint8Array | null;
  emptyAt: number | null;
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export class CollabBook {
  private sessions = new Map<string, CollabSession>();
  private opening = new Map<string, Promise<CollabSession>>();

  /** Сеанс файла; нет — открыть с текущим содержимым файла как исходником */
  async ensure(fileId: string, read: () => Promise<Buffer>): Promise<CollabSession> {
    const have = this.sessions.get(fileId);
    if (have) return have;
    const pending = this.opening.get(fileId);
    if (pending) return pending;
    const p = (async () => {
      const bytes = await read();
      const ydoc = new Y.Doc();
      const s: CollabSession = {
        fileId, key: randomUUID(), baseBytes: bytes, baseSha: sha256(bytes), ydoc, awareness: new Awareness(ydoc),
        seeded: false, seeder: null, waiting: new Set(), awarenessOf: new Map(), savedVector: null, emptyAt: null,
      };
      // Серверу своего курсора не нужно
      s.awareness.setLocalState(null);
      this.sessions.set(fileId, s);
      return s;
    })();
    this.opening.set(fileId, p);
    try { return await p; } finally { this.opening.delete(fileId); }
  }

  get(fileId: string): CollabSession | null { return this.sessions.get(fileId) || null; }

  /** Есть ли правки, которых нет в файле */
  unsaved(s: CollabSession): boolean {
    if (!s.seeded) return false;
    const now = Y.encodeStateVector(s.ydoc);
    return !s.savedVector || Buffer.compare(Buffer.from(now), Buffer.from(s.savedVector)) !== 0;
  }

  /**
   * Кто хочет содержимое: засеявший сеанс — сразу; незасеянный и никому не
   * поручен — этот засевает (если может писать); иначе — ждать.
   */
  want(s: CollabSession, socketId: string, mayWrite: boolean): 'state' | 'seed' | 'wait' {
    if (s.seeded) return 'state';
    if (!s.seeder && mayWrite) { s.seeder = socketId; return 'seed'; }
    s.waiting.add(socketId);
    return 'wait';
  }

  /** Обновление от участника; true — сеанс только что засеян */
  update(s: CollabSession, socketId: string, u: Uint8Array): boolean {
    Y.applyUpdate(s.ydoc, u, socketId);
    if (!s.seeded && s.seeder === socketId) {
      s.seeded = true;
      // Засеянное — это исходник, то есть то, что уже лежит в файле
      s.savedVector = Y.encodeStateVector(s.ydoc);
      return true;
    }
    return false;
  }

  /** Окно ушло. Возвращает, кому теперь поручить засев (если засевающий ушёл, не засеяв) */
  gone(s: CollabSession, socketId: string, now: number): string | null {
    s.waiting.delete(socketId);
    const ids = s.awarenessOf.get(socketId);
    if (ids?.size) removeAwarenessStates(s.awareness, Array.from(ids), socketId);
    s.awarenessOf.delete(socketId);
    let next: string | null = null;
    if (!s.seeded && s.seeder === socketId) {
      s.seeder = null;
      next = Array.from(s.waiting)[0] || null;
      if (next) { s.waiting.delete(next); s.seeder = next; }
    }
    return next;
  }

  markSaved(s: CollabSession): void { s.savedVector = Y.encodeStateVector(s.ydoc); }

  /** Пустые сеансы: записанные — через IDLE_MS; незаписанные ждут людей */
  sweep(now: number, occupied: (fileId: string) => boolean): void {
    for (const [id, s] of this.sessions) {
      if (occupied(id)) { s.emptyAt = null; continue; }
      if (s.emptyAt == null) s.emptyAt = now;
      if (now - s.emptyAt >= IDLE_MS && !this.unsaved(s)) this.sessions.delete(id);
      if (!s.seeded && s.emptyAt != null) this.sessions.delete(id);
    }
  }
}

export const collab = new CollabBook();

const roomOf = (fileId: string) => `office:${fileId}`;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const bytesOf = (v: unknown): Uint8Array | null =>
  v instanceof Uint8Array ? v : Buffer.isBuffer(v) ? new Uint8Array(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : null;

export interface CollabDeps {
  /** Содержимое файла сейчас — исходник нового сеанса */
  read: (fileId: string) => Promise<Buffer>;
}

let sweeper: ReturnType<typeof setInterval> | null = null;

/** Подписать одно соединение на обмен правками. Зовётся из connection */
export function setupOfficeCollab(io: Server, socket: Socket, deps: CollabDeps): { gone: () => void } {
  if (!sweeper) {
    sweeper = setInterval(() => collab.sweep(Date.now(), (id) => officeRooms.roster(id).peers.length > 0), 30_000);
    sweeper.unref?.();
  }
  const mine = new Set<string>();
  const member = (fileId: string) => (ID.test(fileId) ? officeRooms.peerOf(fileId, socket.id) : null);

  socket.on('office:y-want', async ({ fileId }: { fileId: string }) => {
    const id = String(fileId || '');
    const peer = member(id);
    if (!peer || !officeRooms.roster(id).collab) return;
    const s = await collab.ensure(id, () => deps.read(id));
    mine.add(id);
    const what = collab.want(s, socket.id, peer.mayWrite);
    if (what === 'state') socket.emit('office:y-state', { fileId: id, session: s.key, state: Y.encodeStateAsUpdate(s.ydoc) });
    else if (what === 'seed') socket.emit('office:y-state', { fileId: id, session: s.key, seed: true });
    // Курсоры тех, кто уже в файле
    const states = Array.from(s.awareness.getStates().keys());
    if (states.length) socket.emit('office:y-aware', { fileId: id, update: encodeAwarenessUpdate(s.awareness, states) });
  });

  socket.on('office:y', ({ fileId, update }: { fileId: string; update: unknown }) => {
    const id = String(fileId || '');
    const peer = member(id);
    const s = collab.get(id);
    const u = bytesOf(update);
    // Правки шлёт только тот, кому файл можно писать
    if (!peer?.mayWrite || !s || !u) return;
    let seededNow = false;
    try { seededNow = collab.update(s, socket.id, u); } catch (_) { return; }
    socket.to(roomOf(id)).emit('office:y', { fileId: id, update: u });
    if (seededNow) {
      const state = Y.encodeStateAsUpdate(s.ydoc);
      for (const sid of s.waiting) io.to(sid).emit('office:y-state', { fileId: id, session: s.key, state });
      s.waiting.clear();
    }
  });

  socket.on('office:y-aware', ({ fileId, update }: { fileId: string; update: unknown }) => {
    const id = String(fileId || '');
    const s = collab.get(id);
    const u = bytesOf(update);
    if (!member(id) || !s || !u) return;
    const before = new Set(s.awareness.getStates().keys());
    try { applyAwarenessUpdate(s.awareness, u, socket.id); } catch (_) { return; }
    const ids = s.awarenessOf.get(socket.id) || new Set<number>();
    for (const k of s.awareness.getStates().keys()) if (!before.has(k)) ids.add(k);
    s.awarenessOf.set(socket.id, ids);
    socket.to(roomOf(id)).emit('office:y-aware', { fileId: id, update: u });
  });

  /** Держатель записал: теперь в файле всё, что было в Y на этот момент */
  socket.on('office:saved', ({ fileId }: { fileId: string }) => {
    const id = String(fileId || '');
    const s = collab.get(id);
    if (s && officeRooms.holds(id, socket.id)) collab.markSaved(s);
  });

  const leave = (id: string) => {
    const s = collab.get(id);
    if (!s) return;
    const before = new Set(s.awareness.getStates().keys());
    const next = collab.gone(s, socket.id, Date.now());
    const removed = Array.from(before).filter((k) => !s.awareness.getStates().has(k));
    if (removed.length) io.to(roomOf(id)).emit('office:y-aware', { fileId: id, update: encodeAwarenessUpdate(s.awareness, removed) });
    if (next) io.to(next).emit('office:y-state', { fileId: id, session: s.key, seed: true });
  };
  socket.on('office:leave', ({ fileId }: { fileId: string }) => { const id = String(fileId || ''); leave(id); mine.delete(id); });

  return { gone: () => { for (const id of mine) leave(id); mine.clear(); } };
}
