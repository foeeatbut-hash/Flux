/**
 * Общая шина Flux Office: два сервера на одной базе, без браузера.
 *
 * В отделе у каждого сотрудника свой встроенный сервер, а база одна на всех.
 * Комната файла, держатель, общий документ и журнал Таблицы жили в памяти
 * сервера, поэтому двое в одном файле друг друга не видели и оба считали себя
 * держателем (docs/office-collab-shared-db.md). Проверки в контейнере этого не
 * ловили: сервер там один. Здесь их два, и каждый — со своим клиентом базы,
 * своим serverId, своими часами и «сокетами» (FakeSocket): что получило окно
 * каждого, видно прямо.
 *
 * Что стережёт (server/officeBus.ts, officeRooms.ts, officeCollab.ts,
 * officeSheetCollab.ts):
 *   - номера событий идут подряд, без пропусков и повторов, при параллельных
 *     вставках с двух серверов; читатель «всё после N» ничего не теряет;
 *   - держатель одинаков с обеих сторон и в базе он один, даже когда двое
 *     входят в файл в одну и ту же долю секунды;
 *   - уход, обрыв связи (правка ждёт, вернувшееся окно продолжает), смерть
 *     сервера (участник без ударов сердца перестаёт считаться);
 *   - Документ: засев один, содержимое доходит до другого сервера, правки идут
 *     в обе стороны, снимок после записи, опоздавший получает всё;
 *   - Таблица: номера правок общие, порядок у обоих окон один;
 *   - «записал» и «сохрани» доходят до окна на другом сервере;
 *   - сброс сеанса виден всем серверам.
 *
 * База: SQLite во временном файле всегда; PostgreSQL — если задан FLUX_PG
 * (адрес любой базы того же сервера: для проверки создаётся своя и потом
 * удаляется — рабочая не трогается). Таблицы создаёт подстраховка server/ddl.ts,
 * так что заодно проверяется, что её SQL подходит клиентам Prisma.
 *
 * Запуск: npx tsx scripts/test-office-bus.ts
 *         FLUX_PG=postgresql://postgres@127.0.0.1:55432/postgres npx tsx scripts/test-office-bus.ts
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { OfficeBus, type BusEvent } from '../server/officeBus';
import { OfficeRoomHub, GRACE_MS, setupOfficeRooms, type Roster, type OfficeRoomDeps } from '../server/officeRooms';
import { CollabBook, CollabShared, setupOfficeCollab } from '../server/officeCollab';
import { SheetShared, setupOfficeSheetCollab } from '../server/officeSheetCollab';
import { OfficeOut, roomOf, type OutSink } from '../server/officeIo';
import { setDialect } from '../server/ddl';

let f = 0;
let total = 0;
const ok = (n: string, c: boolean, d?: unknown) => {
  total++;
  if (c) console.log('  ✓', n);
  else { f++; console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 500)); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (probe: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> => {
  for (let t = 0; t < ms; t += 50) { if (await probe()) return true; await sleep(50); }
  return probe();
};
const rid = () => Math.random().toString(36).slice(2, 10);

// ── «Сокеты» ────────────────────────────────────────────────────────────────

/** Окна одного сервера: комнаты socket.io и то, что сервер им отдаёт */
class FakeIo {
  rooms = new Map<string, Set<FakeSocket>>();
  sockets = new Map<string, FakeSocket>();
  sink: OutSink = (to, event, payload) => {
    if (to.socket) { this.sockets.get(to.socket)?.receive(event, payload); return; }
    for (const s of this.rooms.get(roomOf(to.room || '')) || []) if (s.id !== to.except) s.receive(event, payload);
  };
}

/**
 * Сокет глазами сервера (on/emit/join/to) и окно глазами теста (send/got).
 * emit у EventEmitter — это «сервер → окно», поэтому вызов обработчиков сервера
 * идёт мимо него, через EventEmitter.prototype.emit.
 */
class FakeSocket extends EventEmitter {
  id: string;
  connected = true;
  got: Array<{ event: string; payload: any }> = [];
  constructor(private io: FakeIo, readonly userId: string) {
    super();
    this.id = `${userId}-${rid()}`;
    io.sockets.set(this.id, this);
  }
  join(room: string): void { (this.io.rooms.get(room) || this.io.rooms.set(room, new Set()).get(room)!).add(this); }
  leave(room: string): void { this.io.rooms.get(room)?.delete(this); }
  to(room: string) {
    return { emit: (event: string, payload: unknown) => { for (const s of this.io.rooms.get(room) || []) if (s !== this) s.receive(event, payload); } };
  }
  receive(event: string, payload: unknown): void { this.got.push({ event, payload }); }
  override emit(event: string | symbol, ...args: any[]): boolean { this.receive(String(event), args[0]); return true; }
  /** Окно → сервер */
  send(event: string, payload?: unknown, ack?: (r: any) => void): void {
    EventEmitter.prototype.emit.call(this, event, payload, ack);
  }
  ask<T = any>(event: string, payload?: unknown): Promise<T> { return new Promise((res) => this.send(event, payload, res)); }
  of(event: string): any[] { return this.got.filter((g) => g.event === event).map((g) => g.payload); }
  last(event: string): any { const l = this.of(event); return l[l.length - 1]; }
}

// ── Сервер ──────────────────────────────────────────────────────────────────

/**
 * shared — один клиент на все серверы проверки. У SQLite так и в жизни: сервер один,
 * а два соединения better-sqlite3 в одном процессе повисли бы друг на друге: пока
 * одно ждёт блокировку, другое не может дойти до фиксации, ведь ждущее держит поток
 */
interface Backend { kind: 'sqlite' | 'pg'; url: string; make: () => any; shared?: boolean }

interface Node {
  name: string;
  prisma: any;
  bus: OfficeBus;
  hub: OfficeRoomHub;
  collab: CollabShared;
  sheets: SheetShared;
  io: FakeIo;
  out: OfficeOut;
  clock: { ms: number };
  logs: string[];
  resets: string[];
  /** Окно сотрудника на этом сервере */
  connect: (userId: string, opts?: { mayWrite?: boolean }) => FakeSocket & { gone: (reason?: string) => void };
  close: () => Promise<void>;
}

