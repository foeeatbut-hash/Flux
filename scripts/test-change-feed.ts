/**
 * Журнал изменений (server/changeFeed.ts, docs/roadmap/offline-work.md, 1).
 *
 * Настоящие базы: расширение Prisma заглушкой не сыграть. SQLite — всегда; PostgreSQL —
 * если есть (FLUX_TEST_PG_URL или временный кластер из установленного PostgreSQL),
 * иначе набор честно печатает FLUX_VERIFY_SKIP: «та же транзакция» на SQLite доказывается
 * плохо (у адаптера одно соединение, и запись мимо транзакции откатывается вместе с ней),
 * поэтому главная проверка — не результат отката, а ИДЕНТИФИКАТОР транзакции у записи и
 * у строки журнала (шпион на клиентах читает его у каждой операции).
 *
 * Что держим, на каждой из 12 моделей:
 *  • create, createMany (без id), upsert (обе ветки), update, updateMany, delete, deleteMany —
 *    по строке журнала на запись, с версией и видом;
 *  • пустой upsert.update и keepVersion — строки нет;
 *  • откат транзакции — нет и строки; пакетная форма и внешний клиент внутри транзакции — громкая ошибка;
 *  • строка и запись — одна транзакция (шпион), в том числе у одиночной записи вне транзакции;
 *  • автор — из контекста запроса, у параллельных запросов свой; вне запроса — «система»;
 *  • проект позиции/моноблока/пункта/файла берётся по цепочке родителей;
 *  • каскад удаления проекта оставляет строки удаления детей;
 *  • очистка: старше 90 дней уходят все, кроме create; нет таблицы — журнал выключен с записью в лог.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureRemoteSchema } from '../server/schema-sync.js';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { VERSIONED_MODELS, keepVersion, withVersionBump } from '../server/versionBump.js';
import { ChangeFeedError, changeFeedEnabled, prepareChangeFeed, runWithActor, withChangeFeed } from '../server/changeFeed.js';
import { deleteProjectData } from '../server/projectDelete.js';
import { setDialect } from '../server/ddl.js';

const require = createRequire(import.meta.url);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-change-feed-'));
let checks = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  checks++;
  console.log(`✓ ${label}`);
};

interface Spec { model: string; delegate: string; create: any; field: string }
const SPECS: Spec[] = [
  { model: 'Project', delegate: 'project', create: { id: 'p1', name: 'P' }, field: 'name' },
  { model: 'Tag', delegate: 'tag', create: { id: 't1', identifier: 'AHU-1', projectId: 'p1' }, field: 'brand' },
  { model: 'EquipmentSystem', delegate: 'equipmentSystem', create: { id: 's1', name: 'у1', projectId: 'p1' }, field: 'name' },
  { model: 'Monoblock', delegate: 'monoblock', create: { id: 'm1', name: 'мн1', systemId: 's1' }, field: 'name' },
  { model: 'ComponentElement', delegate: 'componentElement', create: { id: 'c1', name: 'бл1', itemCode: 'бл1', monoblockId: 'm1' }, field: 'name' },
  { model: 'DocRegister', delegate: 'docRegister', create: { id: 'r1', projectId: 'p1' }, field: 'name' },
  { model: 'DocRegisterItem', delegate: 'docRegisterItem', create: { id: 'i1', registerId: 'r1', projectId: 'p1' }, field: 'titleRu' },
  { model: 'ConstructorDoc', delegate: 'constructorDoc', create: { id: 'd1', projectId: 'p1' }, field: 'name' },
  { model: 'FileNode', delegate: 'fileNode', create: { id: 'f1', name: 'a.txt', filePath: '/a.txt' }, field: 'name' },
  { model: 'Dictionary', delegate: 'dictionary', create: { id: 'dc1', projectId: 'p1', name: 'Словарь' }, field: 'name' },
  { model: 'DictionaryItem', delegate: 'dictionaryItem', create: { id: 'di1', dictionaryId: 'dc1', code: 'K', nameRu: 'Ключ' }, field: 'nameRu' },
  { model: 'TagTemplate', delegate: 'tagTemplate', create: { id: 'tt1', projectId: 'p1', schemaJson: '{}' }, field: 'schemaJson' },
];

const ANNA = { userId: 'u-anna', userName: 'Анна Иванова' };
const BORIS = { userId: 'u-boris', userName: 'Борис Петров' };

/** Данные второй записи той же модели: уникальные поля — со своим суффиксом (TagTemplate — у каждой запись свой проект) */
function variant(s: Spec, id: string, _raw?: any): any {
  const data: any = { ...s.create, id };
  for (const k of ['identifier', 'itemCode', 'code', 'name', 'filePath']) if (typeof data[k] === 'string') data[k] = `${data[k]}-${id}`;
  return data;
}

