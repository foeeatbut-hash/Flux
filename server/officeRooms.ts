/**
 * Комната файла Flux Office: кто открыл файл и кто его правит.
 *
 * Правит один — держатель правки, остальные смотрят. Не потому, что
 * одновременная правка не нужна (она следующий шаг), а потому, что без
 * держателя два сохранения с разных исходников испортили бы файл: редактор
 * помнит абзацы номерами блоков того файла, с которого начал. Держатель —
 * тот, кто сохраняет; на нём же потом встанет сведение правок.
 *
 * Правила (проверяются scripts/test-office-rooms.ts):
 *   - держатель — первый вошедший, кому файл можно писать (если правку в
 *     этой комнате ещё не отпускали);
 *   - остальные — зрители; после каждого сохранения держателя они получают
 *     свежую версию;
 *   - держатель ушёл (закрыл окно) — правка свободна, её берёт зритель
 *     кнопкой; сама она не переходит: у зрителя на экране может быть не то,
 *     что в файле, и молча дать ему правку значило бы подсунуть сюрприз;
 *   - держатель пропал (обрыв связи) — правка ждёт его GRACE_MS: вернулось
 *     то же окно — продолжает, как будто ничего не было;
 *   - сервер не пишет файл от того, кто правку не держит (officeFiles.ts).
 *
 * Состояние в памяти: вопрос «кто сейчас в файле» после перезапуска смысла
 * не имеет.
 */
import type { Server, Socket } from 'socket.io';
import { presenceColor } from './collab.js';

/** Сколько правка ждёт пропавшего держателя */
export const GRACE_MS = 20_000;

export interface OfficePeer {
  socketId: string;
  /** Окно Flux: одно и то же после переподключения сокета */
  clientId: string;
  userId: string;
  name: string;
  color: string;
  /** Может ли вообще писать этот файл (права на диск, чужой личный файл) */
  mayWrite: boolean;
  since: number;
}

interface Holder { peer: OfficePeer; lostAt: number | null }
/**
 * freed — правку отпустили: дальше её берут кнопкой, а не по приходу.
 * collab — файл в общем доступе: правят все сразу (server/officeCollab.ts),
 * держатель только записывает файл и передаётся следующему сам — у всех
 * одно содержимое и один исходник, отдавать нечего
 */
interface Room { peers: Map<string, OfficePeer>; holder: Holder | null; freed: boolean; collab: boolean }

export interface Roster {
  fileId: string;
  /** Совместная правка: правят все, кому можно писать */
  collab: boolean;
  holder: { socketId: string; clientId: string; userId: string; name: string; color: string; lost: boolean } | null;
  peers: Array<Pick<OfficePeer, 'socketId' | 'clientId' | 'userId' | 'name' | 'color' | 'mayWrite'>>;
}

/** Книга комнат: только правила, без сокета — ради проверки без сервера */
export class OfficeRoomBook {
  private rooms = new Map<string, Room>();

  private room(fileId: string, collab = false): Room {
    let r = this.rooms.get(fileId);
    if (!r) { r = { peers: new Map(), holder: null, freed: false, collab }; this.rooms.set(fileId, r); }
    return r;
  }

  /** В общем файле — следующий, кто может писать: пришедший раньше */
  private promote(r: Room): void {
    if (!r.collab) return;
    const next = Array.from(r.peers.values()).filter((p) => p.mayWrite).sort((a, b) => a.since - b.since)[0];
    r.holder = next ? { peer: next, lostAt: null } : null;
  }

  /** Пропавший держатель, не вернувшийся вовремя, правку отдаёт */
  expire(now: number): string[] {
    const freed: string[] = [];
    for (const [fileId, r] of this.rooms) {
      if (r.holder?.lostAt != null && now - r.holder.lostAt >= GRACE_MS) {
        r.holder = null;
        r.freed = true;
        this.promote(r);
        freed.push(fileId);
      }
      if (!r.holder && r.peers.size === 0) this.rooms.delete(fileId);
    }
    return freed;
  }