const BASE_DOC = Buffer.from('исходник документа');

function makeNode(name: string, be: Backend): Node {
  const prisma = be.make();
  const clock = { ms: 0 };
  const logs: string[] = [];
  const bus = new OfficeBus({
    prisma: () => prisma, dialect: () => (be.kind === 'pg' ? 'postgresql' : 'sqlite'), url: () => (be.kind === 'pg' ? be.url : ''),
    now: () => Date.now() + clock.ms, log: (m) => logs.push(m),
  });
  const io = new FakeIo();
  const out = new OfficeOut();
  out.sink = io.sink;
  const hub = new OfficeRoomHub(bus, { out, log: (m) => logs.push(m) });
  const collab = new CollabShared(bus, new CollabBook(), hub, out);
  const sheets = new SheetShared(bus, out);
  const resets: string[] = [];
  bus.onReset((id) => resets.push(id));
  const writers = new Map<string, boolean>();
  const deps: OfficeRoomDeps = {
    nameOf: async (id) => `Имя ${id}`,
    mayWrite: async (id) => (writers.get(id) === false ? 'Только просмотр' : ''),
    mayRead: async () => true,
    isShared: async () => true,
  };
  const node: Node = {
    name, prisma, bus, hub, collab, sheets, io, out, clock, logs, resets,
    connect: (userId, opts = {}) => {
      writers.set(userId, opts.mayWrite !== false);
      const sock = new FakeSocket(io, userId) as FakeSocket & { gone: (reason?: string) => void };
      (sock as any).userId = userId;
      const rooms = setupOfficeRooms(sock as any, deps, hub);
      const docs = setupOfficeCollab(sock as any, { read: async () => BASE_DOC }, { hub, shared: collab, out });
      const xl = setupOfficeSheetCollab(sock as any, { hub, shared: sheets });
      sock.gone = (reason = 'transport close') => { sock.connected = false; rooms.gone(reason); docs.gone(); xl.gone(); };
      return sock;
    },
    close: async () => { bus.stop(); if (!be.shared) await prisma.$disconnect().catch(() => undefined); },
  };
  return node;
}

/** Окно входит в файл и ждёт первого списка с собой */
async function enter(n: Node, sock: FakeSocket, fileId: string, clientId: string, app = 'docs'): Promise<Roster | null> {
  sock.send('office:join', { fileId, clientId, app });
  await until(() => !!sock.of('office:roster').some((r: Roster) => r.fileId === fileId && r.peers.some((p) => p.socketId === sock.id)));
  return sock.last('office:roster') || null;
}
const rosterOf = (s: FakeSocket, fileId: string): Roster | null => s.of('office:roster').filter((r: Roster) => r.fileId === fileId).pop() || null;

// ── Проверки ────────────────────────────────────────────────────────────────

/** Номера подряд: два сервера пишут в один файл одновременно, третий читатель идёт следом */
async function numbering(a: Node, b: Node): Promise<void> {
  console.log('1. Номера событий: подряд, без пропусков');
  const file = `seq-${rid()}`;
  const N = 40;
  const seen: number[] = [];
  let stop = false;
  // Читатель — как насос: «всё после последнего виденного». Если бы номер
  // выдавался автоинкрементом, меньший мог зафиксироваться позже большего, и
  // читатель, уже прочитавший больший, меньшего не увидел бы никогда
  const reader = (async () => {
    let last = 0;
    while (!stop) {
      for (const ev of await a.bus.since(file, last)) { seen.push(ev.seq); last = ev.seq; }
      await sleep(3);
    }
    for (const ev of await a.bus.since(file, last)) { seen.push(ev.seq); last = ev.seq; }
  })();
  const seqsA: number[] = [], seqsB: number[] = [];
  await Promise.all([
    ...Array.from({ length: N }, (_, i) => a.bus.publish(file, { kind: 'x', data: Buffer.from(`a${i}`) }).then((s) => seqsA.push(s))),
    ...Array.from({ length: N }, (_, i) => b.bus.publish(file, { kind: 'x', data: Buffer.from(`b${i}`) }).then((s) => seqsB.push(s))),
  ]);
  stop = true;
  await reader;
  const all = [...seqsA, ...seqsB].sort((x, y) => x - y);
  ok(`выдано ${2 * N} номеров: 1…${2 * N} без повторов и дыр`, all.length === 2 * N && all.every((s, i) => s === i + 1), all.slice(0, 12));
  ok('читатель, шедший следом, увидел все и по порядку', seen.length === 2 * N && seen.every((s, i) => s === i + 1), seen.length);
  const rows = await a.bus.since(file, 0);
  ok('в журнале то же, что выдано', rows.length === 2 * N && rows.every((e, i) => e.seq === i + 1));
  ok('оба сервера в журнале под своими serverId', new Set(rows.map((e) => e.fromServer)).size === 2);
  const sess = await a.bus.session(file);
  ok('lastSeq сеанса равен числу событий', sess?.lastSeq === 2 * N, sess?.lastSeq);
  ok('dataSeq — номер последней правки содержимого', sess?.dataSeq === 2 * N, sess?.dataSeq);
  ok('сеанс создан один: у обоих серверов один ключ', (await b.bus.session(file))?.key === sess?.key);

  console.log('\n   Предел журнала');
  const small = `cap-${rid()}`;
  await a.bus.publish(small, { kind: 'x' }, { maxSeq: 2 });
  await a.bus.publish(small, { kind: 'x' }, { maxSeq: 2 });
  let refused = false;
  try { await a.bus.publish(small, { kind: 'x' }, { maxSeq: 2 }); } catch (e: any) { refused = /переполнен/.test(e.message); }
  ok('сверх предела правку не принимают', refused);
  ok('и номер отказанной не потрачен', (await a.bus.session(small))?.lastSeq === 2);
}

