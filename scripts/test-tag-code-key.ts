/**
 * Ключ кода тега (docs/roadmap/offline-work.md, 0.3): два тега с одним кодом в
 * проекте база не принимает.
 *
 * Настоящая SQLite-база и настоящий express с маршрутами тегов, без сервера:
 * гонку не сыграть заглушкой. Что держим:
 *  • одно правило ключа (NFC, пробелы, регистр) у tagWrite, tagPolicy и заполнения;
 *  • гонка нескольких созданий одного кода (в том числе другим регистром и в NFD)
 *    и создания против переименования — один успех, остальные 409, в базе один тег;
 *  • заполнение ключа у базы с повторами: первому по createdAt — ключ, остальным
 *    NULL, второй прогон ничего не меняет и ничего не удаляет; отчёт читает;
 *  • догоняющая миграция: колонка и ключ создаются на старой базе, заполнение
 *    запускается из автомиграции;
 *  • массовые пути (импорт, захват, генератор) — понятный пропуск, а не 500;
 *  • каждое место, где создаётся тег, пишет codeKey (проверка по тексту).
 *
 * Мутации, при каждой из которых набор обязан упасть: не писать codeKey;
 * ключ без NFC или без нижнего регистра; заполнение ставит ключ всем повторам.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import express from 'express';
import { registerTagRoutes } from '../server/routes/tags.js';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma, setBroadcaster } from '../server/context.js';
import { tagCodeKey, backfillTagCodeKeys, tagCodeRepeats, isCodeKeyViolation, withCodeKey } from '../server/tagCodeKey.js';
import { tagCodeKey as tagCodeKeyOfWrite } from '../server/tagWrite.js';
import { identityKeyOf } from '../equipment/tagPolicy.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-tag-code-key-'));
const dbPath = path.join(temp, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`✓ ${label}`);
};

/** «Й» целым знаком и «И» с краткой: для человека один код, для строки — разные */
const NFC_CODE = 'Й-1';
const NFD_CODE = NFC_CODE.normalize('NFD');

