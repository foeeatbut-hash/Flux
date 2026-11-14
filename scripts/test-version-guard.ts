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
 *  • `expectedVersionOf` не принимает мусор; `sendVersionConflict` — 409 с кодом отдельным полем.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { VersionConflict, expectedVersionOf, guardedDelete, guardedWrite, sendVersionConflict } from '../server/versionGuard.js';
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
