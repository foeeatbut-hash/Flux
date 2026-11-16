/**
 * Сверка версии и отказ общего вида в маршрутах файлов
 * (.claude/progress/explorer-version.md, «Что входит»; общее место —
 * docs/methodology/03-programs/shell.md, «Версия записи и сверка»).
 *
 * Настоящая SQLite-база (таблицы из schema.prisma), настоящие маршруты Проводника и рабочего
 * стола на настоящем express, клиент базы — `withVersionBump(raw)`, как на сервере; действуют
 * двое (заголовок `x-test-user`). После КАЖДОГО отказа сравнивается весь мир: файлы (со всем
 * содержимым и тегами), папки, проекты — ни одной лишней записи.
 *
 *  • PATCH /api/files/:id: `expectedVersion` в теле; чужая версия — 409 с `code` и `current`
 *    (без содержимого файла), текст из словаря; нечитаемая — 400; файла нет или он не виден —
 *    404 `RECORD_GONE` (одинаковым телом); без версии — 200; теги пишутся тем же шагом версии;
 *  • DELETE /api/files/:id: `?expectedVersion=`; файл уходит в корзину под сверкой; уже в
 *    корзине — 200 `alreadyGone` без записи;
 *  • POST /api/files/:id/restore: `expectedVersion` в теле; вместе с файлом возвращается папка из
 *    корзины, в той же транзакции;
 *  • POST /api/desktop/move (файл): `expectedVersion` в теле; папка стола не создаётся по
 *    устаревшей записи; перенос папки версии не знает и работает как раньше;
 *  • POST /api/files/copy (перенос): сверка с собственным чтением, версия растёт на единицу;
 *  • общий диск: без права «Общий диск» правка, корзина и перенос — 403, база нетронута.
 *
 * Мутации, которыми набор проверен (каждая роняет его): убрать сверку у имени (PATCH), у
 * корзины (DELETE), у восстановления, у переноса стола; убрать `assertExpectedVersion` до
 * создания папки стола; вернуть содержимое в `current`; убрать 400 на нечитаемую версию; убрать
 * возврат папки при восстановлении; убрать ответ «уже в корзине»; вернуть различие ответов
 * «нет файла» и «чужой файл».
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
import { registerExplorerRoutes } from '../server/routes/explorer.js';
import { registerDesktopRoutes } from '../server/routes/desktop.js';
import { ensureDiskProject } from '../server/systemFolders.js';
import { editChangedText, editGoneText } from '../src/lib/refusalTexts.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-file-version-routes-'));
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

const ME = 'u-sidorov';
const COLLEAGUE = 'u-petrova';
const SECRET = 'СОДЕРЖИМОЕ-ФАЙЛА-НЕ-ДЛЯ-ОТКАЗА';

/** Всё, чего могут коснуться маршруты: сравнение «до и после» ловит любую лишнюю запись. */
async function world() {
  const by = { orderBy: { id: 'asc' as const } };
  return {
    projects: await raw.project.findMany(by),
    folders: await raw.folder.findMany(by),
    files: await raw.fileNode.findMany({ ...by, include: { mainTags: { orderBy: { id: 'asc' as const } }, additionalTags: { orderBy: { id: 'asc' as const } } } }),
    tags: await raw.tag.findMany(by),
  };
}