type TxLog = Array<{ model: string; operation: string; tx: string | null }>;
const WRITES = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany']);

/** Клиент, собранный как на сервере (server.ts), плюс шпион внутри цепочки: он читает идентификатор транзакции каждой операции */
function buildClient(raw: any, log: TxLog) {
  return withChangeFeed(raw, (inner: any) => withVersionBump(inner).$extends({
    query: {
      $allOperations: ({ model, operation, args, query, __internalParams }: any) => {
        if (model) log.push({ model, operation, tx: __internalParams?.transaction?.id ?? null });
        return query(args);
      },
    },
  }));
}

async function scenario(label: string, raw: any, makeProjectTemplates: (id: string) => Promise<void>) {
  const log: TxLog = [];
  const db = buildClient(raw, log);
  const feed = async (model: string, id: string) =>
    (await raw.changeFeed.findMany({ where: { model, recordId: id }, orderBy: { seq: 'asc' } })).map((r: any) => `${r.kind}:${r.version}`);
  const total = () => raw.changeFeed.count();
  check(`${label}: журнал включён после подготовки`, await prepareChangeFeed(db), changeFeedEnabled(db));

  // ── Записи от имени Анны: по каждой модели ──
  for (const s of SPECS) await runWithActor(ANNA, () => db[s.delegate].create({ data: s.create }));
  for (const s of SPECS) {
    const d = db[s.delegate];
    const id = s.create.id;
    const name = `${label}: ${s.model}`;
    check(`${name}: create — «create:1»`, JSON.stringify(await feed(s.model, id)) === '["create:1"]', await feed(s.model, id));
    const first = (await raw.changeFeed.findFirst({ where: { model: s.model, recordId: id } }));
    check(`${name}: строка несёт автора, а время — серверное`, first.userId === ANNA.userId && first.userName === ANNA.userName && Math.abs(Date.now() - new Date(first.at).getTime()) < 120_000, first);

    await runWithActor(ANNA, async () => {
      await d.update({ where: { id }, data: { [s.field]: s.create[s.field] ?? 'x1' } });
      await d.updateMany({ where: { id }, data: { [s.field]: s.create[s.field] ?? 'x2' } });
      await d.upsert({ where: { id }, update: { [s.field]: s.create[s.field] ?? 'x3' }, create: { ...s.create, id: `${id}-never` } });
    });
    check(`${name}: update, updateMany, upsert(update) — версии 2, 3, 4`, JSON.stringify(await feed(s.model, id)) === '["create:1","update:2","update:3","update:4"]', await feed(s.model, id));

    // Ничего не поменялось в версии — и журнал молчит
    const was = await total();
    await runWithActor(ANNA, async () => {
      await d.upsert({ where: { id }, update: {}, create: { ...s.create, id: `${id}-never` } });
      await d.update({ where: { id }, data: keepVersion({ [s.field]: s.create[s.field] ?? 'k1' }) });
      await d.updateMany({ where: { id }, data: keepVersion({ [s.field]: s.create[s.field] ?? 'k2' }) });
      await d.upsert({ where: { id }, update: keepVersion({ [s.field]: s.create[s.field] ?? 'k3' }), create: { ...s.create, id: `${id}-never` } });
    });
    check(`${name}: пустой upsert.update и keepVersion — строк нет`, (await total()) === was, (await total()) - was);

    // upsert, ветка create
    const up = variant(s, `${id}-up`, raw);
    if (s.model === 'TagTemplate') { up.projectId = `pt-${id}-up`; await makeProjectTemplates(up.projectId); }
    await runWithActor(ANNA, () => d.upsert({ where: { id: up.id }, update: { [s.field]: 'zz' }, create: up }));
    check(`${name}: upsert(create) — «create:1»`, JSON.stringify(await feed(s.model, up.id)) === '["create:1"]', await feed(s.model, up.id));

    // createMany без id: id назначаются, по строке на запись
    const rnd = () => Math.random().toString(36).slice(2, 8);
    const many: any[] = [];
    for (let i = 0; i < 2; i++) {
      const m = variant(s, `${id}-m${i}-${rnd()}`, raw);
      delete m.id;
      if (s.model === 'TagTemplate') { m.projectId = `pt-${rnd()}`; await makeProjectTemplates(m.projectId); }
      many.push(m);
    }
    const beforeIds = new Set((await raw[s.delegate].findMany({ select: { id: true } })).map((r: any) => r.id));
    await runWithActor(ANNA, () => d.createMany({ data: many }));
    const newIds = (await raw[s.delegate].findMany({ select: { id: true } })).map((r: any) => r.id).filter((x: string) => !beforeIds.has(x));
    check(`${name}: createMany без id — создано 2`, newIds.length === 2, newIds);
    const rowsMany = await raw.changeFeed.findMany({ where: { model: s.model, recordId: { in: newIds } } });
    check(`${name}: createMany — по строке «create» на запись, id совпадают с записями`, rowsMany.length === 2 && rowsMany.every((r: any) => r.kind === 'create' && r.version === 1 && r.userId === ANNA.userId), rowsMany);

    // updateMany и deleteMany по двум записям: по строке на каждую
    await runWithActor(BORIS, () => d.updateMany({ where: { id: { in: newIds } }, data: { [s.field]: s.create[s.field] ?? 'um' } }));
    const afterUpdate = await raw.changeFeed.findMany({ where: { model: s.model, recordId: { in: newIds }, kind: 'update' } });
    check(`${name}: updateMany по двум — две строки «update:2» от Бориса`, afterUpdate.length === 2 && afterUpdate.every((r: any) => r.version === 2 && r.userId === BORIS.userId && r.userName === BORIS.userName), afterUpdate);
    await runWithActor(BORIS, () => d.deleteMany({ where: { id: { in: newIds } } }));
    const afterDelete = await raw.changeFeed.findMany({ where: { model: s.model, recordId: { in: newIds }, kind: 'delete' } });
    check(`${name}: deleteMany по двум — две строки «delete:2»`, afterDelete.length === 2 && afterDelete.every((r: any) => r.version === 2), afterDelete);

    await runWithActor(BORIS, () => d.delete({ where: { id: up.id } }));
    check(`${name}: delete — «create:1, delete:1»`, JSON.stringify(await feed(s.model, up.id)) === '["create:1","delete:1"]', await feed(s.model, up.id));
  }

  // ── Узкий ответ: select/omit не ломают журнал и не меняют форму ответа ──
  {
    const r = await runWithActor(ANNA, () => db.tag.update({ where: { id: 't1' }, data: { brand: 'sel' }, select: { brand: true } }));
    check(`${label}: update с select — ответ без лишних полей`, JSON.stringify(Object.keys(r)) === '["brand"]', r);
    const o = await runWithActor(ANNA, () => db.tag.update({ where: { id: 't1' }, data: { brand: 'omit' }, omit: { id: true, version: true } }));
    check(`${label}: update с omit — id и версия не вернулись, а строки журнала есть`, o.id === undefined && o.version === undefined && (await feed('Tag', 't1')).slice(-2).join() === 'update:5,update:6', await feed('Tag', 't1'));
  }

  // ── skipDuplicates (у SQLite такого параметра нет) ──
  if (label === 'PostgreSQL') {
    const before = await total();
    await runWithActor(ANNA, () => db.tag.createMany({ data: [{ id: 't1', identifier: 'dup', projectId: 'p1' }, { identifier: 'new-after-dup', projectId: 'p1' }], skipDuplicates: true }));
    check(`${label}: createMany(skipDuplicates) — строка только у новой`, (await total()) - before === 1, (await total()) - before);
  }

  // ── Откат, фиксация, ошибки устройства ──
  {
    const before = await total();
    const v = (await raw.tag.findUnique({ where: { id: 't1' } })).version;
    await runWithActor(ANNA, () => db.$transaction(async (tx: any) => {
      await tx.tag.update({ where: { id: 't1' }, data: { brand: 'rollback' } });
      await tx.componentElement.update({ where: { id: 'c1' }, data: { name: 'rollback' } });
      throw new Error('откат');
    }).catch(() => {}));
    check(`${label}: откат транзакции — нет ни записи, ни строк журнала`, (await total()) === before && (await raw.tag.findUnique({ where: { id: 't1' } })).version === v);
    await runWithActor(ANNA, () => db.$transaction(async (tx: any) => {
      await tx.tag.update({ where: { id: 't1' }, data: { brand: 'commit1' } });
      await tx.tag.update({ where: { id: 't1' }, data: { brand: 'commit2' } });
    }));
    check(`${label}: фиксация — две строки`, (await total()) === before + 2 && (await feed('Tag', 't1')).slice(-2).join() === `update:${v + 1},update:${v + 2}`, await feed('Tag', 't1'));

    let e1: any; let e2: any; let e3: any;
    try { await db.$transaction([db.tag.update({ where: { id: 't1' }, data: { brand: 'batch' } })]); } catch (e) { e1 = e; }
    check(`${label}: пакетная $transaction([…]) с версионной моделью — громкая ошибка, записи нет`, e1 instanceof ChangeFeedError && (await raw.tag.findUnique({ where: { id: 't1' } })).brand === 'commit2', e1?.message);
    try { await db.$transaction(async () => { await db.tag.update({ where: { id: 't1' }, data: { brand: 'outer' } }); }); } catch (e) { e2 = e; }
    check(`${label}: внешний клиент внутри транзакции — громкая ошибка`, e2 instanceof ChangeFeedError && /внешнему клиенту/.test(e2.message) && (await raw.tag.findUnique({ where: { id: 't1' } })).brand === 'commit2', e2?.message);
    // Невесионная модель в пакете — не наша забота
    try { await db.$transaction([db.appSetting.deleteMany({ where: { key: 'нет такого' } })]); } catch (e) { e3 = e; }
    check(`${label}: пакет с моделью вне журнала проходит`, !e3, e3?.message);
  }

  // ── Автор из контекста ──
  {
    const tags = await Promise.all(Array.from({ length: 8 }, (_, i) => raw.tag.create({ data: { id: `par-${i}`, identifier: `PAR-${i}`, projectId: 'p1' } })));
    await Promise.all(tags.map((t, i) => runWithActor(i % 2 ? ANNA : BORIS, async () => {
      await new Promise((r) => setTimeout(r, 5 * (8 - i)));
      await db.tag.update({ where: { id: t.id }, data: { brand: `b${i}` } });
    })));
    const rows = await raw.changeFeed.findMany({ where: { model: 'Tag', recordId: { startsWith: 'par-' } } });
    check(`${label}: параллельные запросы — у каждой строки свой автор`, rows.length === 8 && rows.every((r: any) => r.userId === (Number(r.recordId.slice(4)) % 2 ? ANNA.userId : BORIS.userId)), rows.map((r: any) => [r.recordId, r.userId]));
    await db.tag.update({ where: { id: 'par-0' }, data: { brand: 'вне запроса' } });
    const sys = await raw.changeFeed.findFirst({ where: { recordId: 'par-0' }, orderBy: { seq: 'desc' } });
    check(`${label}: вне запроса автора нет («система»)`, sys.userId === null && sys.userName === '', sys);
  }

  // ── Проект записи по цепочке родителей ──
  {
    const proj = async (model: string, id: string) => (await raw.changeFeed.findFirst({ where: { model, recordId: id }, orderBy: { seq: 'asc' } })).projectId;
    const got = { project: await proj('Project', 'p1'), tag: await proj('Tag', 't1'), monoblock: await proj('Monoblock', 'm1'), element: await proj('ComponentElement', 'c1'), item: await proj('DictionaryItem', 'di1'), file: await proj('FileNode', 'f1') };
    check(`${label}: проект записи — сам, свой projectId и по цепочке родителей; файл без папки — пусто`,
      got.project === 'p1' && got.tag === 'p1' && got.monoblock === 'p1' && got.element === 'p1' && got.item === 'p1' && got.file === null, got);
  }

  // ── Каскад удаления проекта: строки удаления детей ──
  {
    await raw.project.create({ data: { id: 'pd', name: 'Удаляемый' } });
    await raw.tag.create({ data: { id: 'td', identifier: 'TD-1', projectId: 'pd' } });
    await raw.equipmentSystem.create({ data: { id: 'sd', name: 'у', projectId: 'pd' } });
    await raw.monoblock.create({ data: { id: 'md', name: 'м', systemId: 'sd' } });
    await raw.componentElement.create({ data: { id: 'cd', name: 'п', itemCode: 'п', monoblockId: 'md' } });
    await raw.docRegister.create({ data: { id: 'rd', projectId: 'pd' } });
    await raw.docRegisterItem.create({ data: { id: 'id', registerId: 'rd', projectId: 'pd' } });
    await raw.constructorDoc.create({ data: { id: 'dd', projectId: 'pd' } });
    await raw.dictionary.create({ data: { id: 'dcd', projectId: 'pd', name: 'С' } });
    await raw.dictionaryItem.create({ data: { id: 'dicd', dictionaryId: 'dcd', code: 'K', nameRu: 'К' } });
    await raw.tagTemplate.create({ data: { id: 'ttd', projectId: 'pd', schemaJson: '{}' } });
    await raw.folder.create({ data: { id: 'fod', name: 'папка', projectId: 'pd' } });
    await raw.fileNode.create({ data: { id: 'fd', name: 'f', filePath: '/f', folderId: 'fod' } });
    await runWithActor(ANNA, () => db.$transaction((tx: any) => deleteProjectData(tx, 'pd'), { timeout: 60_000 }));
    const deleted = await raw.changeFeed.findMany({ where: { kind: 'delete', recordId: { in: ['pd', 'td', 'sd', 'md', 'cd', 'rd', 'id', 'dd', 'dcd', 'dicd', 'ttd', 'fd'] } } });
    const byModel = Object.fromEntries(deleted.map((r: any) => [r.model, r.recordId]));
    check(`${label}: каскад проекта — строка удаления у проекта и у детей всех 12 моделей`,
      deleted.length === 12 && VERSIONED_MODELS.every((m) => byModel[m]) && deleted.every((r: any) => r.projectId === 'pd' && r.userId === ANNA.userId),
      deleted.map((r: any) => `${r.model}:${r.recordId}:${r.projectId}`));
  }

  // ── Одна транзакция: у каждой записи и у каждой строки журнала — один и тот же номер транзакции ──
  {
    const writes = log.filter((e) => VERSIONED_MODELS.includes(e.model) && WRITES.has(e.operation));
    const feeds = log.filter((e) => e.model === 'ChangeFeed' && e.operation === 'createMany');
    check(`${label}: шпион: записи версионных моделей прошли ${writes.length} раз, строк журнала записано ${feeds.length} раз`, writes.length > 100 && feeds.length > 50);
    check(`${label}: каждая запись версионной модели — внутри транзакции (даже одиночная)`, writes.every((e) => e.tx), writes.filter((e) => !e.tx).slice(0, 3));
    check(`${label}: каждая строка журнала — внутри транзакции и той же, что запись`, feeds.every((f) => f.tx && writes.some((w) => w.tx === f.tx)), feeds.filter((f) => !f.tx).slice(0, 3));
  }
  return db;
}

