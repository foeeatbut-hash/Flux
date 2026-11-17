/**
 * Сверка версии и отказ общего вида в маршрутах проектов и справочников
 * (.claude/progress/projects-dicts-version.md, «Решение»; общее место —
 * docs/methodology/03-programs/shell.md, «Отказ записи»).
 *
 * Настоящая SQLite-база (таблицы из schema.prisma), настоящие маршруты на настоящем
 * express, клиент базы — `withVersionBump(raw)`, как на сервере; действуют двое
 * (заголовок `x-test-user`). После КАЖДОГО отказа сравнивается весь мир: проекты, теги,
 * оборудование, реестры, справочники, шаблон — ни одной лишней записи.
 *
 *  • PUT /api/projects/:id: `expectedVersion` в теле; чужая версия — 409 с `code` и `current`,
 *    текст из словаря; нечитаемая — 400; проекта нет — 404 `RECORD_GONE`; без версии — 200;
 *  • DELETE /api/projects/:id: `?expectedVersion=`; открытый у коллеги проект и открытая у него
 *    запись внутри проекта (все семь моделей) не дают удалить; каскад и строка проекта — одна
 *    транзакция (сломали удаление строки — данные проекта целы); служебный проект — 400;
 *    повтор — 200 `alreadyGone`; чужие проекты нетронуты;
 *  • PUT/DELETE /api/dictionaries/items/:itemId: версия, открытые пункты (сам и потомки),
 *    потомки и перенос значений тегов при переименовании категории — в той же транзакции;
 *  • POST …/dictionaries/:id/items в справочник, которого нет, — 404 `RECORD_GONE`;
 *  • PUT …/tag-template: есть — сверка версии, нет — создание, ответ отдаёт `version`.
 *
 * Мутации, которыми набор проверен (каждая роняет его): убрать сверку версии у удаления проекта,
 * у правки проекта, у пункта, у шаблона; убрать `openCheck` у удаления проекта и пункта; убрать
 * `cascade` из `openCheck` проекта и пункта; вынести каскад проекта из транзакции; потомков
 * пункта из транзакции; перенос значений тегов из транзакции; POST пункта без 404.
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
import { registerProjectRoutes } from '../server/routes/projects.js';
import { registerDictionaryRoutes } from '../server/routes/dictionaries.js';
import { ensureOpenTable } from '../server/openRecords.js';
import {
  editChangedText, editGoneText, deleteChangedText, deleteOpenText, deleteOpenNestedText, createInsideGoneText,
} from '../src/lib/refusalTexts.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-project-dict-version-routes-'));
const dbPath = path.join(root, 'fixture.sqlite');
const raw = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 900)}`}`);
  checks++;
  console.log(`✓ ${label}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Всё, чего могут коснуться маршруты: сравнение «до и после» ловит любую лишнюю запись. */
async function world() {
  const by = { orderBy: { id: 'asc' as const } };
  return {
    projects: await raw.project.findMany(by),
    tags: await raw.tag.findMany(by),
    systems: await raw.equipmentSystem.findMany(by),
    monoblocks: await raw.monoblock.findMany(by),
    components: await raw.componentElement.findMany(by),
    registers: await raw.docRegister.findMany(by),
    registerItems: await raw.docRegisterItem.findMany(by),
    dictionaries: await raw.dictionary.findMany(by),
    items: await raw.dictionaryItem.findMany(by),
    templates: await raw.tagTemplate.findMany(by),
  };
}

const META = (o: unknown) => JSON.stringify(o);
const metaOf = (t: any) => JSON.parse(t?.metadata || '{}');
const CONFIG = '__tag_creation_config__';

