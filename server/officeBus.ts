/**
 * Общая шина Flux Office: состояние совместной правки живёт в базе.
 *
 * Почему база, а не память сервера. В отделе у каждого сотрудника свой
 * встроенный сервер, а общая только база (README, «Где лежат данные и где
 * сервер»). Пока комната файла, держатель, общий документ и рассылка правок
 * жили в памяти, два сотрудника сидели в одном файле каждый в своей комнате:
 * правки друг друга не видели, оба считали себя держателем и на записи
 * получали отказ (docs/office-collab-shared-db.md). Проверки в контейнере
 * этого не ловили: сервер там один.
 *
 * Модуль не знает ни Word, ни Excel: он выдаёт номера событий, хранит журнал
 * и разносит события по серверам. Что в событии и как его понимать — дело
 * officeRooms / officeCollab / officeSheetCollab.
 *
 * Устройство:
 *   - у каждого файла сеанс (OfficeSession) и журнал (OfficeEvent). Номер
 *     события выдаёт `UPDATE lastSeq = lastSeq + 1` в той же транзакции, что
 *     вставка: строку блокирует первый, второй ждёт. Номера идут подряд и
 *     фиксируются по порядку, поэтому читатель «всё после N» ничего не
 *     пропустит. С автоинкрементом так нельзя: при параллельных вставках
 *     меньший номер может зафиксироваться позже большего, и читатель, уже
 *     прочитавший больший, меньший не увидит никогда;
 *   - насос: сервер по каждому файлу, где у него есть окна, читает события
 *     после последнего виденного и отдаёт их обработчикам. Будят его:
 *     PostgreSQL — LISTEN/NOTIFY (десятки мс), все базы — опрос раз в
 *     POLL_MS (MariaDB другого не умеет), а свои же публикации — сразу;
 *   - события своего сервера, уже разосланные его окнам мгновенно, насос не
 *     повторяет (INSTANT). Порядок важен только у правок Таблицы (kind x):
 *     их номера общий порядок правок, поэтому свои они получают тоже из насоса;
 *   - комнату (OfficePeer, OfficeHolder) правила держателя ведёт
 *     officeRooms.ts, а здесь только строки и сравнение версии.
 *
 * Время — часы серверов: как у присутствия (server/presence.ts), расхождение
 * в единицы секунд допустимо, а несколько десятков секунд — уже нет.
 */
import { randomUUID } from 'node:crypto';
import { getPrisma, onDatabaseSwapped } from './context.js';
import { ensureTables, getDialect, type Dialect, type TableSpec } from './ddl.js';

/** Удар сердца сервера: раз в столько он отмечает своих участников */
export const BEAT_MS = 5_000;
/** Участник, о котором сервер не напоминал столько, считается потерянным вместе с сервером */
export const STALE_MS = 15_000;
/** Как часто насос спрашивает базу, если его никто не разбудил */
export const POLL_MS = 700;
/** Засевающий, не давший о себе знать столько, свою очередь теряет */
export const SEED_STALE_MS = 30_000;
/** Сколько живут служебные события (курсоры, «записал», просьбы): их читают сразу или никогда */
export const EPHEMERAL_MS = 60_000;
/** Записанный сеанс без людей живёт столько: переоткрыли — продолжили */
export const IDLE_MS = 10 * 60_000;

export type EventKind = 'y' | 'x' | 'aware' | 'saved' | 'save-request' | 'roster';

/** Правки содержимого: по ним считается «есть незаписанное» */
const DATA_KINDS: ReadonlySet<EventKind> = new Set(['y', 'x']);
/**
 * События, которые сервер сам разослал своим окнам, не дожидаясь базы:
 * насос их своим не повторяет. Правки Таблицы не такие — их порядок задаёт
 * номер, и получать их надо в порядке номеров, а не в порядке прихода.
 */
const INSTANT: ReadonlySet<EventKind> = new Set(['y', 'aware', 'saved', 'save-request', 'roster']);

export interface BusEvent {
  fileId: string;
  seq: number;
  sessionKey: string;
  kind: EventKind;
  fromSocket: string | null;
  fromServer: string;
  toSocket: string | null;
  data: Buffer | null;
  createdAt: number;
}

export interface SessionRow {
  fileId: string;
  app: string;
  key: string;
  baseData: Buffer | null;
  baseSha: string;
  savedSha: string;
  savedSeq: number;
  lastSeq: number;
  dataSeq: number;
  seeded: boolean;
  seederSocket: string | null;
  seederAt: number | null;
  snapshot: Buffer | null;
  snapshotSeq: number;
  updatedAt: number;
}