async function seed() {
  for (const m of ['fileNode', 'folder', 'tag', 'project']) await raw[m].deleteMany({});
  await raw.project.create({ data: { id: 'P1', name: 'Проект Один' } });
  await raw.tag.create({ data: { id: 'T1', identifier: 'AHU-1', projectId: 'P1', codeKey: 'AHU-1' } });
  await raw.tag.create({ data: { id: 'T2', identifier: 'AHU-2', projectId: 'P1', codeKey: 'AHU-2' } });
  await raw.folder.create({ data: { id: 'F1', name: 'Общая', projectId: 'P1', scope: 'SHARED' } });
  await raw.folder.create({ data: { id: 'F2', name: 'Удалённая папка', projectId: 'P1', scope: 'SHARED', deletedAt: new Date(), deletedById: COLLEAGUE } });
  await raw.folder.create({ data: { id: 'F3', name: 'Папка для переноса', projectId: 'P1', scope: 'SHARED' } });
  await raw.folder.create({ data: { id: 'F4', name: 'Ещё папка', projectId: 'P1', scope: 'SHARED' } });
  const file = (id: string, name: string, extra: Record<string, unknown> = {}) =>
    raw.fileNode.create({ data: { id, name, filePath: `/shared/${name}`, folderId: 'F1', scope: 'SHARED', createdById: ME, updatedById: ME, content: SECRET, size: 7, type: 'TXT', ...extra } });
  await file('A1', 'a.txt', { version: 3, createdById: COLLEAGUE });
  await file('A2', 'b.txt', { version: 4 });
  await file('A3', 'trashed.txt', { version: 6, folderId: 'F2', deletedAt: new Date(), deletedById: COLLEAGUE });
  await file('A4', 'desk.txt', { version: 2 });
  await file('A5', 'cut-one.txt', { version: 5 });
  await file('A6', 'cut-two.txt', { version: 1 });
  await file('A7', 'plain.txt', { version: 2 });
  await file('A8', 'another.txt', { version: 8 });
  // Личное коллеги: человеку не видно, а потому для него «нет такого файла»
  await file('PERS', 'private.txt', { version: 4, scope: 'PERSONAL', ownerId: COLLEAGUE, folderId: null, createdById: COLLEAGUE });
  await sleep(5);
}