async function seed() {
  for (const m of ['docRegisterItem', 'docRegister', 'componentElement', 'monoblock', 'equipmentSystem', 'tag', 'dictionaryItem', 'dictionary', 'tagTemplate', 'openRecord', 'project']) {
    await raw[m].deleteMany({});
  }
  await raw.project.create({ data: { id: 'P1', name: 'Проект Один', version: 3, customer: 'Заказчик' } });
  await raw.project.create({ data: { id: 'P2', name: 'Проект Два', version: 5 } });
  await raw.project.create({ data: { id: 'SYS', name: 'Общий диск', system: true, version: 2 } });
  // Проект P1: всё, что уходит вместе с ним
  const mk = (id: string, identifier: string, projectId: string, version: number, metadata?: unknown) =>
    raw.tag.create({ data: { id, identifier, projectId, codeKey: identifier, version, ...(metadata ? { metadata: META(metadata) } : {}) } });
  await mk('T1', 'AHU-1', 'P1', 3);
  await mk('T2', 'AHU-2', 'P1', 5);
  await mk('X1', 'OTHER-1', 'P2', 2);
  await raw.equipmentSystem.create({ data: { id: 'S1', name: 'SYS-1', projectId: 'P1' } });
  await raw.monoblock.create({ data: { id: 'M1', name: 'Блок 1', systemId: 'S1' } });
  await raw.componentElement.create({ data: { id: 'C1', name: 'Вентилятор', itemCode: 'FAN-1', monoblockId: 'M1' } });
  await raw.docRegister.create({ data: { id: 'R1', projectId: 'P1', name: 'ВДР-1' } });
  await raw.docRegisterItem.create({ data: { id: 'I1', registerId: 'R1', projectId: 'P1', contractorNo: 'DOC-001' } });
  await raw.dictionary.create({ data: { id: 'D1', projectId: 'P1', name: CONFIG } });
  // Проект P2: чужое, чему удаление P1 не должно мешать и что оно не должно трогать
  await raw.equipmentSystem.create({ data: { id: 'S2', name: 'SYS-2', projectId: 'P2' } });
  await raw.monoblock.create({ data: { id: 'M2', name: 'Блок 2', systemId: 'S2' } });
  await raw.componentElement.create({ data: { id: 'C2', name: 'Насос', itemCode: 'PUMP-1', monoblockId: 'M2' } });
  await raw.dictionary.create({ data: { id: 'D2', projectId: 'P2', name: CONFIG } });
  const item = (id: string, dictionaryId: string, parentId: string | null, nameRu: string, version = 1) =>
    raw.dictionaryItem.create({ data: { id, dictionaryId, code: id, nameRu, parentId, version } });
  await item('cat-a', 'D1', null, 'Категория А', 4);
  await item('opt-a1', 'D1', 'cat-a', 'Вариант 1');
  await item('opt-a2', 'D1', 'cat-a', 'Вариант 2');
  await item('sub-a2x', 'D1', 'opt-a2', 'Вложенный');
  await item('cat-b', 'D1', null, 'Категория Б', 2);
  await item('opt-b1', 'D1', 'cat-b', 'Вариант Б');
  await item('foreign', 'D2', null, 'Чужой пункт');
  await raw.tagTemplate.create({ data: { id: 'TT1', projectId: 'P1', schemaJson: '{"a":1}', version: 6 } });
  await sleep(5);
}