export interface PeerRow {
  socketId: string;
  fileId: string;
  serverId: string;
  clientId: string;
  userId: string;
  name: string;
  color: string;
  mayWrite: boolean;
  app: string;
  since: number;
  beatAt: number;
}

export interface HolderRow {
  fileId: string;
  collab: boolean;
  freed: boolean;
  socketId: string;
  clientId: string;
  userId: string;
  name: string;
  color: string;
  lostAt: number | null;
  version: number;
  updatedAt: number;
}

/** Журнал сеанса переполнен: файл надо открыть заново */
export class BusFull extends Error {
  constructor() { super('Журнал сеанса переполнен'); }
}

const ms = (d: Date | null | undefined): number | null => (d ? new Date(d).getTime() : null);
const buf = (b: Uint8Array | null | undefined): Buffer | null => (b ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : null);

const toSession = (r: any): SessionRow => ({
  fileId: r.fileId, app: r.app || '', key: r.key, baseData: buf(r.baseData), baseSha: r.baseSha || '',
  savedSha: r.savedSha || '', savedSeq: r.savedSeq || 0, lastSeq: r.lastSeq || 0, dataSeq: r.dataSeq || 0,
  seeded: !!r.seeded, seederSocket: r.seederSocket || null, seederAt: ms(r.seederAt),
  snapshot: buf(r.snapshot), snapshotSeq: r.snapshotSeq || 0, updatedAt: ms(r.updatedAt) || 0,
});
const toEvent = (r: any): BusEvent => ({
  fileId: r.fileId, seq: r.seq, sessionKey: r.sessionKey || '', kind: r.kind, fromSocket: r.fromSocket || null,
  fromServer: r.fromServer || '', toSocket: r.toSocket || null, data: buf(r.data), createdAt: ms(r.createdAt) || 0,
});
const toPeer = (r: any): PeerRow => ({
  socketId: r.socketId, fileId: r.fileId, serverId: r.serverId, clientId: r.clientId, userId: r.userId,
  name: r.name || '', color: r.color || '', mayWrite: !!r.mayWrite, app: r.app || '',
  since: ms(r.since) || 0, beatAt: ms(r.beatAt) || 0,
});
const toHolder = (r: any): HolderRow => ({
  fileId: r.fileId, collab: !!r.collab, freed: !!r.freed, socketId: r.socketId || '', clientId: r.clientId || '',
  userId: r.userId || '', name: r.name || '', color: r.color || '', lostAt: ms(r.lostAt),
  version: r.version || 0, updatedAt: ms(r.updatedAt) || 0,
});

/** «Записи нет» у Prisma: у него свой код, а при переходе на другой адаптер меняется и текст */
const isMissing = (e: any): boolean => e?.code === 'P2025' || /No record was found|Record to update not found|not found/i.test(String(e?.message || ''));
/** Такая строка уже есть: другой сервер успел раньше */
const isDuplicate = (e: any): boolean => e?.code === 'P2002' || /Unique constraint|duplicate key|UNIQUE constraint|Duplicate entry/i.test(String(e?.message || ''));

