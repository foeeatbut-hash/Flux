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
 *  • обычный путь (и клиент без ожидаемой версии) работает.
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
    const send = async (method: string, url: string, body?: any) => {
      const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    const newRegister = async () => (await send('POST', '/api/vdr/registers', { projectId: 'vdr-project', name: 'ВДР' })).body.register;
    const newItem = async (registerId: string, no: string) => (await send('POST', '/api/vdr/items', { registerId, contractorNo: no, titleRu: no })).body.item;
    const getItem = async (registerId: string, id: string) => (await send('GET', `/api/vdr/items?registerId=${registerId}`)).body.items.find((i: any) => i.id === id);
    const history = async (id: string) => (await send('GET', `/api/vdr/items/${id}/revisions`)).body.revisions as any[];

    const register = await newRegister();

    // ── Обычный путь ──
    const solo = await newItem(register.id, 'D-solo');
    const first = await send('POST', `/api/vdr/items/${solo.id}/issue-revision`, { kind: 'next', expectedRevision: 'A' });
    check('обычный выпуск с ожидаемой ревизией: A → B', first.status === 200 && first.body.item.revision === 'B', first.body);
    check('история после обычного выпуска — одна запись', (await history(solo.id)).length === 1);
    const second = await send('POST', `/api/vdr/items/${solo.id}/issue-revision`, { kind: 'next', expectedRevision: 'B' });
    check('следующий выпуск: B → C', second.status === 200 && second.body.item.revision === 'C', second.body);
    const noExpect = await send('POST', `/api/vdr/items/${solo.id}/issue-revision`, { kind: 'next' });
    check('клиент без ожидаемой версии, без гонки: работает как раньше (C → D)', noExpect.status === 200 && noExpect.body.item.revision === 'D', noExpect.body);

    // ── Устаревший выпуск ──
    const stale = await send('POST', `/api/vdr/items/${solo.id}/issue-revision`, { kind: 'next', expectedRevision: 'B' });
    check('выпуск по устаревшей ревизии — 409', stale.status === 409, stale.body);
    check('в отказе — понятный текст с номером ревизии и текущая строка',
      /D/.test(stale.body.error) && /уже выпущен|уже выпустил/.test(stale.body.error) && stale.body.current?.item?.revision === 'D', stale.body);
    check('отказ ничего не записал: ревизия D, в истории три записи', (await getItem(register.id, solo.id)).revision === 'D' && (await history(solo.id)).length === 3);

    // ── Два параллельных выпуска одной строки ──
    for (let round = 1; round <= 5; round++) {
      const it = await newItem(register.id, `D-race-${round}`);
      const results = await Promise.all([
        send('POST', `/api/vdr/items/${it.id}/issue-revision`, { kind: 'next', expectedRevision: 'A' }),
        send('POST', `/api/vdr/items/${it.id}/issue-revision`, { kind: 'next', expectedRevision: 'A' }),
      ]);
      const codes = results.map((r) => r.status).sort();
      check(`гонка ${round}: один выпуск 200 и один отказ 409`, codes[0] === 200 && codes[1] === 409, results.map((r) => [r.status, r.body.error]));
      const rows = await history(it.id);
      check(`гонка ${round}: ревизия B, в истории ровно одна запись B`, (await getItem(register.id, it.id)).revision === 'B' && rows.length === 1 && rows[0].revision === 'B', rows);
    }

    // Клиент без ожидаемой версии в гонке не получает двух одинаковых номеров
    // и не теряет записи истории: каждая успешная запись — своя ревизия
    {
      const it = await newItem(register.id, 'D-race-old');
      const results = await Promise.all(Array.from({ length: 4 }, () => send('POST', `/api/vdr/items/${it.id}/issue-revision`, { kind: 'next' })));
      const ok = results.filter((r) => r.status === 200);
      const rows = await history(it.id);
      check('старые клиенты в гонке: каждый ответ 200 или 409, без 500', results.every((r) => r.status === 200 || r.status === 409), results.map((r) => r.status));
      check('старые клиенты в гонке: запись истории на каждый успех, номера разные',
        rows.length === ok.length && new Set(rows.map((r) => r.revision)).size === rows.length, { rows: rows.map((r) => r.revision), ok: ok.length });
      check('старые клиенты в гонке: ревизия строки — последняя из истории', (await getItem(register.id, it.id)).revision === rows[rows.length - 1].revision);
    }

    // ── PUT строки ──
    const row = await newItem(register.id, 'D-put');
    const seen = await getItem(register.id, row.id);
    const put1 = await send('PUT', `/api/vdr/items/${row.id}`, { titleRu: 'Первое', expectedUpdatedAt: seen.updatedAt });
    check('PUT с актуальной версией проходит и отдаёт новую updatedAt', put1.status === 200 && put1.body.item.titleRu === 'Первое' && put1.body.item.updatedAt !== seen.updatedAt, put1.body);
    const put2 = await send('PUT', `/api/vdr/items/${row.id}`, { titleRu: 'Устаревшее', expectedUpdatedAt: seen.updatedAt });
    check('PUT по устаревшей версии — 409 с текущей строкой', put2.status === 409 && put2.body.current?.item?.titleRu === 'Первое', put2.body);
    check('устаревший PUT ничего не записал', (await getItem(register.id, row.id)).titleRu === 'Первое');
    const put3 = await send('PUT', `/api/vdr/items/${row.id}`, { titleEn: 'Old client' });
    check('PUT без ожидаемой версии (старый клиент) сливает поля как раньше', put3.status === 200 && put3.body.item.titleEn === 'Old client' && put3.body.item.titleRu === 'Первое', put3.body);

    // Карточка старого клиента шлёт и ревизию, которую видела: затереть ею
    // выпущенную нельзя
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
    check('revision-up по устаревшей ревизии — 409 с текстом и текущим реестром', regStale.status === 409 && /B/.test(regStale.body.error) && regStale.body.current?.register?.revision === 'B', regStale.body);
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
    check('PUT реестра по устаревшей версии — 409 с текущим реестром', rp2.status === 409 && rp2.body.current?.register?.vendor === 'Поставщик 1', rp2.body);
    const rp3 = await send('PUT', `/api/vdr/registers/${reg.id}`, { owner: 'Заказчик' });
    check('PUT реестра без версии (старый клиент) сливает поля', rp3.status === 200 && rp3.body.register.owner === 'Заказчик' && rp3.body.register.vendor === 'Поставщик 1', rp3.body);
    const rp4 = await send('PUT', `/api/vdr/registers/${reg.id}`, { revisions: [], revision: 'A' });
    const regNow = (await send('GET', `/api/vdr/registers?projectId=vdr-project`)).body.registers.find((r: any) => r.id === reg.id);
    check('PUT реестра не стирает историю ревизий и не откатывает ревизию', regNow.revision === 'B' && regNow.revisions.length === 1 && rp4.status === 409, { rp4: rp4.status, regNow: regNow.revisions });

    console.log('\nВДР: одновременные записи — все проверки пройдены');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
