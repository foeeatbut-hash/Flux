/**
 * Ключ повтора записи X-Flux-Op-Id (docs/roadmap/offline-work.md, 0.6 и К6).
 *
 * Настоящая SQLite-база и настоящий express со звеном server/opReceipt.ts:
 * гонку двух запросов заглушкой не сыграть. Тестовые маршруты считают, сколько
 * раз выполнился обработчик, — это и есть главная величина набора: повтор с
 * тем же ключом не должен увеличивать счётчик НИКОГДА. Плюс один настоящий
 * маршрут записи (создание реестра ВДР): строка в базе должна появиться одна.
 *
 * Что держим:
 *  • повтор с тем же ключом — один запуск обработчика, тот же ответ, заголовок
 *    X-Flux-Op-Replayed; порядок полей тела на хеш не влияет;
 *  • два одновременных запроса с одним ключом — один запуск, второй получает
 *    прежний ответ или OP_IN_FLIGHT, но не второе выполнение;
 *  • тот же ключ с другим телом, адресом, длиной сырого тела — 409 OP_ID_REUSED;
 *  • тот же ключ у другого пользователя — независим; личность берётся только из
 *    authUser, а не из тела;
 *  • без заголовка и без пользователя — как раньше; неверный формат — 400;
 *  • ответ клиенту уходит после записи расписки: мгновенный повтор не видит PENDING;
 *  • большой ответ, не JSON, поток, 4xx — повтор с тем же статусом;
 *  • 5xx — расписка остаётся PENDING, повтор получает OP_IN_FLIGHT, второго запуска нет;
 *  • сырое тело (express.raw в маршруте) звено не потребляет;
 *  • нет таблицы расписок — запись не блокируется; уборка старше 7 суток пачками.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import express from 'express';
import { registerVdrRoutes } from '../server/routes/vdr.js';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma, setBroadcaster } from '../server/context.js';
import { opReceiptMiddleware, cleanupOpReceipts, canonicalJson, MAX_STORED_BODY, RECEIPT_TTL_MS, BODY_TTL_MS } from '../server/opReceipt.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-op-receipt-'));
const dbPath = path.join(temp, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`✓ ${label}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const counts: Record<string, number> = {};
  const hit = (name: string) => { counts[name] = (counts[name] || 0) + 1; return counts[name]; };
  const logs: string[] = [];

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  // Проверка входа в миниатюре: личность — только отсюда
  app.use((req, _res, next) => {
    const u = req.get('x-test-user');
    if (u) (req as any).authUser = { id: u };
    next();
  });
  // Запись ответа в расписку замедлена: если звено отдаёт ответ раньше, чем записывает
  // расписку, мгновенный повтор успевает увидеть PENDING (проверка ниже ловит это)
  const slowPrisma = {
    opReceipt: {
      create: (a: any) => prisma.opReceipt.create(a),
      findUnique: (a: any) => prisma.opReceipt.findUnique(a),
      update: async (a: any) => { await sleep(60); return prisma.opReceipt.update(a); },
    },
  };
  app.use(opReceiptMiddleware({ getPrisma: () => slowPrisma, log: (m) => logs.push(m) }));

  app.post('/api/test/counter', async (req, res) => {
    const n = hit('counter');
    if (req.body?.delayMs) await sleep(req.body.delayMs);
    res.json({ ok: true, n, echo: req.body?.value ?? null });
  });
  app.post('/api/test/bad', (_req, res) => { hit('bad'); res.status(400).json({ ok: false, error: 'нельзя' }); });
  app.post('/api/test/boom', (_req, res) => { hit('boom'); res.status(500).json({ ok: false, error: 'упало' }); });
  app.post('/api/test/big', (_req, res) => { const n = hit('big'); res.json({ n, blob: 'x'.repeat(MAX_STORED_BODY + 10) }); });
  app.post('/api/test/text', (_req, res) => { const n = hit('text'); res.status(201).type('text/plain').send(`текст ${n}`); });
  app.post('/api/test/stream', (_req, res) => {
    const n = hit('stream');
    res.status(200).type('application/octet-stream');
    res.write(`часть-${n}-`); res.write('вторая'); res.end();
  });
  app.post('/api/test/noContent', (_req, res) => { hit('noContent'); res.status(204).end(); });
  // Сырое тело читает сам маршрут: звено поток не трогает
  app.post('/api/test/raw', express.raw({ type: 'application/octet-stream', limit: '5mb' }), (req, res) => {
    const n = hit('raw');
    res.json({ n, bytes: Buffer.isBuffer(req.body) ? req.body.length : -1 });
  });
  app.get('/api/test/counter', (_req, res) => { hit('get'); res.json({ ok: true }); });
  registerVdrRoutes(app as any, { chunkBytes: async () => 1024 });
  const server = createServer(app);

  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);
    setBroadcaster(() => {});
    await prisma.project.create({ data: { id: 'op-project', name: 'OpReceipt test' } });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;

    let seq = 0;
    const newKey = () => `op-test-${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const send = async (url: string, opts: { key?: string; user?: string | null; body?: any; raw?: Buffer; method?: string } = {}) => {
      const headers: Record<string, string> = {};
      if (opts.user !== null) headers['x-test-user'] = opts.user || 'u1';
      if (opts.key !== undefined) headers['X-Flux-Op-Id'] = opts.key;
      let body: any;
      if (opts.raw) { headers['Content-Type'] = 'application/octet-stream'; body = opts.raw; }
      else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
      const r = await fetch(`${base}${url}`, { method: opts.method || 'POST', headers, body });
      const text = await r.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch (_) { /* не JSON */ }
      return { status: r.status, replayed: r.headers.get('x-flux-op-replayed') === '1', text, body: json || {} };
    };
    const receipt = (actorId: string, opId: string) => prisma.opReceipt.findUnique({ where: { actorId_opId: { actorId, opId } } });

    // ── Старый клиент и неверный формат ──
    const a1 = await send('/api/test/counter', { body: { value: 1 } });
    const a2 = await send('/api/test/counter', { body: { value: 1 } });
    check('без заголовка запрос идёт как раньше: каждый раз выполняется', a1.status === 200 && a2.status === 200 && a2.body.n === a1.body.n + 1 && !a2.replayed, [a1.body, a2.body]);
    check('без заголовка расписка не создаётся', (await prisma.opReceipt.count()) === 0);
    const noUser = newKey();
    const n1 = await send('/api/test/counter', { key: noUser, user: null, body: {} });
    const n2 = await send('/api/test/counter', { key: noUser, user: null, body: {} });
    check('без пользователя (нет входа) ключ не действует: звено пропускает', n1.status === 200 && n2.body.n === n1.body.n + 1 && (await prisma.opReceipt.count()) === 0, [n1.body, n2.body]);
    for (const bad of ['short', 'bad$chars!!!!', 'a'.repeat(65), 'has space 12345', '']) {
      const r = await send('/api/test/counter', { key: bad, body: {} });
      check(`неверный формат ключа «${bad.slice(0, 12)}» — 400 OP_ID_INVALID`, r.status === 400 && r.body.code === 'OP_ID_INVALID' && typeof r.body.error === 'string', r);
    }
    const countBefore = counts.counter;
    const get = await send('/api/test/counter', { key: newKey(), method: 'GET' });
    check('GET ключ игнорирует и не занимает', get.status === 200 && (await prisma.opReceipt.count()) === 0, get);
    assert.equal(counts.counter, countBefore);

    // ── Повтор ──
    const k1 = newKey();
    const first = await send('/api/test/counter', { key: k1, body: { value: 'a', other: { y: 2, x: 1 } } });
    const rec1 = await receipt('u1', k1);
    check('первый запрос выполнен; расписка DONE со статусом и телом', first.status === 200 && !first.replayed && rec1?.state === 'DONE' && rec1.status === 200 && JSON.parse(rec1.body).n === first.body.n, { first, rec1 });
    const before = counts.counter;
    const again = await send('/api/test/counter', { key: k1, body: { other: { x: 1, y: 2 }, value: 'a' } });
    check('повтор с тем же ключом: обработчик не выполнен, ответ тот же, порядок полей тела не важен', counts.counter === before && again.status === 200 && again.replayed && again.body.n === first.body.n && again.text === first.text, { again, first });
    const third = await send('/api/test/counter', { key: k1, body: { other: { x: 1, y: 2 }, value: 'a' } });
    check('и третий раз — тот же ответ', counts.counter === before && third.replayed && third.text === first.text);

    // Ответ уходит после записи расписки: мгновенный повтор не должен видеть PENDING
    let inFlightSeen = 0;
    for (let i = 0; i < 25; i++) {
      const k = newKey();
      const x = await send('/api/test/counter', { key: k, body: { i } });
      const y = await send('/api/test/counter', { key: k, body: { i } });
      if (y.body.code === 'OP_IN_FLIGHT' || !y.replayed || y.body.n !== x.body.n) inFlightSeen++;
    }
    check('мгновенный повтор после ответа всегда получает прежний ответ (расписка записана до отправки)', inFlightSeen === 0, inFlightSeen);

    // ── Другое действие под тем же ключом ──
    const before2 = counts.counter;
    const other = await send('/api/test/counter', { key: k1, body: { value: 'b' } });
    check('тот же ключ с другим телом — 409 OP_ID_REUSED, обработчик не выполнен', other.status === 409 && other.body.code === 'OP_ID_REUSED' && !other.replayed && counts.counter === before2, other);
    const otherUrl = await send('/api/test/counter?x=1', { key: k1, body: { value: 'a' } });
    check('тот же ключ с другим адресом (query) — 409 OP_ID_REUSED', otherUrl.status === 409 && otherUrl.body.code === 'OP_ID_REUSED' && counts.counter === before2, otherUrl);
    const otherPath = await send('/api/test/bad', { key: k1, body: { value: 'a' } });
    check('тот же ключ с другим маршрутом — 409 OP_ID_REUSED', otherPath.status === 409 && otherPath.body.code === 'OP_ID_REUSED' && !counts.bad, otherPath);

    // ── Другой пользователь ──
    const mine = await send('/api/test/counter', { key: k1, user: 'u2', body: { value: 'a' } });
    check('тот же ключ у другого пользователя независим: выполнен заново', mine.status === 200 && !mine.replayed && mine.body.n === counts.counter && mine.body.n !== first.body.n, mine);
    check('у каждого пользователя своя расписка', (await receipt('u1', k1))?.state === 'DONE' && (await receipt('u2', k1))?.state === 'DONE');
    const spoof = newKey();
    await send('/api/test/counter', { key: spoof, user: 'u1', body: { actorId: 'u3' } });
    check('личность — из authUser, а не из тела: расписка у u1, чужой нет', !!(await receipt('u1', spoof)) && !(await receipt('u3', spoof)));

    // ── Гонка: два одновременных запроса с одним ключом ──
    for (let round = 0; round < 3; round++) {
      const k = newKey();
      const b = counts.counter;
      const [r1, r2] = await Promise.all([
        send('/api/test/counter', { key: k, body: { delayMs: 150 } }),
        send('/api/test/counter', { key: k, body: { delayMs: 150 } }),
      ]);
      const executed = counts.counter - b;
      const replies = [r1, r2];
      const lost = replies.filter((r) => r.status === 409);
      check(`гонка ${round + 1}: обработчик выполнен ровно один раз`, executed === 1, { executed, r1: r1.status, r2: r2.status });
      check(`гонка ${round + 1}: проигравший получил прежний ответ или OP_IN_FLIGHT, не второе выполнение`,
        replies.some((r) => r.status === 200 && !r.replayed) && replies.every((r) => r.status === 200 || r.body.code === 'OP_IN_FLIGHT') && lost.length + replies.filter((r) => r.replayed).length === 1, replies);
      const after = await send('/api/test/counter', { key: k, body: { delayMs: 150 } });
      check(`гонка ${round + 1}: после неё тот же ключ отдаёт ответ победителя`, after.replayed && after.status === 200 && counts.counter - b === 1, after);
    }

    // ── Настоящий маршрут записи ──
    const vk = newKey();
    const reg1 = await send('/api/vdr/registers', { key: vk, body: { projectId: 'op-project', name: 'ВДР по ключу' } });
    const reg2 = await send('/api/vdr/registers', { key: vk, body: { projectId: 'op-project', name: 'ВДР по ключу' } });
    const rows = await prisma.docRegister.count({ where: { name: 'ВДР по ключу' } });
    check('настоящий маршрут (создание реестра ВДР): повтор с ключом — одна строка в базе и тот же ответ',
      reg1.status === 200 && reg2.replayed && reg2.body.register?.id === reg1.body.register?.id && rows === 1, { reg1: reg1.status, reg2, rows });
    const vk2 = newKey();
    await Promise.all([
      send('/api/vdr/registers', { key: vk2, body: { projectId: 'op-project', name: 'ВДР гонка' } }),
      send('/api/vdr/registers', { key: vk2, body: { projectId: 'op-project', name: 'ВДР гонка' } }),
    ]);
    check('настоящий маршрут: два одновременных запроса — одна строка', (await prisma.docRegister.count({ where: { name: 'ВДР гонка' } })) === 1);
    await send('/api/vdr/registers', { body: { projectId: 'op-project', name: 'ВДР без ключа' } });
    await send('/api/vdr/registers', { body: { projectId: 'op-project', name: 'ВДР без ключа' } });
    check('настоящий маршрут без ключа: как раньше (имя не уникально — две строки)', (await prisma.docRegister.count({ where: { name: 'ВДР без ключа' } })) === 2);

    // ── Ответы разного вида ──
    const e4 = newKey();
    const bad1 = await send('/api/test/bad', { key: e4, body: {} });
    const bad2 = await send('/api/test/bad', { key: e4, body: {} });
    check('ответ 4xx сохраняется и повторяется тем же статусом и телом', bad1.status === 400 && bad2.status === 400 && bad2.replayed && bad2.body.error === 'нельзя' && counts.bad === 1, [bad1, bad2]);

    const kb = newKey();
    const big1 = await send('/api/test/big', { key: kb, body: {} });
    const bigRec = await receipt('u1', kb);
    const big2 = await send('/api/test/big', { key: kb, body: {} });
    check('большой ответ (> 256 КиБ) уходит клиенту целиком, в расписку не кладётся', big1.status === 200 && big1.text.length > MAX_STORED_BODY && bigRec?.state === 'DONE' && bigRec.body === '' && bigRec.status === 200, { len: big1.text.length, rec: bigRec?.state });
    check('повтор большого ответа — тот же статус и { replayed: true }, обработчик не выполнен', big2.status === 200 && big2.replayed && big2.body.replayed === true && counts.big === 1, big2);

    const kt = newKey();
    const t1 = await send('/api/test/text', { key: kt, body: {} });
    const t2 = await send('/api/test/text', { key: kt, body: {} });
    check('не JSON-ответ: повтор с тем же статусом 201 и { replayed: true }', t1.status === 201 && t2.status === 201 && t2.replayed && t2.body.replayed === true && counts.text === 1, [t1, t2]);

    const ks = newKey();
    const s1 = await send('/api/test/stream', { key: ks, body: {} });
    await sleep(250); // запись после потока идёт уже после ответа
    const srec = await receipt('u1', ks);
    const s2 = await send('/api/test/stream', { key: ks, body: {} });
    check('потоковый ответ не буферизуется: DONE без тела; повтор — { replayed: true }', s1.status === 200 && s1.text.startsWith('часть-1-') && srec?.state === 'DONE' && srec.body === '' && s2.replayed && s2.body.replayed === true && counts.stream === 1, { s1: s1.text, srec: srec?.state, s2 });

    const kn = newKey();
    await send('/api/test/noContent', { key: kn, body: {} });
    await sleep(250); // запись после потока идёт уже после ответа
    const nc = await send('/api/test/noContent', { key: kn, body: {} });
    check('204: повтор отвечает 204 без тела и без выполнения', nc.status === 204 && nc.replayed && counts.noContent === 1, nc);

    // ── Сырое тело ──
    const kr = newKey();
    const payload = Buffer.from('x'.repeat(3000));
    const r1 = await send('/api/test/raw', { key: kr, raw: payload });
    const r2 = await send('/api/test/raw', { key: kr, raw: payload });
    check('сырое тело: маршрут получает все байты (звено поток не читает), повтор не выполняет', r1.body.bytes === 3000 && r2.replayed && r2.body.n === r1.body.n && counts.raw === 1, [r1.body, r2.body]);
    const r3 = await send('/api/test/raw', { key: kr, raw: Buffer.from('x'.repeat(3001)) });
    check('сырое тело другой длины под тем же ключом — 409 OP_ID_REUSED', r3.status === 409 && r3.body.code === 'OP_ID_REUSED' && counts.raw === 1, r3);

    // ── 5xx и обрыв ──
    const kx = newKey();
    const x1 = await send('/api/test/boom', { key: kx, body: {} });
    const xrec = await receipt('u1', kx);
    const x2 = await send('/api/test/boom', { key: kx, body: {} });
    check('ответ 5xx клиенту уходит как есть, расписка остаётся PENDING (исход неизвестен)', x1.status === 500 && xrec?.state === 'PENDING', { x1: x1.status, xrec });
    check('повтор после 5xx — 409 OP_IN_FLIGHT с понятным текстом, второго выполнения нет', x2.status === 409 && x2.body.code === 'OP_IN_FLIGHT' && /исход неизвестен/.test(x2.body.error) && counts.boom === 1, x2);

    // Сервер упал посреди: расписка PENDING без ответа
    const kp = newKey();
    await prisma.opReceipt.create({ data: { actorId: 'u1', opId: kp, requestHash: 'x', state: 'PENDING' } });
    const p1 = await send('/api/test/counter', { key: kp, body: {} });
    check('чужая зависшая PENDING с другим хешем — OP_ID_REUSED, а не выполнение', p1.status === 409 && p1.body.code === 'OP_ID_REUSED', p1);
    const kq = newKey();
    const hashRow = await send('/api/test/counter', { key: kq, body: { value: 'q' } });
    await prisma.opReceipt.update({ where: { actorId_opId: { actorId: 'u1', opId: kq } }, data: { state: 'PENDING', status: 0, body: '' } });
    const beforeQ = counts.counter;
    const q2 = await send('/api/test/counter', { key: kq, body: { value: 'q' } });
    check('PENDING с тем же хешем (сервер упал посреди) — 409 OP_IN_FLIGHT, обработчик не выполнен', hashRow.status === 200 && q2.status === 409 && q2.body.code === 'OP_IN_FLIGHT' && counts.counter === beforeQ, q2);

    // ── Нет таблицы ──
    const missing: string[] = [];
    const stub = { opReceipt: { create: async () => { const e: any = new Error('The table `main.OpReceipt` does not exist'); e.code = 'P2021'; throw e; } } };
    const app2 = express();
    app2.use(express.json());
    app2.use((req, _res, next) => { (req as any).authUser = { id: 'u1' }; next(); });
    app2.use(opReceiptMiddleware({ getPrisma: () => stub, log: (m) => missing.push(m) }));
    let hits2 = 0;
    app2.post('/api/x', (_req, res) => { hits2++; res.json({ ok: true }); });
    const server2 = createServer(app2);
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
    try {
      const a2 = server2.address() as any;
      const call = () => fetch(`http://127.0.0.1:${a2.port}/api/x`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Flux-Op-Id': 'missing-table-1' }, body: '{}' });
      const m1 = await call(); await call();
      check('таблицы расписок нет: запись не блокируется, причина — в журнале один раз', m1.status === 200 && hits2 === 2 && missing.length === 1, { hits2, missing });
    } finally { server2.close(); }

    // ── Каноническая форма ──
    check('каноническая запись тела не зависит от порядка полей', canonicalJson({ b: [1, { d: 1, c: 2 }], a: null }) === canonicalJson({ a: null, b: [1, { c: 2, d: 1 }] }));

    // ── Уборка ──
    await prisma.opReceipt.deleteMany({});
    const now = Date.now();
    const old = new Date(now - RECEIPT_TTL_MS - 60_000);
    const fresh = new Date(now - RECEIPT_TTL_MS + 3_600_000);
    for (let i = 0; i < 5; i++) await prisma.opReceipt.create({ data: { actorId: 'c', opId: `old-done-${i}`, requestHash: 'h', state: 'DONE', status: 200, createdAt: old } });
    for (let i = 0; i < 3; i++) await prisma.opReceipt.create({ data: { actorId: 'c', opId: `old-pend-${i}`, requestHash: 'h', state: 'PENDING', createdAt: old } });
    for (let i = 0; i < 2; i++) await prisma.opReceipt.create({ data: { actorId: 'c', opId: `fresh-${i}`, requestHash: 'h', state: 'PENDING', createdAt: fresh } });
    const removed = await cleanupOpReceipts(prisma, now, 3);
    const left = await prisma.opReceipt.findMany({ select: { opId: true } });
    check('уборка: расписки старше 7 суток (и DONE, и зависшие PENDING) удалены пачками по 3, свежие целы',
      removed === 8 && left.length === 2 && left.every((x: any) => x.opId.startsWith('fresh-')), { removed, left });
    check('уборка повторно ничего не находит', (await cleanupOpReceipts(prisma, now, 3)) === 0);

    // Тело ответа живёт сутки: ключ ставится на каждую запись, и тела за неделю раздули бы таблицу
    await prisma.opReceipt.deleteMany({});
    const dayOld = new Date(now - BODY_TTL_MS - 60_000);
    const recent = new Date(now - BODY_TTL_MS + 3_600_000);
    for (let i = 0; i < 4; i++) await prisma.opReceipt.create({ data: { actorId: 'c', opId: `day-done-${i}`, requestHash: 'h', state: 'DONE', status: 201, body: '{"id":1}', createdAt: dayOld } });
    await prisma.opReceipt.create({ data: { actorId: 'c', opId: 'recent-done', requestHash: 'h', state: 'DONE', status: 201, body: '{"id":2}', createdAt: recent } });
    const removedDay = await cleanupOpReceipts(prisma, now, 3);
    const afterDay = await prisma.opReceipt.findMany({ select: { opId: true, body: true, state: true, status: true } });
    check('уборка: у выполненных старше суток тело стёрто, расписка, статус и состояние целы; свежее тело цело',
      removedDay === 0 && afterDay.length === 5
      && afterDay.filter((x: any) => x.opId.startsWith('day-done-')).every((x: any) => x.body === '' && x.state === 'DONE' && x.status === 201)
      && afterDay.find((x: any) => x.opId === 'recent-done')?.body === '{"id":2}', { removedDay, afterDay });
  } finally {
    server.close();
    await prisma.$disconnect();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().then(() => { console.log('\nOpReceipt: всё прошло'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
