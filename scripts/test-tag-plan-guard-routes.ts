/**
 * Сверка предпросмотра с базой при массовых действиях над тегами и ВДР
 * (.claude/progress/bulk-plan-guard.md, строка «T»; решения владельца 15 ноября 2026, п. 3 и п. 7).
 *
 * Настоящая SQLite-база (таблицы из schema.prisma), настоящие маршруты на настоящем express,
 * клиент базы — `withVersionBump(raw)`, как на сервере; «коллега» правит записи тем же клиентом
 * (версия растёт). После КАЖДОГО отказа сравнивается весь мир: теги, история, строки ВДР,
 * связи, реестры — ни одной лишней записи («всё или ничего»).
 *
 *  • POST …/tags/bulk-import: `seen` по тегам, которые ввоз тронет; изменённый или удалённый тег —
 *    409 `VERSION_CONFLICT` с `changed` / `gone` по ВСЕМ записям; тронутый тег, которого предпросмотр
 *    не видел (появился после), — тоже отказ; чужой проект не отдаётся; нечитаемый `seen` — 400;
 *    без `seen` — как прежде;
 *  • POST …/tags/capture-apply: `seen` по дополняемым и заменяемым тегам; в ответе `versions`
 *    записанного; строки «привязать» версию не требуют;
 *  • POST …/tags/capture-undo: `seen` = `versions` из применения; тег менял кто-то ещё — отмена не
 *    пишет «до» и не удаляет созданное; повтор с версиями из отказа — подтверждение заново;
 *  • POST /api/vdr/tag-links/apply|undo: применение отдаёт версии строк, отмена сверяет их;
 *  • POST /api/vdr/import: ввоз — одна транзакция (сбой посреди файла не оставляет половины), строка,
 *    изменённая между чтением и записью, — 409 с перечнем, а не затирание.
 *
 * Мутации, которыми набор проверен (каждая роняет его; список и результат — в отчёте исполнителя):
 *  M1 bulk-import без сверки; M2 без `touched` (тег, которого предпросмотр не видел); M3 capture-apply
 *  без сверки; M4 capture-apply не отдаёт `versions`; M5 capture-undo без сверки; M6 undo ВДР без
 *  сверки; M7 apply ВДР не отдаёт `versions`; M8 ввоз ВДР не в транзакции; M9 ввоз ВДР без сверки
 *  версии строки; M10 сверка не называет все записи (только первую); M11 сверка не ограничена проектом;
 *  M12 удалённая запись молча пропускается; M13 нечитаемый `seen` принят.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import * as XLSX from 'xlsx';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma, setBroadcaster } from '../server/context.js';
import { withVersionBump } from '../server/versionBump.js';
import { registerTagRoutes } from '../server/routes/tags.js';
import { registerVdrRoutes } from '../server/routes/vdr.js';
import { bulkChangedText } from '../src/lib/refusalTexts.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-tag-plan-guard-'));
const dbPath = path.join(root, 'fixture.sqlite');
const raw = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
const base = withVersionBump(raw);
let checks = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 900)}`}`);
  checks++;
  console.log(`✓ ${label}`);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const META = (o: unknown) => JSON.stringify(o);

/** Всё, чего могут коснуться маршруты: сравнение «до и после» ловит любую лишнюю запись. */
async function world() {
  return {
    tags: await raw.tag.findMany({ orderBy: { id: 'asc' } }),
    history: await raw.$queryRawUnsafe('SELECT "id","tagId","kind","field" FROM "TagChange" ORDER BY "id"').catch(() => []),
    registers: await raw.docRegister.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true, version: true } }),
    items: await raw.docRegisterItem.findMany({ orderBy: { id: 'asc' } }),
    links: await raw.docRegisterItemTag.findMany({ orderBy: [{ itemId: 'asc' }, { tagId: 'asc' }] }),
  };
}

async function seed() {
  await raw.docRegisterItemTag.deleteMany({});
  await raw.docRegisterItem.deleteMany({});
  await raw.docRegister.deleteMany({});
  await raw.tag.deleteMany({});
  await raw.$executeRawUnsafe('DELETE FROM "TagChange"').catch(() => null);
  // Версии тегов разные — случайное совпадение не пройдёт
  const mk = (id: string, identifier: string, version: number, extra: Record<string, unknown> = {}, projectId = 'p1') =>
    raw.tag.create({ data: { id, identifier, projectId, codeKey: identifier.toLowerCase(), version, ...extra } });
  await mk('T1', 'AHU-1', 3, { brand: 'Старая', metadata: META({ mainName: 'Первый', connections: [] }) });
  await mk('T2', 'AHU-2', 5, { metadata: META({ mainName: 'Второй', connections: [] }) });
  await mk('T3', 'AHU-3', 2, { metadata: META({ mainName: 'Третий', connections: [] }) });
  await mk('TX', 'AHU-1', 7, { metadata: META({}) }, 'p2'); // тот же код в другом проекте — не наш
}

