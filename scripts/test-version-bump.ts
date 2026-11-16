/**
 * Рост целой версии записи расширением клиента (server/versionBump.ts,
 * docs/roadmap/offline-work.md, 0.4).
 *
 * Настоящая SQLite-база: расширение Prisma не сыграть заглушкой — важно, что
 * оно видит операции и внутри `$transaction`, и в паре с наблюдением
 * (`traceDatabase`), с которым стоит в одной цепочке. Что держим, на каждой из
 * 12 моделей:
 *  • `update`, `updateMany`, `upsert` (ветка update) поднимают версию на 1;
 *    ветка create версию не двигает (1 по умолчанию);
 *  • то же внутри интерактивной и массивной `$transaction`;
 *  • явная версия в данных (`withBump`, сверка) уважается — двойного роста нет;
 *  • `keepVersion` — без роста, метка не уходит в базу;
 *  • модель вне списка (у ProjectTagPolicy своя «version» — номер настроек) не затронута;
 *  • перенос карточки тега по холсту версию не двигает, правка поля — двигает;
 *  • клиент сервера (server.ts) собирается с расширением.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { VERSIONED_MODELS, keepVersion, withVersionBump } from '../server/versionBump.js';
import { withBump, bumpElementsOfTags } from '../server/equipmentVersion.js';
import { writeTag } from '../server/tagWrite.js';
import { traceDatabase } from '../server/diagnostics.js';
import { setPrisma } from '../server/context.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-version-bump-'));
const dbPath = path.join(temp, 'fixture.sqlite');
const raw = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  checks++;
  console.log(`✓ ${label}`);
};

/** Модель: делегат клиента, данные создания, поле, которое правят. */
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