// ── PostgreSQL: переменная окружения или временный кластер ──
function startTempPg(): { url: string; stop: () => void } | null {
  const bin = (() => {
    for (const v of fs.existsSync('/usr/lib/postgresql') ? fs.readdirSync('/usr/lib/postgresql') : []) {
      const p = `/usr/lib/postgresql/${v}/bin`;
      if (fs.existsSync(`${p}/initdb`)) return p;
    }
    return '';
  })();
  if (!bin) return null;
  const dir = path.join(temp, 'pg');
  fs.mkdirSync(dir, { recursive: true });
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const run = (cmd: string) => (asRoot
    ? spawnSync('su', ['postgres', '-s', '/bin/bash', '-c', cmd], { encoding: 'utf8' })
    : spawnSync('/bin/bash', ['-c', cmd], { encoding: 'utf8' }));
  if (asRoot) { fs.chmodSync(temp, 0o755); fs.chmodSync(dir, 0o777); }
  const port = 55000 + Math.floor(Math.random() * 900);
  const init = run(`${bin}/initdb -D ${dir}/data -A trust >${dir}/init.log 2>&1 && ${bin}/pg_ctl -D ${dir}/data -o "-p ${port} -k ${dir}" -l ${dir}/log -w start >/dev/null 2>&1`);
  if (init.status !== 0) return null;
  const mk = run(`${bin}/createdb -h ${dir} -p ${port} feed`);
  if (mk.status !== 0) { run(`${bin}/pg_ctl -D ${dir}/data -m immediate stop >/dev/null 2>&1`); return null; }
  return {
    url: `postgresql://${asRoot ? 'postgres' : os.userInfo().username}@localhost:${port}/feed?host=${dir}`,
    stop: () => { run(`${bin}/pg_ctl -D ${dir}/data -m immediate stop >/dev/null 2>&1`); },
  };
}