/** Держатель: двое входят одновременно с разных серверов */
async function holders(a: Node, b: Node): Promise<void> {
  console.log('\n2. Держатель одинаков с обеих сторон');
  const files = Array.from({ length: 12 }, () => `hold-${rid()}`);
  const peer = (n: Node, id: string, user: string, app = 'docs') => ({
    socketId: `${n.name}-${user}-${id}`, clientId: `c-${user}`, userId: user, name: `Имя ${user}`, color: '#000', mayWrite: true, app,
  });
  await Promise.all(files.flatMap((file) => [
    a.hub.join(file, peer(a, file, 'ua'), true),
    b.hub.join(file, peer(b, file, 'ub'), true),
  ]));
  let agree = 0, one = 0, both = 0;
  for (const file of files) {
    const ha = await a.hub.holderOf(file), hb = await b.hub.holderOf(file);
    if (ha && hb && ha.socketId === hb.socketId) agree++;
    const row = await a.bus.holderRow(file);
    if (row && row.socketId === ha?.socketId) one++;
    if ((await a.bus.peers(file)).length === 2 && new Set((await a.bus.peers(file)).map((p) => p.serverId)).size === 2) both++;
  }
  ok(`из ${files.length} файлов держатель у обоих серверов один и тот же`, agree === files.length, agree);
  ok('в базе он записан ровно один и совпадает', one === files.length, one);
  ok('оба сервера в каждой комнате со своими участниками', both === files.length, both);

  console.log('\n   Общий файл: держатель ушёл — записывает следующий, на другом сервере');
  {
    const file = files[0];
    const first = (await a.hub.holderOf(file))!;
    const mine = first.userId === 'ua' ? a : b, other = mine === a ? b : a;
    await mine.hub.depart(first.socketId, 'leave');
    const h1 = await mine.hub.holderOf(file), h2 = await other.hub.holderOf(file);
    ok('после ухода правка у оставшегося', !!h1 && h1.userId !== first.userId, h1);
    ok('и обе стороны так считают', h1?.socketId === h2?.socketId);
    ok('список без ушедшего у обоих', (await a.hub.rosterOf(file)).peers.length === 1 && (await b.hub.rosterOf(file)).peers.length === 1);
  }

  console.log('\n   Личный файл и PDF: правит один, отпущенную правку берут кнопкой');
  {
    const file = `pdf-${rid()}`;
    const p1 = peer(a, file, 'u1', 'pdf'), p2 = peer(b, file, 'u2', 'pdf');
    await a.hub.join(file, p1, false);
    await b.hub.join(file, p2, false);
    ok('правит первый', (await b.hub.holderOf(file))?.socketId === p1.socketId);
    ok('второй с другого сервера взять занятую правку не может', /правит/.test(await b.hub.take(file, p2.socketId)));
    await a.hub.depart(p1.socketId, 'leave');
    ok('ушёл — правка свободна и у другого сервера', (await b.hub.holderOf(file)) === null);
    ok('она сама не переходит', !(await b.hub.rosterOf(file)).holder);
    ok('второй берёт кнопкой', (await b.hub.take(file, p2.socketId)) === '' && (await a.hub.holderOf(file))?.socketId === p2.socketId);
    const p3 = peer(a, file, 'u3', 'pdf');
    await a.hub.join(file, p3, false);
    ok('пришедший позже правку не получает', (await a.hub.holderOf(file))?.socketId === p2.socketId);
    await b.hub.depart(p2.socketId, 'leave');
    await a.hub.depart(p3.socketId, 'leave');
    const p4 = peer(a, file, 'u4', 'pdf');
    await a.hub.join(file, p4, false);
    ok('опустевшая комната начинается заново: первый снова правит', (await b.hub.holderOf(file))?.socketId === p4.socketId);
    await a.hub.depart(p4.socketId, 'leave');
  }

  console.log('\n   Без права записи правку не получают');
  {
    const file = `ro-${rid()}`;
    const reader = { ...peer(a, file, 'ur'), mayWrite: false };
    await a.hub.join(file, reader, true);
    ok('читатель держателем не становится', (await b.hub.holderOf(file)) === null);
    ok('и кнопкой правку не берёт (общий файл)', /только смотреть/.test(await a.hub.take(file, reader.socketId)));
    const w = peer(b, file, 'uw');
    await b.hub.join(file, w, true);
    ok('пришедший с правом записывает', (await a.hub.holderOf(file))?.socketId === w.socketId);
    await a.hub.depart(reader.socketId, 'leave');
    await b.hub.depart(w.socketId, 'leave');
  }
}