  join(fileId: string, peer: OfficePeer, now: number, collab = false): void {
    this.expire(now);
    const r = this.room(fileId, collab);
    r.peers.set(peer.socketId, peer);
    const h = r.holder;
    // То же окно вернулось после обрыва — правка снова его
    if (h && h.lostAt != null && h.peer.clientId === peer.clientId && h.peer.userId === peer.userId) {
      r.holder = { peer, lostAt: null };
      return;
    }
    if (!h && (r.collab || !r.freed) && peer.mayWrite) r.holder = { peer, lostAt: null };
  }

  /** Закрыл окно: правка свободна сразу */
  leave(socketId: string): string[] {
    const touched: string[] = [];
    for (const [fileId, r] of this.rooms) {
      if (!r.peers.delete(socketId)) continue;
      touched.push(fileId);
      if (r.holder?.peer.socketId === socketId) { r.holder = null; r.freed = true; this.promote(r); }
      if (!r.holder && r.peers.size === 0) this.rooms.delete(fileId);
    }
    return touched;
  }

  /** Связь оборвалась: держатель ждёт GRACE_MS, зритель уходит сразу */
  lost(socketId: string, now: number): string[] {
    const touched: string[] = [];
    for (const [fileId, r] of this.rooms) {
      if (!r.peers.delete(socketId)) continue;
      touched.push(fileId);
      if (r.holder?.peer.socketId === socketId) r.holder.lostAt = now;
    }
    return touched;
  }

  /** Взять свободную правку. '' — взял, иначе причина */
  take(fileId: string, socketId: string, now: number): string {
    this.expire(now);
    const r = this.rooms.get(fileId);
    const peer = r?.peers.get(socketId);
    if (!r || !peer) return 'Файл не открыт в этом окне';
    if (!peer.mayWrite) return 'Этот файл вам можно только смотреть';
    if (r.holder?.peer.socketId === socketId) return '';
    if (r.holder) return `Файл правит ${r.holder.peer.name}`;
    r.holder = { peer, lostAt: null };
    return '';
  }

  /** Кто держит правку (в том числе пропавший, пока его ждут) */
  holder(fileId: string, now: number): OfficePeer | null {
    this.expire(now);
    return this.rooms.get(fileId)?.holder?.peer || null;
  }

  /** Участник этой комнаты по сокету */
  peerOf(fileId: string, socketId: string): OfficePeer | null {
    return this.rooms.get(fileId)?.peers.get(socketId) || null;
  }

  /** Держит ли правку именно это окно */
  holds(fileId: string, socketId: string): boolean {
    const h = this.rooms.get(fileId)?.holder;
    return !!h && h.lostAt == null && h.peer.socketId === socketId;
  }

  roster(fileId: string): Roster {
    const r = this.rooms.get(fileId);
    const h = r?.holder;
    return {
      fileId,
      collab: !!r?.collab,
      holder: h ? {
        socketId: h.peer.socketId, clientId: h.peer.clientId, userId: h.peer.userId,
        name: h.peer.name, color: h.peer.color, lost: h.lostAt != null,
      } : null,
      peers: r ? Array.from(r.peers.values()).map(({ socketId, clientId, userId, name, color, mayWrite }) => ({ socketId, clientId, userId, name, color, mayWrite })) : [],
    };
  }
}

export const officeRooms = new OfficeRoomBook();

const roomOf = (fileId: string) => `office:${fileId}`;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface OfficeRoomDeps {
  nameOf: (userId: string) => Promise<string>;
  /** '' — можно писать файл; тот же ответ, что у сохранения */
  mayWrite: (userId: string, fileId: string) => Promise<string>;
  /** Файл в общем доступе — правят вместе (личный правит только хозяин) */
  isShared: (fileId: string) => Promise<boolean>;
}