async function main() {
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, raw, schema, () => {});
    for (const s of SPECS) await raw[s.delegate].create({ data: s.create });
    await raw.projectTagPolicy.create({ data: { id: 'pol1', projectId: 'p1' } });

    // Клиент собран так же, как на сервере: расширение внутри, наблюдение снаружи
    process.env.FLUX_DIAGNOSTICS_DIR = path.join(temp, 'diagnostics');
    const db = traceDatabase(withVersionBump(raw));
    setPrisma(db);

    // Список моделей совпадает со схемой: у каждой модели с `version Int @default(1)` расширение есть,
    // кроме двух, у кого «version» — своё доменное число (номер настроек и шаблона), а не версия записи.
    // Новая модель с такой колонкой роняет проверку: её надо внести в список или в исключения сознательно
    const OWN_VERSION = new Set(['ProjectTagPolicy', 'BlankTemplate']);
    const schemaModels = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
      .filter((m) => /^\s*version\s+Int\s+@default\(1\)/m.test(m[2]) && !OWN_VERSION.has(m[1]))
      .map((m) => m[1]).sort();
    check('перечень моделей расширения — модели схемы с колонкой version Int @default(1), кроме двух с доменной version',
      JSON.stringify([...VERSIONED_MODELS].sort()) === JSON.stringify(schemaModels), { VERSIONED_MODELS, schemaModels });
    check('в перечне 12 моделей', VERSIONED_MODELS.length === 12 && SPECS.length === 12);

    const versionOf = async (s: Spec) => (await raw[s.delegate].findUnique({ where: { id: s.create.id } })).version;

    for (const s of SPECS) {
      const d = db[s.delegate];
      const id = s.create.id;
      const at = async (n: number, what: string) => check(`${s.model}: ${what} — версия ${n}`, (await versionOf(s)) === n, await versionOf(s));
      await at(1, 'новая запись');
      await d.update({ where: { id }, data: { [s.field]: s.create[s.field] ?? 'x1' } });
      await at(2, 'update');
      await d.updateMany({ where: { id }, data: { [s.field]: s.create[s.field] ?? 'x2' } });
      await at(3, 'updateMany');
      await d.upsert({ where: { id }, update: { [s.field]: s.create[s.field] ?? 'x3' }, create: { ...s.create, id: `${id}-never` } });
      await at(4, 'upsert, ветка update');
      await d.upsert({ where: { id }, update: {}, create: { ...s.create, id: `${id}-never` } });
      await at(4, 'upsert с пустым update (создай, если нет) — без роста');
      check(`${s.model}: upsert не создал лишнего`, (await raw[s.delegate].findUnique({ where: { id: `${id}-never` } })) === null);
    }

    // upsert, ветка create: версия по умолчанию, расширение её не двигает
    {
      const created = await db.tag.upsert({ where: { id: 'tu1' }, update: { brand: 'x' }, create: { id: 'tu1', identifier: 'U-1', projectId: 'p1' } });
      check('upsert, ветка create: версия 1', created.version === 1, created.version);
      const again = await db.tag.upsert({ where: { id: 'tu1' }, update: { brand: 'y' }, create: { id: 'tu1', identifier: 'U-1', projectId: 'p1' } });
      check('upsert второй раз (ветка update): версия 2', again.version === 2, again.version);
    }

    for (const s of SPECS) {
      const id = s.create.id;
      const before = await versionOf(s);
      // интерактивная транзакция
      await db.$transaction(async (tx: any) => {
        await tx[s.delegate].update({ where: { id }, data: { [s.field]: s.create[s.field] ?? 'tx1' } });
        await tx[s.delegate].updateMany({ where: { id }, data: { [s.field]: s.create[s.field] ?? 'tx2' } });
      });
      check(`${s.model}: две записи в интерактивной транзакции — версия +2`, (await versionOf(s)) === before + 2, await versionOf(s));
      // массив
      await db.$transaction([
        db[s.delegate].update({ where: { id }, data: { [s.field]: s.create[s.field] ?? 'ar1' } }),
        db[s.delegate].updateMany({ where: { id }, data: { [s.field]: s.create[s.field] ?? 'ar2' } }),
      ]);
      check(`${s.model}: две записи в транзакции-массиве — версия ещё +2`, (await versionOf(s)) === before + 4, await versionOf(s));
      // откат транзакции версию не оставляет
      await db.$transaction(async (tx: any) => {
        await tx[s.delegate].update({ where: { id }, data: { [s.field]: s.create[s.field] ?? 'rb' } });
        throw new Error('откат');
      }).catch(() => {});
      check(`${s.model}: откат транзакции возвращает версию`, (await versionOf(s)) === before + 4, await versionOf(s));
      // явная версия: уважается, двойного роста нет
      await db[s.delegate].update({ where: { id }, data: { [s.field]: s.create[s.field] ?? 'ex', version: { increment: 5 } } });
      check(`${s.model}: явное «version: { increment: 5 }» — ровно +5, без добавки`, (await versionOf(s)) === before + 9, await versionOf(s));
      await db[s.delegate].updateMany({ where: { id }, data: { version: 100 } });
      check(`${s.model}: явное «version: 100» записано как есть`, (await versionOf(s)) === 100, await versionOf(s));
      // keepVersion
      await db[s.delegate].update({ where: { id }, data: keepVersion({ [s.field]: s.create[s.field] ?? 'kv1' }) });
      await db[s.delegate].updateMany({ where: { id }, data: keepVersion({ [s.field]: s.create[s.field] ?? 'kv2' }) });
      await db[s.delegate].upsert({ where: { id }, update: keepVersion({ [s.field]: s.create[s.field] ?? 'kv3' }), create: s.create });
      check(`${s.model}: keepVersion в update, updateMany и upsert — версия 100`, (await versionOf(s)) === 100, await versionOf(s));
      // `undefined` вместо версии — всё равно «версии нет»
      await db[s.delegate].update({ where: { id }, data: { [s.field]: s.create[s.field] ?? 'un', version: undefined } });
      check(`${s.model}: «version: undefined» — запись считается без версии, рост +1`, (await versionOf(s)) === 101, await versionOf(s));
    }

    // Метка keepVersion переживает копирование данных (`{ ...data }`, withCodeKey) и не доходит до базы
    {
      const data = { ...keepVersion({ brand: 'copy' }) };
      await db.tag.update({ where: { id: 't1' }, data });
      const t = await raw.tag.findUnique({ where: { id: 't1' } });
      check('keepVersion переживает копирование данных, значение записано', t.brand === 'copy' && t.version === 101, t);
    }

    // ── Модель вне списка ──
    {
      const pol = await raw.projectTagPolicy.findUnique({ where: { projectId: 'p1' } });
      await db.projectTagPolicy.update({ where: { projectId: 'p1' }, data: { policyJson: '{"a":1}' } });
      const after = await raw.projectTagPolicy.findUnique({ where: { projectId: 'p1' } });
      check('ProjectTagPolicy (своя «version» — номер настроек) расширением не двигается', pol.version === 1 && after.version === 1, after.version);
    }

    // ── Позиции: withBump и bumpElementsOfTags — рост один, не два ──
    {
      const c = async () => (await raw.componentElement.findUnique({ where: { id: 'c1' } })).version;
      const base = await c();
      await db.componentElement.update({ where: { id: 'c1' }, data: withBump({ name: 'бл1-а' }) });
      check('withBump: версия позиции +1, а не +2', (await c()) === base + 1, await c());
      // связь позиция–тег многие-ко-многим; пишем через raw: вложенная запись расширением не видна
      await raw.componentElement.update({ where: { id: 'c1' }, data: { tags: { connect: { id: 't1' } } } });
      const linkedBase = await c();
      await bumpElementsOfTags(db, ['t1']);
      check('bumpElementsOfTags: позиция тега +1, а не +2', (await c()) === linkedBase + 1, await c());
    }

    // ── Тег: перенос карточки по холсту и правка поля ──
    {
      const tag = async () => raw.tag.findUnique({ where: { id: 't1' } });
      const v0 = (await tag()).version;
      const moved = await writeTag(db, 't1', { metadata: { x: 120, y: 40 } });
      const afterMove = await tag();
      check('перенос карточки (x, y): запись произошла, версия не выросла', !moved.unchanged && JSON.parse(afterMove.metadata).x === 120 && afterMove.version === v0, afterMove.version);
      const moved2 = await writeTag(db, 't1', { metadata: { x: 130, y: 50, _noPos: false } });
      check('повторный перенос тоже без роста', !moved2.unchanged && (await tag()).version === v0);
      await writeTag(db, 't1', { fields: { brand: 'Другой' } });
      check('правка поля тега поднимает версию на 1', (await tag()).version === v0 + 1, (await tag()).version);
      await writeTag(db, 't1', { metadata: { comment: 'коммент', x: 140 } });
      check('правка данных вместе с положением поднимает версию на 1', (await tag()).version === v0 + 2, (await tag()).version);
    }

    // ── Сервер собирает клиента с расширением ──
    {
      const server = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
      check('server.ts: клиент создаётся как withChangeFeed(…, traceDatabase(withVersionBump(…))) — одно место для запуска и переключения базы',
        /withChangeFeed\(\s*buildPrismaClient\([^)]*\)\s*,\s*\(\w+\)\s*=>\s*traceDatabase\(\s*withVersionBump\(/.test(server));
    }

    console.log(`\nРост версии записи: ${checks} проверок пройдено`);
  } finally {
    await raw.$disconnect().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