/** Обрыв связи и смерть сервера: время сдвигается часами второго сервера */
async function partings(mk: () => Node[]): Promise<void> {
  console.log('\n3. Обрыв связи: правка ждёт, вернувшееся окно продолжает');
  {
    const [a, b] = mk();
    const file = `lost-${rid()}`;
    const p = (n: Node, user: string, id = rid()) => ({ socketId: `${n.name}-${id}`, clientId: `c-${user}`, userId: user, name: `Имя ${user}`, color: '#000', mayWrite: true, app: 'docs' });
    const pa = p(a, 'ua'), pb = p(b, 'ub');
    await a.hub.join(file, pa, true);
    await b.hub.join(file, pb, true);
    await a.hub.depart(pa.socketId, 'lost');
    const r = await b.hub.rosterOf(file);
    ok('пропавший держатель ещё держит, у другого сервера он «потерял связь»', r.holder?.socketId === pa.socketId && r.holder.lost === true, r.holder);
    ok('пока его ждут, взять нельзя (общий файл: держателем остаётся он)', (await b.hub.holderOf(file))?.socketId === pa.socketId);
    ok('его самого в списке уже нет', !r.peers.some((x) => x.socketId === pa.socketId));
    // То же окно вернулось — но через другой сервер и с другим сокетом
    const back = { ...p(b, 'ua'), clientId: 'c-ua' };
    await b.hub.join(file, back, true);
    const h = await a.hub.holderOf(file);
    ok('то же окно вернулось (даже к другому серверу) — правка снова его', h?.socketId === back.socketId, h);
    ok('и потерянным он уже не числится', (await a.hub.rosterOf(file)).holder?.lost === false);
    // Не вернулось вовремя
    await b.hub.depart(back.socketId, 'lost');
    // Часы уходят вперёд у обоих серверов: живые окна второго не должны выглядеть умершими
    a.clock.ms += GRACE_MS + 1_000;
    b.clock.ms += GRACE_MS + 1_000;
    await b.hub.beat();
    const late = await a.hub.holderOf(file);
    ok('не вернулся вовремя — записывает следующий', late?.socketId === pb.socketId, late);
    await Promise.all([a.close(), b.close()]);
  }

  console.log('\n   Сервер перезапустили: то же окно пришло с новым сокетом, а старое соединение не сообщило об обрыве');
  {
    const [a, b] = mk();
    const file = `restart-${rid()}`;
    const old = { socketId: `${a.name}-old`, clientId: 'c-win', userId: 'ua', name: 'Имя ua', color: '#000', mayWrite: true, app: 'docs' };
    const other = { socketId: `${b.name}-other`, clientId: 'c-other', userId: 'ub', name: 'Имя ub', color: '#000', mayWrite: true, app: 'docs' };
    await a.hub.join(file, old, true);
    await b.hub.join(file, other, true);
    const back = { ...old, socketId: `${b.name}-new` };
    await b.hub.join(file, back, true);
    const r = await a.hub.rosterOf(file);
    ok('правка возвращается окну сразу, а не через полминуты гаснущего сервера', r.holder?.socketId === back.socketId && !r.holder.lost, r.holder);
    ok('старая строка окна убрана, двойников в списке нет', r.peers.filter((x) => x.clientId === 'c-win').length === 1, r.peers);
    await Promise.all([a.close(), b.close()]);
  }

  console.log('\n   Обрыв у держателя личного файла: по истечении ожидания правка свободна');
  {
    const [a, b] = mk();
    const file = `lost-pdf-${rid()}`;
    const p = (n: Node, user: string) => ({ socketId: `${n.name}-${rid()}`, clientId: `c-${user}`, userId: user, name: `Имя ${user}`, color: '#000', mayWrite: true, app: 'pdf' });
    const pa = p(a, 'ua'), pb = p(b, 'ub');
    await a.hub.join(file, pa, false);
    await b.hub.join(file, pb, false);
    await a.hub.depart(pa.socketId, 'lost');
    ok('пока ждём, правка за пропавшим', /правит/.test(await b.hub.take(file, pb.socketId)));
    b.clock.ms += GRACE_MS + 1_000;
    ok('вышло время — правка свободна', (await b.hub.holderOf(file)) === null);
    ok('и её берут кнопкой', (await b.hub.take(file, pb.socketId)) === '');
    await Promise.all([a.close(), b.close()]);
  }

  console.log('\n4. Сервер умер: участник без ударов сердца перестаёт считаться');
  {
    const [a, b] = mk();
    const file = `dead-${rid()}`;
    const p = (n: Node, user: string) => ({ socketId: `${n.name}-${rid()}`, clientId: `c-${user}`, userId: user, name: `Имя ${user}`, color: '#000', mayWrite: true, app: 'docs' });
    const pa = p(a, 'ua'), pb = p(b, 'ub');
    await a.hub.join(file, pa, true);
    await b.hub.join(file, pb, true);
    ok('пока сервер жив, держит его участник', (await b.hub.holderOf(file))?.socketId === pa.socketId);
    // Сервер A умирает: ударов больше нет и «уйти» он не успел
    a.bus.stop();
    if (!(a as any).backend.shared) await a.prisma.$disconnect().catch(() => undefined);
    b.clock.ms += 16_000;
    const r = await b.hub.rosterOf(file);
    ok('через 15 с без ударов его окна из списка пропали', !r.peers.some((x) => x.socketId === pa.socketId), r.peers.map((x) => x.socketId));
    ok('держатель — потерянный, а не «вечно живой»', r.holder?.socketId === pa.socketId && r.holder.lost === true, r.holder);
    b.clock.ms += GRACE_MS + 1_000;
    const h = await b.hub.holderOf(file);
    ok('после ожидания записывает оставшийся', h?.socketId === pb.socketId, h);
    await b.hub.refresh(file);
    ok('уборка убрала строки умершего сервера из базы', !(await b.bus.peers(file)).some((x) => x.socketId === pa.socketId));
    const row = await b.bus.holderRow(file);
    ok('держатель в базе — оставшийся', row?.socketId === pb.socketId && row.lostAt === null, row);
    await b.close();
  }

  console.log('\n   Сервер жив, но его удары запоздали: свои окна он не теряет сам');
  {
    const [a, b] = mk();
    const file = `late-${rid()}`;
    const pa = { socketId: `${a.name}-${rid()}`, clientId: 'c1', userId: 'ua', name: 'A', color: '#000', mayWrite: true, app: 'docs' };
    await a.hub.join(file, pa, true);
    a.clock.ms += 60_000;
    await a.hub.refresh(file);
    ok('своё окно сервер не считает потерянным из-за собственных запоздавших ударов', (await a.hub.rosterOf(file)).peers.some((x) => x.socketId === pa.socketId));
    await b.bus.deletePeers([pa.socketId]);
    await a.hub.beat();
    ok('убранную чужой уборкой строку своего окна сервер записывает заново', (await b.bus.peers(file)).some((x) => x.socketId === pa.socketId));
    await Promise.all([a.close(), b.close()]);
  }
}