/** Как создаются таблицы, если автомиграция схемы их не создала (server/ddl.ts) */
export const TABLES: TableSpec[] = [
  {
    table: 'OfficeSession',
    cols: [
      { name: 'fileId', kind: 'text', pk: true },
      { name: 'app', kind: 'text', notNull: true, def: '' },
      { name: 'key', kind: 'text', notNull: true, def: '' },
      { name: 'baseData', kind: 'blob' },
      { name: 'baseSha', kind: 'text', notNull: true, def: '' },
      { name: 'savedSha', kind: 'text', notNull: true, def: '' },
      { name: 'savedSeq', kind: 'int', notNull: true, def: 0 },
      { name: 'lastSeq', kind: 'int', notNull: true, def: 0 },
      { name: 'dataSeq', kind: 'int', notNull: true, def: 0 },
      { name: 'seeded', kind: 'bool', notNull: true, def: false },
      { name: 'seederSocket', kind: 'text' },
      { name: 'seederAt', kind: 'time' },
      { name: 'snapshot', kind: 'blob' },
      { name: 'snapshotSeq', kind: 'int', notNull: true, def: 0 },
      { name: 'createdAt', kind: 'time', notNull: true, def: 'now' },
      { name: 'updatedAt', kind: 'time', notNull: true, def: 'now', indexed: true },
    ],
    indexes: [{ name: 'OfficeSession_updatedAt_idx', cols: ['updatedAt'] }],
  },
  {
    table: 'OfficeEvent',
    cols: [
      { name: 'id', kind: 'text', pk: true },
      { name: 'fileId', kind: 'text', notNull: true, def: '', indexed: true },
      { name: 'seq', kind: 'int', notNull: true, def: 0 },
      { name: 'sessionKey', kind: 'text', notNull: true, def: '' },
      { name: 'kind', kind: 'text', notNull: true, def: '' },
      { name: 'fromSocket', kind: 'text' },
      { name: 'fromServer', kind: 'text', notNull: true, def: '' },
      { name: 'toSocket', kind: 'text' },
      { name: 'data', kind: 'blob' },
      { name: 'createdAt', kind: 'time', notNull: true, def: 'now', indexed: true },
    ],
    indexes: [
      { name: 'OfficeEvent_fileId_seq_key', cols: ['fileId', 'seq'], unique: true },
      { name: 'OfficeEvent_createdAt_idx', cols: ['createdAt'] },
    ],
  },
  {
    table: 'OfficePeer',
    cols: [
      { name: 'socketId', kind: 'text', pk: true },
      { name: 'fileId', kind: 'text', notNull: true, def: '', indexed: true },
      { name: 'serverId', kind: 'text', notNull: true, def: '', indexed: true },
      { name: 'clientId', kind: 'text', notNull: true, def: '' },
      { name: 'userId', kind: 'text', notNull: true, def: '' },
      { name: 'name', kind: 'text', notNull: true, def: '' },
      { name: 'color', kind: 'text', notNull: true, def: '' },
      { name: 'mayWrite', kind: 'bool', notNull: true, def: false },
      { name: 'app', kind: 'text', notNull: true, def: '' },
      { name: 'since', kind: 'time', notNull: true, def: 'now' },
      { name: 'beatAt', kind: 'time', notNull: true, def: 'now' },
    ],
    indexes: [
      { name: 'OfficePeer_fileId_idx', cols: ['fileId'] },
      { name: 'OfficePeer_serverId_idx', cols: ['serverId'] },
    ],
  },
  {
    table: 'OfficeHolder',
    cols: [
      { name: 'fileId', kind: 'text', pk: true },
      { name: 'collab', kind: 'bool', notNull: true, def: false },
      { name: 'freed', kind: 'bool', notNull: true, def: false },
      { name: 'socketId', kind: 'text', notNull: true, def: '' },
      { name: 'clientId', kind: 'text', notNull: true, def: '' },
      { name: 'userId', kind: 'text', notNull: true, def: '' },
      { name: 'name', kind: 'text', notNull: true, def: '' },
      { name: 'color', kind: 'text', notNull: true, def: '' },
      { name: 'lostAt', kind: 'time' },
      { name: 'version', kind: 'int', notNull: true, def: 0 },
      { name: 'updatedAt', kind: 'time', notNull: true, def: 'now' },
    ],
  },
];

export interface BusDeps {
  /** Клиент базы берётся лениво: он пересоздаётся при смене базы */
  prisma: () => any;
  dialect: () => Dialect;
  /** Адрес базы для LISTEN; пусто — только опрос */
  url: () => string;
  /** Часы: проверкам нужно ими управлять */
  now?: () => number;
  serverId?: string;
  log?: (m: string) => void;
}

type Handler = (ev: BusEvent) => void | Promise<void>;

interface Watch {
  refs: number;
  /** Последний номер, после которого читать; ставится на первом заходе */
  seen: number;
  key: string;
  init: Promise<void>;
  running: Promise<void> | null;
  again: boolean;
}

export class OfficeBus {
  readonly serverId: string;
  private tables = false;
  private handlers = new Map<EventKind, Handler[]>();
  private resetHandlers: Array<(fileId: string) => void> = [];
  private gapHandlers: Array<(fileId: string) => void | Promise<void>> = [];
  private tickHandlers: Array<() => void | Promise<void>> = [];
  private beatHandlers: Array<() => void | Promise<void>> = [];
  private watched = new Map<string, Watch>();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private listener: any = null;
  private listenRetry: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private ticking = false;
  private beating = false;
  private beats = 0;
  /** Файлы, сеанс которых этот сервер уже проверил или создал: чтобы не спрашивать базу перед каждой правкой */
  private known = new Set<string>();

  constructor(private deps: BusDeps) {
    this.serverId = deps.serverId || randomUUID();
  }

  private prisma(): any { return this.deps.prisma(); }
  now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  private log(m: string): void { try { (this.deps.log || ((x) => console.error('[Office]', x)))(m); } catch (_) { /* журнал — не условие работы */ } }

  // ── Таблицы ────────────────────────────────────────────────────────────

