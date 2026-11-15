/**
 * Открытые записи (server/openRecords.ts, маршрут /api/open-records) на настоящей
 * SQLite: таблица из schema.prisma, настоящий express, настоящий клиент базы.
 *
 * Мутации, которыми набор проверен (каждая роняет его):
 *  • убрать «кроме себя» (свои окна мешают собственному удалению);
 *  • убрать свежесть (запись, оставленную закрытым окном, держат вечно);
 *  • не удалять прочие строки окна (закрытая в окне запись остаётся занятой);
 *  • стирать строки не только своего человека (чужой ключ окна стирает чужое);
 *  • принимать любую модель (список не из перечня версионных).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma } from '../server/context.js';
import { findOpen, reportOpen, parseOpenList, purgeStale, type OpenRef } from '../server/openRecords.js';
import { registerOpenRecordRoutes } from '../server/routes/openRecords.js';
import { OPEN_BEAT_MS, OPEN_FRESH_MS, OPEN_MAX_RECORDS } from '../src/lib/openRecordTime.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-open-records-'));
const dbPath = path.join(root, 'fixture.sqlite');
const raw = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });

let checks = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 700)}`}`);
  checks++;
  console.log(`✓ ${label}`);
};

const pos = (id: string): OpenRef => ({ model: 'ComponentElement', id });
const sys = (id: string): OpenRef => ({ model: 'EquipmentSystem', id });
const rowsOf = async (holderKey?: string) => (await raw.openRecord.findMany({ where: holderKey ? { holderKey } : {}, orderBy: [{ recordId: 'asc' }, { holderKey: 'asc' }] }))
  .map((r: any) => `${r.model}:${r.recordId}:${r.userId}:${r.holderKey}`);
const clear = () => raw.openRecord.deleteMany({});
const ago = (ms: number) => new Date(Date.now() - ms);

async function main() {
  let server: any;
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, raw, schema, () => {});
    setPrisma(raw);
    for (const [id, name] of [['U1', 'Иванов И. И.'], ['U2', 'Петрова А. А.'], ['U3', 'Сидоров С. С.']]) {
      await raw.user.create({ data: { id, symbol: `s-${id}`, password: 'x', name } });
    }

    // ── Числа, которые должны совпасть у сервера и окна
    check('удар окна 15 с, свежесть 90 с, не больше 50 записей', OPEN_BEAT_MS === 15_000 && OPEN_FRESH_MS === 90_000 && OPEN_MAX_RECORDS === 50);
    check('свежесть втрое больше удара: один пропущенный удар записи не освобождает', OPEN_FRESH_MS >= OPEN_BEAT_MS * 3);

    // ── Разбор присланного списка
    check('список: повторы схлопываются, лишние поля отбрасываются',
      JSON.stringify(parseOpenList([{ model: 'ComponentElement', id: 'A', x: 1 }, { model: 'ComponentElement', id: 'A' }])) === JSON.stringify([pos('A')]));
    check('список: пустой — это «ничего не держу», а не ошибка', JSON.stringify(parseOpenList([])) === '[]');
    check('список: модель не из перечня версионных — нечитаемо', parseOpenList([{ model: 'User', id: 'A' }]) === null);
    check('список: делегат клиента вместо имени модели — нечитаемо', parseOpenList([{ model: 'componentElement', id: 'A' }]) === null);
    check('список: пустой id и id не строкой — нечитаемо', parseOpenList([{ model: 'ComponentElement', id: ' ' }]) === null && parseOpenList([{ model: 'ComponentElement', id: 5 }]) === null);
    check('список: не массив — нечитаемо', parseOpenList({ model: 'ComponentElement', id: 'A' }) === null && parseOpenList(undefined) === null);
    check('список: 50 записей можно, 51 — нет',
      parseOpenList(Array.from({ length: 50 }, (_, i) => pos(`P${i}`)))?.length === 50 && parseOpenList(Array.from({ length: 51 }, (_, i) => pos(`P${i}`))) === null);

    // ── Запись полного списка окна
    console.log('\n── запись списка окна');
    await clear();
    await reportOpen(raw, { userId: 'U1', holderKey: 'window-U1-a', records: [pos('A'), pos('B'), sys('S1')] });
    check('окно назвало три записи — три строки', (await rowsOf('window-U1-a')).length === 3, await rowsOf());
    await reportOpen(raw, { userId: 'U1', holderKey: 'window-U1-a', records: [pos('A'), pos('B'), sys('S1')] });
    check('тот же список повторно — строк не прибавилось', (await rowsOf()).length === 3);
    const before = (await raw.openRecord.findFirst({ where: { recordId: 'A' } })).at as Date;
    await new Promise((r) => setTimeout(r, 15));
    await reportOpen(raw, { userId: 'U1', holderKey: 'window-U1-a', records: [pos('A')] });
    const after = (await raw.openRecord.findFirst({ where: { recordId: 'A' } })).at as Date;
    check('названной записи отметка обновилась', after.getTime() > before.getTime(), { before, after });
    check('не названные окном строки удалены', JSON.stringify(await rowsOf()) === JSON.stringify(['ComponentElement:A:U1:window-U1-a']), await rowsOf());

    await reportOpen(raw, { userId: 'U1', holderKey: 'window-U1-b', records: [pos('A'), pos('C')] });
    await reportOpen(raw, { userId: 'U2', holderKey: 'window-U2-a', records: [pos('A'), pos('D')] });
    await reportOpen(raw, { userId: 'U1', holderKey: 'window-U1-a', records: [pos('E')] });
    check('другие окна того же человека и чужие окна список не трогает',
      JSON.stringify(await rowsOf()) === JSON.stringify([
        'ComponentElement:A:U1:window-U1-b', 'ComponentElement:A:U2:window-U2-a', 'ComponentElement:C:U1:window-U1-b',
        'ComponentElement:D:U2:window-U2-a', 'ComponentElement:E:U1:window-U1-a',
      ]), await rowsOf());
    await reportOpen(raw, { userId: 'U1', holderKey: 'window-U1-a', records: [] });
    check('пустой список снимает всё, что держало окно', (await rowsOf('window-U1-a')).length === 0 && (await rowsOf()).length === 4, await rowsOf());

    // Чужой ключ окна: тот же ключ у другого человека не стирает и не присваивает чужие строки
    await reportOpen(raw, { userId: 'U3', holderKey: 'window-U2-a', records: [pos('Z')] });
    check('чужой ключ окна не стирает строки владельца ключа',
      (await rowsOf('window-U2-a')).filter((r: string) => r.includes(':U2:')).length === 2, await rowsOf());
    check('и не присваивает их себе', (await raw.openRecord.count({ where: { userId: 'U3', recordId: { in: ['A', 'D'] } } })) === 0);
    await reportOpen(raw, { userId: 'U3', holderKey: 'window-U2-a', records: [] });
    check('чужой ключ с пустым списком тоже ничего не стирает', (await rowsOf('window-U2-a')).filter((r: string) => r.includes(':U2:')).length === 2, await rowsOf());
    const stamped = ago(60_000);
    await raw.openRecord.updateMany({ where: { holderKey: 'window-U2-a', userId: 'U2' }, data: { at: stamped } });
    await reportOpen(raw, { userId: 'U3', holderKey: 'window-U2-a', records: [pos('A')] });
    const kept = (await raw.openRecord.findFirst({ where: { holderKey: 'window-U2-a', userId: 'U2', recordId: 'A' } })).at as Date;
    check('чужой ключ не освежает чужие отметки', kept.getTime() === stamped.getTime(), { kept, stamped });

    // ── Кто держит открытым
    console.log('\n── поиск открытых');
    await clear();
    await reportOpen(raw, { userId: 'U1', holderKey: 'window-U1-a', records: [pos('A'), sys('S1')] });
    await reportOpen(raw, { userId: 'U2', holderKey: 'window-U2-a', records: [pos('A'), pos('B')] });
    await reportOpen(raw, { userId: 'U2', holderKey: 'window-U2-b', records: [pos('A')] });
    const names = (hits: any[], id: string) => (hits.find((h) => h.id === id)?.holders || []).map((h: any) => `${h.userId}=${h.name}`).sort();

    const forU3 = await findOpen(raw, { userId: 'U3', records: [pos('A'), pos('B'), pos('X')] });
    check('открытые записи из списка найдены, прочих нет', forU3.map((h) => h.id).join() === 'A,B', forU3);
    check('имена людей — из карточки пользователя', JSON.stringify(names(forU3, 'A')) === JSON.stringify(['U1=Иванов И. И.', 'U2=Петрова А. А.']), forU3);
    check('два окна одного человека — он один раз', (forU3.find((h) => h.id === 'A')?.holders || []).length === 2);

    const forU1 = await findOpen(raw, { userId: 'U1', records: [pos('A'), sys('S1')] });
    check('свои окна не мешают: у себя держишь A, у другого человека тоже — виден только он',
      JSON.stringify(names(forU1, 'A')) === JSON.stringify(['U2=Петрова А. А.']) && !forU1.some((h) => h.id === 'S1'), forU1);
    check('модель различается: установка с тем же id — не позиция', (await findOpen(raw, { userId: 'U3', records: [sys('A')] })).length === 0);
    check('пустой список проверяемых — пустой ответ', (await findOpen(raw, { userId: 'U3', records: [] })).length === 0);
    check('название и порядок проверяемых сохраняются', (await findOpen(raw, { userId: 'U3', records: [{ ...pos('B'), name: 'Клапан' }, pos('A')] })).map((h) => `${h.id}:${h.name || ''}`).join() === 'B:Клапан,A:');

    // Свежесть: отметка старше 90 с не держит, 80 с — держит
    await raw.openRecord.updateMany({ where: { holderKey: 'window-U2-a', recordId: 'B' }, data: { at: ago(OPEN_FRESH_MS + 5_000) } });
    check('отметка старше 90 с запись не держит', (await findOpen(raw, { userId: 'U3', records: [pos('B')] })).length === 0);
    await raw.openRecord.updateMany({ where: { holderKey: 'window-U2-a', recordId: 'B' }, data: { at: ago(OPEN_FRESH_MS - 10_000) } });
    check('отметка 80 с назад ещё держит', (await findOpen(raw, { userId: 'U3', records: [pos('B')] })).length === 1);
    await raw.openRecord.updateMany({ where: { holderKey: 'window-U2-a' }, data: { at: ago(OPEN_FRESH_MS + 5_000) } });
    await raw.openRecord.updateMany({ where: { holderKey: 'window-U2-b' }, data: { at: ago(OPEN_FRESH_MS + 5_000) } });
    const stale = await findOpen(raw, { userId: 'U3', records: [pos('A')] });
    check('у записи остался только свежий держатель', JSON.stringify(names(stale, 'A')) === JSON.stringify(['U1=Иванов И. И.']), stale);

    // Уборка следов закрытых без прощания окон
    await raw.openRecord.create({ data: { model: 'ComponentElement', recordId: 'OLD', userId: 'U2', holderKey: 'window-old', at: ago(3 * 24 * 3600_000) } });
    await purgeStale(raw);
    check('следы суточной давности убираются, свежие остаются', (await rowsOf('window-old')).length === 0 && (await rowsOf()).length >= 3);

    // Большой список проверяемых: порциями, без потери записей
    await clear();
    await reportOpen(raw, { userId: 'U2', holderKey: 'window-U2-a', records: [pos('P49')] });
    const many = Array.from({ length: 1000 }, (_, i) => pos(`P${i}`));
    check('тысяча проверяемых записей — находится нужная', (await findOpen(raw, { userId: 'U1', records: many })).map((h) => h.id).join() === 'P49');

    // ── Маршруты
    console.log('\n── маршруты');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { const u = req.header('x-test-user'); if (u) (req as any).authUser = { id: u, name: u, role: 'ENGINEER_VENT', isActive: true }; next(); });
    registerOpenRecordRoutes(app);
    server = await new Promise<any>((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const call = async (method: string, body: unknown, user: string | null = 'U1') => {
      const r = await fetch(`${origin}/api/open-records`, {
        method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => null) as any };
    };

    await clear();
    let r = await call('PUT', { holderKey: 'window-route-1', records: [pos('A'), sys('S1')] });
    check('PUT: 200, сохранено две записи', r.status === 200 && r.body?.ok === true && r.body.count === 2, r);
    check('PUT: строки записаны на вошедшего', (await rowsOf()).every((x: string) => x.includes(':U1:window-route-1')) && (await rowsOf()).length === 2, await rowsOf());
    r = await call('POST', { holderKey: 'window-route-1', records: [] });
    check('POST (маяк при закрытии окна): тот же запрос, пустой список снимает всё', r.status === 200 && (await rowsOf()).length === 0, r);

    r = await call('PUT', { holderKey: 'window-route-1', records: [pos('A')] }, null);
    check('без входа — 401, ничего не записано', r.status === 401 && (await rowsOf()).length === 0, r);
    // Личность — из сессии, а не из тела: userId в теле не принимается
    r = await call('PUT', { holderKey: 'window-route-1', userId: 'U2', records: [pos('A')] }, 'U1');
    check('userId из тела игнорируется: запись на вошедшего', (await rowsOf())[0]?.includes(':U1:'), await rowsOf());
    await clear();

    for (const [label, body] of [
      ['модель не из перечня', { holderKey: 'window-route-1', records: [{ model: 'User', id: 'U1' }] }],
      ['51 запись', { holderKey: 'window-route-1', records: Array.from({ length: OPEN_MAX_RECORDS + 1 }, (_, i) => pos(`P${i}`)) }],
      ['записи не массивом', { holderKey: 'window-route-1', records: 'A' }],
      ['записей нет вовсе', { holderKey: 'window-route-1' }],
      ['ключ окна короткий', { holderKey: 'abc', records: [] }],
      ['ключ окна с пробелом', { holderKey: 'window route 1', records: [] }],
      ['ключа нет', { records: [] }],
    ] as Array<[string, any]>) {
      await reportOpen(raw, { userId: 'U1', holderKey: 'window-route-1', records: [pos('KEEP')] });
      r = await call('PUT', body);
      check(`${label} — 400, и уже записанное не снято`, r.status === 400 && typeof r.body?.error === 'string' && (await rowsOf()).length === 1, r);
    }
    r = await call('PUT', { holderKey: 'window-route-1', records: Array.from({ length: OPEN_MAX_RECORDS }, (_, i) => pos(`P${i}`)) });
    check('ровно 50 записей — принимается', r.status === 200 && (await rowsOf()).length === OPEN_MAX_RECORDS, r);

    // ── Таблицы нет (общая база старой версии): отметка создаёт её сама
    console.log('\n── таблицы нет');
    await raw.$executeRawUnsafe('DROP TABLE "OpenRecord"');
    await assert.rejects(findOpen(raw, { userId: 'U1', records: [pos('A')] }), undefined, 'без таблицы поиск должен бросать, решает вызывающий');
    check('поиск без таблицы бросает ошибку, а не отвечает «никто не держит»', true);
    r = await call('PUT', { holderKey: 'window-route-2', records: [pos('A')] });
    check('отметка без таблицы создаёт её и записывает', r.status === 200 && (await rowsOf()).length === 1, r);

    console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${checks})`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await raw.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
