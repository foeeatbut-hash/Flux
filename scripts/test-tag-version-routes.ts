/**
 * Сверка версии и отказ общего вида в маршрутах тегов
 * (.claude/progress/tags-vdr-version.md, «Теги, сервер»; общее место —
 * docs/methodology/03-programs/shell.md, «Отказ записи»).
 *
 * Настоящая SQLite-база (таблицы из schema.prisma), настоящие маршруты на настоящем
 * express, клиент базы — `withVersionBump(raw)`, как на сервере; действуют двое
 * (заголовок `x-test-user`). После КАЖДОГО отказа сравнивается весь мир: теги, позиции,
 * связи, история изменений тега — ни одной лишней записи.
 *
 *  • PUT /api/tags/:id и PATCH /api/tags/:id/procurement: чужая версия — 409 с `code` и
 *    `current` (голая запись тега), текст из словаря без кода, старых полей (`conflict`, `tag`)
 *    нет; тега нет — 404 `RECORD_GONE`; перенос карточки версию не сверяет; занятый код
 *    по-прежнему `duplicate`;
 *  • DELETE /api/tags/:id: `?expectedVersion=` (целая версия), открытый у коллеги тег не
 *    удаляется (`RECORD_OPEN`), дочерние теги и открытые позиции удалению не мешают (они
 *    остаются), «нет записи» — 200 `alreadyGone`, история и рост версии позиции — в той же
 *    транзакции (сломали историю — тег цел);
 *  • PUT /api/tags/bulk-metadata: версии по записям, «всё или ничего», в отказе `changed` и
 *    `gone` по всем записям (а не по первой), перенос карточек без сверки, свыше 2000 — 400.
 *
 * Мутации, которыми набор проверен (каждая роняет его): убрать сверку версии у удаления; убрать
 * `openCheck` у удаления; удаление без записи истории; удаление без роста версии позиций; «нет
 * записи» при удалении — 404; PUT и PATCH закупки — отказ прежнего вида (без `code`/`current`) или
 * без общего ответа; раскладка проверяет версию; «тега нет» без кода; пачка записывает часть при
 * отказе; удалённый тег в пачке молча пропускается; в отказе пачки только первая запись или нет
 * `current`; версии записей пачки не читаются; молчаливый срез 2000 вместо 400; повтор id принят.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma } from '../server/context.js';
import { withVersionBump } from '../server/versionBump.js';
import { registerTagRoutes } from '../server/routes/tags.js';
import { registerTagProcurementRoutes } from '../server/routes/tagProcurement.js';
import { ensureOpenTable } from '../server/openRecords.js';
import { editChangedText, editGoneText, deleteChangedText, deleteOpenText, bulkChangedText } from '../src/lib/refusalTexts.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-tag-version-routes-'));
const dbPath = path.join(root, 'fixture.sqlite');
const raw = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 900)}`}`);
  checks++;
  console.log(`✓ ${label}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Всё, чего могут коснуться маршруты тегов: сравнение «до и после» ловит любую лишнюю запись. */
