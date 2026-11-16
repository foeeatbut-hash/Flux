/**
 * ВДР: одновременные и устаревшие записи (docs/roadmap/offline-work.md, 0.1).
 *
 * Настоящая SQLite-база и настоящий express: гонку не сыграть заглушкой.
 * Что держим:
 *  • два выпуска одной строки одновременно — одна ревизия, один отказ 409,
 *    история без потерь и без второй записи с тем же номером;
 *  • то же для ревизии самого реестра (revision-up);
 *  • правка по устаревшей версии (PUT строки и реестра) — 409, а не перезапись;
 *  • две одновременные правки разных полей `extra` не затирают друг друга;
 *  • обычный путь (и клиент без ожидаемой версии) работает;
 *  • отказ общего вида (.claude/progress/tags-vdr-version.md): 409 с голой текущей записью и текстом
 *    словаря, 404 `RECORD_GONE` для правки и создания внутри, и база после отказа не изменилась;
 *  • удаление строки и реестра: версия в строке запроса, открытая у коллеги запись (и строка внутри
 *    реестра) не удаляется — два человека; «нет записи» — 200 `alreadyGone`, а не 500.
 *
 * Мутации, которыми набор проверен (каждая роняет его): убрать `openCheck` у удаления строки; убрать
 * вложенные строки из `openCheck` реестра; не передавать `expectedVersion` в удаление строки и реестра;
 * вернуть `conflict`/обёртку `{ item }` в отказ; вернуть 500 вместо `alreadyGone`; создание строки без реестра — 500.
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
import {
  editChangedText, deleteChangedText, editGoneText, createInsideGoneText, deleteOpenText, deleteOpenNestedText,
} from '../src/lib/refusalTexts.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-vdr-concurrency-'));
const dbPath = path.join(temp, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`✓ ${label}`);
};

async function main() {
  const app = express();
  app.use(express.json());
  // Два человека — по заголовку: удаление сверяется с открытыми записями других
  app.use((req, _res, next) => { (req as any).authUser = { id: req.header('x-test-user') || 'me', name: 'Инженер', role: 'ADMIN', isActive: true }; next(); });
  registerVdrRoutes(app as any, { chunkBytes: async () => 1024 });
  const server = createServer(app);
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);
    setBroadcaster(() => {});
    await prisma.project.create({ data: { id: 'vdr-project', name: 'VDR test' } });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const send = async (method: string, url: string, body?: any, user = 'me') => {
      const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': user }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    const newRegister = async () => (await send('POST', '/api/vdr/registers', { projectId: 'vdr-project', name: 'ВДР' })).body.register;
    const newItem = async (registerId: string, no: string) => (await send('POST', '/api/vdr/items', { registerId, contractorNo: no, titleRu: no })).body.item;
    const getItem = async (registerId: string, id: string) => (await send('GET', `/api/vdr/items?registerId=${registerId}`)).body.items.find((i: any) => i.id === id);
    const history = async (id: string) => (await send('GET', `/api/vdr/items/${id}/revisions`)).body.revisions as any[];

    // Выпуск идёт окном «Выпустить…» (scripts/test-docflow-issue.ts); здесь «следующая ревизия» открывается
    // только у выпущенного документа, поэтому выпуск ставится прямо в базу — как после окна выпуска
    const seedIssued = async (id: string) => {
      const row = await prisma.docRegisterItem.findUnique({ where: { id } });
      await prisma.docRegisterItemRevision.create({ data: { itemId: id, revision: row.revision, reason: 'IFR', issuedKey: `seed-${id}-${row.revision}` } });
    };
    const register = await newRegister();

    // ── Обычный путь ──
    const solo = await newItem(register.id, 'D-solo');
    const unissued = await send('POST', `/api/vdr/items/${solo.id}/issue-revision`, { kind: 'next', expectedRevision: 'A' });
    check('невыпущенная ревизия следующей не открывается: 409 и указание на окно выпуска', unissued.status === 409 && /Выпустить/.test(unissued.body.error), unissued.body);
    await seedIssued(solo.id);
    const first = await send('POST', `/api/vdr/items/${solo.id}/issue-revision`, { kind: 'next', expectedRevision: 'A' });
    check('обычный выпуск с ожидаемой ревизией: A → B', first.status === 200 && first.body.item.revision === 'B', first.body);
    check('история после обычного выпуска — одна запись', (await history(solo.id)).length === 1);
    await seedIssued(solo.id);
    const second = await send('POST', `/api/vdr/items/${solo.id}/issue-revision`, { kind: 'next', expectedRevision: 'B' });
    check('следующий выпуск: B → C', second.status === 200 && second.body.item.revision === 'C', second.body);
    await seedIssued(solo.id);
    const noExpect = await send('POST', `/api/vdr/items/${solo.id}/issue-revision`, { kind: 'next' });
    check('клиент без ожидаемой версии, без гонки: работает как раньше (C → D)', noExpect.status === 200 && noExpect.body.item.revision === 'D', noExpect.body);

    // ── Устаревший выпуск ──
    const stale = await send('POST', `/api/vdr/items/${solo.id}/issue-revision`, { kind: 'next', expectedRevision: 'B' });
    check('выпуск по устаревшей ревизии — 409', stale.status === 409, stale.body);
    check('в отказе — понятный текст с номером ревизии и текущая строка',
      /D/.test(stale.body.error) && /уже выпущен|уже выпустил/.test(stale.body.error) && stale.body.current?.revision === 'D', stale.body);
    check('отказ ничего не записал: ревизия D, в истории три записи', (await getItem(register.id, solo.id)).revision === 'D' && (await history(solo.id)).length === 3);

    // ── Два параллельных выпуска одной строки ──
    for (let round = 1; round <= 5; round++) {
      const it = await newItem(register.id, `D-race-${round}`);
      await seedIssued(it.id);
      const results = await Promise.all([
        send('POST', `/api/vdr/items/${it.id}/issue-revision`, { kind: 'next', expectedRevision: 'A' }),
        send('POST', `/api/vdr/items/${it.id}/issue-revision`, { kind: 'next', expectedRevision: 'A' }),
      ]);
      const codes = results.map((r) => r.status).sort();
      check(`гонка ${round}: один выпуск 200 и один отказ 409`, codes[0] === 200 && codes[1] === 409, results.map((r) => [r.status, r.body.error]));
      const rows = await history(it.id);
      check(`гонка ${round}: ревизия B, в истории ровно одна запись выпуска A`, (await getItem(register.id, it.id)).revision === 'B' && rows.length === 1 && rows[0].revision === 'A', rows);
    }

    // Клиент без ожидаемой версии в гонке не получает двух одинаковых номеров
    // и не теряет записи истории: каждая успешная запись — своя ревизия
    {
      const it = await newItem(register.id, 'D-race-old');
      await seedIssued(it.id);
      const results = await Promise.all(Array.from({ length: 4 }, () => send('POST', `/api/vdr/items/${it.id}/issue-revision`, { kind: 'next' })));
      const ok = results.filter((r) => r.status === 200);
      const rows = await history(it.id);
      check('старые клиенты в гонке: каждый ответ 200 или 409, без 500', results.every((r) => r.status === 200 || r.status === 409), results.map((r) => r.status));
      check('старые клиенты в гонке: следующую ревизию открывает ровно один, B не выпущена — остальные отказаны', ok.length === 1 && rows.length === 1, { rows: rows.map((r) => r.revision), ok: ok.length });
      check('старые клиенты в гонке: ревизия строки B', (await getItem(register.id, it.id)).revision === 'B');
    }

    // ── PUT строки ──
    const row = await newItem(register.id, 'D-put');
    const seen = await getItem(register.id, row.id);
    const put1 = await send('PUT', `/api/vdr/items/${row.id}`, { titleRu: 'Первое', expectedUpdatedAt: seen.updatedAt });
    check('PUT с актуальной версией проходит и отдаёт новую updatedAt', put1.status === 200 && put1.body.item.titleRu === 'Первое' && put1.body.item.updatedAt !== seen.updatedAt, put1.body);
    const put2 = await send('PUT', `/api/vdr/items/${row.id}`, { titleRu: 'Устаревшее', expectedUpdatedAt: seen.updatedAt });
    check('PUT по устаревшей версии — 409 с текущей строкой', put2.status === 409 && put2.body.code === 'VERSION_CONFLICT' && put2.body.conflict === undefined && put2.body.current?.titleRu === 'Первое' && put2.body.current?.item === undefined, put2.body);
    check('устаревший PUT ничего не записал', (await getItem(register.id, row.id)).titleRu === 'Первое');
    const put3 = await send('PUT', `/api/vdr/items/${row.id}`, { titleEn: 'Old client' });
    check('PUT без ожидаемой версии (старый клиент) сливает поля как раньше', put3.status === 200 && put3.body.item.titleEn === 'Old client' && put3.body.item.titleRu === 'Первое', put3.body);

    // Карточка старого клиента шлёт и ревизию, которую видела: затереть ею
    // выпущенную нельзя
    await seedIssued(row.id);
    await send('POST', `/api/vdr/items/${row.id}/issue-revision`, { kind: 'next' });
    const putRev = await send('PUT', `/api/vdr/items/${row.id}`, { titleRu: 'С чужой ревизией', revision: 'A' });
    check('PUT без версии с ревизией, отличной от текущей — 409, не откат выпуска', putRev.status === 409 && (await getItem(register.id, row.id)).revision === 'B', putRev.body);
    const putSame = await send('PUT', `/api/vdr/items/${row.id}`, { titleRu: 'С той же ревизией', revision: 'B' });
    check('PUT без версии с той же ревизией проходит', putSame.status === 200, putSame.body);

    // Две правки разных ячеек `extra` одновременно: обе остаются
    {
      const it = await newItem(register.id, 'D-extra');
      const results = await Promise.all(['a', 'b', 'c', 'd'].map((k) => send('PUT', `/api/vdr/items/${it.id}`, { extra: { [k]: k.toUpperCase() } })));
      const extra = (await getItem(register.id, it.id)).extra;
      check('одновременные правки разных ячеек extra не затирают друг друга', results.every((r) => r.status === 200) && ['a', 'b', 'c', 'd'].every((k) => extra[k] === k.toUpperCase()), { extra, st: results.map((r) => r.status) });
    }

    // ── Реестр: revision-up ──
    const reg = await newRegister();
    const regUp = await send('POST', `/api/vdr/registers/${reg.id}/revision-up`, { description: 'Обычный', expectedRevision: 'A' });
    check('revision-up реестра с ожидаемой ревизией: A → B', regUp.status === 200 && regUp.body.register.revision === 'B' && regUp.body.register.revisions.length === 1, regUp.body);
    const regStale = await send('POST', `/api/vdr/registers/${reg.id}/revision-up`, { expectedRevision: 'A' });
    check('revision-up по устаревшей ревизии — 409 с текстом и текущим реестром', regStale.status === 409 && regStale.body.code === 'VERSION_CONFLICT' && /B/.test(regStale.body.error) && regStale.body.current?.revision === 'B', regStale.body);
    for (let round = 1; round <= 5; round++) {
      const r2 = await newRegister();
      const results = await Promise.all([
        send('POST', `/api/vdr/registers/${r2.id}/revision-up`, { expectedRevision: 'A', description: 'гонка 1' }),
        send('POST', `/api/vdr/registers/${r2.id}/revision-up`, { expectedRevision: 'A', description: 'гонка 2' }),
      ]);
      const codes = results.map((r) => r.status).sort();
      const fresh = (await send('GET', `/api/vdr/registers?projectId=vdr-project`)).body.registers.find((r: any) => r.id === r2.id);
      check(`гонка реестра ${round}: один 200, один 409, в истории одна запись`, codes[0] === 200 && codes[1] === 409 && fresh.revision === 'B' && fresh.revisions.length === 1, { codes, fresh: fresh.revisions });
    }
    {
      const r3 = await newRegister();
      const results = await Promise.all(Array.from({ length: 4 }, () => send('POST', `/api/vdr/registers/${r3.id}/revision-up`, {})));
      const fresh = (await send('GET', `/api/vdr/registers?projectId=vdr-project`)).body.registers.find((r: any) => r.id === r3.id);
      const ok = results.filter((r) => r.status === 200).length;
      check('revision-up старых клиентов в гонке: без 500, история на каждый успех', results.every((r) => r.status === 200 || r.status === 409) && fresh.revisions.length === ok && new Set(fresh.revisions.map((h: any) => h.rev)).size === ok, { st: results.map((r) => r.status), h: fresh.revisions });
    }

    // ── PUT реестра ──
    const regSeen = (await send('GET', `/api/vdr/registers?projectId=vdr-project`)).body.registers.find((r: any) => r.id === reg.id);
    const rp1 = await send('PUT', `/api/vdr/registers/${reg.id}`, { vendor: 'Поставщик 1', expectedUpdatedAt: regSeen.updatedAt });
    check('PUT реестра с актуальной версией проходит', rp1.status === 200 && rp1.body.register.vendor === 'Поставщик 1', rp1.body);
    const rp2 = await send('PUT', `/api/vdr/registers/${reg.id}`, { vendor: 'Устаревшее', expectedUpdatedAt: regSeen.updatedAt });
    check('PUT реестра по устаревшей версии — 409 с текущим реестром', rp2.status === 409 && rp2.body.code === 'VERSION_CONFLICT' && rp2.body.current?.vendor === 'Поставщик 1' && rp2.body.current?.register === undefined, rp2.body);
    const rp3 = await send('PUT', `/api/vdr/registers/${reg.id}`, { owner: 'Заказчик' });
    check('PUT реестра без версии (старый клиент) сливает поля', rp3.status === 200 && rp3.body.register.owner === 'Заказчик' && rp3.body.register.vendor === 'Поставщик 1', rp3.body);
    const rp4 = await send('PUT', `/api/vdr/registers/${reg.id}`, { revisions: [], revision: 'A' });
    const regNow = (await send('GET', `/api/vdr/registers?projectId=vdr-project`)).body.registers.find((r: any) => r.id === reg.id);
    check('PUT реестра не стирает историю ревизий и не откатывает ревизию', regNow.revision === 'B' && regNow.revisions.length === 1 && rp4.status === 409, { rp4: rp4.status, regNow: regNow.revisions });

    // ── Отказ общего вида: голый current, тексты словаря, 404 с кодом ──
    console.log('\n── отказ общего вида, удаление, открытые записи');
    const world = async () => ({
      registers: await prisma.docRegister.findMany({ orderBy: { id: 'asc' } }),
      items: await prisma.docRegisterItem.findMany({ orderBy: { id: 'asc' } }),
      tags: await prisma.docRegisterItemTag.findMany({ orderBy: [{ itemId: 'asc' }, { tagId: 'asc' }] }),
      history: await prisma.docRegisterItemRevision.findMany({ orderBy: { id: 'asc' } }),
    });
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const open = (userId: string, model: string, recordId: string, at: Date = new Date()) =>
      prisma.openRecord.create({ data: { model, recordId, userId, holderKey: `window-${userId}-${model}-${recordId}`, at } });
    const versionOf = async (model: 'docRegister' | 'docRegisterItem', id: string): Promise<number> => (await (prisma as any)[model].findUnique({ where: { id } })).version;
    const petrova = [{ userId: 'u-petrova', name: 'Петрова А. А.' }];
    await prisma.user.create({ data: { id: 'u-petrova', symbol: 's-u-petrova', password: 'x', name: 'Петрова А. А.' } });
    const NO_TEXT_CODES = (t: unknown) => !/RECORD_GONE|RECORD_OPEN|VERSION_CONFLICT/.test(String(t));

    // Правка по устаревшей версии: ничего не записано, отказ общего вида, текст словаря
    {
      const reg2 = await newRegister();
      const it = await newItem(reg2.id, 'D-refusal');
      const seenIt = await getItem(reg2.id, it.id);
      await send('PUT', `/api/vdr/items/${it.id}`, { remarks: 'правка коллеги', expectedUpdatedAt: seenIt.updatedAt }, 'u-petrova');
      const before = await world();
      const r = await send('PUT', `/api/vdr/items/${it.id}`, { titleRu: 'Моя правка', expectedUpdatedAt: seenIt.updatedAt });
      check('отказ строки: 409, код, текст словаря без кода', r.status === 409 && r.body.code === 'VERSION_CONFLICT' && r.body.error === editChangedText('registerItem', 'D-refusal') && NO_TEXT_CODES(r.body.error), r.body);
      check('отказ строки: current — голая запись (поля строки, extra разобран), без обёрток и старых полей',
        r.body.current?.id === it.id && r.body.current?.remarks === 'правка коллеги' && typeof r.body.current?.extra === 'object' && r.body.current?.item === undefined && r.body.conflict === undefined, r.body);
      check('отказ строки: в базе не изменилось ничего', same(before, await world()));

      const seenReg = (await send('GET', '/api/vdr/registers?projectId=vdr-project')).body.registers.find((x: any) => x.id === reg2.id);
      await send('PUT', `/api/vdr/registers/${reg2.id}`, { vendor: 'Поставщик коллеги', expectedUpdatedAt: seenReg.updatedAt }, 'u-petrova');
      const beforeReg = await world();
      const rr = await send('PUT', `/api/vdr/registers/${reg2.id}`, { vendor: 'Мой', expectedUpdatedAt: seenReg.updatedAt });
      check('отказ реестра: 409, текст словаря, current — голый реестр с разобранными columnsConfig и revisions',
        rr.status === 409 && rr.body.error === editChangedText('register', reg2.name) && rr.body.current?.vendor === 'Поставщик коллеги' && Array.isArray(rr.body.current?.columnsConfig) && Array.isArray(rr.body.current?.revisions) && rr.body.current?.register === undefined && rr.body.conflict === undefined, rr.body);
      check('отказ реестра: в базе не изменилось ничего', same(beforeReg, await world()));
    }

    // Записи уже нет: 404 RECORD_GONE, текст словаря, ничего не записано
    {
      const reg2 = await newRegister();
      const it = await newItem(reg2.id, 'D-gone');
      await send('DELETE', `/api/vdr/items/${it.id}`, undefined, 'u-petrova');
      const ghostReg = await newRegister();
      await prisma.docRegister.delete({ where: { id: ghostReg.id } });
      const before = await world();
      const e1 = await send('PUT', `/api/vdr/items/${it.id}`, { titleRu: 'Призрак' });
      check('правка удалённой строки — 404 RECORD_GONE и текст словаря', e1.status === 404 && e1.body.code === 'RECORD_GONE' && e1.body.error === editGoneText('registerItem') && NO_TEXT_CODES(e1.body.error), e1);
      const e2 = await send('PUT', `/api/vdr/registers/${ghostReg.id}`, { vendor: 'Призрак' });
      check('правка удалённого реестра — 404 RECORD_GONE и текст словаря', e2.status === 404 && e2.body.code === 'RECORD_GONE' && e2.body.error === editGoneText('register'), e2);
      const e3 = await send('POST', `/api/vdr/registers/${ghostReg.id}/revision-up`, { expectedRevision: 'A' });
      check('новая ревизия удалённого реестра — 404 RECORD_GONE', e3.status === 404 && e3.body.code === 'RECORD_GONE', e3);
      const e4 = await send('POST', `/api/vdr/items/${it.id}/issue-revision`, { kind: 'next' });
      check('выпуск ревизии удалённой строки — 404 RECORD_GONE', e4.status === 404 && e4.body.code === 'RECORD_GONE', e4);
      const e5 = await send('POST', '/api/vdr/items', { registerId: ghostReg.id, contractorNo: 'D-ghost' });
      check('создание строки в удалённом реестре — 404 RECORD_GONE, текст «создание внутри»', e5.status === 404 && e5.body.code === 'RECORD_GONE' && e5.body.error === createInsideGoneText('register'), e5);
      const e6 = await send('POST', '/api/vdr/items', { contractorNo: 'D-noreg' });
      check('создание строки без реестра — тоже 404 RECORD_GONE, а не 500', e6.status === 404 && e6.body.code === 'RECORD_GONE', e6);
      check('«записи нет»: в базе не изменилось ничего (строка не создана)', same(before, await world()));
    }

    // Удаление строки: версия в запросе, нет записи — 200 alreadyGone
    {
      const reg2 = await newRegister();
      await prisma.tag.create({ data: { id: 'vdr-tag-1', identifier: 'AHU-VDR-1', projectId: 'vdr-project', codeKey: 'AHU-VDR-1' } }).catch(() => null);
      const it = await newItem(reg2.id, 'D-del');
      await prisma.docRegisterItemTag.create({ data: { itemId: it.id, tagId: 'vdr-tag-1', tagIdentifier: 'AHU-VDR-1' } });
      const v = await versionOf('docRegisterItem', it.id);
      const before = await world();

      const bad = await send('DELETE', `/api/vdr/items/${it.id}?expectedVersion=abc`);
      check('нечитаемая версия при удалении строки — 400, ничего не изменилось', bad.status === 400 && same(before, await world()), bad);
      const stale = await send('DELETE', `/api/vdr/items/${it.id}?expectedVersion=${v + 5}`);
      check('удаление строки по чужой версии — 409 с текстом словаря и голой строкой', stale.status === 409 && stale.body.code === 'VERSION_CONFLICT' && stale.body.error === deleteChangedText('registerItem', 'D-del') && stale.body.current?.id === it.id && stale.body.current?.item === undefined, stale);
      check('отказ по версии: строка и связи тегов на месте', same(before, await world()));

      await open('u-petrova', 'DocRegisterItem', it.id);
      const busy = await send('DELETE', `/api/vdr/items/${it.id}?expectedVersion=${v}`);
      check('строка открыта у коллеги — 409 RECORD_OPEN, держатель и запись названы',
        busy.status === 409 && busy.body.code === 'RECORD_OPEN' && same(busy.body.holders, petrova) && busy.body.record?.model === 'DocRegisterItem' && busy.body.record?.id === it.id, busy);
      check('открытая строка: текст словаря без кода, в базе ничего не изменилось', busy.body.error === deleteOpenText('registerItem', 'D-del', petrova) && NO_TEXT_CODES(busy.body.error) && same(before, await world()));
      const oldClient = await send('DELETE', `/api/vdr/items/${it.id}`);
      check('клиент без версии (старая сборка) открытую строку тоже не удалит', oldClient.status === 409 && oldClient.body.code === 'RECORD_OPEN' && same(before, await world()), oldClient);
      await prisma.openRecord.deleteMany({});

      await open('me', 'DocRegisterItem', it.id);
      await open('u-petrova', 'DocRegisterItem', it.id, new Date(Date.now() - 10 * 60_000));
      const done = await send('DELETE', `/api/vdr/items/${it.id}?expectedVersion=${v}`);
      check('свои окна и несвежие отметки (старше 90 с) удалению не мешают: 200', done.status === 200 && done.body.success === true && done.body.alreadyGone === undefined, done);
      const after = await world();
      check('удалена строка и её связи с тегами, остальное цело', !after.items.some((x: any) => x.id === it.id) && !after.tags.some((x: any) => x.itemId === it.id) && after.items.length === before.items.length - 1);
      const again = await send('DELETE', `/api/vdr/items/${it.id}?expectedVersion=${v}`);
      check('повторное удаление — 200 alreadyGone, а не 500', again.status === 200 && again.body.alreadyGone === true, again);
      const never = await send('DELETE', '/api/vdr/items/net-takoj-stroki');
      check('удаление несуществующей строки — 200 alreadyGone', never.status === 200 && never.body.alreadyGone === true, never);
      await prisma.openRecord.deleteMany({});
    }

    // Удаление реестра: его строки — каскад проверки открытых
    {
      const reg2 = await newRegister();
      const a = await newItem(reg2.id, 'D-cascade-a');
      const b = await newItem(reg2.id, 'D-cascade-b');
      await prisma.docRegisterItemTag.create({ data: { itemId: a.id, tagId: 'vdr-tag-1', tagIdentifier: 'AHU-VDR-1' } });
      const v = await versionOf('docRegister', reg2.id);
      const before = await world();

      const bad = await send('DELETE', `/api/vdr/registers/${reg2.id}?expectedVersion=0`);
      check('нечитаемая версия при удалении реестра — 400', bad.status === 400 && same(before, await world()), bad);
      const stale = await send('DELETE', `/api/vdr/registers/${reg2.id}?expectedVersion=${v + 3}`);
      check('удаление реестра по чужой версии — 409, текст словаря, голый реестр в current',
        stale.status === 409 && stale.body.code === 'VERSION_CONFLICT' && stale.body.error === deleteChangedText('register', reg2.name) && stale.body.current?.id === reg2.id && Array.isArray(stale.body.current?.revisions) && stale.body.current?.register === undefined, stale);
      check('отказ по версии: реестр, строки и связи на месте', same(before, await world()));

      await open('u-petrova', 'DocRegisterItem', b.id);
      const nested = await send('DELETE', `/api/vdr/registers/${reg2.id}?expectedVersion=${v}`);
      check('у реестра открыта строка у коллеги — 409 RECORD_OPEN, названа именно строка',
        nested.status === 409 && nested.body.code === 'RECORD_OPEN' && nested.body.record?.model === 'DocRegisterItem' && nested.body.record?.id === b.id && same(nested.body.holders, petrova), nested);
      check('вложенная открытая: текст «в реестре сейчас открыта строка…» из словаря',
        nested.body.error === deleteOpenNestedText({ noun: 'register', name: reg2.name }, { noun: 'registerItem', name: 'D-cascade-b' }, petrova) && NO_TEXT_CODES(nested.body.error), nested.body.error);
      check('вложенная открытая: в базе не изменилось ничего (ни реестр, ни строки, ни связи)', same(before, await world()));
      await prisma.openRecord.deleteMany({});

      await open('u-petrova', 'DocRegister', reg2.id);
      const self = await send('DELETE', `/api/vdr/registers/${reg2.id}?expectedVersion=${v}`);
      check('сам реестр открыт у коллеги (реквизиты) — 409 RECORD_OPEN с текстом про реестр',
        self.status === 409 && self.body.code === 'RECORD_OPEN' && self.body.error === deleteOpenText('register', reg2.name, petrova) && same(before, await world()), self);
      await prisma.openRecord.deleteMany({});

      const done = await send('DELETE', `/api/vdr/registers/${reg2.id}?expectedVersion=${v}`);
      const after = await world();
      // Строки уходят каскадом базы (в локальной SQLite без внешних ключей он не работает — как и раньше); связи тегов снимает сам маршрут
      check('реестр удалён, связи тегов его строк сняты', done.status === 200 && !after.registers.some((x: any) => x.id === reg2.id) && !after.tags.some((x: any) => x.itemId === a.id), done);
      const again = await send('DELETE', `/api/vdr/registers/${reg2.id}?expectedVersion=${v}`);
      check('повторное удаление реестра — 200 alreadyGone', again.status === 200 && again.body.alreadyGone === true, again);
    }

    // Гонка: удаление и удаление, правка после удаления
    {
      const reg2 = await newRegister();
      const it = await newItem(reg2.id, 'D-del-race');
      const v = await versionOf('docRegisterItem', it.id);
      const results = await Promise.all([
        send('DELETE', `/api/vdr/items/${it.id}?expectedVersion=${v}`),
        send('DELETE', `/api/vdr/items/${it.id}?expectedVersion=${v}`),
      ]);
      check('два удаления одной строки: оба 200, ровно одно настоящее', results.every((r) => r.status === 200) && results.filter((r) => r.body.alreadyGone).length === 1, results.map((r) => r.body));
      const it2 = await newItem(reg2.id, 'D-edit-vs-del');
      const seen = await getItem(reg2.id, it2.id);
      const v2 = await versionOf('docRegisterItem', it2.id);
      await send('DELETE', `/api/vdr/items/${it2.id}?expectedVersion=${v2}`, undefined, 'u-petrova');
      const lateEdit = await send('PUT', `/api/vdr/items/${it2.id}`, { titleRu: 'Поздно', expectedUpdatedAt: seen.updatedAt });
      check('правка с версией после удаления коллегой — 404 RECORD_GONE', lateEdit.status === 404 && lateEdit.body.code === 'RECORD_GONE', lateEdit);
    }

    console.log('\nВДР: одновременные записи — все проверки пройдены');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