async function main() {
  let pgStop: (() => void) | null = null;
  try {
    // ── SQLite ──
    const { PrismaClient } = require('../prisma-clients/client-sqlite');
    const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
    const dbPath = path.join(temp, 'fixture.sqlite');
    const raw = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, raw, schema, () => {});
    const makeTemplateProject = async (id: string) => { await raw.project.upsert({ where: { id }, update: {}, create: { id, name: id } }); };
    const db = await scenario('SQLite', raw, makeTemplateProject);

    // Журнал выключается громко, когда таблицы нет, а запись идёт как прежде
    {
      const dbPath2 = path.join(temp, 'no-feed.sqlite');
      const raw2 = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath2}` }) });
      await bootstrapLocalDatabase(dbPath2, raw2, schema, () => {});
      await raw2.$executeRawUnsafe('DROP TABLE "ChangeFeed"');
      const lines: string[] = [];
      const db2 = withChangeFeed(raw2, (c: any) => withVersionBump(c));
      check('таблицы журнала нет — подготовка возвращает false и пишет в лог «ВЫКЛЮЧЕН»',
        (await prepareChangeFeed(db2, (m) => lines.push(m))) === false && lines.some((l) => /ВЫКЛЮЧЕН/.test(l)), lines);
      await db2.project.create({ data: { id: 'x1', name: 'X' } });
      await db2.$transaction(async (tx: any) => { await tx.project.update({ where: { id: 'x1' }, data: { name: 'Y' } }); });
      check('без таблицы запись идёт без журнала и версия растёт', (await raw2.project.findUnique({ where: { id: 'x1' } })).version === 2);
      await raw2.$disconnect();
    }

    // Очистка: старше 90 дней уходит всё, кроме create
    {
      const old = new Date(Date.now() - 100 * 86_400_000);
      const recent = new Date(Date.now() - 80 * 86_400_000);
      await raw.changeFeed.createMany({ data: [
        { model: 'Tag', recordId: 'old-c', version: 1, kind: 'create', at: old },
        { model: 'Tag', recordId: 'old-u', version: 2, kind: 'update', at: old },
        { model: 'Tag', recordId: 'old-d', version: 2, kind: 'delete', at: old },
        { model: 'Tag', recordId: 'new-u', version: 2, kind: 'update', at: recent },
      ] });
      await prepareChangeFeed(db);
      const left = (await raw.changeFeed.findMany({ where: { recordId: { in: ['old-c', 'old-u', 'old-d', 'new-u'] } } })).map((r: any) => r.recordId).sort();
      check('очистка: старые update/delete стёрты, старый create и свежие остались', JSON.stringify(left) === '["new-u","old-c"]', left);
    }

    // Номер растёт (автонумерация), в том числе после очистки
    {
      const seqs = (await raw.changeFeed.findMany({ orderBy: { seq: 'asc' }, select: { seq: true } })).map((r: any) => r.seq);
      check('seq — растущий номер без повторов', seqs.every((n: number, i: number) => i === 0 || n > seqs[i - 1]) && seqs.length > 100);
    }
    await raw.$disconnect();

    // ── PostgreSQL ──
    let pgUrl = process.env.FLUX_TEST_PG_URL || '';
    if (!pgUrl) {
      const started = startTempPg();
      if (started) { pgUrl = started.url; pgStop = started.stop; }
    }
    if (!pgUrl) {
      console.log('FLUX_VERIFY_SKIP: PostgreSQL не найден (задайте FLUX_TEST_PG_URL) — проверка «той же транзакции» на второй базе не выполнена');
    } else {
      const { PrismaClient: PgClient } = require('../prisma-clients/client-pg');
      const { PrismaPg } = require('@prisma/adapter-pg');
      const pg = new PgClient({ adapter: new PrismaPg({ connectionString: pgUrl }) });
      setDialect('postgresql');
      try {
        await ensureRemoteSchema(pg, 'postgresql', fs.readFileSync(path.join(process.cwd(), 'prisma/schema.postgresql.prisma'), 'utf8'), () => {});
        const pgTemplate = async (id: string) => { await pg.project.upsert({ where: { id }, update: {}, create: { id, name: id } }); };
        const pgDb = await scenario('PostgreSQL', pg, pgTemplate);
        // Откат: именно то, что на SQLite доказать нельзя — запись по другому соединению пережила бы откат
        const before = await pg.changeFeed.count();
        await pgDb.$transaction(async (tx: any) => { await tx.tag.update({ where: { id: 't1' }, data: { brand: 'pg-rollback' } }); throw new Error('откат'); }).catch(() => {});
        check('PostgreSQL: откат — строка журнала не пережила транзакцию', (await pg.changeFeed.count()) === before);
        const seq = await pg.changeFeed.findFirst({ orderBy: { seq: 'desc' } });
        check('PostgreSQL: seq выдаёт база (SERIAL)', typeof seq.seq === 'number' && seq.seq > 100, seq);
      } finally {
        setDialect('sqlite');
        await pg.$disconnect().catch(() => {});
      }
    }
    console.log(`\nЖурнал изменений: ${checks} проверок пройдено`);
  } finally {
    try { pgStop?.(); } catch (_) { /* кластер временный */ }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// Запись мимо транзакции на SQLite виснет на мьютексе адаптера, цикл событий пустеет, и Node выходит с кодом 0:
// без этой сторожки такая поломка выглядела бы зелёной
let finished = false;
process.on('exit', (code) => { if (!finished && code === 0) { console.error('Набор оборвался, не дойдя до конца (зависание на записи мимо транзакции?)'); process.exitCode = 1; } });
setTimeout(() => { console.error('Набор не уложился в 4 минуты'); process.exit(1); }, 240_000).unref();
main().then(() => { finished = true; process.exit(0); }, (e) => { console.error(e); process.exit(1); });
