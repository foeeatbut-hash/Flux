/**
 * Журнал изменений в маршрутах (server/changeFeed.ts, server/changeFeedRead.ts):
 * «кто изменил» в отказе по версии и «кто создал и когда» (GET /api/record-origin).
 *
 * Настоящая SQLite-база, настоящие маршруты на настоящем express, клиент базы собран как на
 * сервере (`withChangeFeed` + рост версии). Звено входа повторяет server.ts: личность —
 * в `authUser` и в `runWithActor`, поэтому автор в журнале — тот, кто прислал запрос.
 *
 *  • отказ по версии (правка и удаление проекта, правка пункта справочника) несёт
 *    `changedBy: { userId, name, at }` — последнего автора записи из журнала, а не свой;
 *  • запись «системы» (без автора) и запись до журнала — `changedBy: null`, отказ тот же;
 *  • удаление пункта справочника с потомками и проекта с содержимым оставляет строки удаления
 *    детей — от имени удалившего;
 *  • record-origin: автор и время из строки `create`; запись до журнала — из колонок
 *    `createdAt`/`createdById`; нет записи — пусто; чужая закрытая запись — 404; чужая модель — 400.
 *
 * Мутация, которой набор проверен: убрать `changedBy` из ответа `sendVersionConflict` (или не
 * дополнять отказ в guardedWrite/guardedDelete) — набор падает.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma, setBroadcaster } from '../server/context.js';
import { setDialect } from '../server/ddl.js';
import { withVersionBump } from '../server/versionBump.js';
import { prepareChangeFeed, runWithActor, withChangeFeed } from '../server/changeFeed.js';
import { registerProjectRoutes } from '../server/routes/projects.js';
import { registerDictionaryRoutes } from '../server/routes/dictionaries.js';
import { registerRecordOriginRoutes } from '../server/routes/recordOrigin.js';
import { ensureOpenTable } from '../server/openRecords.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-change-feed-routes-'));
const dbPath = path.join(root, 'fixture.sqlite');
const raw = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 900)}`}`);
  checks++;
  console.log(`✓ ${label}`);
};

const PEOPLE: Record<string, { name: string; role: string }> = {
  'u-petrova': { name: 'Петрова А. А.', role: 'ADMIN' },
  'u-sidorov': { name: 'Сидоров С. С.', role: 'USER' },
  'u-ivanov': { name: 'Иванов И. И.', role: 'ADMIN' },
};

async function main() {
  let server: any;
  try {
    setDialect('sqlite');
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, raw, schema, () => {});
    const db = withChangeFeed(raw, (c: any) => withVersionBump(c));
    await prepareChangeFeed(db);
    setPrisma(db);
    await ensureOpenTable(raw);
    setBroadcaster(() => {});
    for (const [id, p] of Object.entries(PEOPLE)) await raw.user.create({ data: { id, symbol: `s-${id}`, password: 'x', name: p.name } });

    // Данные, заведённые «до журнала» (мимо расширения)
    await raw.project.create({ data: { id: 'P1', name: 'Проект Один' } });
    await raw.project.create({ data: { id: 'P2', name: 'Проект Два' } });
    await raw.tag.create({ data: { id: 'T-old', identifier: 'OLD-1', projectId: 'P1', codeKey: 'OLD-1', createdAt: new Date('2026-01-05T10:00:00Z') } });
    await raw.equipmentSystem.create({ data: { id: 'S1', name: 'SYS-1', projectId: 'P1' } });
    await raw.monoblock.create({ data: { id: 'M1', name: 'Блок 1', systemId: 'S1' } });
    await raw.componentElement.create({ data: { id: 'C-old', name: 'Вентилятор', itemCode: 'FAN-1', monoblockId: 'M1', createdById: 'u-ivanov', createdAt: new Date('2026-02-06T11:00:00Z') } });
    await raw.dictionary.create({ data: { id: 'D1', projectId: 'P1', name: 'Прочий' } });
    const item = (id: string, parentId: string | null, nameRu: string) => raw.dictionaryItem.create({ data: { id, dictionaryId: 'D1', code: id, nameRu, parentId } });
    await item('cat-a', null, 'Категория А');
    await item('opt-a1', 'cat-a', 'Вариант 1');
    await item('opt-a2', 'cat-a', 'Вариант 2');
    await item('sub-a2x', 'opt-a2', 'Вложенный');
    await raw.projectMember.create({ data: { projectId: 'P2', userId: 'u-petrova' } });

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    // Звено входа, как в server.ts: личность из сессии и автор для журнала
    app.use((req, res, next) => {
      const id = req.header('x-test-user') || 'u-petrova';
      const p = PEOPLE[id];
      (req as any).authUser = { id, name: p.name, role: p.role, isActive: true };
      return runWithActor({ userId: id, userName: p.name }, next);
    });
    registerProjectRoutes(app, { enforce: async () => true, notifyAll: async () => {} });
    registerDictionaryRoutes(app);
    registerRecordOriginRoutes(app);
    server = await new Promise<any>((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = async (method: string, url: string, body?: unknown, as?: string) => {
      const r = await fetch(`${origin}${url}`, {
        method, headers: { 'content-type': 'application/json', ...(as ? { 'x-test-user': as } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { json = { text }; }
      return { status: r.status, body: json };
    };
    const nearNow = (iso: string) => Math.abs(Date.now() - new Date(iso).getTime()) < 120_000;

    // ── Отказ по версии: «кто изменил» ──
    console.log('\n── отказ по версии');
    {
      const seen = (await raw.project.findUnique({ where: { id: 'P1' } })).version;
      const ok = await send('PUT', '/api/projects/P1', { name: 'Правка Петровой', expectedVersion: seen }, 'u-petrova');
      check('правка Петровой по своей версии — 200', ok.status === 200, ok);
      const stale = await send('PUT', '/api/projects/P1', { name: 'Затираю', expectedVersion: seen }, 'u-sidorov');
      check('проект: чужая версия — 409 с кодом и текущей записью', stale.status === 409 && stale.body.code === 'VERSION_CONFLICT' && stale.body.current?.name === 'Правка Петровой', stale);
      check('проект: changedBy — Петрова, а не Сидоров (кто отказан)',
        stale.body.changedBy?.userId === 'u-petrova' && stale.body.changedBy?.name === 'Петрова А. А.', stale.body.changedBy);
      check('проект: changedBy.at — время правки в ISO', typeof stale.body.changedBy?.at === 'string' && nearNow(stale.body.changedBy.at), stale.body.changedBy);

      // Следующим правит Иванов — в отказе уже он
      const v2 = (await raw.project.findUnique({ where: { id: 'P1' } })).version;
      await send('PUT', '/api/projects/P1', { description: 'от Иванова', expectedVersion: v2 }, 'u-ivanov');
      const stale2 = await send('PUT', '/api/projects/P1', { name: 'Опять затираю', expectedVersion: v2 }, 'u-sidorov');
      check('проект: после правки Иванова в отказе Иванов', stale2.status === 409 && stale2.body.changedBy?.userId === 'u-ivanov' && stale2.body.changedBy?.name === 'Иванов И. И.', stale2.body.changedBy);

      const del = await send('DELETE', `/api/projects/P1?expectedVersion=${v2}`, undefined, 'u-sidorov');
      check('удаление проекта по чужой версии — 409 с changedBy', del.status === 409 && del.body.changedBy?.userId === 'u-ivanov' && del.body.code === 'VERSION_CONFLICT', del);
      check('проект цел после отказа', !!(await raw.project.findUnique({ where: { id: 'P1' } })));

      // Правка пункта справочника
      const catV = (await raw.dictionaryItem.findUnique({ where: { id: 'cat-a' } })).version;
      const itemOk = await send('PUT', '/api/dictionaries/items/cat-a', { nameRu: 'Категория А (Петрова)', expectedVersion: catV }, 'u-petrova');
      check('пункт: правка Петровой — 200', itemOk.status === 200, itemOk);
      const itemStale = await send('PUT', '/api/dictionaries/items/cat-a', { nameRu: 'Не пройдёт', expectedVersion: catV }, 'u-sidorov');
      check('пункт: чужая версия — 409 с changedBy Петровой', itemStale.status === 409 && itemStale.body.changedBy?.userId === 'u-petrova', itemStale);
      const itemDelStale = await send('DELETE', `/api/dictionaries/items/cat-a?expectedVersion=${catV}`, undefined, 'u-sidorov');
      check('пункт: удаление по чужой версии — 409 с changedBy, потомки целы', itemDelStale.status === 409 && itemDelStale.body.changedBy?.userId === 'u-petrova' && (await raw.dictionaryItem.count({ where: { dictionaryId: 'D1' } })) === 4, itemDelStale);

      // Запись «системы» (вне запроса): автора нет — changedBy null, отказ прежний
      const sysV = (await raw.dictionaryItem.findUnique({ where: { id: 'opt-a1' } })).version;
      await db.dictionaryItem.update({ where: { id: 'opt-a1' }, data: { nameRu: 'Системная правка' } });
      const sysStale = await send('PUT', '/api/dictionaries/items/opt-a1', { nameRu: 'Не пройдёт', expectedVersion: sysV }, 'u-sidorov');
      check('запись без автора («система»): 409, changedBy null', sysStale.status === 409 && sysStale.body.changedBy === null && sysStale.body.code === 'VERSION_CONFLICT', sysStale);

      // Запись, заведённая до журнала: строк нет — changedBy null
      await raw.dictionaryItem.update({ where: { id: 'opt-a2' }, data: { version: { increment: 1 } } });
      const oldStale = await send('PUT', '/api/dictionaries/items/opt-a2', { nameRu: 'Не пройдёт', expectedVersion: 1 }, 'u-sidorov');
      check('запись до журнала: 409, changedBy null', oldStale.status === 409 && oldStale.body.changedBy === null, oldStale);
    }

    // ── Каскады: строки удаления детей ──
    console.log('\n── каскады');
    {
      const cat = await raw.dictionaryItem.findUnique({ where: { id: 'cat-a' } });
      const del = await send('DELETE', `/api/dictionaries/items/cat-a?expectedVersion=${cat.version}`, undefined, 'u-ivanov');
      check('пункт справочника с потомками удалён', del.status === 200 && (await raw.dictionaryItem.count({ where: { dictionaryId: 'D1' } })) === 0, del);
      const rows = await raw.changeFeed.findMany({ where: { model: 'DictionaryItem', kind: 'delete' }, orderBy: { seq: 'asc' } });
      check('журнал: строки удаления пункта и всех трёх потомков, от Иванова, с проектом',
        JSON.stringify(rows.map((r: any) => r.recordId).sort()) === JSON.stringify(['cat-a', 'opt-a1', 'opt-a2', 'sub-a2x'])
        && rows.every((r: any) => r.userId === 'u-ivanov' && r.projectId === 'P1'), rows);

      const p2 = await raw.project.findUnique({ where: { id: 'P2' } });
      await raw.tag.create({ data: { id: 'T2', identifier: 'P2-1', projectId: 'P2', codeKey: 'P2-1' } });
      const p1 = await raw.project.findUnique({ where: { id: 'P1' } });
      const delProject = await send('DELETE', `/api/projects/P1?expectedVersion=${p1.version}`, undefined, 'u-ivanov');
      check('проект со всем содержимым удалён', delProject.status === 200 && !(await raw.project.findUnique({ where: { id: 'P1' } })) && !(await raw.tag.findUnique({ where: { id: 'T-old' } })), delProject);
      const del2 = await raw.changeFeed.findMany({ where: { kind: 'delete', recordId: { in: ['P1', 'T-old', 'S1', 'M1', 'C-old', 'D1'] } } });
      check('журнал: удаление проекта, тега, установки, моноблока, позиции и справочника — от Иванова',
        del2.length === 6 && del2.every((r: any) => r.userId === 'u-ivanov' && r.projectId === 'P1'), del2.map((r: any) => `${r.model}:${r.recordId}`));
      check('чужой проект P2 журналом удаления не затронут', (await raw.changeFeed.count({ where: { projectId: 'P2', kind: 'delete' } })) === 0 && !!p2);
    }

    // ── record-origin ──
    console.log('\n── record-origin');
    {
      await send('POST', '/api/projects/P2/dictionaries/D3/items', { code: 'x', nameRu: 'x' }, 'u-petrova'); // справочника нет — 404, ничего не создаёт
      await raw.dictionary.create({ data: { id: 'D3', projectId: 'P2', name: 'Прочий' } });
      const made = await send('POST', '/api/projects/P2/dictionaries/D3/items', { code: 'n1', nameRu: 'Новый пункт' }, 'u-petrova');
      const newId = made.body?.item?.id as string;
      check('пункт создан Петровой через маршрут', made.status === 200 && !!newId, made);
      const o = await send('GET', `/api/record-origin?model=DictionaryItem&id=${encodeURIComponent(newId)}`, undefined, 'u-petrova');
      check('record-origin: автор и время — из строки create журнала',
        o.status === 200 && o.body.createdBy?.userId === 'u-petrova' && o.body.createdBy?.name === 'Петрова А. А.' && nearNow(o.body.createdAt) && Object.keys(o.body).sort().join() === 'createdAt,createdBy', o);

      // Заведена до журнала: колонки записи
      await raw.project.create({ data: { id: 'P3', name: 'Три' } });
      await raw.componentElement.create({ data: { id: 'C-old2', name: 'Насос', itemCode: 'PUMP-1', monoblockId: 'M-none', createdById: 'u-ivanov', createdAt: new Date('2026-02-06T11:00:00Z') } });
      const col = await send('GET', '/api/record-origin?model=ComponentElement&id=C-old2', undefined, 'u-petrova');
      check('record-origin: запись до журнала — из колонок createdAt и createdById', col.status === 200 && col.body.createdBy?.userId === 'u-ivanov' && col.body.createdBy?.name === 'Иванов И. И.' && col.body.createdAt === '2026-02-06T11:00:00.000Z', col);
      const tag = await send('GET', '/api/record-origin?model=Tag&id=T2', undefined, 'u-petrova');
      check('record-origin: тег без createdById — время есть, автора нет', tag.status === 200 && tag.body.createdBy === null && typeof tag.body.createdAt === 'string', tag);
      const none = await send('GET', '/api/record-origin?model=Tag&id=нет-такого', undefined, 'u-petrova');
      check('record-origin: записи нет нигде — 200 и пусто', none.status === 200 && none.body.createdBy === null && none.body.createdAt === null, none);

      const bad = await send('GET', '/api/record-origin?model=User&id=u-petrova', undefined, 'u-petrova');
      check('record-origin: модель не из перечня — 400', bad.status === 400, bad);
      const noId = await send('GET', '/api/record-origin?model=Tag', undefined, 'u-petrova');
      check('record-origin: без id — 400', noId.status === 400, noId);
      // Проект P2 закрыт составом (в нём только Петрова): Сидоров (не администратор) записи не видит
      const hidden = await send('GET', `/api/record-origin?model=DictionaryItem&id=${encodeURIComponent(newId)}`, undefined, 'u-sidorov');
      check('record-origin: запись закрытого проекта чужому — 404, без автора', hidden.status === 404 && !hidden.body.createdBy, hidden);
    }
    console.log(`\nЖурнал изменений в маршрутах: ${checks} проверок пройдено`);
  } finally {
    server?.close();
    await raw.$disconnect().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