async function main() {
  // ── Одно правило ключа ──
  check('ключ: пробелы по краям и регистр не различают коды', tagCodeKey('  Ahu-1 ') === tagCodeKey('AHU-1'));
  check('ключ: NFC и NFD — один код', NFC_CODE !== NFD_CODE && tagCodeKey(NFC_CODE) === tagCodeKey(NFD_CODE));
  check('ключ: разные коды разные', tagCodeKey('AHU-1') !== tagCodeKey('AHU-11'));
  check('ключ tagWrite, tagPolicy и заполнения — одна функция',
    tagCodeKeyOfWrite === tagCodeKey && ['  Ахе-1 ', NFD_CODE, 'AHU-1', ''].every((c) => identityKeyOf(c) === tagCodeKey(c)));

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.authUser = { id: 'u1', role: 'ADMIN' }; next(); });
  const io: any = { emit() {}, to() { return { emit() {} }; } };
  registerTagRoutes(app as any, { io, notifyAll: async () => {} });
  const server = createServer(app);
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);
    setBroadcaster(() => {});
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) await prisma.project.create({ data: { id, name: `Проект ${id}` } });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const send = async (method: string, url: string, body?: any) => {
      const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    const create = (projectId: string, identifier: string) => send('POST', `/api/projects/${projectId}/tags`, { identifier });
    const tagsOf = (projectId: string) => prisma.tag.findMany({ where: { projectId } }) as Promise<any[]>;
    const withKey = async (projectId: string, key: string) => (await tagsOf(projectId)).filter((t) => t.codeKey === key);

    // ── Обычный путь ──
    const solo = await create('p1', 'Solo-1');
    check('создание пишет ключ кода', solo.status === 200 && solo.body.tag.codeKey === 'solo-1', solo.body);
    const same = await create('p1', ' SOLO-1 ');
    check('повтор того же кода другим регистром и с пробелами — 409 с текстом, кодом и занявшим тегом',
      same.status === 409 && same.body.duplicate === true && /уже заведён/.test(same.body.error) && same.body.code === 'SOLO-1' && same.body.existing?.id === solo.body.tag.id, same.body);
    check('тот же код в другом проекте — можно', (await create('p2', 'Solo-1')).status === 200);
    const renameSelf = await send('PUT', `/api/tags/${solo.body.tag.id}`, { identifier: 'SOLO-1' });
    check('смена регистра собственного кода — можно, ключ тот же', renameSelf.status === 200 && renameSelf.body.tag.identifier === 'SOLO-1' && renameSelf.body.tag.codeKey === 'solo-1', renameSelf.body);

    // Ключ в самой базе: тег, созданный мимо проверок, всё равно не пройдёт
    let direct: any = null;
    try { await prisma.tag.create({ data: { id: 'direct-1', projectId: 'p1', identifier: 'solo-1', codeKey: 'solo-1' } }); } catch (e) { direct = e; }
    check('база сама не принимает второй ключ в проекте (P2002 по codeKey)', direct && isCodeKeyViolation(direct), direct?.code);
    check('withCodeKey: ключ выводится из кода, без кода — данные как есть', withCodeKey({ identifier: 'AbC' }).codeKey === 'abc' && !('codeKey' in withCodeKey({ brand: 'x' } as any)));

    // ── Гонка: несколько одинаковых созданий разом ──
    const variants = ['RACE-1', 'race-1', ' Race-1 ', 'RACE-1', 'rAcE-1', 'RACE-1 '];
    const racers = await Promise.all(variants.map((v) => create('p3', v)));
    const won = racers.filter((r) => r.status === 200);
    check('гонка создания одного кода: один успех, остальные 409', won.length === 1 && racers.filter((r) => r.status === 409).length === variants.length - 1, racers.map((r) => r.status));
    check('гонка создания: в базе один тег, ни одного 500', (await tagsOf('p3')).length === 1 && !racers.some((r) => r.status >= 500));
    check('отказ гонки — тот же ответ, что у проверки: duplicate, code, existing',
      racers.filter((r) => r.status === 409).every((r) => r.body.duplicate === true && typeof r.body.code === 'string' && r.body.existing?.id === won[0].body.tag.id), racers.map((r) => r.body));

    // То же в NFC/NFD
    const uni = await Promise.all([create('p3', NFC_CODE), create('p3', NFD_CODE), create('p3', NFC_CODE.toLowerCase()), create('p3', NFD_CODE.toLowerCase())]);
    check('гонка NFC/NFD и регистр: один успех, остальные 409', uni.filter((r) => r.status === 200).length === 1 && uni.filter((r) => r.status === 409).length === 3, uni.map((r) => r.status));
    check('NFC/NFD: в базе один тег с таким ключом', (await withKey('p3', tagCodeKey(NFC_CODE))).length === 1);

    // ── Создание против переименования ──
    for (let round = 1; round <= 4; round++) {
      const pid = 'p4';
      const old = await create(pid, `OLD-${round}`);
      const target = round % 2 ? `New-${round}` : (round === 2 ? `Й-${round}` : `Й-${round}`.normalize('NFD'));
      const asked = round % 2 ? `NEW-${round}` : (round === 2 ? `Й-${round}`.normalize('NFD') : `й-${round}`);
      const [made, renamed] = await Promise.all([create(pid, target), send('PUT', `/api/tags/${old.body.tag.id}`, { identifier: asked })]);
      const codes = (await tagsOf(pid)).map((t) => t.codeKey).filter((k) => k === tagCodeKey(asked));
      check(`создание против переименования (круг ${round}): один успех, другой 409`,
        [made.status, renamed.status].sort().join() === '200,409' && codes.length === 1, { made: made.status, renamed: renamed.status, codes });
    }

    // ── Заполнение на базе с повторами ──
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
    // «a-late» создан позже, но по id идёт раньше: ключ получает старший по createdAt, а не по id
    const legacy = [
      { id: 'z-early', projectId: 'p5', identifier: 'DUP-1', createdAt: at(1) },
      { id: 'a-late', projectId: 'p5', identifier: 'dup-1', createdAt: at(2) },
      { id: 'm-mid', projectId: 'p5', identifier: ' Dup-1 ', createdAt: at(3) },
      { id: 'solo-old', projectId: 'p5', identifier: 'SOLO-OLD', createdAt: at(4) },
      { id: 'other-p', projectId: 'p6', identifier: 'DUP-1', createdAt: at(5) },
      { id: 'uni-1', projectId: 'p5', identifier: NFC_CODE, createdAt: at(6) },
      { id: 'uni-2', projectId: 'p5', identifier: NFD_CODE, createdAt: at(7) },
    ];
    for (const row of legacy) await prisma.tag.create({ data: row });
    const snapshot = async () => (await prisma.tag.findMany({ orderBy: { id: 'asc' } })).map((t: any) => `${t.id}|${t.projectId}|${t.identifier}|${t.codeKey}`);
    const beforeFill = await snapshot();
    check('до заполнения у старых тегов ключа нет', (await prisma.tag.findMany({ where: { id: { in: legacy.map((l) => l.id) } } })).every((t: any) => t.codeKey === null));
    // Без ключа в базе: правило «один ключ на группу» должно держать само заполнение, а не индекс
    await prisma.$executeRawUnsafe('DROP INDEX "Tag_projectId_codeKey_key"');
    const logs: string[] = [];
    const first = await backfillTagCodeKeys(prisma, 'sqlite', (m) => logs.push(m));
    const keyOf = async (id: string) => (await prisma.tag.findUnique({ where: { id } })).codeKey;
    check('заполнение: первому по createdAt — ключ, остальным повторам — NULL',
      (await keyOf('z-early')) === 'dup-1' && (await keyOf('a-late')) === null && (await keyOf('m-mid')) === null);
    check('заполнение: одиночкам и тому же коду в другом проекте — ключ',
      (await keyOf('solo-old')) === 'solo-old' && (await keyOf('other-p')) === 'dup-1');
    check('заполнение: NFC и NFD — повтор друг друга', (await keyOf('uni-1')) === tagCodeKey(NFC_CODE) && (await keyOf('uni-2')) === null);
    check('заполнение: итог — 4 ключа поставлено, 3 повтора осталось, число повторов — в журнал',
      first.filled === 4 && first.repeats === 3 && logs.some((l) => /повторов кода без ключа: 3/.test(l)), { first, logs });
    let rebuilt = '';
    try { await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX "Tag_projectId_codeKey_key" ON "Tag" ("projectId", "codeKey")'); } catch (e: any) { rebuilt = e.message; }
    check('после заполнения уникальный ключ создаётся: повторов ключа нет', rebuilt === '', rebuilt);
    const afterFill = await snapshot();
    check('заполнение ничего не удалило и не переименовало', afterFill.length === beforeFill.length && afterFill.every((row, i) => row.split('|').slice(0, 3).join('|') === beforeFill[i].split('|').slice(0, 3).join('|')));
    const second = await backfillTagCodeKeys(prisma, 'sqlite', () => {});
    check('второй прогон ничего не меняет', second.filled === 0 && second.repeats === 3 && JSON.stringify(await snapshot()) === JSON.stringify(afterFill), second);
    const report = await tagCodeRepeats(prisma, 'sqlite');
    const dupGroup = report.find((g) => g.projectId === 'p5' && g.key === 'dup-1');
    check('отчёт о повторах читает: группа с занявшим и двумя повторами, остальное не показано',
      report.length === 2 && dupGroup?.keeper?.id === 'z-early' && dupGroup.repeats.map((r) => r.id).sort().join() === 'a-late,m-mid', report);
    check('отчёт ничего не менял', JSON.stringify(await snapshot()) === JSON.stringify(afterFill));

    const clash = await create('p5', 'dUP-1');
    check('тег с кодом старого повтора отказан: у другого из пары ключ есть', clash.status === 409 && tagCodeKey(clash.body.existing?.identifier) === 'dup-1', clash.body);
    const freed = await send('PUT', `/api/tags/a-late`, { identifier: 'DUP-2' });
    check('старый повтор можно переименовать в свободный код — он получает ключ', freed.status === 200 && (await keyOf('a-late')) === 'dup-2', freed.body);
    const stuck = await send('PUT', `/api/tags/m-mid`, { identifier: 'dup-2' });
    check('переименовать повтор в код соседа нельзя', stuck.status === 409 && (await keyOf('m-mid')) === null, stuck.body);
    const quiet = await send('PUT', `/api/tags/m-mid`, { brand: 'Марка' });
    check('правка другого поля повтора без ключа проходит, ключ остаётся пустым', quiet.status === 200 && (await keyOf('m-mid')) === null, quiet.body);

    // ── Догоняющая миграция: старая база без колонки ──
    const old = new (require('better-sqlite3'))(dbPath);
    old.exec('DROP INDEX IF EXISTS "Tag_projectId_codeKey_key"');
    old.exec('ALTER TABLE "Tag" DROP COLUMN "codeKey"');
    old.close();
    const migLogs: string[] = [];
    await bootstrapLocalDatabase(dbPath, prisma, schema, (m) => migLogs.push(m));
    const migrated = await prisma.tag.findMany({ where: { projectId: 'p5' }, orderBy: { id: 'asc' } });
    const keyed = (id: string) => migrated.find((t: any) => t.id === id)?.codeKey;
    check('автомиграция старой базы: колонка и ключ созданы, заполнение выполнено',
      keyed('z-early') === 'dup-1' && keyed('a-late') === 'dup-2' && keyed('m-mid') === null && keyed('solo-old') === 'solo-old', migrated.map((t: any) => [t.id, t.codeKey]));
    const indexes = new (require('better-sqlite3'))(dbPath, { readonly: true });
    const hasIndex = indexes.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='Tag_projectId_codeKey_key'`).get();
    indexes.close();
    check('автомиграция старой базы: уникальный ключ создан', !!hasIndex);

    // ── Массовые пути ──
    const bulk = await send('POST', '/api/projects/p6/tags/bulk-import', { mode: 'add', rows: [{ identifier: 'B-1' }, { identifier: 'b-1' }, { identifier: 'B-2', parent: 'B-1' }, { identifier: 'DUP-1' }] });
    check('импорт: повтор внутри файла и с базой — в списке повторов, не 500', bulk.status === 200 && bulk.body.created === 2 && bulk.body.duplicates.sort().join() === 'DUP-1,b-1', bulk.body);
    const bulkTags = await tagsOf('p6');
    check('импорт: в базе по одному тегу на код, у каждого ключ', bulkTags.length === 3 && bulkTags.every((t: any) => t.codeKey === tagCodeKey(t.identifier)), bulkTags.map((t: any) => t.identifier));
    const bulk2 = await send('POST', '/api/projects/p6/tags/bulk-import', { mode: 'update', rows: [{ identifier: 'b-1', brand: 'Марка' }, { identifier: 'B-3' }, { identifier: 'b-3', brand: 'Вторая' }] });
    const b1 = (await tagsOf('p6')).find((t: any) => t.codeKey === 'b-1');
    check('импорт (обновление): другой регистр находит тот же тег и не переименовывает его; повтор в файле обновляет, а не создаёт',
      bulk2.status === 200 && bulk2.body.created === 1 && bulk2.body.updated === 2 && b1.identifier === 'B-1' && b1.brand === 'Марка', bulk2.body);
    const cap = await send('POST', '/api/projects/p6/tags/capture-apply', { rows: [
      { identifier: 'CAP-1', action: 'create' }, { identifier: 'cap-1', action: 'duplicate' }, { identifier: 'b-1', action: 'create' }, { identifier: 'CAP-2', action: 'create' },
    ] });
    check('захват: занятые коды пропущены с причиной, остальные созданы', cap.status === 200 && cap.body.created.length === 2 && cap.body.refused.length === 2 && cap.body.skipped.length === 2 && cap.body.duplicated.length === 0, cap.body);
    check('захват: в проекте нет двух тегов с одним ключом',
      new Set((await tagsOf('p6')).map((t: any) => t.codeKey)).size === (await tagsOf('p6')).length);

    const gens = await Promise.all(Array.from({ length: 6 }, () => send('POST', '/api/tags/generate', { projectId: 'p2', prefix: 'GEN-' })));
    const genCodes = gens.map((g) => g.body.tag?.identifier);
    check('генератор: шесть одновременных запросов — шесть разных кодов, без 500', gens.every((g) => g.status === 200) && new Set(genCodes).size === 6, gens.map((g) => [g.status, g.body.tag?.identifier]));
    check('генератор пишет ключ', gens.every((g) => g.body.tag.codeKey === tagCodeKey(g.body.tag.identifier)));

    // ── Каждое место, где создаётся тег, пишет codeKey ──
    const sources: string[] = [];
    const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (/\.ts$/.test(e.name)) sources.push(f); } };
    walk(path.join(process.cwd(), 'server'));
    const bare: string[] = [];
    for (const file of sources) {
      const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      for (const m of text.matchAll(/\.tag\.(create|createMany|upsert)\(/g)) {
        const body = text.slice(m.index!, m.index! + 700);
        if (!body.includes('withCodeKey(')) bare.push(`${path.relative(process.cwd(), file)}:${text.slice(0, m.index!).split('\n').length}`);
      }
    }
    check('все места создания тега пишут codeKey через withCodeKey', bare.length === 0, bare);

    console.log('\nКлюч кода тега — все проверки пройдены');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
