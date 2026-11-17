/**
 * Одно место сверки версии записи (server/versionGuard.ts,
 * docs/roadmap/offline-work.md, 0.5).
 *
 * Настоящая SQLite-база. Гонку «между чтением и записью» на SQLite иначе не
 * сыграть (транзакции идут по очереди, а чужая запись внутри своей транзакции
 * откатилась бы вместе с ней), поэтому её играет `build` / `before` на клиенте
 * без `$transaction` — пути заглушек проверок. Что держим:
 *  • чужая версия → `VersionConflict` с текущей записью, запись не применена;
 *  • версия верна → запись проходит, версия растёт на 1 (и на клиенте без
 *    расширения, и на клиенте с ним — без двойного роста);
 *  • проигранная гонка: условие `version` в `updateMany` не даёт записать
 *    поверх; клиент с версией получает отказ, клиент без версии — повтор;
 *  • две одновременные записи с одной версией — проходит одна;
 *  • то же для удаления; удаление не повторяется, каскад откатывается;
 *  • `expectedVersionOf` не принимает мусор; `sendVersionConflict` — 409 с кодом отдельным полем;
 *  • `openCheck`: запись, открытая у другого сотрудника (и вложенное в каскаде), не удаляется — отказ
 *    `RecordOpen` до каскада и до удаления; свои окна и несвежие отметки не мешают; таблицы нет —
 *    удаление идёт; иной сбой чтения — `OpenCheckUnavailable`, запись на месте;
 *  • ответы `RECORD_OPEN` (409), `RECORD_GONE` (404) и 503 — формы и тексты словаря.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import {
  VersionConflict, RecordOpen, OpenCheckUnavailable, expectedVersionOf, guardedDelete, guardedWrite,
  sendVersionConflict, sendRecordOpen, sendRecordGone, sendOpenCheckUnavailable, sendGuardRefusal,
} from '../server/versionGuard.js';
import { ensureOpenTable, type OpenRef } from '../server/openRecords.js';
import { OPEN_FRESH_MS } from '../src/lib/openRecordTime.js';
import { deleteOpenText, deleteOpenNestedText, editGoneText, createInsideGoneText, openCheckUnavailableText } from '../src/lib/refusalTexts.js';
import { keepVersion, withVersionBump } from '../server/versionBump.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-version-guard-'));
const dbPath = path.join(temp, 'fixture.sqlite');
const raw = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  checks++;
  console.log(`✓ ${label}`);
};
const stale = (current: any) => `Тег изменили: версия ${current.version}`;
const rejects = async <T>(fn: () => Promise<T>): Promise<any> => { try { await fn(); } catch (e) { return e; } return null; };

async function main() {
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, raw, schema, () => {});
    await raw.project.create({ data: { id: 'p1', name: 'P' } });
    let seq = 0;
    const newTag = async (brand = 'исходный') => raw.tag.create({ data: { id: `t${++seq}`, identifier: `T-${seq}`, projectId: 'p1', brand } });
    const tagOf = (id: string) => raw.tag.findUnique({ where: { id } });
    const ext = withVersionBump(raw);
    /**
     * Клиент без `$transaction` — путь «заглушки проверок» (inTransaction зовёт функцию на самом клиенте):
     * чужая запись между чтением и записью тогда настоящая и не откатывается вместе с транзакцией, как
     * откатилась бы внутри неё. Это и есть гонка PostgreSQL/MariaDB, где параллельный запрос виден сразу.
     * Версия растёт явно, чтобы проверка не зависела от расширения.
     */
    const bare: any = { tag: raw.tag, dictionary: raw.dictionary };
    const foreignWrite = (db: any, id: string) => db.tag.update({ where: { id }, data: { brand: 'чужой', version: { increment: 1 } } });

    // ── expectedVersionOf ──
    check('нет версии → undefined', [undefined, null, ''].every((v) => expectedVersionOf(v) === undefined));
    check('целое ≥ 1 принимается числом и строкой', expectedVersionOf(3) === 3 && expectedVersionOf('3') === 3 && expectedVersionOf(' 12 ') === 12 && expectedVersionOf(1) === 1);
    check('мусор → null (маршрут ответит 400)', [0, -1, 1.5, 'abc', '3x', '1.5', '-2', true, {}, [], NaN, Infinity, 2 ** 60, '0'].every((v) => expectedVersionOf(v) === null),
      [0, -1, 1.5, 'abc', '3x', true, {}, [], NaN].map((v) => [String(v), expectedVersionOf(v)]));

    // ── Версия совпала ──
    for (const [name, client] of [['клиент без расширения', raw], ['клиент с расширением', ext]] as const) {
      const t = await newTag();
      const done: any = await guardedWrite(client, { model: 'tag', id: t.id, expectedVersion: 1, staleMessage: stale, build: () => ({ data: { brand: 'новый' }, extra: 'e' }) });
      const row = await tagOf(t.id);
      check(`${name}: версия верна — запись прошла, версия ровно +1 (без двойного роста)`, row.brand === 'новый' && row.version === 2 && done.after.version === 2 && done.before.version === 1 && done.extra === 'e', row);
    }
    {
      const t = await newTag();
      const done: any = await guardedWrite(ext, { model: 'tag', id: t.id, staleMessage: stale, build: (cur) => ({ data: { brand: `${cur.brand}+` } }) });
      check('клиент без версии, без гонки: запись проходит', done.after.brand === 'исходный+' && done.after.version === 2, done.after);
      const same = await guardedWrite(ext, { model: 'tag', id: t.id, expectedVersion: 2, staleMessage: stale, build: () => ({ data: keepVersion({ brand: 'без роста' }) }) });
      check('keepVersion в данных сверяемой записи: версия не растёт', (await tagOf(t.id)).version === 2 && (await tagOf(t.id)).brand === 'без роста' && !!same);
      check('нет записи → null', (await guardedWrite(ext, { model: 'tag', id: 'нет-такого', expectedVersion: 1, staleMessage: stale, build: () => ({ data: {} }) })) === null);
    }

    // ── Чужая версия ──
    {
      const t = await newTag();
      await raw.tag.update({ where: { id: t.id }, data: { brand: 'правка коллеги', version: { increment: 1 } } });
      let built = false;
      const e = await rejects(() => guardedWrite(raw, { model: 'tag', id: t.id, expectedVersion: 1, staleMessage: stale, build: () => { built = true; return { data: { brand: 'устаревшая правка' } }; } }));
      check('чужая версия: VersionConflict', e instanceof VersionConflict, e?.name);
      check('отказ несёт текущую запись и текст для человека', e.current?.id === t.id && e.current.version === 2 && e.current.brand === 'правка коллеги' && e.message === 'Тег изменили: версия 2', { cur: e.current, msg: e.message });
      const row = await tagOf(t.id);
      check('чужая версия: запись не применена, build не вызывался', row.brand === 'правка коллеги' && row.version === 2 && !built, row);
      const ahead = await rejects(() => guardedWrite(raw, { model: 'tag', id: t.id, expectedVersion: 99, staleMessage: stale, build: () => ({ data: { brand: 'x' } }) }));
      check('версия «из будущего» тоже конфликт', ahead instanceof VersionConflict && (await tagOf(t.id)).brand === 'правка коллеги');
      // ВДР-приём: сверка по updatedAt
      const seen = (await tagOf(t.id)).updatedAt;
      await raw.tag.update({ where: { id: t.id }, data: { brand: 'ещё правка', version: { increment: 1 } } });
      const e2 = await rejects(() => guardedWrite(raw, { model: 'tag', id: t.id, expectedUpdatedAt: seen.toISOString(), matchUpdatedAt: true, staleMessage: stale, build: () => ({ data: { brand: 'y' } }) }));
      check('expectedUpdatedAt устарел — конфликт, запись не применена', e2 instanceof VersionConflict && (await tagOf(t.id)).brand === 'ещё правка');
    }

    // ── Проигранная гонка (чужая запись между чтением и записью) ──
    {
      const t = await newTag();
      const e = await rejects(() => guardedWrite(bare, {
        model: 'tag', id: t.id, expectedVersion: 1, staleMessage: stale,
        build: async (_cur, tx) => { await foreignWrite(tx, t.id); return { data: { brand: 'поверх чужого' } }; },
      }));
      const row = await tagOf(t.id);
      check('гонка, клиент с версией: отказ с текущей записью, поверх чужого не записано', e instanceof VersionConflict && row.brand === 'чужой' && row.version === 2 && e.current?.brand === 'чужой', { row, cur: e?.current });
    }
    {
      const t = await newTag();
      let calls = 0;
      const done: any = await guardedWrite(bare, {
        model: 'tag', id: t.id, staleMessage: stale,
        build: async (cur, tx) => { if (++calls === 1) await foreignWrite(tx, t.id); return { data: { brand: `${cur.brand}+мой` } }; },
      });
      const row = await tagOf(t.id);
      check('гонка, клиент без версии: правка повторена по свежему чтению, чужое сохранено', calls === 2 && row.brand === 'чужой+мой' && row.version === 3 && !!done, { calls, row });
    }
    {
      const t = await newTag();
      let calls = 0;
      const e = await rejects(() => guardedWrite(bare, {
        model: 'tag', id: t.id, staleMessage: stale,
        build: async (_cur, tx) => { calls++; await foreignWrite(tx, t.id); return { data: { brand: 'не успею' } }; },
      }));
      const row = await tagOf(t.id);
      check('гонка, клиент без версии, каждая попытка проиграна: 4 попытки и отказ с текущей записью', e instanceof VersionConflict && calls === 4 && row.brand === 'чужой' && e.current?.version === row.version, { calls, e: e?.message });
    }

    // ── Две одновременные записи с одной версией ──
    for (let round = 1; round <= 5; round++) {
      const t = await newTag();
      const results = await Promise.allSettled(['A', 'B'].map((who) => guardedWrite(ext, { model: 'tag', id: t.id, expectedVersion: 1, staleMessage: stale, build: () => ({ data: { brand: who } }) })));
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      const row = await tagOf(t.id);
      check(`одновременно ${round}: прошла одна запись, вторая — конфликт`, won.length === 1 && lost.length === 1 && lost[0].reason instanceof VersionConflict && row.version === 2 && ['A', 'B'].includes(row.brand), results.map((r) => r.status));
    }
    {
      // Клиенты без версии в гонке не теряют правок друг друга: каждая дописывает своё
      const t = await newTag('');
      const results = await Promise.all(['a', 'b', 'c', 'd'].map((k) => guardedWrite(ext, { model: 'tag', id: t.id, staleMessage: stale, build: (cur) => ({ data: { brand: cur.brand + k } }) })));
      const row = await tagOf(t.id);
      check('одновременные записи без версии: все четыре применены, ничего не потеряно', results.every(Boolean) && [...row.brand].sort().join('') === 'abcd' && row.version === 5, row);
    }

    // ── Удаление ──
    {
      const t = await newTag();
      const gone: any = await guardedDelete(ext, { model: 'tag', id: t.id, expectedVersion: 1, staleMessage: stale });
      check('удаление с верной версией: запись удалена, возвращена прежней', gone?.before.id === t.id && (await tagOf(t.id)) === null);
      check('удаление несуществующей записи → null', (await guardedDelete(ext, { model: 'tag', id: t.id, expectedVersion: 1, staleMessage: stale })) === null);
    }
    {
      const t = await newTag();
      await raw.tag.update({ where: { id: t.id }, data: { brand: 'правка коллеги', version: { increment: 1 } } });
      let touched = false;
      const e = await rejects(() => guardedDelete(raw, { model: 'tag', id: t.id, expectedVersion: 1, staleMessage: stale, before: async () => { touched = true; } }));
      check('удаление по чужой версии: конфликт с текущей записью, запись на месте, каскад не начат', e instanceof VersionConflict && e.current?.brand === 'правка коллеги' && !!(await tagOf(t.id)) && !touched);
    }
    {
      const t = await newTag();
      let calls = 0;
      const e = await rejects(() => guardedDelete(bare, {
        model: 'tag', id: t.id, staleMessage: stale,
        before: async (db) => { calls++; await foreignWrite(db, t.id); }, // чужая правка между чтением и удалением
      }));
      const row = await tagOf(t.id);
      check('удаление, проигранная гонка: отказ без повтора, запись на месте с чужой правкой', e instanceof VersionConflict && calls === 1 && row?.brand === 'чужой' && e.current?.brand === 'чужой', { calls, row });
    }
    {
      const t = await newTag();
      const other = await newTag('соседний');
      const e = await rejects(() => guardedDelete(raw, {
        model: 'tag', id: t.id, staleMessage: stale,
        before: async (tx) => { await tx.tag.update({ where: { id: other.id }, data: { brand: 'каскад' } }); throw new Error('каскад не удался'); },
      }));
      check('сбой каскада перед удалением: запись на месте, записанное каскадом откатилось', e?.message === 'каскад не удался' && !!(await tagOf(t.id)) && (await tagOf(other.id)).brand === 'соседний');
    }
    {
      const t = await newTag();
      const results = await Promise.allSettled([1, 2].map(() => guardedDelete(ext, { model: 'tag', id: t.id, expectedVersion: 1, staleMessage: stale })));
      const done = results.filter((r) => r.status === 'fulfilled' && r.value).length;
      check('два одновременных удаления: запись удалена ровно одним', done === 1 && (await tagOf(t.id)) === null, results.map((r) => r.status));
    }

    // ── Другая модель: общий механизм, а не тег ──
    {
      await raw.dictionary.create({ data: { id: 'dc1', projectId: 'p1', name: 'Словарь' } });
      const done: any = await guardedWrite(raw, { model: 'dictionary', id: 'dc1', expectedVersion: 1, staleMessage: () => 'x', build: () => ({ data: { name: 'Новый' } }) });
      const e = await rejects(() => guardedWrite(raw, { model: 'dictionary', id: 'dc1', expectedVersion: 1, staleMessage: () => 'Словарь изменили', build: () => ({ data: { name: 'Старый' } }) }));
      check('справочник: запись под версией и конфликт тем же кодом', done.after.version === 2 && e instanceof VersionConflict && e.message === 'Словарь изменили');
      const gone = await guardedDelete(raw, { model: 'dictionary', id: 'dc1', expectedVersion: 2, staleMessage: () => 'x' });
      check('справочник: удаление под версией', !!gone && (await raw.dictionary.findUnique({ where: { id: 'dc1' } })) === null);
    }

    // ── Открытые записи при удалении ──
    console.log('\n── openCheck');
    await raw.user.create({ data: { id: 'U1', symbol: 's-1', password: 'x', name: 'Иванов И. И.' } });
    await raw.user.create({ data: { id: 'U2', symbol: 's-2', password: 'x', name: 'Петрова А. А.' } });
    const seedEquipment = async () => {
      await raw.openRecord.deleteMany({});
      await raw.componentElement.deleteMany({});
      await raw.monoblock.deleteMany({});
      await raw.equipmentSystem.deleteMany({});
      await raw.equipmentSystem.create({ data: { id: 'S1', name: 'ПВ-1', projectId: 'p1' } });
      await raw.monoblock.create({ data: { id: 'M1', name: 'Блок 1', systemId: 'S1' } });
      await raw.componentElement.create({ data: { id: 'C1', name: 'Вентилятор', itemCode: 'FAN-1', monoblockId: 'M1', role: 'ВЕНТИЛЯТОР' } });
      await raw.componentElement.create({ data: { id: 'C2', name: 'Двигатель', itemCode: 'FAN-1/м', monoblockId: 'M1', role: 'ДВИГАТЕЛЬ', parentElementId: 'C1' } });
      await raw.componentElement.create({ data: { id: 'C3', name: 'Клапан', itemCode: 'VLV-1', monoblockId: 'M1', role: 'КЛАПАН' } });
    };
    const holds = (userId: string, model: string, recordId: string, holderKey = `win-${userId}`, at = new Date()) =>
      raw.openRecord.create({ data: { model, recordId, userId, holderKey, at } });
    const count = async () => ({ c: await raw.componentElement.count(), m: await raw.monoblock.count(), s: await raw.equipmentSystem.count() });
    const compOf = (id: string) => raw.componentElement.findUnique({ where: { id } });
    const elementDelete = (id: string, userId: string, extra: Record<string, unknown> = {}) => guardedDelete(raw, {
      model: 'componentElement', id, staleMessage: stale, openCheck: { userId }, ...extra,
    });
    const cascadeOfSystem = async (db: any): Promise<OpenRef[]> => [
      ...(await db.monoblock.findMany({ where: { systemId: 'S1' }, select: { id: true, name: true } })).map((m: any) => ({ model: 'Monoblock', id: m.id, name: m.name })),
      ...(await db.componentElement.findMany({ where: { monoblock: { systemId: 'S1' } }, select: { id: true, name: true } })).map((c: any) => ({ model: 'ComponentElement', id: c.id, name: c.name })),
    ];

    await seedEquipment();
    {
      const gone: any = await elementDelete('C3', 'U1');
      check('openCheck: никто не держит — удаление проходит', gone?.before.id === 'C3' && !(await compOf('C3')));
    }
    {
      await seedEquipment();
      await holds('U2', 'ComponentElement', 'C3');
      let cascaded = false;
      const e = await rejects(() => elementDelete('C3', 'U1', { before: async () => { cascaded = true; } }));
      check('открыта у коллеги: RecordOpen с держателем, записью и текстом словаря',
        e instanceof RecordOpen && e.holders.length === 1 && e.holders[0].userId === 'U2' && e.holders[0].name === 'Петрова А. А.'
        && e.record.model === 'ComponentElement' && e.record.id === 'C3' && e.record.name === 'Клапан'
        && e.message === deleteOpenText('position', 'Клапан', [{ name: 'Петрова А. А.' }]), e);
      check('открыта у коллеги: запись на месте, каскад не начат', !!(await compOf('C3')) && !cascaded);
    }
    {
      await seedEquipment();
      await holds('U1', 'ComponentElement', 'C3');
      await holds('U1', 'ComponentElement', 'C3', 'win-U1-второе');
      const gone: any = await elementDelete('C3', 'U1');
      check('свои окна удалению не мешают (у человека их может быть несколько)', gone?.before.id === 'C3' && !(await compOf('C3')));
    }
    {
      await seedEquipment();
      await holds('U2', 'ComponentElement', 'C3', 'win-U2', new Date(Date.now() - OPEN_FRESH_MS - 5000));
      const gone: any = await elementDelete('C3', 'U1');
      check('отметка старше 90 с не держит: удаление проходит', gone?.before.id === 'C3');
    }
    {
      await seedEquipment();
      await holds('U2', 'Monoblock', 'C3');
      await holds('U2', 'EquipmentSystem', 'C3');
      const gone: any = await elementDelete('C3', 'U1');
      check('чужая модель с тем же id запись не держит', gone?.before.id === 'C3');
    }
    {
      // Вложенное: удаляется установка, у коллеги открыта позиция внутри неё
      await seedEquipment();
      await holds('U2', 'ComponentElement', 'C2');
      const before = await count();
      let cascaded = false;
      const e = await rejects(() => guardedDelete(raw, {
        model: 'equipmentSystem', id: 'S1', staleMessage: stale,
        openCheck: { userId: 'U1', cascade: (db) => cascadeOfSystem(db) },
        before: async () => { cascaded = true; },
      }));
      check('открыто вложенное: удаление установки отказано, назван вложенный и его держатель',
        e instanceof RecordOpen && e.record.id === 'C2' && e.record.name === 'Двигатель' && e.holders[0].userId === 'U2'
        && e.message === deleteOpenNestedText({ noun: 'system', name: 'ПВ-1' }, { noun: 'position', name: 'Двигатель' }, [{ name: 'Петрова А. А.' }]), e);
      check('открыто вложенное: ничего не удалено, каскад не начат', JSON.stringify(await count()) === JSON.stringify(before) && !cascaded, await count());
    }
    {
      // Без списка каскада вложенное не видно — поэтому маршрут обязан его передать (и передаёт, см. test-equipment-version-routes)
      await seedEquipment();
      await holds('U2', 'ComponentElement', 'C2');
      const e = await rejects(() => guardedDelete(raw, { model: 'equipmentSystem', id: 'S1', staleMessage: stale, openCheck: { userId: 'U1' } }));
      check('без списка каскада защита смотрит только саму запись', e === null);
    }
    {
      // Сама запись называется раньше вложенных
      await seedEquipment();
      await holds('U2', 'EquipmentSystem', 'S1');
      await holds('U2', 'ComponentElement', 'C2');
      const e = await rejects(() => guardedDelete(raw, {
        model: 'equipmentSystem', id: 'S1', staleMessage: stale, openCheck: { userId: 'U1', cascade: (db) => cascadeOfSystem(db) },
      }));
      check('открыта и сама установка, и вложенное: отказ называет установку', e instanceof RecordOpen && e.record.model === 'EquipmentSystem' && e.message === deleteOpenText('system', 'ПВ-1', [{ name: 'Петрова А. А.' }]), e);
    }
    {
      // Чужая версия и открытая запись: версия проверяется первой, как и раньше
      await seedEquipment();
      await holds('U2', 'ComponentElement', 'C3');
      const e = await rejects(() => elementDelete('C3', 'U1', { expectedVersion: 99 }));
      check('чужая версия отказывает раньше открытой записи', e instanceof VersionConflict && !(e instanceof RecordOpen), e);
    }
    {
      // Сбой чтения открытых — не «никто не держит»: удалять вслепую нельзя
      await seedEquipment();
      const broken: any = {
        componentElement: raw.componentElement, user: raw.user,
        openRecord: { findMany: async () => { throw new Error('disk I/O error'); } },
      };
      const e = await rejects(() => guardedDelete(broken, { model: 'componentElement', id: 'C3', staleMessage: stale, openCheck: { userId: 'U1' } }));
      check('иной сбой чтения открытых: OpenCheckUnavailable, запись на месте', e instanceof OpenCheckUnavailable && e.message === openCheckUnavailableText() && !!(await compOf('C3')), e);
      const missing: any = {
        componentElement: raw.componentElement, user: raw.user,
        openRecord: { findMany: async () => { throw Object.assign(new Error('The table `main.OpenRecord` does not exist'), { code: 'P2021' }); } },
      };
      const gone: any = await guardedDelete(missing, { model: 'componentElement', id: 'C3', staleMessage: stale, openCheck: { userId: 'U1' } });
      check('таблицы открытых нет: удаление идёт без этой защиты', gone?.before.id === 'C3' && !(await compOf('C3')));
    }
    {
      // Настоящая база без таблицы, через настоящую транзакцию
      await seedEquipment();
      await raw.$executeRawUnsafe('DROP TABLE "OpenRecord"');
      const gone: any = await elementDelete('C3', 'U1');
      check('таблицы нет в самой базе: удаление проходит, транзакция не повисла', gone?.before.id === 'C3' && !(await compOf('C3')));
      check('и таблицу можно создать на лету', (await ensureOpenTable(raw)) === '' && (await raw.openRecord.count()) === 0);
    }
    {
      await seedEquipment();
      // Справочник: версионная модель, у которой слова в словаре пока нет (появится в строке 3 очерёдности — тогда взять другую)
      // У справочника слово теперь есть; документ Конструктора — модель с версией, но без слова
      const d = await raw.constructorDoc.create({ data: { id: 'cd-noun', projectId: 'p1', name: 'Без слова' } });
      const e = await rejects(() => guardedDelete(raw, { model: 'constructorDoc', id: d.id, staleMessage: stale, openCheck: { userId: 'U1' } }));
      check('модель без существительного в словаре: ошибка разработчика сразу, а не молчание', e instanceof Error && /NOUN_OF_MODEL/.test(e.message) && !!(await raw.constructorDoc.findUnique({ where: { id: d.id } })), e?.message);
    }

    // ── Ответы отказов ──
    {
      const sent: any[] = [];
      const res = { status(code: number) { sent.push({ code }); return { json: (body: unknown) => { sent[sent.length - 1].body = body; } }; } };
      sendRecordOpen(res, new RecordOpen('Позиция «X» сейчас открыта у сотрудника: Иванов И. И. Удалить её нельзя, пока запись открыта.', [{ userId: 'U1', name: 'Иванов И. И.' }], { model: 'ComponentElement', id: 'C1', name: 'X' }));
      check('sendRecordOpen: 409, RECORD_OPEN, держатели и запись по договору',
        sent[0].code === 409 && sent[0].body.code === 'RECORD_OPEN' && JSON.stringify(sent[0].body.holders) === JSON.stringify([{ userId: 'U1', name: 'Иванов И. И.' }])
        && JSON.stringify(sent[0].body.record) === JSON.stringify({ model: 'ComponentElement', id: 'C1', name: 'X' }) && !/RECORD_OPEN/.test(sent[0].body.error), sent[0]);
      sendRecordGone(res, 'position');
      check('sendRecordGone: 404, RECORD_GONE, текст словаря (правка)', sent[1].code === 404 && sent[1].body.code === 'RECORD_GONE' && sent[1].body.error === editGoneText('position') && !/RECORD_GONE/.test(sent[1].body.error), sent[1]);
      sendRecordGone(res, 'system', { inside: true });
      check('sendRecordGone: создание внутри удалённого — свой текст', sent[2].code === 404 && sent[2].body.error === createInsideGoneText('system') && sent[2].body.code === 'RECORD_GONE', sent[2]);
      sendOpenCheckUnavailable(res, new OpenCheckUnavailable(new Error('x')));
      check('sendOpenCheckUnavailable: 503 с текстом словаря', sent[3].code === 503 && sent[3].body.error === openCheckUnavailableText(), sent[3]);
      check('sendGuardRefusal: берёт три отказа и не берёт чужую ошибку',
        sendGuardRefusal(res, new VersionConflict('v', null)) && sendGuardRefusal(res, new RecordOpen('o', [], { model: 'ComponentElement', id: 'a', name: '' }))
        && sendGuardRefusal(res, new OpenCheckUnavailable()) && !sendGuardRefusal(res, new Error('чужая')));
    }

    // ── Ответ 409 ──
    {
      const sent: any[] = [];
      const res = { status(code: number) { sent.push({ code }); return { json: (body: unknown) => { sent[sent.length - 1].body = body; } }; } };
      const conflict = new VersionConflict('Тег изменили до вас.', { id: 'x', version: 7, metadata: '{"a":1}' });
      sendVersionConflict(res, conflict);
      check('sendVersionConflict: 409, текст, код отдельным полем, текущая запись',
        sent[0].code === 409 && sent[0].body.error === 'Тег изменили до вас.' && sent[0].body.code === 'VERSION_CONFLICT' && sent[0].body.current.version === 7, sent[0]);
      check('текст ошибки — для человека: без кода и служебных слов', !/VERSION_CONFLICT|VersionConflict/.test(sent[0].body.error));
      sendVersionConflict(res, conflict, (r) => ({ ...r, metadata: JSON.parse(r.metadata) }));
      check('sendVersionConflict: запись можно подать так, как маршрут отдаёт её обычно', sent[1].body.current.metadata.a === 1);
      sendVersionConflict(res, new VersionConflict('Запись уже удалена.'));
      check('нет текущей записи — current: null', sent[2].body.current === null && sent[2].code === 409);
    }

    console.log(`\nСверка версии записи: ${checks} проверок пройдено`);
  } finally {
    await raw.$disconnect().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