  /**
   * Таблицы есть? Их создаёт автомиграция схемы при старте; здесь — подстраховка
   * на случай базы, созданной старой версией, и вернуть надо причину, а не
   * молчать: без таблиц комната файла работать не будет.
   */
  async ready(): Promise<string> {
    if (this.tables) return '';
    const prisma = this.prisma();
    if (!prisma) return 'База данных не подключена';
    try {
      await prisma.officeSession.count();
      await prisma.officeEvent.count();
      await prisma.officePeer.count();
      await prisma.officeHolder.count();
      this.tables = true;
      return '';
    } catch (_) {
      const why = await ensureTables(prisma, TABLES, (m) => this.log(m), true);
      if (!why) this.tables = true;
      return why;
    }
  }

  /** База сменилась: таблицы и слушатель — заново, номера виденного — с нуля */
  reset(): void {
    this.tables = false;
    this.known.clear();
    for (const [id, w] of this.watched) { w.seen = 0; w.key = ''; w.init = this.initWatch(w, id); }
    if (this.listener) { void this.stopListen(); this.startListen(); }
  }

  // ── Сеансы ─────────────────────────────────────────────────────────────

  async session(fileId: string): Promise<SessionRow | null> {
    const r = await this.prisma().officeSession.findUnique({ where: { fileId } });
    return r ? toSession(r) : null;
  }

  /**
   * Сеанс без содержимого: комнате файла исходник не нужен, а журналу нужна
   * строка с номерами. Создаётся с повтором: у SQLite (один сервер, одно
   * соединение) запрос вне транзакции выполняется внутри открытой, и если та
   * откатится (правку отказали), вместе с ней пропадёт и созданная строка —
   * прочитав её обратно и не найдя, надо просто создать ещё раз.
   */
  async ensureSession(fileId: string, app = ''): Promise<SessionRow> {
    for (let i = 0; i < 5; i++) {
      const have = await this.session(fileId);
      if (have) return have;
      try {
        const now = new Date(this.now());
        await this.prisma().officeSession.create({ data: { fileId, app, key: randomUUID(), createdAt: now, updatedAt: now } });
      } catch (e) {
        // Другой сервер успел раньше — берём его строку: ключ и исходник у всех одни
        if (!isDuplicate(e)) throw e;
      }
    }
    const row = await this.session(fileId);
    if (!row) throw new Error('Сеанс файла не создан');
    return row;
  }

  /**
   * Сеанс с исходником. Исходник записывает первый: условное обновление
   * «пока исходника нет», и второй сервер, прочитав файл чуть позже (а он мог
   * уже измениться), свой исходник выбрасывает и берёт записанный. Иначе у
   * двоих были бы разные исходники, а редактор помнит абзацы номерами блоков
   * именно того файла, с которого начал.
   */
  async ensureBase(fileId: string, app: string, read: () => Promise<Buffer>, shaOf: (b: Buffer) => string): Promise<SessionRow> {
    let row = await this.ensureSession(fileId, app);
    if (row.baseSha) return row;
    const bytes = await read();
    await this.prisma().officeSession.updateMany({
      where: { fileId, baseSha: '' },
      data: { baseData: bytes, baseSha: shaOf(bytes), savedSha: shaOf(bytes), app: app || row.app, updatedAt: new Date(this.now()) },
    });
    row = (await this.session(fileId)) || row;
    return row;
  }

  /** Условная правка строки сеанса; сколько строк изменилось */
  async patchSession(where: Record<string, unknown>, data: Record<string, unknown>): Promise<number> {
    const r = await this.prisma().officeSession.updateMany({ where, data });
    return r.count;
  }

  /**
   * Забыть сеанс: файл записал сервер в обход окна (откат, «Обновить поля»,
   * английская версия) — в сеансе старое содержимое. Строка и журнал уходят
   * вместе; ключ следующего сеанса другой, и окна с прежним переоткроют файл.
   */
  async dropSession(fileId: string): Promise<void> {
    const prisma = this.prisma();
    if (!prisma) return;
    try {
      await prisma.officeEvent.deleteMany({ where: { fileId } });
      await prisma.officeSession.deleteMany({ where: { fileId } });
    } catch (e: any) { this.log(`Сеанс ${fileId} не сброшен: ${e?.message || e}`); return; }
    this.known.delete(fileId);
    for (const fn of this.resetHandlers) { try { fn(fileId); } catch (_) { /* кэш — не условие работы */ } }
    this.notify(fileId);
  }

  // ── События ────────────────────────────────────────────────────────────