/** Документ: засев, обмен правками, снимок, опоздавший */
async function documents(a: Node, b: Node): Promise<void> {
  console.log('\n5. Документ: два сервера, один общий Y');
  const file = `doc-${rid()}`;
  const w1 = a.connect('u1'), w2 = b.connect('u2');
  const r1 = await enter(a, w1, file, 'c1'), r2 = await enter(b, w2, file, 'c2');
  await until(() => rosterOf(w1, file)?.peers.length === 2 && rosterOf(w2, file)?.peers.length === 2);
  ok('оба окна видят друг друга в одной комнате', rosterOf(w1, file)?.peers.length === 2 && rosterOf(w2, file)?.peers.length === 2, [r1?.peers.length, r2?.peers.length]);
  ok('комната общая (collab)', !!rosterOf(w1, file)?.collab && !!rosterOf(w2, file)?.collab);
  ok('держатель у обоих один и тот же', rosterOf(w1, file)?.holder?.socketId === rosterOf(w2, file)?.holder?.socketId && !!rosterOf(w1, file)?.holder);
  // Первым вошёл первый: он же держатель и он же засевает (кто из двоих первым успеет
  // заявить право засева — решает база, это проверено отдельно ниже)
  ok('держатель — вошедший первым', rosterOf(w1, file)?.holder?.socketId === w1.id);
  const [holder, guest, hn, gn] = [w1, w2, a, b];

  holder.send('office:y-want', { fileId: file });
  await until(() => holder.of('office:y-state').length > 0);
  guest.send('office:y-want', { fileId: file });
  const hs = holder.of('office:y-state')[0];
  ok('первому поручено засеять', !!hs?.seed && typeof hs.session === 'string', hs);
  await sleep(300);
  ok('второй засевать не должен и состояния пока не получил', guest.of('office:y-state').every((s: any) => !s.seed) && !guest.of('office:y-state').some((s: any) => s.state));
  const sess0 = await hn.bus.session(file);
  ok('ключ сеанса у обоих один, исходник записан в базу', sess0?.key === hs.session && sess0?.baseData?.equals(BASE_DOC) === true);

  const dh = new Y.Doc(), dg = new Y.Doc();
  dh.getXmlFragment('prosemirror').insert(0, [new Y.XmlText('Проба')]);
  holder.send('office:y', { fileId: file, update: Y.encodeStateAsUpdate(dh) });
  ok('засеянное доходит до окна на другом сервере', await until(() => guest.of('office:y-state').some((s: any) => s.state)));
  const gs = guest.of('office:y-state').find((s: any) => s.state);
  Y.applyUpdate(dg, new Uint8Array(gs.state));
  ok('и это то же содержимое', dg.getXmlFragment('prosemirror').toString() === dh.getXmlFragment('prosemirror').toString(), dg.getXmlFragment('prosemirror').toString());
  await until(async () => (await hn.bus.session(file))?.seeded === true);
  ok('в сеансе в базе сказано «засеяно», снимок есть', (await hn.bus.session(file))?.seeded === true && !!(await hn.bus.session(file))?.snapshot);
  const sess1 = await hn.bus.session(file);
  ok('засеянное числится записанным: оно и есть исходник', sess1?.savedSeq === sess1?.dataSeq, [sess1?.savedSeq, sess1?.dataSeq]);

  // Правки в обе стороны
  const before = Y.encodeStateVector(dh);
  dh.getXmlFragment('prosemirror').insert(1, [new Y.XmlText(' от держателя')]);
  holder.send('office:y', { fileId: file, update: Y.encodeStateAsUpdate(dh, before) });
  // Гость получает и засев (он вошёл в комнату раньше), и правку: применяем всё пришедшее, Y повторов не боится
  const text = (d: Y.Doc) => d.getXmlFragment('prosemirror').toString();
  ok('правка держателя доходит до гостя на другом сервере', await until(() => { for (const u of guest.of('office:y')) Y.applyUpdate(dg, new Uint8Array(u.update)); return text(dg).includes('от держателя'); }));
  const beforeG = Y.encodeStateVector(dg);
  dg.getXmlFragment('prosemirror').insert(2, [new Y.XmlText(' от гостя')]);
  guest.send('office:y', { fileId: file, update: Y.encodeStateAsUpdate(dg, beforeG) });
  ok('правка гостя доходит до держателя', await until(() => { for (const u of holder.of('office:y')) Y.applyUpdate(dh, new Uint8Array(u.update)); return text(dh).includes('от гостя'); }));
  ok('у обоих один и тот же документ', dh.getXmlFragment('prosemirror').toString() === dg.getXmlFragment('prosemirror').toString(), [dh.getXmlFragment('prosemirror').toString(), dg.getXmlFragment('prosemirror').toString()]);
  ok('автор своей правки её обратно не получает: у держателя только чужая', holder.of('office:y').length === 1, holder.of('office:y').length);

  if ((a as any).backend.kind === 'pg') {
    // Без LISTEN/NOTIFY правка ждала бы опроса (до POLL_MS): у PostgreSQL она должна идти сразу
    ok('PostgreSQL: серверы слушают уведомления базы', a.bus.listening && b.bus.listening);
    const lat: number[] = [];
    for (let i = 0; i < 8; i++) {
      const v = Y.encodeStateVector(dh);
      dh.getXmlFragment('prosemirror').insert(dh.getXmlFragment('prosemirror').length, [new Y.XmlText(`·${i}`)]);
      const t0 = Date.now();
      holder.send('office:y', { fileId: file, update: Y.encodeStateAsUpdate(dh, v) });
      await until(() => { for (const u of guest.of('office:y')) Y.applyUpdate(dg, new Uint8Array(u.update)); return text(dg).includes(`·${i}`); }, 3000);
      lat.push(Date.now() - t0);
    }
    lat.sort((x, y) => x - y);
    const med = lat[Math.floor(lat.length / 2)];
    ok(`PostgreSQL: правка доходит до другого сервера за десятки миллисекунд (медиана ${med} мс)`, med < 250, lat);
    // Выравниваем гостя: он мог не всё применить к моменту следующей проверки
    for (const u of guest.of('office:y')) Y.applyUpdate(dg, new Uint8Array(u.update));
    guest.got = guest.got.filter((g) => g.event !== 'office:y');
    holder.got = holder.got.filter((g) => g.event !== 'office:y');
  }
  // Курсор гостя виден держателю на другом сервере
  const awg = new Awareness(dg);
  awg.setLocalState({ user: { name: 'гость' } });
  guest.send('office:y-aware', { fileId: file, update: encodeAwarenessUpdate(awg, [dg.clientID]) });
  const seenAw = new Awareness(new Y.Doc());
  await until(() => { for (const u of holder.of('office:y-aware')) { try { applyAwarenessUpdate(seenAw, new Uint8Array(u.update), 'test'); } catch (_) { /* пропуск */ } } return Array.from(seenAw.getStates().values()).some((st: any) => st?.user?.name === 'гость'); });
  ok('курсор гостя виден держателю на другом сервере', Array.from(seenAw.getStates().values()).some((st: any) => st?.user?.name === 'гость'));

  // Записал
  const savedBefore = holder.of('office:saved').length;
  guest.send('office:saved', { fileId: file, sha256: 'чужой' });
  await sleep(500);
  ok('«записал» от не-держателя игнорируется', holder.of('office:saved').length === savedBefore && guest.of('office:saved').length === 0);
  holder.send('office:saved', { fileId: file, sha256: 'abc123' });
  ok('«записал» держателя доходит до окна на другом сервере', await until(() => guest.of('office:saved').some((m: any) => m.sha256 === 'abc123')));
  ok('и самому держателю не приходит', holder.of('office:saved').length === savedBefore);
  await until(async () => { const s = await hn.bus.session(file); return !!s && s.savedSeq >= s.dataSeq && s.snapshotSeq > 0; });
  const sess2 = await hn.bus.session(file);
  ok('после записи: всё до последней правки записано', !!sess2 && sess2.savedSeq === sess2.dataSeq, [sess2?.savedSeq, sess2?.dataSeq]);
  ok('снимок пересчитан по номеру журнала', !!sess2 && sess2.snapshotSeq > sess1!.snapshotSeq, [sess1?.snapshotSeq, sess2?.snapshotSeq]);

  // Просьба «запиши» от соавтора
  guest.send('office:save-request', { fileId: file });
  ok('просьба сохранить (Ctrl+S соавтора) доходит до держателя на другом сервере', await until(() => holder.of('office:save-request').length > 0));
  ok('и больше никому', guest.of('office:save-request').length === 0);

  // Опоздавший — на втором сервере, после записи
  const w3 = gn.connect('u3');
  await enter(gn, w3, file, 'c3');
  w3.send('office:y-want', { fileId: file });
  await until(() => w3.of('office:y-state').some((s: any) => s.state));
  const d3 = new Y.Doc();
  const st = w3.of('office:y-state').find((s: any) => s.state);
  if (st) Y.applyUpdate(d3, new Uint8Array(st.state));
  ok('опоздавший сразу получает всё, включая правки обоих', d3.getXmlFragment('prosemirror').toString() === dh.getXmlFragment('prosemirror').toString(), d3.getXmlFragment('prosemirror').toString());
  ok('и тот же ключ сеанса', st?.session === hs.session);
  // Опоздавший на сервере, где Y ещё не было вовсе: строится из снимка и журнала
  const c = makeNode('C', (a as any).backend);
  const w4 = c.connect('u4');
  await enter(c, w4, file, 'c4');
  w4.send('office:y-want', { fileId: file });
  await until(() => w4.of('office:y-state').some((s: any) => s.state));
  const d4 = new Y.Doc();
  const st4 = w4.of('office:y-state').find((s: any) => s.state);
  if (st4) Y.applyUpdate(d4, new Uint8Array(st4.state));
  ok('третий сервер строит документ из снимка и журнала', d4.getXmlFragment('prosemirror').toString() === dh.getXmlFragment('prosemirror').toString(), d4.getXmlFragment('prosemirror').toString());
  w4.gone('client namespace disconnect');
  await sleep(200);
  await c.close();
  w3.gone('client namespace disconnect');

  console.log('\n   Право засевать: двое просят одновременно — получает один');
  {
    const f0 = `claim-${rid()}`;
    await a.bus.ensureSession(f0, 'docs');
    const got = await Promise.all([a.collab.claimSeed(f0, 's-a'), b.collab.claimSeed(f0, 's-b'), a.collab.claimSeed(f0, 's-a2'), b.collab.claimSeed(f0, 's-b2')]);
    ok('из четырёх заявок с двух серверов выигрывает ровно одна', got.filter(Boolean).length === 1, got);
    const winner = ['s-a', 's-b', 's-a2', 's-b2'][got.indexOf(true)];
    ok('повторная заявка победителя не отнимает право', await a.collab.claimSeed(f0, winner));
  }

  console.log('\n   Засевающий ушёл, не засеяв, — засев переходит окну на другом сервере');
  {
    const f2 = `seed-${rid()}`;
    const s1 = a.connect('s1'), s2 = b.connect('s2');
    await enter(a, s1, f2, 'cs1');
    await enter(b, s2, f2, 'cs2');
    await until(() => rosterOf(s2, f2)?.peers.length === 2);
    s1.send('office:y-want', { fileId: f2 });
    await until(() => s1.of('office:y-state').some((s: any) => s.seed));
    s2.send('office:y-want', { fileId: f2 });
    await sleep(300);
    ok('второй ждёт', !s2.of('office:y-state').some((s: any) => s.seed || s.state));
    s1.send('office:leave', { fileId: f2 });
    s1.gone('client namespace disconnect');
    ok('право засевать перешло к окну на другом сервере', await until(() => s2.of('office:y-state').some((s: any) => s.seed), 10_000));
    s2.gone('client namespace disconnect');
    await sleep(200);
  }

  console.log('\n   Засевающий пропал вместе с сервером — право переходит по истечении срока');
  {
    const [x, y] = [makeNode('X', (a as any).backend), makeNode('Y', (a as any).backend)];
    const f3 = `seed2-${rid()}`;
    const s1 = x.connect('t1'), s2 = y.connect('t2');
    await enter(x, s1, f3, 'ct1');
    await enter(y, s2, f3, 'ct2');
    await until(() => rosterOf(s2, f3)?.peers.length === 2);
    s1.send('office:y-want', { fileId: f3 });
    await until(() => s1.of('office:y-state').some((s: any) => s.seed));
    s2.send('office:y-want', { fileId: f3 });
    await sleep(300);
    x.bus.stop();
    if (!(a as any).backend.shared) await x.prisma.$disconnect().catch(() => undefined);
    y.clock.ms += 31_000;
    ok('сервер засевающего умер — засев поручают ждущему', await until(() => s2.of('office:y-state').some((s: any) => s.seed), 10_000));
    s2.gone('client namespace disconnect');
    await sleep(200);
    await y.close();
  }
  w1.gone('client namespace disconnect');
  w2.gone('client namespace disconnect');
  await sleep(300);
}