async function main() {
  let server: any;
  try {
    setDialect('sqlite');
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, raw, schema, () => {});
    setPrisma(withVersionBump(raw));
    setBroadcaster(() => {});
    for (const [id, name] of [[COLLEAGUE, 'Петрова А. А.'], [ME, 'Сидоров С. С.']]) await raw.user.create({ data: { id, symbol: `s-${id}`, password: 'x', name, role: 'USER' } });
    // Общий диск заводится при первой же проверке права записи: пусть он есть до первого снимка мира
    await ensureDiskProject();

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, _res, next) => { (req as any).authUser = { id: req.header('x-test-user') || ME, name: 'Инженер', role: 'USER', isActive: true }; next(); });
    registerExplorerRoutes(app, { can: () => true });
    registerDesktopRoutes(app);
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
    const isPlainRefusal = (b: any) => typeof b?.error === 'string' && /[а-яё]{4,}/i.test(b.error) && !/VERSION_CONFLICT|RECORD_/.test(b.error);
    const badVersions: unknown[] = ['abc', 0, -3, 1.5];
    const file = (id: string) => raw.fileNode.findUnique({ where: { id }, include: { mainTags: { orderBy: { id: 'asc' } } } });
    const patch = (id: string, body: Record<string, unknown>, as?: string) => send('PATCH', `/api/files/${id}`, body, as);
    const trash = (id: string, version?: unknown, as?: string) => send('DELETE', `/api/files/${id}${version === undefined ? '' : `?expectedVersion=${version}`}`, undefined, as);
    const restore = (id: string, body: Record<string, unknown> = {}, as?: string) => send('POST', `/api/files/${id}/restore`, body, as);
    const move = (body: Record<string, unknown>, as?: string) => send('POST', '/api/desktop/move', { projectId: 'P1', ...body }, as);
    const cut = (ids: string[], targetFolderId: string, as?: string) => send('POST', '/api/files/copy', { ids, targetFolderId, isCut: true }, as);

    // ───────────────────────── PATCH /api/files/:id ─────────────────────────
    console.log('\n── PATCH /api/files/:id');
    {
      await seed();
      let before = await world();
      const stale = await patch('A1', { name: 'моё имя.txt', expectedVersion: 2 });
      check('файл: чужая версия — 409 с кодом отдельным полем', stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT', stale);
      check('файл: текст — из словаря, с названием, без кода', stale.body?.error === editChangedText('file', 'a.txt') && isPlainRefusal(stale.body), stale.body);
      check('файл: в отказе текущая запись с версией', stale.body?.current?.id === 'A1' && stale.body.current.version === 3 && stale.body.current.name === 'a.txt', stale.body?.current);
      check('файл: содержимое файла в отказ не попадает', stale.body?.current && !('content' in stale.body.current) && !JSON.stringify(stale.body).includes(SECRET), stale.body);
      check('файл: чужая версия — в базе не изменилось ничего', same(before, await world()));
      const staleTags = await patch('A1', { mainTagIds: ['T1'], expectedVersion: 1 });
      check('файл: чужая версия с тегами — 409, теги не тронуты', staleTags.status === 409 && same(before, await world()), staleTags);
      for (const bad of badVersions) {
        const r = await patch('A1', { name: 'не пишем.txt', expectedVersion: bad });
        check(`файл: версия ${JSON.stringify(bad)} — 400`, r.status === 400 && typeof r.body?.error === 'string', r);
      }
      check('файл: нечитаемая версия — в базе не изменилось ничего', same(before, await world()));
      const blank = await patch('A1', { name: '   ', expectedVersion: 3 });
      check('файл: пустое имя — прежний отказ 400, версия не двинулась', blank.status === 400 && (await file('A1'))?.version === 3, blank);

      const ok = await patch('A1', { name: 'Новое имя.txt', revision: '2', expectedVersion: 3 });
      check('файл: своя версия — 200 и запись применена', ok.status === 200 && ok.body?.file?.name === 'Новое имя.txt' && ok.body.file.revision === '2', ok);
      check('файл: версия выросла на 1 и отдана в ответе', ok.body?.file?.version === 4 && (await file('A1'))?.version === 4, ok.body?.file?.version);
      check('файл: содержимое в ответе нет, а в базе цело', ok.body?.file && !('content' in ok.body.file) && (await file('A1'))?.content === SECRET);
      check('файл: подпись «кто изменил» — вошедший', ok.body?.file?.updatedBy?.id === ME && ok.body.file.createdBy?.id === COLLEAGUE, ok.body?.file?.updatedBy);

      const tags = await patch('A1', { mainTagIds: ['T1', 'T2'], additionalTagIds: ['T2'], expectedVersion: 4 });
      check('файл: теги пишутся, версия выросла ровно на 1', tags.status === 200 && tags.body.file.version === 5 && tags.body.file.mainTags.length === 2 && tags.body.file.additionalTags.length === 1, tags.body);
      check('файл: теги в базе записаны', (await file('A1'))?.mainTags.map((t: any) => t.id).join() === 'T1,T2');

      const stringVersion = await patch('A1', { statusCode: 'A', expectedVersion: '5' });
      check('файл: версия строкой «5» читается как число', stringVersion.status === 200 && stringVersion.body.file.version === 6, stringVersion);
      const noVersion = await patch('A2', { revision: '7' });
      check('файл: без версии (клиент без сверки) — 200', noVersion.status === 200 && (await file('A2'))?.revision === '7' && (await file('A2'))?.version === 5, noVersion);

      // Коллега правит настоящим маршрутом — версия уходит вперёд
      await sleep(5);
      const mine = (await file('A7'))!.version;
      const colleague = await patch('A7', { name: 'правка коллеги.txt' }, COLLEAGUE);
      check('файл: правка коллеги двигает версию', colleague.status === 200 && (await file('A7'))!.version === mine + 1, colleague);
      before = await world();
      const lost = await patch('A7', { name: 'Затираю.txt', expectedVersion: mine });
      check('файл: версия до правки коллеги — 409, его правка цела', lost.status === 409 && lost.body?.current?.name === 'правка коллеги.txt' && same(before, await world()), lost);
      check('файл: текст отказа называет файл коллеги', lost.body?.error === editChangedText('file', 'правка коллеги.txt'), lost.body?.error);

      // Нет файла и чужое личное: один ответ, номер не подтверждается
      before = await world();
      const gone = await patch('NO-SUCH', { name: 'x.txt', expectedVersion: 1 });
      check('файла нет — 404 RECORD_GONE с текстом словаря', gone.status === 404 && gone.body?.code === 'RECORD_GONE' && gone.body.error === editGoneText('file'), gone);
      const hidden = await patch('PERS', { name: 'x.txt', expectedVersion: 4 });
      check('чужой личный файл — тот же ответ, что и «нет файла»', hidden.status === 404 && same(hidden.body, gone.body), hidden);
      const goneNoVersion = await patch('NO-SUCH', { name: 'x.txt' });
      check('файла нет, версии нет — тоже 404 RECORD_GONE', goneNoVersion.status === 404 && goneNoVersion.body?.code === 'RECORD_GONE', goneNoVersion);
      check('нет файла — в базе не изменилось ничего', same(before, await world()));

      const v = (await file('A8'))!.version;
      const [a, b] = await Promise.all([patch('A8', { name: 'гонка-1.txt', expectedVersion: v }), patch('A8', { name: 'гонка-2.txt', expectedVersion: v })]);
      check('файл: две правки с одной версией — прошла ровно одна, вторая 409', [a, b].filter((r) => r.status === 200).length === 1 && [a, b].filter((r) => r.status === 409 && r.body?.code === 'VERSION_CONFLICT').length === 1, [a.status, b.status]);
      check('файл: после гонки версия выросла один раз', (await file('A8'))!.version === v + 1);
    }

    // ───────────────────────── DELETE /api/files/:id ─────────────────────────
    console.log('\n── DELETE /api/files/:id (в корзину)');
    {
      await seed();
      let before = await world();
      const stale = await trash('A2', 3);
      check('корзина: чужая версия — 409 VERSION_CONFLICT с текущей записью', stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT' && stale.body?.current?.id === 'A2' && stale.body.current.version === 4, stale);
      check('корзина: текст из словаря, содержимого в отказе нет', stale.body?.error === editChangedText('file', 'b.txt') && isPlainRefusal(stale.body) && !JSON.stringify(stale.body).includes(SECRET), stale.body);
      check('корзина: чужая версия — файл не удалён, в базе не изменилось ничего', same(before, await world()));
      for (const bad of badVersions) {
        const r = await trash('A2', encodeURIComponent(String(bad)));
        check(`корзина: версия ${JSON.stringify(bad)} — 400`, r.status === 400 && typeof r.body?.error === 'string', r);
      }
      check('корзина: нечитаемая версия — в базе не изменилось ничего', same(before, await world()));

      const ok = await trash('A2', 4);
      const row = await file('A2');
      check('корзина: своя версия — 200, файл в корзине под именем вошедшего', ok.status === 200 && ok.body?.trashed === true && row?.deletedAt instanceof Date && row.deletedById === ME, ok);
      check('корзина: версия выросла на 1 и отдана', row?.version === 5 && ok.body?.version === 5, ok.body);
      check('корзина: содержимое цело (удаление мягкое)', row?.content === SECRET);

      before = await world();
      const again = await trash('A2', 4);
      check('корзина: файл уже в корзине — 200 alreadyGone, ничего не записано', again.status === 200 && again.body?.alreadyGone === true && same(before, await world()), again);

      const noVersion = await trash('A7');
      check('корзина: без версии (клиент без сверки) — 200', noVersion.status === 200 && (await file('A7'))?.deletedAt instanceof Date, noVersion);
      const stringVersion = await trash('A8', '8');
      check('корзина: версия строкой читается', stringVersion.status === 200 && (await file('A8'))?.version === 9, stringVersion);

      // Коллега переименовал — моя устаревшая карточка не уносит файл в корзину
      await sleep(5);
      const mine = (await file('A4'))!.version;
      await patch('A4', { name: 'коллега переименовал.txt' }, COLLEAGUE);
      before = await world();
      const lost = await trash('A4', mine);
      check('корзина: версия до правки коллеги — 409, файл на месте', lost.status === 409 && lost.body?.current?.name === 'коллега переименовал.txt' && (await file('A4'))?.deletedAt === null && same(before, await world()), lost);

      before = await world();
      const gone = await trash('NO-SUCH', 1);
      check('корзина: файла нет — 404 RECORD_GONE', gone.status === 404 && gone.body?.code === 'RECORD_GONE' && gone.body.error === editGoneText('file'), gone);
      const hidden = await trash('PERS', 4);
      check('корзина: чужой личный файл — тот же ответ, файл на месте', hidden.status === 404 && same(hidden.body, gone.body) && same(before, await world()), hidden);

      const v = (await file('A5'))!.version;
      const [a, b] = await Promise.all([trash('A5', v), trash('A5', v)]);
      const statuses = [a.status, b.status].sort();
      check('корзина: два удаления с одной версией — файл в корзине один раз, версия +1', (await file('A5'))!.version === v + 1 && statuses.every((s) => s === 200 || s === 409) && statuses.includes(200), [a, b].map((r) => [r.status, r.body?.code ?? r.body?.alreadyGone]));
    }

    // ───────────────────────── POST /api/files/:id/restore ─────────────────────────
    console.log('\n── POST /api/files/:id/restore');
    {
      await seed();
      let before = await world();
      const stale = await restore('A3', { expectedVersion: 5 });
      check('восстановление: чужая версия — 409 VERSION_CONFLICT с текущей записью', stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT' && stale.body?.current?.id === 'A3' && stale.body.current.version === 6 && stale.body.current.deletedAt, stale);
      check('восстановление: текст из словаря, содержимого в отказе нет', stale.body?.error === editChangedText('file', 'trashed.txt') && isPlainRefusal(stale.body) && !JSON.stringify(stale.body).includes(SECRET), stale.body);
      check('восстановление: чужая версия — файл и его папка остались в корзине, база та же', same(before, await world()));
      for (const bad of badVersions) {
        const r = await restore('A3', { expectedVersion: bad });
        check(`восстановление: версия ${JSON.stringify(bad)} — 400`, r.status === 400 && typeof r.body?.error === 'string', r);
      }
      check('восстановление: нечитаемая версия — в базе не изменилось ничего', same(before, await world()));

      const ok = await restore('A3', { expectedVersion: 6 });
      const row = await file('A3');
      check('восстановление: своя версия — 200, файл вернулся', ok.status === 200 && ok.body?.success === true && row?.deletedAt === null && row.deletedById === null, ok);
      check('восстановление: версия выросла на 1 и отдана', row?.version === 7 && ok.body?.version === 7, ok.body);
      check('восстановление: вместе с файлом вернулась и его папка из корзины', (await raw.folder.findUnique({ where: { id: 'F2' } }))?.deletedAt === null);

      before = await world();
      const late = await restore('A3', { expectedVersion: 6 });
      check('восстановление: вторая попытка по прежней версии — 409, версия не растёт', late.status === 409 && late.body?.current?.deletedAt === null && same(before, await world()), late);

      // Без версии — принимается
      await trash('A7');
      const noVersion = await restore('A7');
      check('восстановление: без версии (клиент без сверки) — 200', noVersion.status === 200 && (await file('A7'))?.deletedAt === null, noVersion);

      before = await world();
      const gone = await restore('NO-SUCH', { expectedVersion: 1 });
      check('восстановление: файла нет (очистили корзину) — 404 RECORD_GONE', gone.status === 404 && gone.body?.code === 'RECORD_GONE' && gone.body.error === editGoneText('file'), gone);
      const hidden = await restore('PERS', { expectedVersion: 4 });
      check('восстановление: чужой личный файл — тот же ответ', hidden.status === 404 && same(hidden.body, gone.body) && same(before, await world()), hidden);
    }

    // ───────────────────────── POST /api/desktop/move ─────────────────────────
    console.log('\n── POST /api/desktop/move (файл)');
    {
      await seed();
      let before = await world();
      const stale = await move({ id: 'A4', to: 'PERSONAL', expectedVersion: 1 });
      check('стол: чужая версия — 409 VERSION_CONFLICT с текущей записью', stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT' && stale.body?.current?.id === 'A4' && stale.body.current.version === 2, stale);
      check('стол: текст из словаря, содержимого в отказе нет', stale.body?.error === editChangedText('file', 'desk.txt') && isPlainRefusal(stale.body) && !JSON.stringify(stale.body).includes(SECRET), stale.body);
      check('стол: чужая версия — файл на месте, папка стола не заведена, база та же', same(before, await world()));
      for (const bad of badVersions) {
        const r = await move({ id: 'A4', to: 'PERSONAL', expectedVersion: bad });
        check(`стол: версия ${JSON.stringify(bad)} — 400`, r.status === 400 && typeof r.body?.error === 'string', r);
      }
      check('стол: нечитаемая версия — в базе не изменилось ничего', same(before, await world()));

      const ok = await move({ id: 'A4', to: 'PERSONAL', expectedVersion: 2 });
      const row = await file('A4');
      const desk = await raw.folder.findFirst({ where: { projectId: 'P1', system: true, scope: 'PERSONAL', ownerId: ME } });
      check('стол: своя версия — 200, файл на личном столе владельцем стал вошедший', ok.status === 200 && !!desk && row?.folderId === desk.id && row.scope === 'PERSONAL' && row.ownerId === ME, ok);
      check('стол: версия выросла на 1 и отдана', row?.version === 3 && ok.body?.version === 3, ok.body);

      const back = await move({ id: 'A4', to: 'SHARED', expectedVersion: 3 });
      check('стол: обратно на общий — 200, владельца нет', back.status === 200 && (await file('A4'))?.scope === 'SHARED' && (await file('A4'))?.ownerId === null && (await file('A4'))?.version === 4, back);

      const stringVersion = await move({ id: 'A4', to: 'PERSONAL', expectedVersion: '4' });
      check('стол: версия строкой читается', stringVersion.status === 200 && (await file('A4'))?.version === 5, stringVersion);
      const noVersion = await move({ id: 'A7', to: 'PERSONAL' });
      check('стол: без версии (клиент без сверки) — 200', noVersion.status === 200 && (await file('A7'))?.scope === 'PERSONAL', noVersion);

      // Коллега тем временем переименовал
      await sleep(5);
      await move({ id: 'A4', to: 'SHARED' });
      const mine = (await file('A4'))!.version;
      await patch('A4', { name: 'коллега.txt' }, COLLEAGUE);
      before = await world();
      const lost = await move({ id: 'A4', to: 'PERSONAL', expectedVersion: mine });
      check('стол: версия до правки коллеги — 409, файл остался общим', lost.status === 409 && lost.body?.current?.name === 'коллега.txt' && (await file('A4'))?.scope === 'SHARED' && same(before, await world()), lost);

      before = await world();
      const gone = await move({ id: 'NO-SUCH', to: 'PERSONAL', expectedVersion: 1 });
      check('стол: файла нет (версия пришла) — 404 RECORD_GONE', gone.status === 404 && gone.body?.code === 'RECORD_GONE' && gone.body.error === editGoneText('file'), gone);
      const hidden = await move({ id: 'PERS', to: 'PERSONAL', expectedVersion: 4 });
      check('стол: чужой личный файл — тот же ответ, владелец не сменился', hidden.status === 404 && same(hidden.body, gone.body) && (await file('PERS'))?.ownerId === COLLEAGUE && same(before, await world()), hidden);
      const goneNoVersion = await move({ id: 'NO-SUCH', to: 'PERSONAL' });
      check('стол: номера нет и версии нет — прежний отказ «папка не найдена»', goneNoVersion.status === 404 && goneNoVersion.body?.code === undefined && /Папка/.test(goneNoVersion.body?.error), goneNoVersion);

      // Правило «чужое с общего стола не забрать» прежнее
      const takeAway = await move({ id: 'A1', to: 'PERSONAL', expectedVersion: 3 });
      check('стол: чужой файл с общего стола не забрать — прежний 403, версия не двинулась', takeAway.status === 403 && (await file('A1'))?.version === 3, takeAway);

      // Перенос папки версии не знает и работает как раньше
      const folderMove = await move({ id: 'F3', to: 'PERSONAL' });
      const deskPersonal = await raw.folder.findFirst({ where: { projectId: 'P1', system: true, scope: 'PERSONAL', ownerId: ME } });
      check('стол: перенос папки — 200 без версии, как раньше', folderMove.status === 200 && (await raw.folder.findUnique({ where: { id: 'F3' } }))?.parentId === deskPersonal?.id, folderMove);
    }

    // ───────────────────────── POST /api/files/copy (перенос) ─────────────────────────
    console.log('\n── POST /api/files/copy (перенос файлов)');
    {
      await seed();
      const v5 = (await file('A5'))!.version;
      const v6 = (await file('A6'))!.version;
      const ok = await cut(['A5', 'A6'], 'F3');
      check('перенос: файлы в новой папке, версия каждого выросла на 1', ok.status === 200 && (await file('A5'))?.folderId === 'F3' && (await file('A6'))?.folderId === 'F3' && (await file('A5'))!.version === v5 + 1 && (await file('A6'))!.version === v6 + 1, ok);
      check('перенос: содержимое цело', (await file('A5'))?.content === SECRET);
      const before = await world();
      const missing = await cut(['A5', 'NO-SUCH'], 'F4');
      check('перенос: номер не найден — прежний 404 «Файл не найден», ничего не двинулось', missing.status === 404 && missing.body?.error === 'Файл не найден' && same(before, await world()), missing);
      const hidden = await cut(['PERS'], 'F4');
      check('перенос: чужой личный файл не переносится', hidden.status === 404 && (await file('PERS'))?.ownerId === COLLEAGUE, hidden);

      // Две переноски одного файла разом: ни одна не теряется, версия растёт на каждую
      const v = (await file('A5'))!.version;
      const [a, b] = await Promise.all([cut(['A5'], 'F1'), cut(['A5'], 'F4')]);
      check('перенос: два переноса разом — оба 200, версия выросла на два', a.status === 200 && b.status === 200 && (await file('A5'))!.version === v + 2 && ['F1', 'F4'].includes((await file('A5'))!.folderId!), [a.status, b.status]);

      const copied = await send('POST', '/api/files/copy', { ids: ['A5'], targetFolderId: 'F3', isCut: false });
      check('копирование: создаётся файл «— Copy» с версией 1, оригинал не тронут', copied.status === 200 && (await raw.fileNode.count({ where: { name: 'cut-one.txt - Copy' } })) === 1 && (await file('A5'))!.version === v + 2, copied);
    }

    // ───────────────────────── общий диск: право записи старше сверки ─────────────────────────
    console.log('\n── общий диск без права «Общий диск»');
    {
      await seed();
      const diskId = await ensureDiskProject();
      await raw.folder.create({ data: { id: 'DF', name: 'Папка диска', projectId: diskId, scope: 'SHARED' } });
      await raw.fileNode.create({ data: { id: 'D1', name: 'disk.txt', filePath: '/disk/disk.txt', folderId: 'DF', scope: 'SHARED', createdById: ME, content: SECRET, version: 2 } });
      const denied = express();
      denied.use(express.json());
      denied.use((req, _res, next) => { (req as any).authUser = { id: ME, name: 'Инженер', role: 'USER', isActive: true }; next(); });
      registerExplorerRoutes(denied, { can: () => false });
      const deniedServer = await new Promise<any>((resolve) => { const l = denied.listen(0, '127.0.0.1', () => resolve(l)); });
      try {
        const base = `http://127.0.0.1:${deniedServer.address().port}`;
        const call = async (method: string, url: string, body?: unknown) => {
          const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
          return { status: r.status, body: await r.json().catch(() => null) };
        };
        const before = await world();
        const results = [
          await call('PATCH', '/api/files/D1', { name: 'x.txt', expectedVersion: 2 }),
          await call('DELETE', '/api/files/D1?expectedVersion=2'),
          await call('POST', '/api/files/copy', { ids: ['D1'], targetFolderId: 'F1', isCut: true }),
        ];
        check('диск без права: правка, корзина и перенос — 403 с объяснением', results.every((r) => r.status === 403 && /Общий диск/.test(r.body?.error)), results);
        check('диск без права: ничего не записано, версия на месте', same(before, await world()) && (await file('D1'))?.version === 2);
      } finally {
        await new Promise((resolve) => deniedServer.close(resolve));
      }
    }

    console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${checks})`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await raw.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