  /**
   * Добавить событие в журнал файла; возвращает его номер.
   *
   * Номер выдаёт UPDATE в той же транзакции, что вставка (см. шапку файла).
   * `maxSeq` — предел журнала: сверх него правку не принимают. `data` в
   * `patch` — правка строки сеанса под той же блокировкой (номер уже известен).
   */
  async publish(fileId: string, e: {
    kind: EventKind; fromSocket?: string | null; toSocket?: string | null; data?: Uint8Array | null; app?: string;
  }, opts: { maxSeq?: number; patch?: (seq: number) => Record<string, unknown> } = {}): Promise<number> {
    const why = await this.ready();
    if (why) throw new Error(why);
    const prisma = this.prisma();
    // Строка сеанса нужна до транзакции, а не после её отказа: у SQLite запросы
    // вне транзакции выполняются внутри открытой, и созданное ими откатилось бы
    // вместе с ней (см. ensureSession)
    if (!this.known.has(fileId)) {
      await this.ensureSession(fileId, e.app || '');
      if (this.known.size > 5000) this.known.clear();
      this.known.add(fileId);
    }
    let created = 0;
    for (;;) {
      try {
        const seq: number = await prisma.$transaction(async (tx: any) => {
          const row = await tx.officeSession.update({
            where: { fileId }, data: { lastSeq: { increment: 1 }, updatedAt: new Date(this.now()) }, select: { lastSeq: true, key: true },
          });
          if (opts.maxSeq && row.lastSeq > opts.maxSeq) throw new BusFull();
          await tx.officeEvent.create({
            data: {
              fileId, seq: row.lastSeq, sessionKey: row.key, kind: e.kind, fromSocket: e.fromSocket || null,
              fromServer: this.serverId, toSocket: e.toSocket || null, data: e.data ? Buffer.from(e.data) : null,
              createdAt: new Date(this.now()),
            },
          });
          const after: Record<string, unknown> = { ...(opts.patch ? opts.patch(row.lastSeq) : {}) };
          if (DATA_KINDS.has(e.kind)) after.dataSeq = row.lastSeq;
          if (Object.keys(after).length) await tx.officeSession.update({ where: { fileId }, data: after });
          return row.lastSeq;
        }, { maxWait: 10_000, timeout: 30_000 });
        this.notify(fileId);
        this.wake(fileId);
        return seq;
      } catch (err: any) {
        // Сеанса файла ещё нет (комнате исходник не нужен): создать и повторить
        if (created < 3 && isMissing(err)) { created++; this.known.delete(fileId); await this.ensureSession(fileId, e.app || ''); continue; }
        throw err;
      }
    }
  }

  /** События после номера seq, по порядку; kinds — только этих видов */
  async since(fileId: string, seq: number, kinds?: EventKind[], take = 2000): Promise<BusEvent[]> {
    const rows = await this.prisma().officeEvent.findMany({
      where: { fileId, seq: { gt: seq }, ...(kinds ? { kind: { in: kinds } } : {}) },
      orderBy: { seq: 'asc' }, take,
    });
    return rows.map(toEvent);
  }

  /** Недавние события вида (курсоры для опоздавшего) */
  async recent(fileId: string, kind: EventKind, withinMs: number): Promise<BusEvent[]> {
    const rows = await this.prisma().officeEvent.findMany({
      where: { fileId, kind, createdAt: { gte: new Date(this.now() - withinMs) } }, orderBy: { seq: 'asc' }, take: 500,
    });
    return rows.map(toEvent);
  }

  /** Кто хочет слушать события вида */
  on(kind: EventKind, fn: Handler): void {
    const list = this.handlers.get(kind) || [];
    list.push(fn);
    this.handlers.set(kind, list);
  }
  /** Сеанс файла сменился или исчез: кэши по нему недействительны */
  onReset(fn: (fileId: string) => void): void { this.resetHandlers.push(fn); }
  /** Насос увидел дыру в номерах: часть журнала уже убрана уплотнением */
  onGap(fn: (fileId: string) => void | Promise<void>): void { this.gapHandlers.push(fn); }
  /** Каждый оборот насоса (POLL_MS) */
  onTick(fn: () => void | Promise<void>): void { this.tickHandlers.push(fn); }
  /** Каждый удар сердца (BEAT_MS) */
  onBeat(fn: () => void | Promise<void>): void { this.beatHandlers.push(fn); }

  // ── Насос ──────────────────────────────────────────────────────────────

  private async initWatch(w: Watch, fileId: string): Promise<void> {
    if (!fileId) return;
    try {
      const row = await this.prisma().officeSession.findUnique({ where: { fileId }, select: { lastSeq: true, key: true } });
      w.seen = row?.lastSeq || 0;
      w.key = row?.key || '';
    } catch (_) { w.seen = 0; }
  }