/** Таблица: номера правок общие, порядок у обоих окон один */
async function sheets(a: Node, b: Node): Promise<void> {
  console.log('\n6. Таблица: журнал правок в общей базе');
  const file = `xl-${rid()}`;
  const w1 = a.connect('x1'), w2 = b.connect('x2'), ro = b.connect('xr', { mayWrite: false });
  const base = Buffer.from('исходник книги');
  const s = await a.sheets.open(file, async () => base);
  const s2 = await b.sheets.open(file, async () => Buffer.from('другой исходник'));
  ok('сеанс общий: ключ и исходник у второго сервера те же', s.key === s2.key && s2.baseData?.equals(base) === true);
  await enter(a, w1, file, 'cx1', 'sheets');
  await enter(b, w2, file, 'cx2', 'sheets');
  await enter(b, ro, file, 'cxr', 'sheets');
  await until(() => rosterOf(w1, file)?.peers.length === 3);
  const op = (i: number) => ({ id: 'sheet.mutation.set-range-values', params: { i }, sheets: {} });
  const N = 20;
  const acks1: number[] = [], acks2: number[] = [];
  await Promise.all([
    (async () => { for (let i = 0; i < N; i++) { const r = await w1.ask('office:x-op', { fileId: file, key: s.key, op: op(i) }); acks1.push(r.seq); } })(),
    (async () => { for (let i = 0; i < N; i++) { const r = await w2.ask('office:x-op', { fileId: file, key: s.key, op: op(100 + i) }); acks2.push(r.seq); } })(),
  ]);
  const acked = [...acks1, ...acks2];
  ok('все правки приняты и получили номера', acked.every((n) => typeof n === 'number') && acked.length === 2 * N, acked);
  ok('номера уникальны у обоих серверов', new Set(acked).size === 2 * N);
  await until(() => w1.of('office:x-op').length === N && w2.of('office:x-op').length === N);
  const got1 = w1.of('office:x-op').map((m: any) => m.seq), got2 = w2.of('office:x-op').map((m: any) => m.seq);
  ok('окно получило все чужие правки и ни одной своей', got1.length === N && got2.length === N && got1.every((n: number) => acks2.includes(n)) && got2.every((n: number) => acks1.includes(n)), [got1.length, got2.length]);
  const inOrder = (l: number[]) => l.every((n, i) => i === 0 || n > l[i - 1]);
  ok('чужие правки приходят каждому в порядке номеров', inOrder(got1) && inOrder(got2), [got1, got2]);
  ok('читатель без права записи получил всё и по порядку', await until(() => ro.of('office:x-op').length === 2 * N) && inOrder(ro.of('office:x-op').map((m: any) => m.seq)));
  const journal = await w1.ask('office:x-want', { fileId: file, from: 0 });
  ok('журнал по запросу — то же, по порядку, с ключом сеанса', journal.key === s.key && journal.ops.length === 2 * N && inOrder(journal.ops.map((o: any) => o.seq)), journal.ops?.length);
  const tail = await w2.ask('office:x-want', { fileId: file, from: journal.ops[journal.ops.length - 6].seq });
  ok('опоздавший может взять только хвост', tail.ops.length === 5, tail.ops?.length);
  ok('правка читателя не принимается', /только смотреть/.test((await ro.ask('office:x-op', { fileId: file, key: s.key, op: op(1) })).error || ''));
  const wrong = await w1.ask('office:x-op', { fileId: file, key: 'чужой-ключ', op: op(1) });
  ok('правка с чужим ключом сеанса возвращает верный ключ', wrong.error === 'session' && wrong.key === s.key, wrong);
  ok('мусор вместо правки отклоняется', !!(await w1.ask('office:x-op', { fileId: file, key: s.key, op: { id: '../x' } })).error);

  console.log('\n   Запись книги и сверка');
  await a.sheets.markSaved(file, 'sha-1', (await a.bus.session(file))!.dataSeq);
  const saved = await b.bus.session(file);
  ok('хеш последней записи виден другому серверу', saved?.savedSha === 'sha-1' && saved.savedSeq === saved.dataSeq, [saved?.savedSha, saved?.savedSeq]);
  ok('и незаписанного нет', saved!.dataSeq <= saved!.savedSeq);
  await b.hub.announceSaved(file, 'sha-1', w2.id);
  ok('«записал» после записи Таблицы доходит до окна на другом сервере', await until(() => w1.of('office:saved').some((m: any) => m.sha256 === 'sha-1')));

  console.log('\n7. Сброс сеанса: файл записал сервер в обход окна');
  await a.bus.dropSession(file);
  ok('сеанса и журнала в базе больше нет', (await b.bus.session(file)) === null && (await b.bus.since(file, 0)).length === 0);
  ok('свой кэш сервер забыл сразу', a.resets.includes(file));
  ok('чужой сервер узнал по опросу', await until(() => b.resets.includes(file), 5000));
  const fresh = await b.sheets.open(file, async () => Buffer.from('новое содержимое'));
  ok('следующий сеанс — с другим ключом и новым исходником', fresh.key !== s.key && fresh.baseData?.toString() === 'новое содержимое');
  const a1 = await w1.ask('office:x-op', { fileId: file, key: fresh.key, op: op(7) });
  ok('с новым ключом правка принята, номера нового сеанса идут с единицы', a1.seq === 1, a1);
  const late = await w1.ask('office:x-op', { fileId: file, key: s.key, op: op(8) });
  ok('прежний ключ после сброса не принимается', late.error === 'session', late);
  ok('и правка нового сеанса дошла до окна другого сервера', await until(() => w2.of('office:x-op').some((m: any) => m.op?.params?.i === 7), 6000));
  for (const w of [w1, w2, ro]) w.gone('client namespace disconnect');
  await sleep(300);
}