async function world() {
  const history = await raw.$queryRawUnsafe('SELECT "id","tagId","kind","field" FROM "TagChange" ORDER BY "id"').catch(() => []);
  return {
    tags: await raw.tag.findMany({ orderBy: { id: 'asc' } }),
    components: await raw.componentElement.findMany({ orderBy: { id: 'asc' }, include: { tags: { select: { id: true }, orderBy: { id: 'asc' } } } }),
    links: await raw.$queryRawUnsafe('SELECT * FROM "_ComponentElementToTag" ORDER BY "A","B"'),
    history,
  };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const META = (o: unknown) => JSON.stringify(o);
const metaOf = (t: any) => JSON.parse(t?.metadata || '{}');

async function seed() {
  await raw.$executeRawUnsafe('DELETE FROM "_ComponentElementToTag"');
  await raw.componentElement.deleteMany({});
  await raw.monoblock.deleteMany({});
  await raw.equipmentSystem.deleteMany({});
  await raw.tag.deleteMany({});
  await raw.$executeRawUnsafe('DELETE FROM "TagChange"').catch(() => null);
  await raw.openRecord.deleteMany({});
  await raw.equipmentSystem.create({ data: { id: 'S1', name: 'SYS-1', projectId: 'p1' } });
  await raw.monoblock.create({ data: { id: 'M1', name: 'M1', systemId: 'S1' } });
  await raw.componentElement.create({ data: { id: 'C1', name: 'Вентилятор', itemCode: 'FAN-1', monoblockId: 'M1', role: 'ВЕНТИЛЯТОР', version: 4 } });
  // Версии тегов разные — случайное совпадение «updatedAt/version» не пройдёт
  const mk = (id: string, identifier: string, version: number, metadata?: unknown) =>
    raw.tag.create({ data: { id, identifier, projectId: 'p1', codeKey: identifier, version, ...(metadata ? { metadata: META(metadata) } : {}) } });
  await mk('T1', 'AHU-1', 3, { descriptions: ['первое'], procurement: { stage: 'draft' }, x: 10, y: 20 });
  await mk('T2', 'AHU-2', 5, { mainName: 'Второй' });
  await mk('T3', 'AHU-3', 2, { mainName: 'Третий' });
  // Дочерний тег: родитель лежит в metadata, а не в связи схемы
  await mk('T4', 'AHU-1.1', 1, { parentId: 'T1', mainName: 'Дочерний' });
  await raw.componentElement.update({ where: { id: 'C1' }, data: { tags: { connect: { id: 'T1' } } } });
  await raw.componentElement.updateMany({ where: { id: 'C1' }, data: { version: 4 } });
  await sleep(5);
}

async function main() {
  let server: any;
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, raw, schema, () => {});
    setPrisma(withVersionBump(raw));
    await ensureOpenTable(raw);
    await raw.project.create({ data: { id: 'p1', name: 'P1' } });
    for (const [id, name] of [['u-petrova', 'Петрова А. А.'], ['u-sidorov', 'Сидоров С. С.']]) await raw.user.create({ data: { id, symbol: `s-${id}`, password: 'x', name } });

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, _res, next) => { (req as any).authUser = { id: req.header('x-test-user') || 'fixture-user', name: 'Инженер', role: 'ADMIN', isActive: true }; next(); });
    registerTagRoutes(app, { io: {} as any, notifyAll: async () => {} });
    registerTagProcurementRoutes(app);
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
    const row = (id: string) => raw.tag.findUnique({ where: { id } });
    const upd = (t: any) => (t?.updatedAt ? new Date(t.updatedAt).toISOString() : null);
    /** «Коллега поправил тег»: настоящий маршрут от другого человека, версия тега уходит вперёд */
    const colleagueEdits = async (id: string, patch: Record<string, unknown> = { department: 'ОВ' }) => {
      await sleep(5);
      const r = await send('PUT', `/api/tags/${id}`, patch, 'u-petrova');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await sleep(5);
    };
    const isPlainRefusal = (b: any) => typeof b?.error === 'string' && /[а-яё]{4,}/i.test(b.error) && !/VERSION_CONFLICT|RECORD_/.test(b.error)
      && !('conflict' in b) && !('tag' in b);

    // ───────────────────────── PUT и PATCH закупки ─────────────────────────
    for (const kind of ['PUT', 'PATCH'] as const) {
      const url = (id: string) => (kind === 'PUT' ? `/api/tags/${id}` : `/api/tags/${id}/procurement`);
      const body = (version: unknown) => (kind === 'PUT'
        ? { department: 'Цех-1', version }
        : { procurement: { stage: 'ordered' }, version });
      const wrote = (t: any) => (kind === 'PUT' ? t.department === 'Цех-1' : metaOf(t).procurement?.stage === 'ordered');
      const tag = kind === 'PUT' ? 'PUT /api/tags/:id' : 'PATCH /api/tags/:id/procurement';
      console.log(`\n── ${tag}`);

      await seed();
      const seen = upd(await row('T1'));
      await colleagueEdits('T1');
      let before = await world();
      const stale = await send(kind, url('T1'), body(seen));
      check(`${tag}: чужая версия — 409 с кодом отдельным полем`, stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT', stale);
      check(`${tag}: текст — из словаря, с названием тега, без кода и старых полей`, stale.body?.error === editChangedText('tag', 'AHU-1') && isPlainRefusal(stale.body), stale.body);
      const now = await row('T1');
      check(`${tag}: в отказе голая текущая запись тега (с версией и metadata строкой)`,
        stale.body?.current?.id === 'T1' && stale.body.current.version === now.version && typeof stale.body.current.metadata === 'string'
        && stale.body.current.department === 'ОВ' && stale.body.current.identifier === 'AHU-1', stale.body?.current);
      check(`${tag}: чужая версия — в базе не изменилось ничего (и история)`, same(before, await world()));

      const ok = await send(kind, url('T1'), body(upd(await row('T1'))));
      check(`${tag}: своя версия — 200 и запись применена`, ok.status === 200 && wrote(ok.body.tag) && wrote(await row('T1')), ok);
      check(`${tag}: своя версия — целая версия тега выросла`, (await row('T1')).version === now.version + 1);

      await seed();
      const noVersion = await send(kind, url('T1'), kind === 'PUT' ? { department: 'Цех-1' } : { procurement: { stage: 'ordered' } });
      check(`${tag}: без версии (клиент без сверки) — 200`, noVersion.status === 200 && wrote(await row('T1')), noVersion);

      await seed();
      const seenBeforeDelete = upd(await row('T2'));
      await raw.tag.delete({ where: { id: 'T2' } });
      before = await world();
      const gone = await send(kind, url('T2'), body(seenBeforeDelete));
      check(`${tag}: тега нет — 404 с кодом RECORD_GONE`, gone.status === 404 && gone.body?.code === 'RECORD_GONE', gone);
      check(`${tag}: тега нет — текст словаря без кода`, gone.body?.error === editGoneText('tag') && isPlainRefusal(gone.body), gone.body);
      check(`${tag}: тега нет — в базе не изменилось ничего`, same(before, await world()));
    }

    console.log('\n── PUT: раскладка и занятый код');
    {
      await seed();
      const seen = upd(await row('T1'));
      await colleagueEdits('T1');
      const v = (await row('T1'));
      const layout = await send('PUT', '/api/tags/T1', { metadata: { x: 640, y: 480, _noPos: false }, version: seen });
      const after = await row('T1');
      check('перенос карточки со старой версией проходит (x, y записаны)', layout.status === 200 && metaOf(after).x === 640 && metaOf(after).y === 480, layout);
      check('перенос карточки не двигает ни версию, ни updatedAt', after.version === v.version && upd(after) === upd(v), [after.version, v.version]);
      const before = await world();
      const dup = await send('PUT', '/api/tags/T1', { identifier: 'ahu-2', version: upd(await row('T1')) });
      check('занятый код — по-прежнему 409 duplicate (не конфликт версий)', dup.status === 409 && dup.body?.duplicate === true && dup.body?.existing?.id === 'T2' && dup.body?.code !== 'VERSION_CONFLICT', dup);
      check('занятый код — в базе не изменилось ничего', same(before, await world()));
    }

    // ───────────────────────── DELETE ─────────────────────────
    console.log('\n── DELETE /api/tags/:id');
    const del = (id: string, version?: unknown, as?: string) =>
      send('DELETE', `/api/tags/${id}${version === undefined ? '' : `?expectedVersion=${encodeURIComponent(String(version))}`}`, undefined, as);
    const holds = (userId: string, model: string, recordId: string, at: Date = new Date()) =>
      raw.openRecord.create({ data: { model, recordId, userId, holderKey: `window-${userId}`, at } });
    const petrova = [{ userId: 'u-petrova', name: 'Петрова А. А.' }];
    const open409 = (r: { status: number; body: any }) => r.status === 409 && r.body?.code === 'RECORD_OPEN';
    {
      await seed();
      const v = (await row('T1')).version;
      let before = await world();
      const stale = await del('T1', v - 1);
      check('удаление: чужая версия — 409 VERSION_CONFLICT', stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT', stale);
      check('удаление: текст словаря (удаление изменённого), в отказе текущая запись', stale.body?.error === deleteChangedText('tag', 'AHU-1') && isPlainRefusal(stale.body)
        && stale.body?.current?.id === 'T1' && stale.body.current.version === v, stale.body);
      check('удаление: чужая версия — в базе не изменилось ничего (тег, связь, версия позиции, история)', same(before, await world()));
      for (const bad of ['abc', 0, -3, 1.5]) {
        const r = await del('T1', bad);
        check(`удаление: версия ${JSON.stringify(bad)} — 400`, r.status === 400 && typeof r.body?.error === 'string', r);
      }
      check('удаление: нечитаемая версия — в базе не изменилось ничего', same(before, await world()));

      before = await world();
      const ok = await del('T1', v);
      const after = await world();
      check('удаление: своя версия — 200 {success}', ok.status === 200 && ok.body?.success === true && !ok.body?.alreadyGone, ok);
      check('удаление: тега нет, связь с позицией снята', !(await row('T1')) && after.links.length === 0, after.links);
      check('удаление: версия позиции, державшей тег, выросла на 1', after.components[0].version === before.components[0].version + 1, [after.components[0].version, before.components[0].version]);
      const hist = after.history.filter((h: any) => h.tagId === 'T1');
      check('удаление: в истории одна строка «удалён»', hist.length === 1 && hist[0].kind === 'удалён', hist);
      check('удаление: дочерний и соседние теги остались нетронутыми',
        same(before.tags.filter((t: any) => t.id !== 'T1'), after.tags), after.tags.map((t: any) => t.id));
      check('удаление: у дочернего тега родитель в metadata остался как был (снимает его экран, не сервер)', metaOf(await row('T4')).parentId === 'T1');

      const again = await del('T1', v);
      check('повторное удаление — 200 alreadyGone, а не ошибка', again.status === 200 && again.body?.alreadyGone === true, again);
      check('повторное удаление — истории не прибавилось', same(after.history, (await world()).history));
      const noRecord = await del('T-нет', 3);
      check('записи с таким id нет — 200 alreadyGone', noRecord.status === 200 && noRecord.body?.alreadyGone === true, noRecord);
    }
    {
      await seed();
      const r = await del('T2');
      check('удаление без версии (клиент без сверки) — 200', r.status === 200 && !(await row('T2')), r);
    }
    {
      await seed();
      await colleagueEdits('T2');
      const r = await del('T2', 5);
      check('удаление: версия до правки коллеги — 409 и тег цел', r.status === 409 && r.body?.code === 'VERSION_CONFLICT' && !!(await row('T2')), r);
    }
    {
      // Гонка: два удаления с одной версией — ровно одно удалило, второе узнало «уже нет» или отказ
      await seed();
      const v = (await row('T3')).version;
      const [a, b] = await Promise.all([del('T3', v), del('T3', v)]);
      const wins = [a, b].filter((r) => r.status === 200 && !r.body?.alreadyGone).length;
      check('два удаления с одной версией: удалило ровно одно, тега нет', wins === 1 && !(await row('T3')), [a, b]);
      check('два удаления: в истории одна строка «удалён»', (await world()).history.filter((h: any) => h.tagId === 'T3' && h.kind === 'удалён').length === 1);
    }
    console.log('\n── DELETE: открытые записи, два человека');
    {
      await seed();
      await holds('u-petrova', 'Tag', 'T1');
      const before = await world();
      const r = await del('T1', (await row('T1')).version);
      check('тег открыт у коллеги: 409 RECORD_OPEN', open409(r), r);
      check('тег открыт у коллеги: держатель и запись названы',
        same(r.body?.holders, petrova) && same(r.body?.record, { model: 'Tag', id: 'T1', name: 'AHU-1' }), r.body);
      check('тег открыт у коллеги: текст словаря, без кода', r.body?.error === deleteOpenText('tag', 'AHU-1', petrova) && !/RECORD_OPEN/.test(r.body?.error), r.body?.error);
      check('тег открыт у коллеги: в базе не изменилось ничего', same(before, await world()));
      const noVersion = await del('T1');
      check('открыт у коллеги: и без версии удаление не проходит', open409(noVersion) && same(before, await world()), noVersion);
      const stale = await del('T1', (await row('T1')).version - 1);
      check('и изменён, и открыт: отказ по версии идёт первым', stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT', stale);
    }
    {
      await seed();
      await holds('fixture-user', 'Tag', 'T1');
      const r = await del('T1', (await row('T1')).version);
      check('своё окно удалению не мешает', r.status === 200 && !(await row('T1')), r);
    }
    {
      await seed();
      await holds('u-petrova', 'Tag', 'T1', new Date(Date.now() - 100_000));
      const r = await del('T1', (await row('T1')).version);
      check('несвежая отметка (100 с) тег не держит', r.status === 200 && !(await row('T1')), r);
    }
    {
      await seed();
      await holds('u-petrova', 'Tag', 'T2');
      const r = await del('T1', (await row('T1')).version);
      check('открыт другой тег — удаление проходит', r.status === 200 && !(await row('T1')), r);
    }
    {
      await seed();
      await holds('u-petrova', 'Tag', 'T4');
      await holds('u-sidorov', 'ComponentElement', 'C1');
      const r = await del('T1', (await row('T1')).version);
      check('открыт дочерний тег и позиция с этим тегом: они не удаляются, удалению тега не мешают', r.status === 200 && !(await row('T1')) && !!(await row('T4')), r);
    }
    {
      // Общая база создана версией без таблицы открытых записей: удаление идёт без этой защиты
      await seed();
      await raw.$executeRawUnsafe('ALTER TABLE "OpenRecord" RENAME TO "OpenRecord_off"');
      try {
        const r = await del('T3', (await row('T3')).version);
        check('таблицы открытых записей нет — удаление идёт', r.status === 200 && !(await row('T3')), r);
      } finally {
        await raw.$executeRawUnsafe('ALTER TABLE "OpenRecord_off" RENAME TO "OpenRecord"');
      }
    }
    {
      // История — в той же транзакции: сломали её — тег цел, версия позиции прежняя
      await seed();
      await send('PUT', '/api/tags/T2', { department: 'x' });
      await raw.$executeRawUnsafe('ALTER TABLE "TagChange" RENAME TO "TagChange_off"');
      try {
        const before = await world().catch(() => null);
        const r = await del('T1', (await row('T1')).version);
        const stillThere = await row('T1');
        const element = await raw.componentElement.findUnique({ where: { id: 'C1' }, include: { tags: true } });
        check('сбой записи истории: удаление отказано (не 200), тег цел и привязан, версия позиции прежняя',
          r.status >= 500 && !!stillThere && element.version === 4 && element.tags.length === 1, { r, version: element?.version });
        void before;
      } finally {
        await raw.$executeRawUnsafe('ALTER TABLE "TagChange_off" RENAME TO "TagChange"');
      }
    }

    // ───────────────────────── bulk-metadata ─────────────────────────
    console.log('\n── PUT /api/tags/bulk-metadata');
    const bulk = (updates: unknown, source?: string) => send('PUT', '/api/tags/bulk-metadata', { updates, ...(source ? { source } : {}) });
    {
      await seed();
      const seen = { T1: upd(await row('T1')), T2: upd(await row('T2')), T3: upd(await row('T3')) };
      const ok = await bulk([
        { id: 'T1', metadata: { mainName: 'А' }, version: seen.T1 },
        { id: 'T2', metadata: { mainName: 'Б' }, version: seen.T2 },
        { id: 'T3', metadata: { mainName: 'В' }, version: seen.T3 },
      ]);
      const versions = ok.body?.versions || [];
      check('все версии свои — 200, ответ прежней формы (success, updated, missing, versions)',
        ok.status === 200 && ok.body?.success === true && ok.body?.updated === 3 && Array.isArray(ok.body?.missing) && ok.body.missing.length === 0 && versions.length === 3, ok);
      const dbNow = await raw.tag.findMany({ where: { id: { in: ['T1', 'T2', 'T3'] } } });
      check('новые версии в ответе совпадают с базой',
        dbNow.every((t: any) => versions.find((v: any) => v.id === t.id && new Date(v.updatedAt).getTime() === new Date(t.updatedAt).getTime())), versions);
      check('записано у всех трёх, чужие ключи (x, y, закупка) на месте',
        dbNow.map((t: any) => metaOf(t).mainName).sort().join() === 'А,Б,В' && metaOf(await row('T1')).procurement?.stage === 'draft' && metaOf(await row('T1')).x === 10);
      check('история — по строке на изменённый тег', (await world()).history.filter((h: any) => h.kind === 'изменён').length >= 3);
    }
    {
      // Один изменили: не записано ничего, даже то, что свежо
      await seed();
      const seen = { T1: upd(await row('T1')), T2: upd(await row('T2')), T3: upd(await row('T3')) };
      await colleagueEdits('T2');
      const before = await world();
      const r = await bulk([
        { id: 'T1', metadata: { mainName: 'А' }, version: seen.T1 },
        { id: 'T2', metadata: { mainName: 'Б' }, version: seen.T2 },
        { id: 'T3', metadata: { mainName: 'В' }, version: seen.T3 },
      ]);
      check('одну запись изменили: 409 VERSION_CONFLICT, текст массового отказа без кода', r.status === 409 && r.body?.code === 'VERSION_CONFLICT' && r.body?.error === bulkChangedText() && isPlainRefusal(r.body), r);
      check('в отказе changed: [{ id, current }] с текущей записью и gone: []',
        r.body?.changed?.length === 1 && r.body.changed[0].id === 'T2' && r.body.changed[0].current?.id === 'T2' && r.body.changed[0].current.department === 'ОВ' && same(r.body?.gone, []), r.body);
      check('всё или ничего: свежие записи пачки тоже не записаны, история не тронута', same(before, await world()));
    }
    {
      // Изменён, удалён и свежий: перечислены ВСЕ проблемные, не первый
      await seed();
      const seen = { T1: upd(await row('T1')), T2: upd(await row('T2')), T3: upd(await row('T3')), T4: upd(await row('T4')) };
      await colleagueEdits('T1');
      await colleagueEdits('T3');
      await raw.tag.delete({ where: { id: 'T2' } });
      const before = await world();
      const r = await bulk([
        { id: 'T1', metadata: { mainName: 'А' }, version: seen.T1 },
        { id: 'T2', metadata: { mainName: 'Б' }, version: seen.T2 },
        { id: 'T3', metadata: { mainName: 'В' }, version: seen.T3 },
        { id: 'T4', metadata: { mainName: 'Г' }, version: seen.T4 },
      ]);
      check('изменены два и удалён один: changed — оба, gone — удалённый',
        r.status === 409 && same((r.body?.changed || []).map((c: any) => c.id).sort(), ['T1', 'T3']) && same(r.body?.gone, ['T2']), r);
      check('изменены и удалены: не записано ничего (в том числе свежий T4)', same(before, await world()));
    }
    {
      // Только раскладка: сверки нет; со смешанной пачкой — раскладка проходит, остальное сверяется
      await seed();
      const seen = { T1: upd(await row('T1')), T2: upd(await row('T2')) };
      await colleagueEdits('T1');
      await colleagueEdits('T2');
      const v1 = await row('T1');
      const r = await bulk([{ id: 'T1', metadata: { x: 1, y: 2, _noPos: false }, version: seen.T1 }]);
      const after = await row('T1');
      check('только раскладка со старой версией — 200, координаты записаны', r.status === 200 && metaOf(after).x === 1 && metaOf(after).y === 2, r);
      check('раскладка не двигает ни целую версию, ни updatedAt', after.version === v1.version && upd(after) === upd(v1));
      const nothing = await bulk([{ id: 'T2', metadata: { x: 5, y: 6 } }]);
      check('раскладка без версии — 200', nothing.status === 200, nothing);
      const before = await world();
      const mixed = await bulk([
        { id: 'T1', metadata: { x: 3, y: 4 }, version: seen.T1 },
        { id: 'T2', metadata: { mainName: 'Новое' }, version: seen.T2 },
      ]);
      check('раскладка вместе с правкой по старой версии: отказ по правке, раскладка не записана',
        mixed.status === 409 && same((mixed.body?.changed || []).map((c: any) => c.id), ['T2']) && same(before, await world()), mixed);
    }
    {
      // Раскладка удалённого тега — не молчание: он назван в gone
      await seed();
      await raw.tag.delete({ where: { id: 'T3' } });
      const before = await world();
      const r = await bulk([{ id: 'T1', metadata: { x: 7, y: 7 } }, { id: 'T3', metadata: { x: 8, y: 8 } }]);
      check('удалённый тег в пачке — 409, он назван в gone, `missing` не молчит', r.status === 409 && same(r.body?.gone, ['T3']) && same(r.body?.changed, []), r);
      check('удалённый тег в пачке: остальные не записаны', same(before, await world()));
    }
    {
      // Закупки: сужение до ключа procurement и сверка версии у массовой смены этапа
      await seed();
      const seen = upd(await row('T2'));
      await colleagueEdits('T2');
      const before = await world();
      const stale = await bulk([{ id: 'T2', metadata: { procurement: { stage: 'ordered' }, mainName: 'не моё' }, version: seen }], 'Закупки');
      check('Закупки: массовая смена этапа по чужой версии — 409 с перечнем', stale.status === 409 && same((stale.body?.changed || []).map((c: any) => c.id), ['T2']) && same(before, await world()), stale);
      const fresh = await bulk([{ id: 'T2', metadata: { procurement: { stage: 'ordered' }, mainName: 'не моё' }, version: upd(await row('T2')) }], 'Закупки');
      check('Закупки: по свежей версии пишется только procurement', fresh.status === 200 && metaOf(await row('T2')).procurement?.stage === 'ordered' && metaOf(await row('T2')).mainName === 'Второй', fresh);
    }
    {
      await seed();
      const before = await world();
      const bad = [
        ['пустой список', []],
        ['id повторяется', [{ id: 'T1', metadata: { x: 1 } }, { id: 'T1', metadata: { x: 2 } }]],
        ['id нет', [{ metadata: { x: 1 } }]],
        ['metadata не объект', [{ id: 'T1', metadata: [1] }]],
      ] as const;
      for (const [name, updates] of bad) {
        const r = await bulk(updates);
        check(`${name} — 400`, r.status === 400 && typeof r.body?.error === 'string', r);
      }
      check('нечитаемые запросы — в базе не изменилось ничего', same(before, await world()));
      const edge = await bulk(Array.from({ length: 2000 }, (_, i) => ({ id: `нет-${i}`, metadata: { x: i } })));
      check('ровно 2000 записей — не 400 (дошло до проверки записей: все они в gone)', edge.status === 409 && edge.body?.gone?.length === 2000, [edge.status, edge.body?.gone?.length]);
      const over = await bulk([...Array.from({ length: 2000 }, (_, i) => ({ id: `нет-${i}`, metadata: { x: i } })), { id: 'T1', metadata: { mainName: 'хвост' } }]);
      check('2001 запись — 400 с понятным текстом, а не молчаливый срез', over.status === 400 && /2000/.test(over.body?.error) && isPlainRefusal(over.body), over);
      check('2001 запись — в базе не изменилось ничего (хвост не записан)', same(before, await world()));
    }

    console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${checks})`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await raw.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