  /**
   * Сервер начинает слушать файл: у него появилось окно. Слушать с текущего
   * номера: прежнее опоздавший берёт не из потока, а из состояния сеанса
   * (снимок и журнал по запросу).
   */
  async watch(fileId: string): Promise<void> {
    let w = this.watched.get(fileId);
    if (!w) {
      const created: Watch = { refs: 0, seen: 0, key: '', init: Promise.resolve(), running: null, again: false };
      created.init = this.initWatch(created, fileId);
      this.watched.set(fileId, created);
      w = created;
    }
    w.refs++;
    this.start();
    await w.init;
  }

  unwatch(fileId: string): void {
    const w = this.watched.get(fileId);
    if (!w) return;
    if (--w.refs <= 0) this.watched.delete(fileId);
  }

  isWatched(fileId: string): boolean { return this.watched.has(fileId); }
  /** До какого номера этот сервер уже прочитал журнал файла */
  seen(fileId: string): number { return this.watched.get(fileId)?.seen ?? 0; }

  /** Разбудить насос по файлу; безвредно, если файл не слушается */
  wake(fileId: string): void {
    if (this.watched.has(fileId)) void this.drain(fileId);
  }

  /**
   * Прочитать и раздать всё новое по файлу. Параллельный вызов не начинает
   * второй проход, а просит первый пройти ещё раз и ждёт его конца: кто зовёт,
   * чтобы «догнать», должен получить догнанное, а не обещание.
   */
  drain(fileId: string): Promise<void> {
    const w = this.watched.get(fileId);
    if (!w) return Promise.resolve();
    if (w.running) { w.again = true; return w.running; }
    w.running = this.pass(fileId, w).finally(() => { w.running = null; });
    return w.running;
  }

  private async pass(fileId: string, w: Watch): Promise<void> {
    try {
      await w.init;
      do {
        w.again = false;
        const row = await this.prisma().officeSession.findUnique({ where: { fileId }, select: { lastSeq: true, key: true } });
        if (!row) {
          // Сеанс сбросили: номера начнутся с единицы
          if (w.key) { w.key = ''; w.seen = 0; this.fireReset(fileId); }
          continue;
        }
        if (w.key && row.key !== w.key) { w.seen = 0; w.key = row.key; this.fireReset(fileId); }
        else if (!w.key) w.key = row.key;
        if (row.lastSeq <= w.seen) continue;
        const events = await this.since(fileId, w.seen, undefined, 500);
        if (events.length && events[0].seq > w.seen + 1) {
          // Часть журнала убрана уплотнением: опоздавший берёт состояние из снимка
          for (const fn of this.gapHandlers) { try { await fn(fileId); } catch (err: any) { this.log(`Пропуск в журнале ${fileId}: ${err?.message || err}`); } }
        }
        for (const ev of events) {
          w.seen = ev.seq;
          if (ev.fromServer === this.serverId && INSTANT.has(ev.kind)) continue;
          for (const fn of this.handlers.get(ev.kind) || []) {
            try { await fn(ev); } catch (err: any) { this.log(`Событие ${ev.kind} ${fileId}#${ev.seq}: ${err?.message || err}`); }
          }
        }
        if (events.length >= 500) w.again = true;
      } while (w.again);
    } catch (err: any) {
      this.log(`Насос ${fileId}: ${err?.message || err}`);
    }
  }

  private fireReset(fileId: string): void {
    this.known.delete(fileId);
    for (const fn of this.resetHandlers) { try { fn(fileId); } catch (_) { /* кэш — не условие работы */ } }
  }

