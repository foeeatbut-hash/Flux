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
 * Где что живёт. У каждого сотрудника свой сервер, а общая только база, поэтому
 * сеанс — исходник, ключ, кто засевает, снимок Y и журнал обновлений — лежит в
 * общей базе (server/officeBus.ts). Память сервера — кэш: свой Y-документ,
 * который сервер строит из снимка и журнала и дальше ведёт по потоку событий.
 * Y не боится повторов и разного порядка, поэтому лишнее прочитанное из базы
 * ему не вредит; опоздавшему отдаётся то, что собрано из базы, а не то, что
 * успел увидеть этот сервер.
 *
 * Сеанс без людей живёт в базе IDLE_MS, если всё записано. Незаписанное не
 * выбрасывается: сеанс ждёт, пока кто-нибудь откроет файл и держатель его
 * запишет.
 */
import type { Socket } from 'socket.io';
import { createHash, randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { officeHub, type OfficeRoomHub } from './officeRooms.js';
import { officeBus, IDLE_MS, SEED_STALE_MS, type OfficeBus, type SessionRow } from './officeBus.js';
import { officeOut, roomOf, type OfficeOut } from './officeIo.js';

export { IDLE_MS };

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
  /** До какого номера снимка из базы этот Y уже включает (0 — снимок не применялся) */
  snapSeq: number;
  /** Курсоры, которые сервер уже успел собрать из базы для опоздавших */
  awareLoaded: boolean;
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export class CollabBook {
  private sessions = new Map<string, CollabSession>();
  private opening = new Map<string, Promise<CollabSession>>();

  /** Сеанс файла; нет — открыть с текущим содержимым файла как исходником */
  async ensure(fileId: string, read: () => Promise<Buffer | { key: string; bytes: Buffer }>): Promise<CollabSession> {
    const have = this.sessions.get(fileId);
    if (have) return have;
    const pending = this.opening.get(fileId);
    if (pending) return pending;
    const p = (async () => {
      const got = await read();
      // Ключ приходит вместе с исходником, когда сеанс общий: у всех серверов он один
      const bytes = Buffer.isBuffer(got) ? got : got.bytes;
      const key = Buffer.isBuffer(got) ? randomUUID() : got.key;
      const ydoc = new Y.Doc();
      const s: CollabSession = {
        fileId, key, baseBytes: bytes, baseSha: sha256(bytes), ydoc, awareness: new Awareness(ydoc),
        seeded: false, seeder: null, waiting: new Set(), awarenessOf: new Map(), savedVector: null, emptyAt: null,
        snapSeq: 0, awareLoaded: false,
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

  /**
   * Забыть сеанс: файл записал сервер в обход окна (восстановление версии,
   * «Обновить поля»). Иначе следующий вошедший получил бы старый исходник и
   * старое содержимое из памяти, а автосохранение держателя записало бы его
   * поверх только что записанного.
   */
  drop(fileId: string): void {
    // У Awareness свой таймер: без destroy он пережил бы забытый сеанс
    try { this.sessions.get(fileId)?.awareness.destroy(); } catch (_) { /* уже остановлен */ }
    this.sessions.delete(fileId);
  }

  /** Все кэшированные сеансы: сервер обходит их по удару сердца */
  all(): CollabSession[] { return Array.from(this.sessions.values()); }

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
      if (now - s.emptyAt >= IDLE_MS && !this.unsaved(s)) this.drop(id);
      else if (!s.seeded && s.emptyAt != null) this.drop(id);
    }
  }

  /**
   * Кэш сервера, а не сеанс: без окон на этом сервере Y-документ никому не
   * нужен, а всё нужное для нового окна лежит в общей базе. Удерживать его
   * дольше значит хранить в памяти чужую работу, которую в любой момент можно
   * собрать заново из снимка и журнала.
   */
  evict(now: number, occupied: (fileId: string) => boolean, afterMs: number): void {
    for (const [id, s] of Array.from(this.sessions)) {
      if (occupied(id)) { s.emptyAt = null; continue; }
      if (s.emptyAt == null) s.emptyAt = now;
      if (now - s.emptyAt >= afterMs) this.drop(id);
    }
  }
}

export const collab = new CollabBook();



const sha = (b: Buffer): string => sha256(b);
const bytesOf = (v: unknown): Uint8Array | null =>
  v instanceof Uint8Array ? v : Buffer.isBuffer(v) ? new Uint8Array(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : null;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Как часто курсор одного окна уходит в общую базу: чаще — лишняя запись на каждое движение мыши */
const AWARE_MS = 200;
/** Сколько помнить курсоры для опоздавшего */
const AWARE_KEEP_MS = 60_000;
/** Сколько сервер держит Y-документ файла, в котором у него нет окон */
const EVICT_MS = 60_000;
/** Сколько раз повторять запись правки в базу, прежде чем оставить её только в памяти */
const PUBLISH_TRIES = 5;

interface Outgoing { u: Uint8Array; seed?: CollabSession }

/**
 * Общий сеанс Документа на шине. Один на сервер; правила засева и Y-документ
 * остаются в CollabBook, а этот класс приносит в них состояние из базы и
 * уносит обратно.
 */
export class CollabShared {
  private outq = new Map<string, { items: Outgoing[]; running: boolean }>();
  private awareOut = new Map<string, { fileId: string; socketId: string; update: Uint8Array }>();
  private awareTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private bus: OfficeBus, readonly book: CollabBook, private hub: OfficeRoomHub, private out: OfficeOut = officeOut) {
    bus.on('y', (ev) => this.remoteY(ev.fileId, ev.data));
    bus.on('aware', (ev) => this.remoteAware(ev.fileId, ev.data));
    // Сеанс сброшен (файл записал сервер) — Y в памяти устарел
    bus.onReset((id) => this.book.drop(id));
    bus.onGap((id) => this.resync(id));
    bus.onTick(() => this.serveWaiting());
    bus.onBeat(() => { this.book.evict(bus.now(), (id) => this.hub.occupied(id), EVICT_MS); });
  }

  private log(m: string): void { console.error('[Office]', m); }

  /** Исходник сеанса и его ключ; сеанса нет — открыть с текущим содержимым файла */
  async base(fileId: string, read: () => Promise<Buffer>): Promise<SessionRow> {
    const row = await this.bus.ensureBase(fileId, 'docs', read, sha);
    if (!row.baseData) throw new Error('У сеанса нет исходника');
    return row;
  }

  /** Сеанс в памяти этого сервера — по строке из базы; сменился ключ, так и выбрасывается прежний */
  async session(fileId: string, read: () => Promise<Buffer>): Promise<CollabSession> {
    const row = await this.base(fileId, read);
    const have = this.book.get(fileId);
    if (have && have.key === row.key) return have;
    if (have) this.book.drop(fileId);
    return this.book.ensure(fileId, async () => ({ key: row.key, bytes: row.baseData as Buffer }));
  }

  /** Снимок и журнал из базы — в Y этого сервера; лишнее Y не вредит */
  async sync(s: CollabSession): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.bus.session(s.fileId);
      if (!row || row.key !== s.key) return;
      if (row.snapshot && s.snapSeq < row.snapshotSeq) { Y.applyUpdate(s.ydoc, row.snapshot, 'db'); s.snapSeq = row.snapshotSeq; }
      let from = row.snapshotSeq;
      for (;;) {
        const events = await this.bus.since(s.fileId, from, ['y']);
        for (const ev of events) if (ev.data) Y.applyUpdate(s.ydoc, ev.data, 'db');
        if (events.length < 2000) break;
        from = events[events.length - 1].seq;
      }
      // Пока читали журнал, уплотнение могло убрать его начало: тогда прочитанное неполно
      const again = await this.bus.session(s.fileId);
      if (again && again.snapshotSeq === row.snapshotSeq) return;
    }
  }

  /** Кто хочет содержимое: состояние, засев или ждать. Засевающего назначает база, а не сервер */
  async want(fileId: string, socketId: string, mayWrite: boolean, read: () => Promise<Buffer>): Promise<{ s: CollabSession; what: 'state' | 'seed' | 'wait' }> {
    const s = await this.session(fileId, read);
    await this.sync(s);
    const row = await this.bus.session(fileId);
    s.seeded = !!row?.seeded;
    const alive = !!row?.seederSocket && row.seederSocket !== socketId && row.seederAt != null && this.bus.now() - row.seederAt < SEED_STALE_MS;
    s.seeder = alive ? row!.seederSocket : null;
    let what = this.book.want(s, socketId, mayWrite);
    if (what === 'seed' && !(await this.claimSeed(fileId, socketId))) {
      // Другой сервер успел раньше
      s.seeder = null;
      s.waiting.add(socketId);
      what = 'wait';
    }
    if (what === 'state') s.waiting.delete(socketId);
    if (!s.awareLoaded) {
      s.awareLoaded = true;
      for (const ev of await this.bus.recent(fileId, 'aware', AWARE_KEEP_MS)) if (ev.data) {
        try { applyAwarenessUpdate(s.awareness, ev.data, 'db'); } catch (_) { /* устаревший курсор пропускаем */ }
      }
    }
    return { s, what };
  }

  /** Право засевать: условное обновление, выигрывает один сервер */
  async claimSeed(fileId: string, socketId: string): Promise<boolean> {
    const now = this.bus.now();
    return (await this.bus.patchSession({
      fileId, seeded: false,
      OR: [{ seederSocket: null }, { seederSocket: '' }, { seederSocket: socketId }, { seederAt: { lt: new Date(now - SEED_STALE_MS) } }],
    }, { seederSocket: socketId, seederAt: new Date(now) })) === 1;
  }

  /** Обновление окна — в журнал; засев — ещё и в сеанс (сеанс готов, снимок = исходник + засеянное) */
  push(fileId: string, u: Uint8Array, seed?: CollabSession): void {
    let q = this.outq.get(fileId);
    if (!q) { q = { items: [], running: false }; this.outq.set(fileId, q); }
    q.items.push({ u, seed });
    if (!q.running) void this.flush(fileId, q);
  }

  private async flush(fileId: string, q: { items: Outgoing[]; running: boolean }): Promise<void> {
    q.running = true;
    try {
      while (q.items.length) {
        // Засев — отдельной записью; остальное, накопившееся пока писалось прошлое, — одной
        const batch: Outgoing[] = [];
        if (q.items[0].seed) batch.push(q.items.shift() as Outgoing);
        else while (q.items.length && !q.items[0].seed) batch.push(q.items.shift() as Outgoing);
        const data = batch.length === 1 ? batch[0].u : Y.mergeUpdates(batch.map((b) => b.u));
        for (let attempt = 1; ; attempt++) {
          try {
            const seq = await this.bus.publish(fileId, { kind: 'y', data, app: 'docs' });
            if (batch[0].seed) await this.markSeeded(fileId, batch[0].seed, seq);
            break;
          } catch (e: any) {
            if (attempt >= PUBLISH_TRIES) { this.log(`Правка ${fileId} осталась только у этого сервера: ${e?.message || e}`); break; }
            await new Promise((r) => setTimeout(r, 400 * attempt));
          }
        }
      }
    } finally { q.running = false; if (!q.items.length) this.outq.delete(fileId); }
  }

  /** Засев дошёл до базы: сеанс готов, снимок — то, что засеяно, и оно уже лежит в файле */
  private async markSeeded(fileId: string, s: CollabSession, seq: number): Promise<void> {
    const state = Y.encodeStateAsUpdate(s.ydoc);
    await this.bus.patchSession({ fileId, key: s.key, seeded: false }, {
      seeded: true, snapshot: Buffer.from(state), snapshotSeq: seq, savedSeq: seq,
    });
  }

  /** Курсор окна: своим — сразу (это делает вызывающий), базе — не чаще AWARE_MS на окно */
  pushAware(fileId: string, socketId: string, update: Uint8Array): void {
    this.awareOut.set(`${fileId}|${socketId}`, { fileId, socketId, update });
    if (this.awareTimer) return;
    this.awareTimer = setTimeout(() => {
      this.awareTimer = null;
      const batch = Array.from(this.awareOut.values());
      this.awareOut.clear();
      for (const a of batch) {
        this.bus.publish(a.fileId, { kind: 'aware', fromSocket: a.socketId, data: a.update, app: 'docs' })
          .catch((e: any) => this.log(`Курсор ${a.fileId} не разослан: ${e?.message || e}`));
      }
    }, AWARE_MS);
    this.awareTimer.unref?.();
  }

  /** Обновление с другого сервера: в Y этого (если он есть) и окнам */
  private remoteY(fileId: string, data: Buffer | null): void {
    if (!data) return;
    const s = this.book.get(fileId);
    if (s) { try { Y.applyUpdate(s.ydoc, data, 'bus'); } catch (_) { return; } }
    this.out.room(fileId, 'office:y', { fileId, update: data });
    if (s?.waiting.size) void this.serveWaiting();
  }

  private remoteAware(fileId: string, data: Buffer | null): void {
    if (!data) return;
    const s = this.book.get(fileId);
    if (s) { try { applyAwarenessUpdate(s.awareness, data, 'bus'); } catch (_) { return; } }
    this.out.room(fileId, 'office:y-aware', { fileId, update: data });
  }

  /** Часть журнала убрана уплотнением раньше, чем сервер её прочитал: взять из снимка и показать разницу окнам */
  private async resync(fileId: string): Promise<void> {
    const s = this.book.get(fileId);
    if (!s) return;
    const before = Y.encodeStateVector(s.ydoc);
    await this.sync(s);
    const diff = Y.encodeStateAsUpdate(s.ydoc, before);
    if (diff.length > 2) this.out.room(fileId, 'office:y', { fileId, update: diff });
  }

  /**
   * Ждущие содержимого: засеяли (в том числе на другом сервере) — отдать
   * состояние; засевающий пропал — поручить засев тому, кто ждёт здесь.
   * Запускается каждый оборот насоса и по каждому чужому обновлению.
   */
  async serveWaiting(): Promise<void> {
    for (const s of this.book.all()) {
      if (!s.waiting.size) continue;
      try {
        const row = await this.bus.session(s.fileId);
        if (!row || row.key !== s.key) continue;
        if (row.seeded) {
          await this.sync(s);
          const state = Y.encodeStateAsUpdate(s.ydoc);
          s.seeded = true;
          for (const sid of s.waiting) this.out.socket(sid, 'office:y-state', { fileId: s.fileId, session: s.key, state });
          s.waiting.clear();
          continue;
        }
        // Засевающий ушёл или его сервер упал: право переходит к тому, кто ждёт
        if (row.seederSocket && !(await this.bus.peers(s.fileId)).some((p) => p.socketId === row.seederSocket)) {
          await this.bus.patchSession({ fileId: s.fileId, seeded: false, seederSocket: row.seederSocket }, { seederSocket: null });
        }
        for (const sid of Array.from(s.waiting)) {
          if (!this.hub.peerLocal(s.fileId, sid)?.mayWrite) continue;
          if (await this.claimSeed(s.fileId, sid)) {
            s.waiting.delete(sid);
            s.seeder = sid;
            this.out.socket(sid, 'office:y-state', { fileId: s.fileId, session: s.key, seed: true });
            break;
          }
        }
      } catch (e: any) { this.log(`Ожидающие ${s.fileId}: ${e?.message || e}`); }
    }
  }

  /**
   * Держатель записал: теперь в файле всё, что было в Y на этот момент.
   * Снимок пересчитывается после каждой записи, а журнал до него убирается —
   * опоздавшему не проигрывать всю историю.
   */
  async saved(fileId: string): Promise<void> {
    const s = this.book.get(fileId);
    if (!s) return;
    this.book.markSaved(s);
    await this.bus.drain(fileId);
    const seen = this.bus.seen(fileId);
    const row = await this.bus.session(fileId);
    if (!row || row.key !== s.key) return;
    await this.bus.patchSession({ fileId, key: s.key, snapshotSeq: { lt: seen } }, { snapshot: Buffer.from(Y.encodeStateAsUpdate(s.ydoc)), snapshotSeq: seen });
    await this.bus.patchSession({ fileId, key: s.key, savedSeq: { lt: row.dataSeq } }, { savedSeq: row.dataSeq });
    await this.bus.pruneEvents(fileId, 'y', seen);
  }

  /** Окно ушло: курсор убрать у всех, право засевать — вернуть */
  async leave(fileId: string, socketId: string): Promise<void> {
    const s = this.book.get(fileId);
    if (!s) return;
    const before = new Set(s.awareness.getStates().keys());
    const next = this.book.gone(s, socketId, this.bus.now());
    const removed = Array.from(before).filter((k) => !s.awareness.getStates().has(k));
    if (removed.length) {
      const update = encodeAwarenessUpdate(s.awareness, removed);
      this.out.room(fileId, 'office:y-aware', { fileId, update });
      this.bus.publish(fileId, { kind: 'aware', fromSocket: socketId, data: update, app: 'docs' }).catch(() => undefined);
    }
    // Засевающий ушёл, не засеяв: сначала вернуть право в базу, потом отдать следующему
    if (!s.seeded) {
      await this.bus.patchSession({ fileId, seeded: false, seederSocket: socketId }, { seederSocket: null }).catch(() => 0);
      if (next && await this.claimSeed(fileId, next).catch(() => false)) this.out.socket(next, 'office:y-state', { fileId, session: s.key, seed: true });
      else if (next) { s.seeder = null; s.waiting.add(next); }
    }
  }
}

export const collabShared = new CollabShared(officeBus, collab, officeHub);

export interface CollabDeps {
  /** Содержимое файла сейчас — исходник нового сеанса */
  read: (fileId: string) => Promise<Buffer>;
}

/** Подписать одно соединение на обмен правками. Зовётся из connection */
export function setupOfficeCollab(
  socket: Socket, deps: CollabDeps,
  parts: { hub: OfficeRoomHub; shared: CollabShared; out: OfficeOut } = { hub: officeHub, shared: collabShared, out: officeOut },
): { gone: () => void } {
  const { hub, shared: collabShared, out } = parts;
  const collab = collabShared.book;
  const mine = new Set<string>();
  const member = (fileId: string) => (ID.test(fileId) ? hub.peerLocal(fileId, socket.id) : null);

  socket.on('office:y-want', async ({ fileId }: { fileId: string }) => {
    const id = String(fileId || '');
    const peer = member(id);
    if (!peer || !hub.isCollab(id)) return;
    try {
      mine.add(id);
      const { s, what } = await collabShared.want(id, socket.id, peer.mayWrite, () => deps.read(id));
      if (what === 'state') socket.emit('office:y-state', { fileId: id, session: s.key, state: Y.encodeStateAsUpdate(s.ydoc) });
      else if (what === 'seed') socket.emit('office:y-state', { fileId: id, session: s.key, seed: true });
      // Курсоры тех, кто уже в файле
      const states = Array.from(s.awareness.getStates().keys());
      if (states.length) socket.emit('office:y-aware', { fileId: id, update: encodeAwarenessUpdate(s.awareness, states) });
    } catch (e: any) { console.error('[Office] Содержимое общего документа не отдано:', e?.message || e); }
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
    // Своим окнам — сразу, не дожидаясь базы: Y не боится порядка
    socket.to(roomOf(id)).emit('office:y', { fileId: id, update: u });
    collabShared.push(id, u, seededNow ? s : undefined);
    if (seededNow) {
      const state = Y.encodeStateAsUpdate(s.ydoc);
      for (const sid of s.waiting) out.socket(sid, 'office:y-state', { fileId: id, session: s.key, state });
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
    collabShared.pushAware(id, socket.id, u);
  });

  /** Держатель записал: теперь в файле всё, что было в Y на этот момент */
  socket.on('office:saved', ({ fileId }: { fileId: string }) => {
    const id = String(fileId || '');
    if (hub.holds(id, socket.id)) void collabShared.saved(id).catch((e: any) => console.error('[Office] Снимок общего документа не записан:', e?.message || e));
  });

  const leave = (id: string) => { void collabShared.leave(id, socket.id); };
  socket.on('office:leave', ({ fileId }: { fileId: string }) => { const id = String(fileId || ''); leave(id); mine.delete(id); });

  return { gone: () => { for (const id of mine) leave(id); mine.clear(); } };
}