/** Таймер ожидания пропавших держателей — один на сервер */
let sweeper: ReturnType<typeof setInterval> | null = null;

/** Подписать одно соединение на комнаты файлов. Зовётся из connection */
export function setupOfficeRooms(io: Server, socket: Socket, deps: OfficeRoomDeps): { gone: (reason: string) => void } {
  const emit = (fileId: string) => io.to(roomOf(fileId)).emit('office:roster', officeRooms.roster(fileId));
  if (!sweeper) {
    sweeper = setInterval(() => { for (const f of officeRooms.expire(Date.now())) emit(f); }, 5_000);
    sweeper.unref?.();
  }

  socket.on('office:join', async ({ fileId, clientId, app }: { fileId: string; clientId: string; app?: string }) => {
    if (!ID.test(String(fileId || '')) || !ID.test(String(clientId || ''))) return;
    const userId = String((socket as any).userId || '');
    if (!userId) return;
    let name = 'Сотрудник';
    try { name = (await deps.nameOf(userId)) || name; } catch (_) { /* без имени участник всё равно виден */ }
    let mayWrite = false;
    try { mayWrite = !(await deps.mayWrite(userId, fileId)); } catch (_) { mayWrite = false; }
    // Правят вместе Документ и Таблица; в PDF правит один (держатель), как
    // раньше, — остальные смотрят и получают свежую версию после записи
    let shared = false;
    try { shared = ['docs', 'sheets'].includes(app || 'docs') && await deps.isShared(fileId); } catch (_) { shared = false; }
    socket.join(roomOf(fileId));
    officeRooms.join(fileId, {
      socketId: socket.id, clientId, userId, name, color: presenceColor(userId), mayWrite, since: Date.now(),
    }, Date.now(), shared);
    emit(fileId);
  });

  socket.on('office:leave', ({ fileId }: { fileId: string }) => {
    socket.leave(roomOf(String(fileId || '')));
    for (const f of officeRooms.leave(socket.id)) emit(f);
  });

  socket.on('office:take', ({ fileId }: { fileId: string }, ack?: (r: { error: string }) => void) => {
    const error = officeRooms.take(String(fileId || ''), socket.id, Date.now());
    if (typeof ack === 'function') ack({ error });
    if (!error) emit(String(fileId));
  });

  /**
   * «Сохрани сейчас» от соавтора (Ctrl+S): записывает только держатель, и
   * просьба уходит ему. Ответ соавтор узнает по office:saved
   */
  socket.on('office:save-request', ({ fileId }: { fileId: string }) => {
    const id = String(fileId || '');
    const h = officeRooms.holder(id, Date.now());
    if (h && officeRooms.peerOf(id, socket.id)) io.to(h.socketId).emit('office:save-request', { fileId: id });
  });

  /**
   * Держатель записал файл — зрителям пора взять свежую версию. Рассылает
   * только держатель: чужое «я сохранил» заставило бы всех перечитать файл
   * без причины
   */
  socket.on('office:saved', ({ fileId, sha256 }: { fileId: string; sha256: string }) => {
    if (!officeRooms.holds(String(fileId || ''), socket.id)) return;
    socket.to(roomOf(String(fileId))).emit('office:saved', { fileId, sha256: String(sha256 || '') });
  });

  return {
    /**
     * Соединение закрылось. Окно, закрытое человеком, отключается само —
     * это уход, правка свободна сразу. Его «ухожу» могло не успеть уйти:
     * окно шлёт его и тут же рвёт сокет, и без этой развилки закрытое окно
     * держало бы правку ещё GRACE_MS. Всё остальное — обрыв, и правка ждёт
     */
    gone: (reason: string) => {
      const touched = reason === 'client namespace disconnect'
        ? officeRooms.leave(socket.id)
        : officeRooms.lost(socket.id, Date.now());
      for (const f of touched) emit(f);
    },
  };
}