  /** Один оборот опроса: у кого номер ушёл вперёд — прочитать */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const ids = Array.from(this.watched.keys());
      if (ids.length) {
        const rows: Array<{ fileId: string; lastSeq: number; key: string }> = await this.prisma().officeSession.findMany({
          where: { fileId: { in: ids } }, select: { fileId: true, lastSeq: true, key: true },
        });
        const by = new Map(rows.map((r) => [r.fileId, r]));
        for (const id of ids) {
          const w = this.watched.get(id);
          if (!w) continue;
          const r = by.get(id);
          // Сеанс исчез или сменился, либо есть непрочитанное — насос сам разберётся
          if ((!r && w.key) || (r && (r.key !== w.key || r.lastSeq > w.seen))) await this.drain(id);
        }
      }
      for (const fn of this.tickHandlers) { try { await fn(); } catch (err: any) { this.log(`Оборот: ${err?.message || err}`); } }
    } catch (err: any) {
      this.log(`Опрос базы: ${err?.message || err}`);
    } finally { this.ticking = false; }
  }

  private async beat(): Promise<void> {
    if (this.beating) return;
    this.beating = true;
    try {
      for (const fn of this.beatHandlers) { try { await fn(); } catch (err: any) { this.log(`Удар сердца: ${err?.message || err}`); } }
      // Уборка общих таблиц — раз в полминуты; её ведёт каждый сервер, и это безвредно
      if (++this.beats % 6 === 0) { try { await this.sweep(); } catch (err: any) { this.log(`Уборка: ${err?.message || err}`); } }
    } finally { this.beating = false; }
  }

  /** Запустить опрос, удар сердца и слушатель; безвредно повторять */
  start(): void {
    if (this.started) return;
    this.started = true;
    const t1 = setInterval(() => { void this.tick(); }, POLL_MS);
    const t2 = setInterval(() => { void this.beat(); }, BEAT_MS);
    t1.unref?.(); t2.unref?.();
    this.timers.push(t1, t2);
    this.startListen();
  }

  stop(): void {
    this.started = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.listenRetry) { clearTimeout(this.listenRetry); this.listenRetry = null; }
    void this.stopListen();
  }

  // ── PostgreSQL: LISTEN / NOTIFY ────────────────────────────────────────

  /** После фиксации: разбудить насосы других серверов. Только PostgreSQL; остальным хватает опроса */
  private notify(fileId: string): void {
    if (this.deps.dialect() !== 'postgresql') return;
    try {
      const p = this.prisma()?.$queryRawUnsafe('SELECT pg_notify($1, $2)', 'flux_office', fileId);
      p?.catch?.(() => { /* не разбудили — опрос дочитает */ });
    } catch (_) { /* то же */ }
  }

  private startListen(): void {
    if (this.deps.dialect() !== 'postgresql') return;
    const url = this.deps.url();
    if (!url || this.listener) return;
    let Client: any;
    // Клиент pg ставится вместе с адаптером Prisma; нет его — работает опрос
    try { Client = require('pg').Client; } catch (_) { return; }
    const client = new Client({ connectionString: url });
    this.listener = client;
    const retry = () => {
      if (this.listener !== client) return;
      this.listener = null;
      try { client.removeAllListeners(); client.on('error', () => {}); void client.end().catch(() => {}); } catch (_) { /* уже закрыт */ }
      if (!this.started || this.listenRetry) return;
      this.listenRetry = setTimeout(() => { this.listenRetry = null; this.startListen(); }, 5_000);
      this.listenRetry.unref?.();
    };
    client.on('notification', (m: any) => { if (m?.channel === 'flux_office' && m.payload) this.wake(String(m.payload)); });
    client.on('error', retry);
    client.on('end', retry);
    client.connect().then(() => client.query('LISTEN flux_office')).catch(retry);
  }

  private async stopListen(): Promise<void> {
    const c = this.listener;
    this.listener = null;
    if (!c) return;
    try { c.removeAllListeners(); c.on('error', () => {}); await c.end(); } catch (_) { /* уже закрыт */ }
  }

  /** Слушает ли сервер уведомления PostgreSQL прямо сейчас (проверкам) */
  get listening(): boolean { return !!this.listener; }

  // ── Комната: строки ────────────────────────────────────────────────────

  async peers(fileId: string): Promise<PeerRow[]> {
    return (await this.prisma().officePeer.findMany({ where: { fileId } })).map(toPeer);
  }

  async upsertPeer(p: PeerRow): Promise<void> {
    const data = {
      fileId: p.fileId, serverId: p.serverId, clientId: p.clientId, userId: p.userId, name: p.name, color: p.color,
      mayWrite: p.mayWrite, app: p.app, since: new Date(p.since), beatAt: new Date(p.beatAt),
    };
    await this.prisma().officePeer.upsert({ where: { socketId: p.socketId }, update: data, create: { socketId: p.socketId, ...data } });
  }

  async deletePeers(socketIds: string[]): Promise<void> {
    if (socketIds.length) await this.prisma().officePeer.deleteMany({ where: { socketId: { in: socketIds } } });
  }

  /** Удар сердца: свои участники живы. Возвращает, чьих строк не оказалось (их убрали чужие серверы) */
  async touchPeers(serverId: string, at: number, known: string[]): Promise<string[]> {
    const prisma = this.prisma();
    const rows: Array<{ socketId: string }> = await prisma.officePeer.findMany({ where: { serverId }, select: { socketId: true } });
    const have = new Set(rows.map((r) => r.socketId));
    // Только те, что этот сервер помнит: строка окна, которого уже нет, не должна жить вечно
    await prisma.officePeer.updateMany({ where: { serverId, socketId: { in: known } }, data: { beatAt: new Date(at) } });
    return known.filter((id) => !have.has(id));
  }

  async holderRow(fileId: string): Promise<HolderRow | null> {
    const r = await this.prisma().officeHolder.findUnique({ where: { fileId } });
    return r ? toHolder(r) : null;
  }

  /**
   * Заменить держателя, если за время расчёта его не сменил другой сервер.
   * Сравнивается version: нет строки — вставка (второй вставляющий упирается в
   * первичный ключ), есть — обновление «где version прежняя». true — вышло;
   * false — опоздали: пересчитать по свежему.
   */
  async casHolder(fileId: string, prev: number | null, next: Omit<HolderRow, 'fileId' | 'version' | 'updatedAt'> | null): Promise<boolean> {
    const prisma = this.prisma();
    const at = new Date(this.now());
    const data = next ? {
      collab: next.collab, freed: next.freed, socketId: next.socketId, clientId: next.clientId, userId: next.userId,
      name: next.name, color: next.color, lostAt: next.lostAt == null ? null : new Date(next.lostAt), updatedAt: at,
    } : null;
    if (prev == null) {
      if (!data) return true;
      try { await prisma.officeHolder.create({ data: { fileId, ...data, version: 1 } }); return true; }
      catch (e) { if (isDuplicate(e)) return false; throw e; }
    }
    if (!data) return (await prisma.officeHolder.deleteMany({ where: { fileId, version: prev } })).count === 1;
    return (await prisma.officeHolder.updateMany({ where: { fileId, version: prev }, data: { ...data, version: prev + 1 } })).count === 1;
  }

  // ── Уборка ─────────────────────────────────────────────────────────────

  /** Убрать из журнала события вида до номера, если им больше olderThanMs: медленный сервер успеет их прочитать */
  async pruneEvents(fileId: string, kind: EventKind, upToSeq: number, olderThanMs = 30_000): Promise<void> {
    await this.prisma().officeEvent.deleteMany({
      where: { fileId, kind, seq: { lte: upToSeq }, createdAt: { lt: new Date(this.now() - olderThanMs) } },
    });
  }

  /**
   * Уборка общих таблиц; безвредно, если её ведут несколько серверов сразу.
   *   - участники, от которых давно нет ударов, — сервер упал;
   *   - держатели комнат, где никого нет;
   *   - служебные события старше минуты (курсоры, «записал», просьбы);
   *   - записанные сеансы без людей дольше IDLE_MS. Незаписанное не
   *     выбрасывается: сеанс ждёт, пока кто-нибудь откроет файл и держатель
   *     его запишет.
   */
  async sweep(): Promise<void> {
    const prisma = this.prisma();
    const now = this.now();
    await prisma.officePeer.deleteMany({ where: { beatAt: { lt: new Date(now - STALE_MS * 4) } } });
    await prisma.officeEvent.deleteMany({
      where: { kind: { in: ['aware', 'saved', 'save-request', 'roster'] }, createdAt: { lt: new Date(now - EPHEMERAL_MS) } },
    });
    const holders: Array<{ fileId: string; version: number }> = await prisma.officeHolder.findMany({
      where: { updatedAt: { lt: new Date(now - STALE_MS * 2) } }, select: { fileId: true, version: true },
    });
    for (const h of holders) {
      if (await prisma.officePeer.count({ where: { fileId: h.fileId } }) === 0) {
        await prisma.officeHolder.deleteMany({ where: { fileId: h.fileId, version: h.version } });
      }
    }
    const idle: SessionRow[] = (await prisma.officeSession.findMany({
      where: { updatedAt: { lt: new Date(now - IDLE_MS) } },
      select: { fileId: true, dataSeq: true, savedSeq: true, updatedAt: true, key: true, app: true, lastSeq: true },
    })).map((r: any) => ({ ...r, updatedAt: ms(r.updatedAt) || 0 }));
    for (const s of idle) {
      if (s.dataSeq > s.savedSeq) continue;
      if (await prisma.officePeer.count({ where: { fileId: s.fileId } }) > 0) continue;
      await prisma.officeEvent.deleteMany({ where: { fileId: s.fileId } });
      await prisma.officeSession.deleteMany({ where: { fileId: s.fileId, lastSeq: s.lastSeq } });
      this.fireReset(s.fileId);
    }
  }
}

/** Шина этого сервера: один serverId на процесс */
export const officeBus = new OfficeBus({
  prisma: () => getPrisma(),
  dialect: () => getDialect(),
  url: () => String(process.env.DATABASE_URL || ''),
});
onDatabaseSwapped(() => officeBus.reset());
