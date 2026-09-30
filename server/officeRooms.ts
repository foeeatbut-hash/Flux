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
 * Где что живёт. Правила — в OfficeRoomBook, чистом классе без сокета и без
 * базы. Состояние комнаты — в общей базе (OfficePeer, OfficeHolder): в отделе
 * у каждого сотрудника свой сервер, и комната в памяти одного сервера двоим не
 * общая (docs/office-collab-shared-db.md). OfficeRoomHub загружает комнату из
 * базы в книгу, применяет к ней те же правила и записывает итог: участники —
 * каждый сервер про своих, держатель — сравнением версии, чтобы двое серверов
 * не назначили каждый своего. Память сервера — только кэш последнего списка.
 */
import type { Socket } from 'socket.io';
import { presenceColor } from './presenceColor.js';
import { officeBus, STALE_MS, type OfficeBus, type PeerRow, type HolderRow } from './officeBus.js';
import { officeOut, roomOf, type OfficeOut } from './officeIo.js';

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

/** Комната такой, какой её записывают в общую базу и читают из неё */
export interface RoomCell { collab: boolean; freed: boolean; holder: { peer: OfficePeer; lostAt: number | null } | null }
export interface RoomSnapshot extends RoomCell { peers: OfficePeer[] }

/** Книга комнат: только правила, без сокета и без базы — ради проверки без сервера */
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

  /**
   * Загрузить комнату из общей базы. Правила те же, что у комнаты в памяти:
   * держатель и участники приходят готовыми строками, дальше книга решает, кто
   * держит правку, теми же join / leave / lost / take / expire.
   */
  load(fileId: string, s: RoomSnapshot): void {
    this.rooms.set(fileId, {
      peers: new Map(s.peers.map((p) => [p.socketId, p])),
      holder: s.holder ? { peer: s.holder.peer, lostAt: s.holder.lostAt } : null,
      freed: s.freed,
      collab: s.collab,
    });
  }

  /**
   * Что комната записывает в общую базу. null — комнаты нет: в ней никого и
   * правка не держится, «отпущенность» кончилась вместе с последним окном.
   */
  cell(fileId: string): RoomCell | null {
    const r = this.rooms.get(fileId);
    if (!r) return null;
    return { collab: r.collab, freed: r.freed, holder: r.holder ? { peer: r.holder.peer, lostAt: r.holder.lostAt } : null };
  }

  /**
   * Держатель, которого нет среди участников, а связь с ним не помечена
   * потерянной: строку участника убрали (сервер упал, а его уборщик успел
   * раньше), не тронув держателя. Такой считается потерявшим связь с момента
   * `at`: вернётся — продолжит, не вернётся — правка освободится, как при обрыве.
   */
  reconcile(fileId: string, at: number): void {
    const r = this.rooms.get(fileId);
    if (r?.holder && r.holder.lostAt == null && !r.peers.has(r.holder.peer.socketId)) r.holder.lostAt = at;
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


// ── Общая комната: правила книги над состоянием в базе ────────────────────

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Участник, как его держит сервер у себя: с приложением, которое его открыло */
export type LocalPeer = OfficePeer & { app: string };

/** Совпадает ли комната, посчитанная книгой, со строкой держателя в базе */
function sameCell(cell: RoomCell | null, row: HolderRow | null): boolean {
  if (!cell) return !row;
  if (!row) return false;
  const h = cell.holder;
  return cell.collab === row.collab && cell.freed === row.freed
    && (h?.peer.socketId || '') === row.socketId && (h?.lostAt ?? null) === row.lostAt;
}

const peerOf = (r: PeerRow): OfficePeer => ({
  socketId: r.socketId, clientId: r.clientId, userId: r.userId, name: r.name, color: r.color, mayWrite: r.mayWrite, since: r.since,
});

export interface HubOptions {
  /** Куда отдавать события окнам этого сервера; по умолчанию — его сокеты */
  out?: OfficeOut;
  log?: (m: string) => void;
}

/**
 * Комнаты файлов на общей базе. Один на сервер.
 *
 * Каждая операция над комнатой идёт по кругу «прочитать всё из базы →
 * применить правило книги → записать»: участников каждый сервер пишет про
 * своих сам, держателя — только сравнением версии, а не «записал и надеюсь».
 * Проиграл сравнение — пересчитал по свежему. Так двое серверов, вошедшие в
 * файл в одну и ту же секунду, не назначают каждый своего держателя.
 *
 * Операции над одним файлом на этом сервере идут по очереди: иначе более
 * ранний ответ базы мог бы прийти окну позже более позднего.
 */
export class OfficeRoomHub {
  /** Мои окна: файл → сокет → участник. Кэш того, что записано про меня в базе */
  private local = new Map<string, Map<string, LocalPeer>>();
  private collabOfFile = new Map<string, boolean>();
  /** Последний разосланный список: по нему решается, слать ли новый и кто держит */
  private rosters = new Map<string, Roster>();
  private sent = new Map<string, string>();
  private chains = new Map<string, Promise<unknown>>();

  readonly out: OfficeOut;

  constructor(private bus: OfficeBus, private opts: HubOptions = {}) {
    this.out = opts.out || officeOut;
    // Чужой сервер изменил комнату — пересчитать и, если список другой, разослать своим окнам
    bus.on('roster', (ev) => { void this.refresh(ev.fileId); });
    // Держатель на другом сервере записал файл — своим окнам взять свежее
    bus.on('saved', (ev) => {
      let sha = '';
      try { sha = String(JSON.parse(ev.data ? ev.data.toString('utf8') : '{}').sha256 || ''); } catch (_) { /* без хеша окно перечитает по метаданным */ }
      this.out.room(ev.fileId, 'office:saved', { fileId: ev.fileId, sha256: sha }, ev.fromSocket);
    });
    // Просьба «запиши» адресована держателю: доходит, если он на этом сервере
    bus.on('save-request', (ev) => { if (ev.toSocket) this.out.socket(ev.toSocket, 'office:save-request', { fileId: ev.fileId }); });
    bus.onBeat(() => this.beat());
  }

  private log(m: string): void { try { (this.opts.log || ((x) => console.error('[Office]', x)))(m); } catch (_) { /* журнал — не условие работы */ } }

  private queue<T>(fileId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(fileId) || Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.chains.set(fileId, next);
    next.then(() => undefined, () => undefined).then(() => { if (this.chains.get(fileId) === next) this.chains.delete(fileId); });
    return next;
  }

  private mirror(fileId: string): Map<string, LocalPeer> {
    let m = this.local.get(fileId);
    if (!m) { m = new Map(); this.local.set(fileId, m); }
    return m;
  }

  private rowOf(fileId: string, p: LocalPeer): PeerRow {
    return {
      socketId: p.socketId, fileId, serverId: this.bus.serverId, clientId: p.clientId, userId: p.userId, name: p.name,
      color: p.color, mayWrite: p.mayWrite, app: p.app, since: p.since, beatAt: this.bus.now(),
    };
  }

  /** Комната из базы, с тем же разбором потерянных, что и при записи, но без записи */
  private async load(fileId: string, now: number, hintCollab: boolean): Promise<{ book: OfficeRoomBook; prev: HolderRow | null; stale: string[] }> {
    const [rows, prev] = await Promise.all([this.bus.peers(fileId), this.bus.holderRow(fileId)]);
    const book = new OfficeRoomBook();
    book.load(fileId, {
      peers: rows.map(peerOf),
      freed: prev?.freed ?? false,
      collab: prev ? prev.collab : hintCollab,
      holder: prev && prev.socketId ? {
        peer: { socketId: prev.socketId, clientId: prev.clientId, userId: prev.userId, name: prev.name, color: prev.color, mayWrite: true, since: 0 },
        lostAt: prev.lostAt,
      } : null,
    });
    // Участник без ударов сердца — его сервер упал и уйти по-человечески не успел.
    // Свои не трогаем: если моя очередь ударов запоздала, это моя беда, а не их уход
    const stale: string[] = [];
    for (const r of rows) {
      if (r.serverId === this.bus.serverId || now - r.beatAt < STALE_MS) continue;
      book.lost(r.socketId, r.beatAt);
      stale.push(r.socketId);
    }
    if (prev?.socketId) book.reconcile(fileId, prev.updatedAt);
    return { book, prev, stale };
  }

  /**
   * Применить правило и записать итог. Возвращает список после применения.
   * Своя запись участника — до расчёта (она ничьей не задевает), уход — после
   * успешного сравнения версии: при повторе книга должна снова увидеть уходящего.
   */
  private async apply(fileId: string, fn: (b: OfficeRoomBook, now: number) => void, o: { upsert?: LocalPeer; remove?: string[]; collab?: boolean } = {}): Promise<Roster> {
    if (o.upsert) await this.bus.upsertPeer(this.rowOf(fileId, o.upsert));
    const hint = o.collab ?? this.collabOfFile.get(fileId) ?? false;
    for (let i = 0; i < 8; i++) {
      const now = this.bus.now();
      const s = await this.load(fileId, now, hint);
      fn(s.book, now);
      s.book.expire(now);
      const cell = s.book.cell(fileId);
      if (!sameCell(cell, s.prev)) {
        const h = cell?.holder;
        const next = cell ? {
          collab: cell.collab, freed: cell.freed, socketId: h?.peer.socketId || '', clientId: h?.peer.clientId || '',
          userId: h?.peer.userId || '', name: h?.peer.name || '', color: h?.peer.color || '', lostAt: h?.lostAt ?? null,
        } : null;
        if (!(await this.bus.casHolder(fileId, s.prev ? s.prev.version : null, next))) continue;
      }
      const gone = [...(o.remove || []), ...s.stale];
      if (gone.length) await this.bus.deletePeers(gone);
      return s.book.roster(fileId);
    }
    throw new Error('Держатель правки не назначен: другие серверы меняют комнату слишком часто');
  }

  /** Своим окнам — сразу, остальным серверам — через шину */
  private async announce(fileId: string, roster: Roster, app = ''): Promise<void> {
    this.deliver(fileId, roster);
    try { await this.bus.publish(fileId, { kind: 'roster', app }); }
    catch (e: any) { this.log(`Список участников ${fileId} не разослан другим серверам: ${e?.message || e}`); }
  }

  private deliver(fileId: string, roster: Roster): void {
    this.rosters.set(fileId, roster);
    this.sent.set(fileId, JSON.stringify(roster));
    this.out.room(fileId, 'office:roster', roster);
  }

  /** Вошёл в файл: участник — в базу, держатель — по правилам книги */
  async join(fileId: string, p: Omit<LocalPeer, 'since'>, collab: boolean): Promise<Roster> {
    await this.bus.watch(fileId);
    try {
      const roster = await this.queue(fileId, async () => {
        // Раньше всех пришедших — иначе при разбросе часов позже пришедший
        // оказался бы «первым» и перехватил правку у записывающего
        const others = await this.bus.peers(fileId);
        const since = Math.max(this.bus.now(), ...others.map((o) => o.since + 1));
        const peer: LocalPeer = { ...p, since };
        this.mirror(fileId).set(peer.socketId, peer);
        this.collabOfFile.set(fileId, collab);
        // То же окно, но с другим сокетом: оно переподключилось, а старое соединение
        // так и не сообщило об обрыве (сервер перезапустили — сообщать было некому).
        // Старая строка — обрыв: правка ждёт вернувшееся окно, а не 35 секунд гаснущего сервера
        const before = others.filter((o) => o.clientId === p.clientId && o.userId === p.userId && o.socketId !== p.socketId).map((o) => o.socketId);
        return this.apply(fileId, (b, now) => {
          for (const id of before) b.lost(id, now);
          b.join(fileId, peer, now, collab);
        }, { upsert: peer, collab, remove: before });
      });
      await this.announce(fileId, roster, p.app);
      return roster;
    } catch (e) {
      // Не вошли — слушать нечего
      this.local.get(fileId)?.delete(p.socketId);
      if (!this.local.get(fileId)?.size) this.local.delete(fileId);
      this.bus.unwatch(fileId);
      throw e;
    }
  }

  /** Окно закрыто (leave) или связь оборвалась (lost) — по всем файлам этого сокета */
  async depart(socketId: string, how: 'leave' | 'lost', onlyFile?: string): Promise<void> {
    for (const [fileId, m] of Array.from(this.local)) {
      if (!m.has(socketId) || (onlyFile && fileId !== onlyFile)) continue;
      m.delete(socketId);
      if (!m.size) { this.local.delete(fileId); this.rosters.delete(fileId); this.sent.delete(fileId); this.collabOfFile.delete(fileId); }
      this.bus.unwatch(fileId);
      try {
        const roster = await this.queue(fileId, () => this.apply(fileId, (b, now) => {
          if (how === 'leave') b.leave(socketId); else b.lost(socketId, now);
        }, { remove: [socketId] }));
        await this.announce(fileId, roster);
        // Окон здесь больше нет — помнить последний список незачем
        if (!this.local.has(fileId)) { this.rosters.delete(fileId); this.sent.delete(fileId); }
      } catch (e: any) { this.log(`Уход ${socketId} из ${fileId} не записан: ${e?.message || e}`); }
    }
  }

  /** Взять свободную правку. '' — взял, иначе причина */
  async take(fileId: string, socketId: string): Promise<string> {
    let why = '';
    const roster = await this.queue(fileId, () => this.apply(fileId, (b, now) => { why = b.take(fileId, socketId, now); }));
    if (!why) await this.announce(fileId, roster);
    return why;
  }

  /** Список по базе на этот миг, ничего не записывая: сервер отвечает по нему на запись и просьбы */
  async rosterOf(fileId: string): Promise<Roster> {
    const now = this.bus.now();
    const s = await this.load(fileId, now, this.collabOfFile.get(fileId) ?? false);
    s.book.expire(now);
    return s.book.roster(fileId);
  }

  /** Кто держит правку (в том числе пропавший, пока его ждут). Спрашивает базу, а не память */
  async holderOf(fileId: string): Promise<OfficePeer | null> {
    const now = this.bus.now();
    const s = await this.load(fileId, now, false);
    return s.book.holder(fileId, now);
  }

  /** «Сохрани сейчас» от соавтора: держателю, где бы его сервер ни был */
  async requestSave(fileId: string, fromSocket: string): Promise<boolean> {
    const holder = await this.holderOf(fileId);
    if (!holder || !this.local.get(fileId)?.has(fromSocket)) return false;
    this.out.socket(holder.socketId, 'office:save-request', { fileId });
    await this.bus.publish(fileId, { kind: 'save-request', fromSocket, toSocket: holder.socketId });
    return true;
  }

  /** Держатель записал файл — остальным пора взять свежую версию */
  async announceSaved(fileId: string, sha256: string, fromSocket: string | null): Promise<void> {
    this.out.room(fileId, 'office:saved', { fileId, sha256 }, fromSocket);
    await this.bus.publish(fileId, { kind: 'saved', fromSocket, data: Buffer.from(JSON.stringify({ sha256 })) });
  }

  /** Пересчитать по базе и, если список изменился, разослать своим окнам */
  refresh(fileId: string): Promise<void> {
    return this.queue(fileId, async () => {
      if (!this.local.has(fileId)) return;
      const roster = await this.apply(fileId, () => undefined);
      if (JSON.stringify(roster) !== this.sent.get(fileId)) this.deliver(fileId, roster);
    }).catch((e: any) => this.log(`Список ${fileId} не обновлён: ${e?.message || e}`));
  }

  /** Удар сердца: мои участники живы; чьих строк не стало — записать заново; списки — по свежему */
  async beat(): Promise<void> {
    const mine: Array<[string, LocalPeer]> = [];
    for (const [fileId, m] of this.local) for (const p of m.values()) mine.push([fileId, p]);
    if (mine.length) {
      const missing = await this.bus.touchPeers(this.bus.serverId, this.bus.now(), mine.map(([, p]) => p.socketId));
      for (const id of missing) {
        const hit = mine.find(([, p]) => p.socketId === id);
        if (hit) await this.bus.upsertPeer(this.rowOf(hit[0], hit[1]));
      }
    }
    for (const fileId of Array.from(this.local.keys())) await this.refresh(fileId);
  }

  // ── Что известно этому серверу без обращения к базе ──

  /** Участник комнаты по сокету: только окна этого сервера */
  peerLocal(fileId: string, socketId: string): LocalPeer | null { return this.local.get(fileId)?.get(socketId) || null; }
  /** Комната общая? По последнему разосланному списку */
  isCollab(fileId: string): boolean { return this.rosters.get(fileId)?.collab ?? this.collabOfFile.get(fileId) ?? false; }
  /** Держит ли правку именно это окно — по последнему разосланному списку */
  holds(fileId: string, socketId: string): boolean {
    const h = this.rosters.get(fileId)?.holder;
    return !!h && !h.lost && h.socketId === socketId;
  }
  /** Есть ли у сервера окна в файле */
  occupied(fileId: string): boolean { return !!this.local.get(fileId)?.size; }
  /** Мои окна в файле */
  localSockets(fileId: string): string[] { return Array.from(this.local.get(fileId)?.keys() || []); }
}

export const officeHub = new OfficeRoomHub(officeBus);

export interface OfficeRoomDeps {
  nameOf: (userId: string) => Promise<string>;
  /**
   * Видит ли человек файл (server/fileAccess.ts). Обязательна: без неё вход
   * в комнату был бы открыт всем, кто знает номер файла
   */
  mayRead: (userId: string, fileId: string) => Promise<boolean>;
  /** '' — можно писать файл; тот же ответ, что у сохранения */
  mayWrite: (userId: string, fileId: string) => Promise<string>;
  /** Файл в общем доступе — правят вместе (личный правит только хозяин) */
  isShared: (fileId: string) => Promise<boolean>;
}

/**
 * Подписать одно соединение на комнаты файлов. Зовётся из connection
 * (server/officeSockets.ts). Комнаты — этого сервера; проверка подставляет свои
 */
export function setupOfficeRooms(socket: Socket, deps: OfficeRoomDeps, hub: OfficeRoomHub = officeHub): { gone: (reason: string) => void } {

  socket.on('office:join', async ({ fileId, clientId, app }: { fileId: string; clientId: string; app?: string }) => {
    if (!ID.test(String(fileId || '')) || !ID.test(String(clientId || ''))) return;
    const userId = String((socket as any).userId || '');
    if (!userId) return;
    // Право ЧТЕНИЯ — до socket.join. Раньше сокет попадал в комнату любого
    // файла по номеру (проверялась лишь запись, и она только помечала
    // участника «зрителем»), а комната отдаёт список участников, правки
    // документа и сигнал «сохранено». Отказ молчаливый — как «нет файла»:
    // ни комнаты, ни состояния, ни подтверждения, что номер существует
    let readable = false;
    try { readable = await deps.mayRead(userId, fileId); } catch (_) { readable = false; }
    if (!readable) return;
    let name = 'Сотрудник';
    try { name = (await deps.nameOf(userId)) || name; } catch (_) { /* без имени участник всё равно виден */ }
    let mayWrite = false;
    try { mayWrite = !(await deps.mayWrite(userId, fileId)); } catch (_) { mayWrite = false; }
    // Правят вместе Документ и Таблица; в PDF правит один (держатель), как
    // раньше, — остальные смотрят и получают свежую версию после записи
    const kind = ['docs', 'sheets', 'pdf'].includes(app || '') ? String(app) : 'docs';
    let shared = false;
    try { shared = ['docs', 'sheets'].includes(kind) && await deps.isShared(fileId); } catch (_) { shared = false; }
    socket.join(roomOf(fileId));
    try {
      await hub.join(fileId, { socketId: socket.id, clientId, userId, name, color: presenceColor(userId), mayWrite, app: kind }, shared);
    } catch (e: any) {
      console.error('[Office] Вход в файл не записан в общую базу:', e?.message || e);
      return;
    }
    // Окно закрылось, пока комната записывалась: строка участника иначе жила бы вечно
    if (!socket.connected) void hub.depart(socket.id, 'lost');
  });

  socket.on('office:leave', ({ fileId }: { fileId: string }) => {
    const id = String(fileId || '');
    socket.leave(roomOf(id));
    void hub.depart(socket.id, 'leave', id);
  });

  socket.on('office:take', async ({ fileId }: { fileId: string }, ack?: (r: { error: string }) => void) => {
    let error = '';
    try { error = await hub.take(String(fileId || ''), socket.id); } catch (e: any) { error = `Правка не взята: ${e?.message || e}`; }
    if (typeof ack === 'function') ack({ error });
  });

  /**
   * «Сохрани сейчас» от соавтора (Ctrl+S): записывает только держатель, и
   * просьба уходит ему — на любой сервер. Ответ соавтор узнает по office:saved
   */
  socket.on('office:save-request', ({ fileId }: { fileId: string }) => {
    void hub.requestSave(String(fileId || ''), socket.id).catch((e: any) => console.error('[Office] Просьба сохранить не дошла:', e?.message || e));
  });

  /**
   * Держатель записал файл — зрителям пора взять свежую версию. Рассылает
   * только держатель: чужое «я сохранил» заставило бы всех перечитать файл
   * без причины
   */
  socket.on('office:saved', ({ fileId, sha256 }: { fileId: string; sha256: string }) => {
    const id = String(fileId || '');
    if (!hub.holds(id, socket.id)) return;
    void hub.announceSaved(id, String(sha256 || ''), socket.id).catch((e: any) => console.error('[Office] «Записал» не разослано:', e?.message || e));
  });

  return {
    /**
     * Соединение закрылось. Окно, закрытое человеком, отключается само —
     * это уход, правка свободна сразу. Его «ухожу» могло не успеть уйти:
     * окно шлёт его и тут же рвёт сокет, и без этой развилки закрытое окно
     * держало бы правку ещё GRACE_MS. Всё остальное — обрыв, и правка ждёт
     */
    gone: (reason: string) => {
      void hub.depart(socket.id, reason === 'client namespace disconnect' ? 'leave' : 'lost');
    },
  };
}