/** Уборка */
async function cleanup(a: Node, b: Node): Promise<void> {
  console.log('\n8. Уборка общих таблиц');
  const idle = `idle-${rid()}`, unsaved = `unsaved-${rid()}`, busy = `busy-${rid()}`;
  await a.bus.publish(idle, { kind: 'x', data: Buffer.from('1') });
  await a.bus.patchSession({ fileId: idle }, { savedSeq: 1 });
  await a.bus.publish(unsaved, { kind: 'x', data: Buffer.from('1') });
  await a.bus.publish(busy, { kind: 'x', data: Buffer.from('1') });
  await a.bus.patchSession({ fileId: busy }, { savedSeq: 1 });
  await a.hub.join(busy, { socketId: `a-${busy}`, clientId: 'c', userId: 'u', name: 'U', color: '#000', mayWrite: true, app: 'docs' }, true);
  await a.bus.publish(idle, { kind: 'aware', data: Buffer.from('курсор') });
  // Все три давно без правок (часы не трогаем: у живых окон удары сердца должны остаться свежими)
  await a.bus.patchSession({ fileId: { in: [idle, unsaved, busy] } }, { updatedAt: new Date(Date.now() - 11 * 60_000) });
  await b.bus.sweep();
  ok('записанный сеанс без людей дольше срока убран любым сервером', (await b.bus.session(idle)) === null && (await b.bus.since(idle, 0)).length === 0);
  ok('незаписанный ждёт, пока его откроют', (await b.bus.session(unsaved)) !== null);
  ok('сеанс, где есть люди, не тронут', (await b.bus.session(busy)) !== null);
  await a.hub.depart(`a-${busy}`, 'leave');
  // Служебные события старше минуты
  await a.bus.publish(unsaved, { kind: 'aware', data: Buffer.from('курсор') });
  await a.prisma.officeEvent.updateMany({ where: { fileId: unsaved, kind: 'aware' }, data: { createdAt: new Date(Date.now() - 120_000) } });
  await b.bus.sweep();
  ok('курсоры старше минуты удаляются, правки — нет', (await b.bus.since(unsaved, 0, ['aware'])).length === 0 && (await b.bus.since(unsaved, 0, ['x'])).length === 1);
}