async function main() {
  let server: any;
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, raw, schema, () => {});
    setPrisma(base);
    setBroadcaster(() => {});
    await raw.project.create({ data: { id: 'p1', name: 'P1' } });
    await raw.project.create({ data: { id: 'p2', name: 'P2' } });

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, _res, next) => { (req as any).authUser = { id: 'fixture-user', name: 'Инженер', role: 'ADMIN', isActive: true }; next(); });
    registerTagRoutes(app, { io: {} as any, notifyAll: async () => {} });
    registerVdrRoutes(app as any, { chunkBytes: async () => 1024 });
    server = await new Promise<any>((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = async (method: string, url: string, body?: unknown) => {
      const r = await fetch(`${origin}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { json = { text }; }
      return { status: r.status, body: json };
    };
    const tag = (id: string) => raw.tag.findUnique({ where: { id } });
    /** «Коллега поправил тег»: версия уходит вперёд */
    const colleagueEdits = (id: string, data: Record<string, unknown> = { department: 'ОВ' }) => base.tag.update({ where: { id }, data });
    const isConflict = (r: { status: number; body: any }) => r.status === 409 && r.body?.code === 'VERSION_CONFLICT'
      && r.body?.error === bulkChangedText() && Array.isArray(r.body?.changed) && Array.isArray(r.body?.gone);
    const ids = (list: any[]) => list.map((c) => c.id).sort().join(',');
    const BI = '/api/projects/p1/tags/bulk-import';
    const CA = '/api/projects/p1/tags/capture-apply';
    const CU = '/api/projects/p1/tags/capture-undo';

    // ───────────────────────── bulk-import ─────────────────────────
    console.log('\n── POST …/tags/bulk-import');
    {
      await seed();
      const rows = [{ identifier: 'AHU-1', name: 'Новое имя', brand: 'КЦКП' }, { identifier: 'AHU-2', name: 'Второе' }, { identifier: 'AHU-9', name: 'Новый', parent: 'AHU-3' }];
      // Предпросмотр видел тронутые: AHU-1, AHU-2 (режим «обновить») и родителя AHU-3
      const seen = { T1: 3, T2: 5, T3: 2 };
      await colleagueEdits('T1');
      await colleagueEdits('T2');
      const before = await world();
      const r = await send('POST', BI, { rows, mode: 'update', seen });
      check('ввоз: два тега изменили после предпросмотра — 409 с кодом отдельным полем, текст из словаря', isConflict(r), r);
      check('ввоз: в отказе названы ВСЕ изменённые теги (а не первый), с текущей записью', ids(r.body.changed) === 'T1,T2'
        && r.body.changed.every((c: any) => c.current?.id === c.id && typeof c.current.version === 'number'), r.body);
      check('ввоз: отказ — в базе не изменилось ничего (ни обновления, ни нового тега AHU-9, ни связи, ни истории)', same(before, await world()));

      // Удалённый тег
      await raw.tag.delete({ where: { id: 'T2' } });
      const beforeGone = await world();
      const g = await send('POST', BI, { rows, mode: 'update', seen: { T1: (await tag('T1')).version, T2: 5, T3: 2 } });
      check('ввоз: удалённый тег — `gone`, а не молчаливый пропуск', isConflict(g) && g.body.gone.join() === 'T2' && g.body.changed.length === 0, g.body);
      check('ввоз: удалённый тег — в базе не изменилось ничего', same(beforeGone, await world()));

      // Версии из отказа — подтверждение заново; запись идёт, остальное не тронуто
      await seed();
      const versions = Object.fromEntries((await raw.tag.findMany({ where: { projectId: 'p1' } })).map((t: any) => [t.id, t.version]));
      const ok = await send('POST', BI, { rows, mode: 'update', seen: versions });
      check('ввоз: актуальные версии — 200, создано и обновлено', ok.status === 200 && ok.body.created === 1 && ok.body.updated === 2, ok);
      check('ввоз: записано то, что в предпросмотре (имя, марка, связь родителя)', (await tag('T1')).brand === 'КЦКП'
        && JSON.parse((await tag('T1')).metadata).mainName === 'Новое имя'
        && JSON.parse((await tag('T3')).metadata).connections.length === 1);
    }
    {
      // Тег появился после предпросмотра: режим «обновить», строка AHU-3, а предпросмотр его не видел
      await seed();
      const before = await world();
      const r = await send('POST', BI, { rows: [{ identifier: 'AHU-3', name: 'Из файла' }], mode: 'update', seen: {} });
      check('ввоз: тег, который предпросмотр не видел (появился после), не обновляется молча — 409 с ним в `changed`', isConflict(r) && ids(r.body.changed) === 'T3', r);
      check('ввоз: тронутый, но не показанный тег — в базе не изменилось ничего', same(before, await world()));
      // Родитель в режиме «добавить»: ему дописывается связь
      const p = await send('POST', BI, { rows: [{ identifier: 'AHU-8', parent: 'AHU-2' }], mode: 'add', seen: {} });
      check('ввоз: родитель строки — тоже тронутый тег: без его версии отказ', isConflict(p) && ids(p.body.changed) === 'T2', p);
      check('ввоз: отказ из-за родителя — нового тега нет', (await raw.tag.count({ where: { identifier: 'AHU-8' } })) === 0 && same(before, await world()));
      // Режим «добавить»: совпавший по коду тег не пишется — версия не нужна
      const a = await send('POST', BI, { rows: [{ identifier: 'AHU-3' }, { identifier: 'AHU-7' }], mode: 'add', seen: {} });
      check('ввоз «добавить»: совпавший по коду тег не пишется — версия не нужна, повтор уходит в `duplicates`', a.status === 200 && a.body.created === 1 && a.body.duplicates.join() === 'AHU-3', a);
    }
    {
      // Чужой проект: тег с тем же кодом в p2 не отдаётся и не сверяется
      await seed();
      const r = await send('POST', BI, { rows: [{ identifier: 'AHU-9' }], mode: 'add', seen: { TX: 7 } });
      check('ввоз: тег другого проекта в `seen` считается отсутствующим (`gone`), его запись в отказ не попадает', isConflict(r) && r.body.gone.join() === 'TX' && r.body.changed.length === 0, r);
      const bad = [await send('POST', BI, { rows: [{ identifier: 'AHU-9' }], mode: 'add', seen: [1, 2] }),
        await send('POST', BI, { rows: [{ identifier: 'AHU-9' }], mode: 'add', seen: { T1: 0 } }),
        await send('POST', BI, { rows: [{ identifier: 'AHU-9' }], mode: 'add', seen: { T1: 'abc' } })];
      check('ввоз: нечитаемый `seen` — 400 с понятным текстом, ничего не записано', bad.every((b) => b.status === 400 && /не записано/i.test(b.body?.error || '')) && (await raw.tag.count({ where: { identifier: 'AHU-9' } })) === 0, bad.map((b) => b.body));
      const old = await send('POST', BI, { rows: [{ identifier: 'AHU-9' }], mode: 'add' });
      check('ввоз: старый клиент без `seen` — как прежде, 200', old.status === 200 && old.body.created === 1, old);
    }

    // ───────────────────────── capture-apply ─────────────────────────
    console.log('\n── POST …/tags/capture-apply');
    {
      await seed();
      const rows = [
        { identifier: 'AHU-1', action: 'fill', targetId: 'T1', brand: 'Новая', department: 'ОВ' },
        { identifier: 'AHU-2', action: 'replace', targetId: 'T2', name: 'Заменено' },
        { identifier: 'AHU-3', action: 'link', targetId: 'T3' },
        { identifier: 'AHU-20', action: 'create', name: 'Новый' },
      ];
      await colleagueEdits('T2');
      const before = await world();
      const r = await send('POST', CA, { rows, seen: { T1: 3, T2: 5 } });
      check('захват: дополняемый тег изменили после плана — 409, `changed` с этим тегом', isConflict(r) && ids(r.body.changed) === 'T2', r);
      check('захват: отказ — в базе не изменилось ничего (даже T1 не дополнен, AHU-20 не создан)', same(before, await world()));

      await raw.tag.delete({ where: { id: 'T1' } });
      const beforeGone = await world();
      const g = await send('POST', CA, { rows, seen: { T1: 3, T2: (await tag('T2')).version } });
      check('захват: удалённая цель — `gone`, а не новый тег с тем же кодом', isConflict(g) && g.body.gone.join() === 'T1', g);
      check('захват: удалённая цель — в базе не изменилось ничего', same(beforeGone, await world()));

      await seed();
      const t3 = (await tag('T3')).version;
      const ok = await send('POST', CA, { rows, seen: { T1: 3, T2: 5 } });
      check('захват: версии те — 200, «привязать» версии не требует', ok.status === 200 && ok.body.filled.length === 2 && ok.body.created.length === 1 && ok.body.linked.length === 1, ok);
      const nowT1 = await tag('T1'); const nowT2 = await tag('T2'); const created = await raw.tag.findFirst({ where: { identifier: 'AHU-20' } });
      check('захват: в ответе `versions` записанного — ровно то, что в базе (дополненные и созданный)',
        ok.body.versions?.T1 === nowT1.version && ok.body.versions?.T2 === nowT2.version && ok.body.versions?.[created.id] === created.version
        && Object.keys(ok.body.versions).length === 3 && nowT1.version === 4 && nowT2.version === 6, { v: ok.body.versions, t1: nowT1.version });
      check('захват: «привязать» не пишет — версия связанного тега прежняя', (await tag('T3')).version === t3);
      const unseen = await send('POST', CA, { rows: [{ identifier: 'AHU-3', action: 'fill', targetId: 'T3', brand: 'Б' }], seen: {} });
      check('захват: цель, которой в `seen` нет, не дополняется молча — 409', isConflict(unseen) && ids(unseen.body.changed) === 'T3', unseen);
      const old = await send('POST', CA, { rows: [{ identifier: 'AHU-3', action: 'fill', targetId: 'T3', brand: 'Б' }] });
      check('захват: старый клиент без `seen` — как прежде, 200', old.status === 200 && old.body.filled.length === 1, old);
      const bad = await send('POST', CA, { rows: [], seen: 'много' });
      check('захват: нечитаемый `seen` — 400', bad.status === 400 && /не записано/i.test(bad.body?.error || ''), bad);
    }

    // ───────────────────────── capture-undo ─────────────────────────
    console.log('\n── POST …/tags/capture-undo');
    const applied = async () => {
      await seed();
      const snapshot = (t: any) => ({ id: t.id, brand: t.brand ?? null, department: t.department ?? null, fluid: t.fluid ?? null, wbs: t.wbs ?? null, metadata: t.metadata ?? null });
      const restore = [snapshot(await tag('T1')), snapshot(await tag('T2'))];
      const res = await send('POST', CA, { rows: [
        { identifier: 'AHU-1', action: 'fill', targetId: 'T1', brand: 'Новая', department: 'ОВ' },
        { identifier: 'AHU-2', action: 'replace', targetId: 'T2', name: 'Заменено', department: 'ВК' },
        { identifier: 'AHU-30', action: 'create' },
      ], seen: { T1: 3, T2: 5 } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return { restore, deleteIds: res.body.created.map((c: any) => c.id), versions: res.body.versions as Record<string, number>, created: res.body.created[0].id as string };
    };
    {
      const s = await applied();
      const r = await send('POST', CU, { deleteIds: s.deleteIds, restore: s.restore, seen: s.versions });
      check('отмена: версии те, что оставило применение — 200, созданное удалено, прежнее возвращено',
        r.status === 200 && r.body.deleted === 1 && r.body.restored === 2 && (await tag('T1')).brand === 'Старая' && (await tag('T1')).department === null && !(await tag(s.created)), r);
    }
    {
      // Дополненный тег успел поправить коллега: «до» поверх его правки не пишется
      const s = await applied();
      await colleagueEdits('T1', { fluid: 'Вода' });
      const before = await world();
      const r = await send('POST', CU, { deleteIds: s.deleteIds, restore: s.restore, seen: s.versions });
      check('отмена: дополненный тег изменили с тех пор — 409 с этим тегом, текст из словаря', isConflict(r) && ids(r.body.changed) === 'T1', r);
      check('отмена: отказ — созданный тег цел, «до» не записано ни одному, история не выросла', same(before, await world()) && !!(await tag(s.created)));
      // Подтверждение заново: версия из отказа уходит в `seen` — запись идёт, правка коллеги затёрта осознанно
      const again = await send('POST', CU, { deleteIds: s.deleteIds, restore: s.restore, seen: { ...s.versions, T1: r.body.changed[0].current.version } });
      check('отмена: повтор с версиями из отказа (человек прочёл перечень) — 200', again.status === 200 && again.body.restored === 2 && again.body.deleted === 1, again);
    }
    {
      // Созданный тег успели изменить: удалять его без спроса нельзя
      const s = await applied();
      await colleagueEdits(s.created, { department: 'Свой' });
      const before = await world();
      const r = await send('POST', CU, { deleteIds: s.deleteIds, restore: s.restore, seen: s.versions });
      check('отмена: созданный тег изменили с тех пор — 409, тег не удалён', isConflict(r) && ids(r.body.changed) === s.created && same(before, await world()), r);
    }
    {
      const s = await applied();
      await raw.tag.delete({ where: { id: 'T2' } });
      const before = await world();
      const r = await send('POST', CU, { deleteIds: s.deleteIds, restore: s.restore, seen: s.versions });
      check('отмена: дополненный тег удалили — `gone`, остальное не тронуто', isConflict(r) && r.body.gone.join() === 'T2' && same(before, await world()), r);
      const old = await send('POST', CU, { deleteIds: s.deleteIds, restore: s.restore });
      check('отмена: старый клиент без `seen` — как прежде, 200', old.status === 200 && old.body.deleted === 1, old);
    }
    {
      const s = await applied();
      const r = await send('POST', CU, { deleteIds: s.deleteIds, restore: s.restore, seen: { TX: 7 } });
      check('отмена: тег чужого проекта в `seen` — `gone`, не отдаётся', isConflict(r) && r.body.gone.join() === 'TX' && r.body.changed.length === 0, r);
      const bad = await send('POST', CU, { deleteIds: [], restore: [], seen: { T1: -1 } });
      check('отмена: нечитаемый `seen` — 400', bad.status === 400, bad);
    }

    // ───────────────────────── ВДР: связи ─────────────────────────
    console.log('\n── POST /api/vdr/tag-links/apply и undo');
    const seedVdr = async () => {
      await seed();
      await raw.docRegister.create({ data: { id: 'R1', projectId: 'p1', name: 'ВДР 1' } });
      await raw.docRegister.create({ data: { id: 'RX', projectId: 'p2', name: 'ВДР чужой' } });
      const item = (id: string, no: string, tags: string[], registerId = 'R1', projectId = 'p1') =>
        raw.docRegisterItem.create({ data: { id, registerId, projectId, contractorNo: no, titleRu: `Док ${no}`, equipmentTags: JSON.stringify(tags), version: 4 } });
      await item('I1', 'D-1', ['AHU-2']); await item('I2', 'D-2', ['AHU-3']); await item('I3', 'D-3', []);
      await item('IX', 'D-9', ['AHU-1'], 'RX', 'p2');
    };
    const applyLinks = async () => {
      const plan = await send('GET', '/api/vdr/tag-links?projectId=p1');
      return send('POST', '/api/vdr/tag-links/apply', { projectId: 'p1', digest: plan.body.plan.digest });
    };
    {
      await seedVdr();
      const a = await applyLinks();
      check('связи: применение — созданные пары, `versions` строк со связями и сами строки (чтобы показать «было → стало»)',
        a.status === 200 && a.body.created.length === 2 && a.body.versions?.I1 === 4 && a.body.versions?.I2 === 4 && Object.keys(a.body.versions).length === 2
        && a.body.items?.length === 2 && a.body.items[0].extra !== undefined, a);
      const r = await send('POST', '/api/vdr/tag-links/undo', { projectId: 'p1', created: a.body.created, seen: a.body.versions });
      check('связи: отмена по тем же версиям — связи сняты', r.status === 200 && r.body.removed === 2 && (await raw.docRegisterItemTag.count()) === 0, r);
    }
    {
      await seedVdr();
      const a = await applyLinks();
      await base.docRegisterItem.update({ where: { id: 'I1' }, data: { titleRu: 'Переименовал коллега' } });
      const before = await world();
      const r = await send('POST', '/api/vdr/tag-links/undo', { projectId: 'p1', created: a.body.created, seen: a.body.versions });
      check('связи: строку изменили после применения — отмена 409 с кодом, `changed` со строкой в виде чтения (extra объектом)',
        isConflict(r) && ids(r.body.changed) === 'I1' && r.body.changed[0].current.titleRu === 'Переименовал коллега' && typeof r.body.changed[0].current.extra === 'object', r);
      check('связи: отказ отмены — ни одна связь не снята', same(before, await world()) && (await raw.docRegisterItemTag.count()) === 2);
      const again = await send('POST', '/api/vdr/tag-links/undo', { projectId: 'p1', created: a.body.created, seen: { ...a.body.versions, I1: r.body.changed[0].current.version } });
      check('связи: повтор с версией из отказа — связи сняты', again.status === 200 && again.body.removed === 2, again);
    }
    {
      await seedVdr();
      const a = await applyLinks();
      await raw.docRegisterItemTag.deleteMany({ where: { itemId: 'I2' } });
      await raw.docRegisterItem.delete({ where: { id: 'I2' } });
      const before = await world();
      const r = await send('POST', '/api/vdr/tag-links/undo', { projectId: 'p1', created: a.body.created, seen: a.body.versions });
      check('связи: строку удалили — отмена `gone`, связи остальных не сняты', isConflict(r) && r.body.gone.join() === 'I2' && same(before, await world()), r);
      const foreign = await send('POST', '/api/vdr/tag-links/undo', { projectId: 'p1', created: [], seen: { IX: 4 } });
      check('связи: строка чужого проекта в `seen` — `gone`, не отдаётся', isConflict(foreign) && foreign.body.gone.join() === 'IX' && foreign.body.changed.length === 0, foreign);
      const old = await send('POST', '/api/vdr/tag-links/undo', { projectId: 'p1', created: a.body.created });
      check('связи: старый клиент без `seen` — как прежде, 200', old.status === 200, old);
      const bad = await send('POST', '/api/vdr/tag-links/undo', { projectId: 'p1', created: [], seen: 'x' });
      check('связи: нечитаемый `seen` — 400', bad.status === 400, bad);
    }

    // ───────────────────────── ВДР: ввоз ─────────────────────────
    console.log('\n── POST /api/vdr/import');
    const book = (rows: string[][]) => {
      const ws = XLSX.utils.aoa_to_sheet([['Contractor Document No', 'Russian Title', 'English Title', 'Rev'], ...rows]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Register');
      return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
    };
    const importBody = (rows: string[][], extra: Record<string, unknown> = {}) => ({ projectId: 'p1', content: book(rows), fileName: 'ВДР.xlsx', registerId: 'R1', ...extra });
    /** Клиент базы, у которого в транзакции можно подстроить «коллегу» или сбой в нужный момент ввоза. */
    let hook: null | { on: 'updateMany' | 'create'; at: number; run: (tx: any) => Promise<void> } = null;
    let calls = { updateMany: 0, create: 0 };
    const hooked = new Proxy(base, {
      get(target: any, key: PropertyKey) {
        const v = Reflect.get(target, key);
        if (key !== '$transaction') return typeof v === 'function' ? v.bind(target) : v;
        return (fn: any, opts: any) => target.$transaction((tx: any) => fn(new Proxy(tx, {
          get(t: any, k: PropertyKey) {
            const d = Reflect.get(t, k);
            if (k !== 'docRegisterItem') return typeof d === 'function' ? d.bind(t) : d;
            return new Proxy(d, {
              get(m: any, op: PropertyKey) {
                const f = Reflect.get(m, op);
                if ((op === 'updateMany' || op === 'create') && typeof f === 'function') {
                  return async (a: any) => {
                    calls[op as 'updateMany' | 'create']++;
                    if (hook && hook.on === op && calls[op as 'updateMany' | 'create'] === hook.at) { const h = hook; hook = null; await h.run(t); }
                    return f.call(m, a);
                  };
                }
                return typeof f === 'function' ? f.bind(m) : f;
              },
            });
          },
        })), opts);
      },
    });
    const seedImport = async () => {
      await seedVdr();
      await raw.docRegisterItem.deleteMany({});
      await raw.docRegisterItem.create({ data: { id: 'E1', registerId: 'R1', projectId: 'p1', contractorNo: 'D-1', titleRu: 'Было 1', version: 6 } });
      await raw.docRegisterItem.create({ data: { id: 'E2', registerId: 'R1', projectId: 'p1', contractorNo: 'D-2', titleRu: 'Было 2', version: 2 } });
      calls = { updateMany: 0, create: 0 };
    };
    setPrisma(hooked);
    {
      await seedImport();
      const r = await send('POST', '/api/vdr/import', importBody([['D-1', 'Стало 1', 'New 1', 'A'], ['D-2', 'Стало 2', 'New 2', 'A'], ['D-3', 'Новая', 'New 3', 'A']]));
      check('ввоз ВДР: без помех — 200, обновлено 2, создано 1', r.status === 200 && r.body.updated === 2 && r.body.created === 1, r);
      check('ввоз ВДР: версии обновлённых строк выросли ровно на 1', (await raw.docRegisterItem.findUnique({ where: { id: 'E1' } })).version === 7 && (await raw.docRegisterItem.findUnique({ where: { id: 'E2' } })).version === 3);
    }
    {
      // Коллега правит вторую строку между чтением и записью ввоза
      await seedImport();
      hook = { on: 'updateMany', at: 2, run: async (tx) => { await tx.docRegisterItem.update({ where: { id: 'E2' }, data: { titleRu: 'Правка коллеги' } }); } };
      const before = await world();
      const r = await send('POST', '/api/vdr/import', importBody([['D-1', 'Стало 1', 'New 1', 'A'], ['D-2', 'Стало 2', 'New 2', 'A'], ['D-3', 'Новая', 'New 3', 'A']]));
      const e2 = await raw.docRegisterItem.findUnique({ where: { id: 'E2' } });
      check('ввоз ВДР: строку изменили во время ввоза — 409 с кодом и перечнем, чужая правка видна в `current`, значение файла не записано',
        r.status === 409 && r.body?.code === 'VERSION_CONFLICT' && r.body.changed?.length === 1 && r.body.changed[0].id === 'E2'
        && typeof r.body.changed[0].current.extra === 'object' && r.body.gone.length === 0
        && r.body.changed[0].current.titleRu === 'Правка коллеги' && e2.titleRu !== 'Стало 2', r);
      check('ввоз ВДР: отказ — ввоз откачен целиком (первая строка не обновлена, новая не создана)', (await raw.docRegisterItem.findUnique({ where: { id: 'E1' } })).titleRu === 'Было 1'
        && (await raw.docRegisterItem.count({ where: { contractorNo: 'D-3' } })) === 0 && before.registers.length === (await world()).registers.length);
      check('ввоз ВДР: текст отказа — по-русски, про ввоз, без слова «предпросмотр»', /ввоз/i.test(r.body.error) && !/предпросмотр/i.test(r.body.error), r.body.error);
    }
    {
      // Строку удалили во время ввоза
      await seedImport();
      hook = { on: 'updateMany', at: 1, run: async (tx) => { await tx.docRegisterItem.delete({ where: { id: 'E1' } }); } };
      const r = await send('POST', '/api/vdr/import', importBody([['D-1', 'Стало 1', 'New 1', 'A'], ['D-2', 'Стало 2', 'New 2', 'A']]));
      check('ввоз ВДР: строку удалили во время ввоза — 409 `gone`, ничего не записано', r.status === 409 && r.body.gone?.join() === 'E1'
        && (await raw.docRegisterItem.findUnique({ where: { id: 'E2' } })).titleRu === 'Было 2', r);
    }
    {
      // Сбой посреди файла: ни реестра, ни половины строк
      await seedImport();
      hook = { on: 'create', at: 2, run: async () => { throw new Error('сбой диска'); } };
      const itemsBefore = await raw.docRegisterItem.count();
      const regsBefore = await raw.docRegister.count();
      const r = await send('POST', '/api/vdr/import', importBody([['D-1', 'Стало 1', 'New 1', 'A'], ['D-5', 'Новая 5', 'N5', 'A'], ['D-6', 'Новая 6', 'N6', 'A'], ['D-7', 'Новая 7', 'N7', 'A']], { registerId: undefined, name: 'Новый реестр' }));
      check('ввоз ВДР: сбой посреди файла — ответ-отказ', r.status >= 400, r);
      check('ввоз ВДР: сбой посреди файла — ни нового реестра, ни созданных строк, ни обновлённой первой («всё или ничего»)',
        (await raw.docRegisterItem.count()) === itemsBefore && (await raw.docRegister.count()) === regsBefore
        && (await raw.docRegisterItem.findUnique({ where: { id: 'E1' } })).titleRu === 'Было 1');
    }
    setPrisma(base);

    console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${checks})`);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await raw.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