async function main() {
  let server: any;
  try {
    setDialect('sqlite');
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, raw, schema, () => {});
    setPrisma(withVersionBump(raw));
    await ensureOpenTable(raw);
    const events: any[] = [];
    setBroadcaster((event: string, payload: any) => { if (event === 'entity:changed') events.push(payload); });
    for (const [id, name] of [['u-petrova', 'Петрова А. А.'], ['u-sidorov', 'Сидоров С. С.']]) await raw.user.create({ data: { id, symbol: `s-${id}`, password: 'x', name } });

    const notified: string[] = [];
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, _res, next) => { (req as any).authUser = { id: req.header('x-test-user') || 'fixture-user', name: 'Инженер', role: 'ADMIN', isActive: true }; next(); });
    registerProjectRoutes(app, { enforce: async () => true, notifyAll: async (_c, title) => { notified.push(title); } });
    registerDictionaryRoutes(app);
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
    const holds = (userId: string, model: string, recordId: string, at: Date = new Date()) =>
      raw.openRecord.create({ data: { model, recordId, userId, holderKey: `window-${userId}`, at } });
    const petrova = [{ userId: 'u-petrova', name: 'Петрова А. А.' }];
    const open409 = (r: { status: number; body: any }) => r.status === 409 && r.body?.code === 'RECORD_OPEN';
    const isPlainRefusal = (b: any) => typeof b?.error === 'string' && /[а-яё]{4,}/i.test(b.error) && !/VERSION_CONFLICT|RECORD_/.test(b.error);
    const badVersions: unknown[] = ['abc', 0, -3, 1.5];
    const project = (id: string) => raw.project.findUnique({ where: { id } });
    const item = (id: string) => raw.dictionaryItem.findUnique({ where: { id } });
    const projectData = async (id: string) => ({
      tags: await raw.tag.count({ where: { projectId: id } }),
      systems: await raw.equipmentSystem.count({ where: { projectId: id } }),
      registers: await raw.docRegister.count({ where: { projectId: id } }),
      registerItems: await raw.docRegisterItem.count({ where: { projectId: id } }),
      dictionaries: await raw.dictionary.count({ where: { projectId: id } }),
    });

    // ───────────────────────── PUT /api/projects/:id ─────────────────────────
    console.log('\n── PUT /api/projects/:id');
    {
      await seed();
      const put = (id: string, body: Record<string, unknown>, as?: string) => send('PUT', `/api/projects/${id}`, body, as);
      let before = await world();
      const stale = await put('P1', { name: 'Моё имя', expectedVersion: 2 });
      check('проект: чужая версия — 409 с кодом отдельным полем', stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT', stale);
      check('проект: текст — из словаря, с названием, без кода', stale.body?.error === editChangedText('project', 'Проект Один') && isPlainRefusal(stale.body), stale.body);
      check('проект: в отказе текущая запись с версией', stale.body?.current?.id === 'P1' && stale.body.current.version === 3 && stale.body.current.customer === 'Заказчик', stale.body?.current);
      check('проект: чужая версия — в базе не изменилось ничего', same(before, await world()));
      for (const bad of badVersions) {
        const r = await put('P1', { name: 'Не пишем', expectedVersion: bad });
        check(`проект: версия ${JSON.stringify(bad)} — 400`, r.status === 400 && typeof r.body?.error === 'string', r);
      }
      check('проект: нечитаемая версия — в базе не изменилось ничего', same(before, await world()));

      const ok = await put('P1', { name: '  Новое имя  ', code: 'К-1', status: 'ARCHIVED', expectedVersion: 3 });
      check('проект: своя версия — 200 и запись применена (имя без пробелов)', ok.status === 200 && ok.body?.project?.name === 'Новое имя' && ok.body.project.code === 'К-1' && ok.body.project.status === 'ARCHIVED', ok);
      check('проект: версия выросла на 1 и отдана в ответе', ok.body?.project?.version === 4 && (await project('P1'))?.version === 4, ok.body?.project?.version);
      check('проект: поля, которых нет в запросе, не тронуты', ok.body?.project?.customer === 'Заказчик');
      const blank = await put('P1', { name: '   ', expectedVersion: 4 });
      check('проект: имя из одних пробелов — «Без названия»', blank.status === 200 && blank.body.project.name === 'Без названия', blank);

      const stringVersion = await put('P1', { description: 'строкой', expectedVersion: '5' });
      check('проект: версия строкой «5» читается как число', stringVersion.status === 200 && stringVersion.body.project.version === 6, stringVersion);
      const noVersion = await put('P1', { description: 'без версии' });
      check('проект: без версии (клиент без сверки) — 200', noVersion.status === 200 && (await project('P1'))?.description === 'без версии', noVersion);

      // Коллега правит настоящим маршрутом — версия уходит вперёд
      await sleep(5);
      const mine = (await project('P2'))!.version;
      const colleague = await put('P2', { description: 'правка коллеги' }, 'u-petrova');
      check('проект: правка коллеги двигает версию', colleague.status === 200 && (await project('P2'))!.version === mine + 1, colleague);
      before = await world();
      const lost = await put('P2', { name: 'Затираю', expectedVersion: mine });
      check('проект: версия до правки коллеги — 409, его правка цела', lost.status === 409 && lost.body?.current?.description === 'правка коллеги' && same(before, await world()), lost);

      const gone = await put('P-нет', { name: 'x', expectedVersion: 1 });
      check('проект: проекта нет — 404 RECORD_GONE', gone.status === 404 && gone.body?.code === 'RECORD_GONE', gone);
      check('проект: проекта нет — текст словаря без кода', gone.body?.error === editGoneText('project') && isPlainRefusal(gone.body), gone.body);
      check('проект: проекта нет — запись не создана', (await raw.project.count({ where: { id: 'P-нет' } })) === 0);

      const v = (await project('P2'))!.version;
      before = await world();
      const [a, b] = await Promise.all([put('P2', { name: 'А', expectedVersion: v }), put('P2', { name: 'Б', expectedVersion: v })]);
      check('проект: две правки с одной версией — прошла ровно одна, вторая 409', [a, b].filter((r) => r.status === 200).length === 1 && [a, b].filter((r) => r.status === 409 && r.body?.code === 'VERSION_CONFLICT').length === 1, [a.status, b.status]);
    }

    // ───────────────────────── DELETE /api/projects/:id ─────────────────────────
    console.log('\n── DELETE /api/projects/:id');
    const delProject = (id: string, version?: unknown, as?: string) =>
      send('DELETE', `/api/projects/${id}${version === undefined ? '' : `?expectedVersion=${encodeURIComponent(String(version))}`}`, undefined, as);
    {
      await seed();
      const v = (await project('P1'))!.version;
      const before = await world();
      const stale = await delProject('P1', v - 1);
      check('удаление проекта: чужая версия — 409 VERSION_CONFLICT', stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT', stale);
      check('удаление проекта: текст словаря (удаление изменённого), в отказе текущая запись', stale.body?.error === deleteChangedText('project', 'Проект Один') && isPlainRefusal(stale.body)
        && stale.body?.current?.id === 'P1' && stale.body.current.version === v, stale.body);
      check('удаление проекта: чужая версия — в базе не изменилось ничего (теги, оборудование, реестр, справочники)', same(before, await world()));
      for (const bad of badVersions) {
        const r = await delProject('P1', bad);
        check(`удаление проекта: версия ${JSON.stringify(bad)} — 400`, r.status === 400 && typeof r.body?.error === 'string', r);
      }
      check('удаление проекта: нечитаемая версия — в базе не изменилось ничего', same(before, await world()));
      const service = await delProject('SYS', 2);
      check('служебный проект — 400 как было, строка цела', service.status === 400 && /Служебный проект/.test(service.body?.error) && !!(await project('SYS')), service);
      const serviceNoVersion = await delProject('SYS');
      check('служебный проект без версии — тоже 400', serviceNoVersion.status === 400 && !!(await project('SYS')), serviceNoVersion);
      check('служебный проект — в базе не изменилось ничего', same(before, await world()));
    }
    console.log('\n── DELETE /api/projects/:id: открытые записи, два человека');
    {
      await seed();
      await holds('u-petrova', 'Project', 'P1');
      const before = await world();
      const r = await delProject('P1', 3);
      check('проект открыт у коллеги: 409 RECORD_OPEN', open409(r), r);
      check('проект открыт у коллеги: держатель и запись названы', same(r.body?.holders, petrova) && same(r.body?.record, { model: 'Project', id: 'P1', name: 'Проект Один' }), r.body);
      check('проект открыт у коллеги: текст словаря, без кода', r.body?.error === deleteOpenText('project', 'Проект Один', petrova) && isPlainRefusal(r.body), r.body?.error);
      check('проект открыт у коллеги: в базе не изменилось ничего', same(before, await world()));
      const noVersion = await delProject('P1');
      check('открыт у коллеги: и без версии удаление не проходит', open409(noVersion) && same(before, await world()), noVersion);
      const stale = await delProject('P1', 2);
      check('и изменён, и открыт: отказ по версии идёт первым', stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT', stale);
    }
    // Открытая внутри проекта запись — по одной на каждую из семи моделей
    const inside: Array<[string, string, string, string]> = [
      ['Tag', 'T1', 'tag', 'AHU-1'],
      ['EquipmentSystem', 'S1', 'system', 'SYS-1'],
      ['Monoblock', 'M1', 'block', 'Блок 1'],
      ['ComponentElement', 'C1', 'position', 'Вентилятор'],
      ['DocRegister', 'R1', 'register', 'ВДР-1'],
      ['DocRegisterItem', 'I1', 'registerItem', 'DOC-001'],
      ['DictionaryItem', 'opt-a2', 'dictionaryItem', 'Вариант 2'],
    ];
    for (const [model, id, noun, name] of inside) {
      await seed();
      await holds('u-petrova', model, id);
      const before = await world();
      const r = await delProject('P1', 3);
      check(`в проекте открыт ${model}: 409 RECORD_OPEN, назван именно он`, open409(r) && same(r.body?.record, { model, id, name }) && same(r.body?.holders, petrova), r);
      check(`в проекте открыт ${model}: текст «в проекте открыт…» из словаря`,
        r.body?.error === deleteOpenNestedText({ noun: 'project', name: 'Проект Один' }, { noun: noun as any, name }, petrova) && isPlainRefusal(r.body), r.body?.error);
      check(`в проекте открыт ${model}: в базе не изменилось ничего (каскад не выполнялся)`, same(before, await world()));
    }
    {
      await seed();
      await holds('u-petrova', 'Tag', 'X1');
      await holds('u-sidorov', 'ComponentElement', 'C2');
      await holds('u-petrova', 'DictionaryItem', 'foreign');
      const r = await delProject('P1', 3);
      check('открыто в другом проекте — удаление проходит', r.status === 200 && r.body?.success === true && !(await project('P1')), r);
      check('другой проект и его записи после удаления P1 целы', (await raw.tag.count({ where: { projectId: 'P2' } })) === 1 && !!(await raw.componentElement.findUnique({ where: { id: 'C2' } })) && !!(await item('foreign')));
    }
    {
      await seed();
      await holds('fixture-user', 'Tag', 'T1');
      await holds('fixture-user', 'Project', 'P1');
      const r = await delProject('P1', 3);
      check('своё окно удалению не мешает', r.status === 200 && !(await project('P1')), r);
    }
    {
      await seed();
      await holds('u-petrova', 'Tag', 'T1', new Date(Date.now() - 100_000));
      await holds('u-petrova', 'Project', 'P1', new Date(Date.now() - 100_000));
      const r = await delProject('P1', 3);
      check('несвежая отметка (100 с) проект не держит', r.status === 200 && !(await project('P1')), r);
    }
    console.log('\n── DELETE /api/projects/:id: удаление, откат, повтор, гонка');
    {
      await seed();
      notified.length = 0;
      const others = (await world());
      const r = await delProject('P1', 3);
      check('проект удалён: 200 {success, removed}, счёт тегов и самого проекта', r.status === 200 && r.body?.success === true && r.body.removed?.tag === 2 && r.body.removed?.project === 1 && !r.body?.alreadyGone, r);
      check('проект удалён: строка и всё проектное ушли', !(await project('P1')) && same(await projectData('P1'), { tags: 0, systems: 0, registers: 0, registerItems: 0, dictionaries: 0 })
        && (await raw.dictionaryItem.count({ where: { dictionaryId: 'D1' } })) === 0 && (await raw.tagTemplate.count({ where: { projectId: 'P1' } })) === 0
        && (await raw.monoblock.count({ where: { id: 'M1' } })) === 0 && (await raw.componentElement.count({ where: { id: 'C1' } })) === 0);
      const after = await world();
      check('проект удалён: чужие проекты, служебный и их записи нетронуты',
        same(others.projects.filter((p: any) => p.id !== 'P1'), after.projects) && same(others.tags.filter((t: any) => t.projectId !== 'P1'), after.tags)
        && same(others.systems.filter((s: any) => s.projectId !== 'P1'), after.systems) && same(others.items.filter((i: any) => i.dictionaryId !== 'D1'), after.items));
      check('проект удалён: команде отправлено уведомление с названием', notified.length === 1 && /Проект Один/.test(notified[0]), notified);
      const again = await delProject('P1', 3);
      check('повторное удаление — 200 alreadyGone, а не ошибка', again.status === 200 && again.body?.alreadyGone === true && same(after, await world()), again);
      check('повтор не шлёт второе уведомление', notified.length === 1, notified);
      const none = await delProject('P-нет', 7);
      check('записи с таким id нет — 200 alreadyGone', none.status === 200 && none.body?.alreadyGone === true, none);
    }
    {
      await seed();
      const r = await delProject('P2');
      check('удаление без версии (клиент без сверки) — 200', r.status === 200 && !(await project('P2')), r);
    }
    {
      // Каскад и строка проекта — одна транзакция: отказ удаления строки откатывает и каскад
      await seed();
      await raw.$executeRawUnsafe(`CREATE TRIGGER fail_project_row BEFORE DELETE ON "Project" WHEN old.id = 'P1' BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`);
      try {
        const before = await world();
        const r = await delProject('P1', 3);
        check('строка проекта не удалилась — 500', r.status === 500, r);
        check('…и каскад откатился вместе с ней: проект, теги, оборудование, реестр, справочники целы', same(before, await world()));
      } finally {
        await raw.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_project_row');
      }
      const ok = await delProject('P1', 3);
      check('после снятия сбоя то же удаление проходит', ok.status === 200 && !(await project('P1')), ok);
    }
    {
      // Версия проверяется до каскада: опоздавший ничего не снимает
      await seed();
      await send('PUT', '/api/projects/P1', { description: 'коллега' }, 'u-petrova');
      const before = await world();
      const r = await delProject('P1', 3);
      check('версия до правки коллеги — 409, проект и всё его содержимое целы', r.status === 409 && r.body?.code === 'VERSION_CONFLICT' && same(before, await world()), r);
    }
    {
      await seed();
      const [a, b] = await Promise.all([delProject('P2', 5), delProject('P2', 5)]);
      const wins = [a, b].filter((r) => r.status === 200 && !r.body?.alreadyGone).length;
      check('два удаления с одной версией: удалило ровно одно, проекта нет', wins === 1 && !(await project('P2')) && [a, b].every((r) => r.status === 200 || r.status === 409), [a, b]);
    }
    {
      // Общая база создана версией без таблицы открытых записей: удаление идёт без этой защиты
      await seed();
      await raw.$executeRawUnsafe('ALTER TABLE "OpenRecord" RENAME TO "OpenRecord_off"');
      try {
        const r = await delProject('P2', 5);
        check('таблицы открытых записей нет — удаление идёт', r.status === 200 && !(await project('P2')), r);
      } finally {
        await raw.$executeRawUnsafe('ALTER TABLE "OpenRecord_off" RENAME TO "OpenRecord"');
      }
    }

    // ───────────────────────── PUT /api/dictionaries/items/:itemId ─────────────────────────
    console.log('\n── PUT /api/dictionaries/items/:itemId');
    const putItem = (id: string, body: Record<string, unknown>, as?: string) => send('PUT', `/api/dictionaries/items/${id}`, body, as);
    {
      await seed();
      events.length = 0;
      let before = await world();
      const stale = await putItem('opt-a1', { code: 'opt-a1', nameRu: 'Моё имя', expectedVersion: 7 });
      check('пункт: чужая версия — 409 VERSION_CONFLICT', stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT', stale);
      check('пункт: текст словаря с названием, в отказе текущая запись', stale.body?.error === editChangedText('dictionaryItem', 'Вариант 1') && isPlainRefusal(stale.body)
        && stale.body?.current?.id === 'opt-a1' && stale.body.current.version === 1, stale.body);
      check('пункт: чужая версия — в базе не изменилось ничего, событие не отправлено', same(before, await world()) && events.length === 0, events);
      for (const bad of badVersions) {
        const r = await putItem('opt-a1', { nameRu: 'x', expectedVersion: bad });
        check(`пункт: версия ${JSON.stringify(bad)} — 400`, r.status === 400 && typeof r.body?.error === 'string', r);
      }
      check('пункт: нечитаемая версия — в базе не изменилось ничего', same(before, await world()));

      const ok = await putItem('opt-a1', { code: 'a1-new', nameRu: 'Вариант 1б', parentId: 'cat-b', expectedVersion: 1 });
      check('пункт: своя версия — 200, поля записаны, версия выросла и отдана', ok.status === 200 && ok.body?.item?.nameRu === 'Вариант 1б' && ok.body.item.code === 'a1-new' && ok.body.item.parentId === 'cat-b' && ok.body.item.version === 2, ok);
      check('пункт: правка сообщена проекту', events.some((e) => e.kind === 'dictionary' && e.projectId === 'P1'), events);
      const part = await putItem('opt-a1', { nameRu: 'Вариант 1в', expectedVersion: 2 });
      check('пункт: поля, которых нет в запросе, не тронуты (код и родитель)', part.status === 200 && part.body.item.code === 'a1-new' && part.body.item.parentId === 'cat-b', part);
      const noVersion = await putItem('opt-a1', { nameRu: 'Без версии' });
      check('пункт: без версии (клиент без сверки) — 200', noVersion.status === 200 && (await item('opt-a1'))?.nameRu === 'Без версии', noVersion);

      await sleep(5);
      const colleague = await putItem('opt-b1', { nameRu: 'Правка коллеги' }, 'u-petrova');
      before = await world();
      const lost = await putItem('opt-b1', { nameRu: 'Затираю', expectedVersion: 1 });
      check('пункт: версия до правки коллеги — 409, его правка цела', colleague.status === 200 && lost.status === 409 && lost.body?.current?.nameRu === 'Правка коллеги' && same(before, await world()), lost);

      before = await world();
      const gone = await putItem('нет-такого', { nameRu: 'x', expectedVersion: 1 });
      check('пункта нет — 404 RECORD_GONE', gone.status === 404 && gone.body?.code === 'RECORD_GONE', gone);
      check('пункта нет — текст словаря без кода, в базе не изменилось ничего', gone.body?.error === editGoneText('dictionaryItem') && isPlainRefusal(gone.body) && same(before, await world()), gone.body);

      const v = (await item('opt-a2'))!.version;
      const [a, b] = await Promise.all([putItem('opt-a2', { nameRu: 'А', expectedVersion: v }), putItem('opt-a2', { nameRu: 'Б', expectedVersion: v })]);
      check('пункт: две правки с одной версией — прошла ровно одна, вторая 409', [a, b].filter((r) => r.status === 200).length === 1 && [a, b].filter((r) => r.status === 409 && r.body?.code === 'VERSION_CONFLICT').length === 1, [a.status, b.status]);
    }
    console.log('\n── PUT пункта: переименование категории переносит значения тегов');
    {
      const seedTags = async () => {
        await seed();
        await raw.tag.update({ where: { id: 'T1' }, data: { metadata: META({ dynamicFields: { 'Категория А': 'значение 1', 'другая': 'x' }, keep: true }) } });
        await raw.tag.update({ where: { id: 'T2' }, data: { metadata: META({ dynamicFields: { 'cat-a': 'уже по id', 'Категория А': 'старое' } }) } });
        await raw.tag.update({ where: { id: 'X1' }, data: { metadata: META({ dynamicFields: { 'Категория А': 'чужой проект' } }) } });
      };
      await seedTags();
      let before = await world();
      const stale = await putItem('cat-a', { code: 'cat-a', nameRu: 'Категория А2', expectedVersion: 1 });
      check('переименование по чужой версии — 409, значения тегов не перенесены', stale.status === 409 && same(before, await world()), stale);

      const ok = await putItem('cat-a', { code: 'cat-a', nameRu: 'Категория А2', expectedVersion: 4 });
      check('переименование категории — 200, версия выросла', ok.status === 200 && ok.body?.item?.nameRu === 'Категория А2' && ok.body.item.version === 5, ok);
      const t1 = metaOf(await raw.tag.findUnique({ where: { id: 'T1' } }));
      const t2 = metaOf(await raw.tag.findUnique({ where: { id: 'T2' } }));
      const x1 = metaOf(await raw.tag.findUnique({ where: { id: 'X1' } }));
      check('значение тега перенесено на id категории, старый ключ остался', t1.dynamicFields['cat-a'] === 'значение 1' && t1.dynamicFields['Категория А'] === 'значение 1' && t1.keep === true && t1.dynamicFields.другая === 'x', t1);
      check('значение по id главнее старого ключа (не затёрто)', t2.dynamicFields['cat-a'] === 'уже по id', t2);
      check('теги другого проекта не тронуты', x1.dynamicFields['cat-a'] === undefined && x1.dynamicFields['Категория А'] === 'чужой проект', x1);

      // Вариант (с родителем) и неконфигурационный справочник значения тегов не переносят
      await seedTags();
      before = await world();
      const variant = await putItem('opt-a1', { nameRu: 'Вариант 1 новый', expectedVersion: 1 });
      check('переименование варианта значения тегов не переносит', variant.status === 200 && same(before.tags, (await world()).tags), variant);

      // Перенос и правка пункта — одна транзакция: сбой записи тега откатывает и переименование
      await seedTags();
      await raw.$executeRawUnsafe(`CREATE TRIGGER fail_tag_update BEFORE UPDATE ON "Tag" BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`);
      try {
        before = await world();
        const failed = await putItem('cat-a', { code: 'cat-a', nameRu: 'Категория А3', expectedVersion: 4 });
        check('сбой переноса значений — 500', failed.status === 500, failed);
        check('…и переименование откатилось вместе с ним (пункт, версия, теги)', same(before, await world()) && (await item('cat-a'))?.nameRu === 'Категория А', await item('cat-a'));
      } finally {
        await raw.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_tag_update');
      }
    }

    // ───────────────────────── DELETE /api/dictionaries/items/:itemId ─────────────────────────
    console.log('\n── DELETE /api/dictionaries/items/:itemId');
    const delItem = (id: string, version?: unknown, as?: string) =>
      send('DELETE', `/api/dictionaries/items/${id}${version === undefined ? '' : `?expectedVersion=${encodeURIComponent(String(version))}`}`, undefined, as);
    {
      await seed();
      events.length = 0;
      let before = await world();
      const stale = await delItem('cat-a', 3);
      check('удаление пункта: чужая версия — 409 VERSION_CONFLICT', stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT', stale);
      check('удаление пункта: текст словаря, в отказе текущая запись', stale.body?.error === deleteChangedText('dictionaryItem', 'Категория А') && isPlainRefusal(stale.body)
        && stale.body?.current?.id === 'cat-a' && stale.body.current.version === 4, stale.body);
      check('удаление пункта: чужая версия — в базе не изменилось ничего (потомки целы), событие не отправлено', same(before, await world()) && events.length === 0, events);
      for (const bad of badVersions) {
        const r = await delItem('cat-a', bad);
        check(`удаление пункта: версия ${JSON.stringify(bad)} — 400`, r.status === 400 && typeof r.body?.error === 'string', r);
      }
      check('удаление пункта: нечитаемая версия — в базе не изменилось ничего', same(before, await world()));

      const ok = await delItem('cat-a', 4);
      check('удаление пункта: своя версия — 200 {success}, событие проекту', ok.status === 200 && ok.body?.success === true && !ok.body?.alreadyGone && events.some((e) => e.kind === 'dictionary' && e.projectId === 'P1'), [ok, events]);
      const left = (await raw.dictionaryItem.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((r: any) => r.id);
      check('удаление пункта: категория и все потомки (варианты, вложенные) ушли, остальное цело', same(left, ['cat-b', 'foreign', 'opt-b1']), left);
      const again = await delItem('cat-a', 4);
      check('повторное удаление — 200 alreadyGone', again.status === 200 && again.body?.alreadyGone === true, again);
      const none = await delItem('нет-такого', 1);
      check('пункта с таким id нет — 200 alreadyGone', none.status === 200 && none.body?.alreadyGone === true, none);

      await seed();
      const noVersion = await delItem('opt-b1');
      check('удаление пункта без версии (клиент без сверки) — 200', noVersion.status === 200 && !(await item('opt-b1')), noVersion);

      await seed();
      await sleep(5);
      await putItem('opt-b1', { nameRu: 'Правка коллеги' }, 'u-petrova');
      before = await world();
      const lost = await delItem('opt-b1', 1);
      check('удаление пункта: версия до правки коллеги — 409, пункт цел', lost.status === 409 && lost.body?.code === 'VERSION_CONFLICT' && same(before, await world()), lost);

      await seed();
      const [a, b] = await Promise.all([delItem('cat-b', 2), delItem('cat-b', 2)]);
      check('два удаления с одной версией: удалило ровно одно', [a, b].filter((r) => r.status === 200 && !r.body?.alreadyGone).length === 1 && !(await item('cat-b')) && !(await item('opt-b1')), [a, b]);
    }
    console.log('\n── DELETE пункта: открытые записи, потомки, откат');
    {
      await seed();
      await holds('u-petrova', 'DictionaryItem', 'cat-a');
      const before = await world();
      const r = await delItem('cat-a', 4);
      check('пункт открыт у коллеги: 409 RECORD_OPEN, запись названа', open409(r) && same(r.body?.record, { model: 'DictionaryItem', id: 'cat-a', name: 'Категория А' }) && same(r.body?.holders, petrova), r);
      check('пункт открыт у коллеги: текст словаря, в базе не изменилось ничего', r.body?.error === deleteOpenText('dictionaryItem', 'Категория А', petrova) && isPlainRefusal(r.body) && same(before, await world()), r.body?.error);
      const stale = await delItem('cat-a', 3);
      check('и изменён, и открыт: отказ по версии идёт первым', stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT', stale);
    }
    for (const child of ['opt-a1', 'sub-a2x']) {
      await seed();
      await holds('u-sidorov', 'DictionaryItem', child);
      const before = await world();
      const r = await delItem('cat-a', 4);
      const name = child === 'opt-a1' ? 'Вариант 1' : 'Вложенный';
      check(`у категории открыт потомок ${child}: 409 RECORD_OPEN, назван потомок`, open409(r) && same(r.body?.record, { model: 'DictionaryItem', id: child, name }), r);
      check(`у категории открыт потомок ${child}: текст «в … открыт…», в базе не изменилось ничего`,
        r.body?.error === deleteOpenNestedText({ noun: 'dictionaryItem', name: 'Категория А' }, { noun: 'dictionaryItem', name }, [{ userId: 'u-sidorov', name: 'Сидоров С. С.' }]) && same(before, await world()), r.body?.error);
    }
    {
      await seed();
      await holds('u-petrova', 'DictionaryItem', 'cat-b');
      const r = await delItem('cat-a', 4);
      check('открыт другой пункт — удаление проходит', r.status === 200 && !(await item('cat-a')), r);
    }
    {
      await seed();
      await holds('fixture-user', 'DictionaryItem', 'opt-a1');
      const r = await delItem('cat-a', 4);
      check('своё окно удалению не мешает', r.status === 200 && !(await item('cat-a')), r);
    }
    {
      await seed();
      await holds('u-petrova', 'DictionaryItem', 'opt-a1', new Date(Date.now() - 100_000));
      const r = await delItem('cat-a', 4);
      check('несвежая отметка (100 с) потомка не держит', r.status === 200 && !(await item('cat-a')), r);
    }
    {
      // Потомки уходят в той же транзакции, что и пункт: сбой удаления пункта возвращает и потомков
      await seed();
      await raw.$executeRawUnsafe(`CREATE TRIGGER fail_item_row BEFORE DELETE ON "DictionaryItem" WHEN old.id = 'cat-a' BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`);
      try {
        const before = await world();
        const r = await delItem('cat-a', 4);
        check('пункт не удалился — 500', r.status === 500, r);
        check('…и потомки вернулись вместе с ним (удаление потомков — в той же транзакции)', same(before, await world()));
      } finally {
        await raw.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_item_row');
      }
    }
    {
      await seed();
      await raw.$executeRawUnsafe('ALTER TABLE "OpenRecord" RENAME TO "OpenRecord_off"');
      try {
        const r = await delItem('cat-b', 2);
        check('таблицы открытых записей нет — удаление пункта идёт', r.status === 200 && !(await item('cat-b')), r);
      } finally {
        await raw.$executeRawUnsafe('ALTER TABLE "OpenRecord_off" RENAME TO "OpenRecord"');
      }
    }

    // ───────────────────────── POST пункта в справочник ─────────────────────────
    console.log('\n── POST /api/projects/:projectId/dictionaries/:dictionaryId/items');
    {
      await seed();
      const before = await world();
      const gone = await send('POST', '/api/projects/P1/dictionaries/D-нет/items', { code: 'n1', nameRu: 'Новый' });
      check('справочника нет — 404 RECORD_GONE, а не 500', gone.status === 404 && gone.body?.code === 'RECORD_GONE', gone);
      check('справочника нет — текст словаря «в который вы добавляете…», без кода', gone.body?.error === createInsideGoneText('dictionary') && isPlainRefusal(gone.body), gone.body);
      check('справочника нет — в базе не изменилось ничего', same(before, await world()));
      const ok = await send('POST', '/api/projects/P1/dictionaries/D1/items', { code: 'n1', nameRu: 'Новый', parentId: 'cat-b' });
      check('справочник есть — 200, пункт создан с версией 1', ok.status === 200 && ok.body?.item?.nameRu === 'Новый' && ok.body.item.version === 1 && !!(await item(ok.body.item.id)), ok);
    }

    // ───────────────────────── PUT tag-template ─────────────────────────
    console.log('\n── PUT /api/projects/:projectId/tag-template');
    const putTemplate = (projectId: string, body: Record<string, unknown>) => send('PUT', `/api/projects/${projectId}/tag-template`, body);
    {
      await seed();
      let before = await world();
      const stale = await putTemplate('P1', { schemaJson: '{"a":2}', expectedVersion: 5 });
      check('шаблон: чужая версия — 409 VERSION_CONFLICT с текущим шаблоном', stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT' && stale.body?.current?.version === 6 && stale.body.current.schemaJson === '{"a":1}', stale);
      check('шаблон: текст словаря без кода, в базе не изменилось ничего', stale.body?.error === editChangedText('tagTemplate') && isPlainRefusal(stale.body) && same(before, await world()), stale.body);
      for (const bad of badVersions) {
        const r = await putTemplate('P1', { schemaJson: '{"a":9}', expectedVersion: bad });
        check(`шаблон: версия ${JSON.stringify(bad)} — 400`, r.status === 400 && typeof r.body?.error === 'string', r);
      }
      check('шаблон: нечитаемая версия — в базе не изменилось ничего', same(before, await world()));
      const ok = await putTemplate('P1', { schemaJson: '{"a":2}', expectedVersion: 6 });
      check('шаблон: своя версия — 200, версия выросла и отдана', ok.status === 200 && ok.body?.template?.schemaJson === '{"a":2}' && ok.body.template.version === 7, ok);
      const noVersion = await putTemplate('P1', { schemaJson: '{"a":3}' });
      check('шаблон: без версии — 200 (сверка с чтением сервера)', noVersion.status === 200 && noVersion.body.template.version === 8, noVersion);
      check('шаблон один на проект — строка не размножилась', (await raw.tagTemplate.count({ where: { projectId: 'P1' } })) === 1);

      const created = await putTemplate('P2', { schemaJson: '{"b":1}' });
      check('шаблона нет — создание, версия 1 в ответе', created.status === 200 && created.body?.template?.version === 1 && created.body.template.projectId === 'P2', created);
      before = await world();
      const goneVersion = await (async () => { await raw.tagTemplate.deleteMany({ where: { projectId: 'P2' } }); return putTemplate('P2', { schemaJson: '{"b":2}', expectedVersion: 1 }); })();
      check('версия пришла, а шаблона уже нет — 404 RECORD_GONE, шаблон не создан', goneVersion.status === 404 && goneVersion.body?.code === 'RECORD_GONE' && goneVersion.body.error === editGoneText('tagTemplate') && (await raw.tagTemplate.count({ where: { projectId: 'P2' } })) === 0, goneVersion);

      const v = (await raw.tagTemplate.findUnique({ where: { projectId: 'P1' } }))!.version;
      const [a, b] = await Promise.all([putTemplate('P1', { schemaJson: '{"c":1}', expectedVersion: v }), putTemplate('P1', { schemaJson: '{"c":2}', expectedVersion: v })]);
      check('шаблон: две правки с одной версией — прошла ровно одна, вторая 409', [a, b].filter((r) => r.status === 200).length === 1 && [a, b].filter((r) => r.status === 409 && r.body?.code === 'VERSION_CONFLICT').length === 1, [a.status, b.status]);
      const [c, d] = await Promise.all([putTemplate('P2', { schemaJson: '{"d":1}' }), putTemplate('P2', { schemaJson: '{"d":2}' })]);
      check('шаблон: два создания разом — оба 200, строка одна', c.status === 200 && d.status === 200 && (await raw.tagTemplate.count({ where: { projectId: 'P2' } })) === 1, [c.status, d.status]);
    }
    
    console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${checks})`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await raw.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