/** Таблицы созданы подстраховкой ddl.ts, а не автомиграцией Prisma */
async function schema(a: Node, be: Backend): Promise<void> {
  console.log('\n0. Таблицы: подстраховка server/ddl.ts');
  ok('таблицы созданы и клиент Prisma с ними работает', (await a.bus.ready()) === '');
  ok('повторный вызов ничего не ломает', (await a.bus.ready()) === '');
  const n = await a.prisma.officeSession.count();
  ok('пустая база — пустая таблица', n === 0, n);
  const t: BusEvent[] = await a.bus.since('нет-такого', 0);
  ok('чтение несуществующего файла — пусто, не ошибка', t.length === 0);
  void be;
}

// ── База и запуск ───────────────────────────────────────────────────────────

async function run(be: Backend, label: string): Promise<void> {
  console.log(`\n══ ${label} ══`);
  setDialect(be.kind === 'pg' ? 'postgresql' : 'sqlite');
  const mk = (name: string): Node => { const n = makeNode(name, be); (n as any).backend = be; return n; };
  const a = mk('A'), b = mk('B');
  try {
    await schema(a, be);
    await numbering(a, b);
    await holders(a, b);
    await documents(a, b);
    await sheets(a, b);
    await cleanup(a, b);
    await partings(() => [mk(`A${rid()}`), mk(`B${rid()}`)]);
  } catch (e: any) {
    ok('проверка оборвалась', false, String(e?.stack || e));
  } finally {
    const bad = [...a.logs, ...b.logs].filter((m) => !/Пропуск|курсор/i.test(m));
    if (bad.length) console.log('  · журнал серверов:', bad.slice(0, 5).join(' | '));
    await Promise.all([a.close(), b.close()]);
  }
}

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flux-office-bus-'));
  let created: (() => Promise<void>) | null = null;
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(join(process.cwd(), 'package.json'));
    let lite: any = null;
    const sqlite: Backend = {
      kind: 'sqlite', url: join(dir, 'bus.sqlite'), shared: true,
      make: () => {
        if (lite) return lite;
        const { PrismaClient } = req('@prisma/client-sqlite');
        const { PrismaBetterSqlite3 } = req('@prisma/adapter-better-sqlite3');
        lite = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${join(dir, 'bus.sqlite')}`, timeout: 15000 }) });
        return lite;
      },
    };
    await run(sqlite, 'SQLite (файл во временной папке, один клиент, как в жизни)');
    await lite?.$disconnect().catch(() => undefined);

    if (process.env.FLUX_PG) {
      // Своя база на том же сервере: рабочая не трогается
      const { Client } = req('pg');
      const admin = new URL(process.env.FLUX_PG);
      const dbName = `flux_bus_test_${rid()}`;
      const root = new Client({ connectionString: process.env.FLUX_PG });
      await root.connect();
      await root.query(`CREATE DATABASE "${dbName}"`);
      created = async () => {
        await root.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
        await root.end().catch(() => undefined);
      };
      admin.pathname = `/${dbName}`;
      const url = admin.toString();
      const pg: Backend = {
        kind: 'pg', url,
        make: () => {
          const { PrismaClient } = req('@prisma/client-pg');
          const { PrismaPg } = req('@prisma/adapter-pg');
          return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
        },
      };
      await run(pg, 'PostgreSQL (своя база, LISTEN/NOTIFY, два клиента)');
    } else {
      console.log('\n· PostgreSQL пропущен: нет FLUX_PG (адрес базы того же сервера, например postgresql://postgres@127.0.0.1:5432/postgres)');
    }
  } catch (e: any) {
    ok('проверка оборвалась', false, String(e?.stack || e));
  } finally {
    if (created) await created();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${total - f} проверок пройдено, ${f} провалено`);
  process.exit(f ? 1 : 0);
})();
