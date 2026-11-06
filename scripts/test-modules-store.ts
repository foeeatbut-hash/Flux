/**
 * Flux Store насквозь: витрина и допуск, установка с зависимостями, закрепление
 * версии, обязательные для должности, отзывы, журнал — на настоящих маршрутах и
 * одноразовой SQLite; и сторона компьютера — выбор установленного у каждого
 * человека, возврат к прошлой версии без связи, отзыв выпуска, который
 * возвращает всех на прошлую версию.
 *
 * Запуск: npx tsx scripts/test-modules-store.ts
 */
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRemoteSchema } from '../server/schema-sync';
import { registerModulePublishingRoutes } from '../server/routes/modulePublishing';
import { ModuleCache, syncModuleReleases, KEEP_VERSIONS } from '../electron/moduleCache';
import { ModuleSelection } from '../electron/moduleSelection';
import { addedPermissions, permissionsDigest, searchListings, storeRows, unmetRequirements, updateAvailable } from '../modules/store/model';
import type { ModuleManifest } from '../modules/contract';
import { certificateEnvelope, hexOf, moduleBundle, newKey, releaseEnvelope, requestEnvelope, revocationEnvelope } from './fixtures/moduleTrust';

const Database = require('better-sqlite3');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-module-store-'));
const root = newKey(), rootHex = hexOf(root), dev = newKey(), devHex = hexOf(dev);
const PNG = 'не настоящий png, но байты снимка';

const store = (summary: string, extra: Record<string, unknown> = {}) => ({ store: { category: 'calc', summary, description: `Описание: ${summary}`, color: '#2563eb', screenshots: ['store/a.png'], ...extra } });
const pack = (id: string, name: string, version: string, patch: Record<string, unknown> = {}) =>
  moduleBundle(version, { 'store/a.png': PNG }, { id, name, ...patch });

async function main() {
  const file = path.join(dir, 'flux.sqlite');
  new Database(file).close();
  const { PrismaClient } = require('@prisma/client-sqlite');
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  const log: string[] = [];
  await ensureRemoteSchema(db, 'sqlite', fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8'), (m) => log.push(m));
  ok('таблицы Store созданы', !log.some((m) => /Не удалось|Ошибка при/.test(m)) && (await db.moduleInstall.count()) === 0);

  const people: Record<string, any> = {
    owner: { id: 'flux-owner', name: 'Владелец', role: 'OWNER' }, admin: { id: 'admin', name: 'Админ', role: 'ADMIN' },
    dev: { id: 'dev', name: 'Разработчик', role: 'MODULE_DEVELOPER', perms: ['module.develop'] },
    ann: { id: 'ann', name: 'Анна', role: 'ENGINEER_AUTO' }, bob: { id: 'bob', name: 'Борис', role: 'ENGINEER_VENT' },
  };
  const app = express(); app.use(express.json({ limit: '50mb' }));
  app.use('/api', (req: any, res, next) => { req.authUser = people[String(req.headers.authorization || '').replace(/^Bearer /, '')]; return req.authUser ? next() : res.status(401).end(); });
  registerModulePublishingRoutes(app, { getPrisma: () => db, broadcast: () => {}, modulePublicKeyHex: rootHex, can: (u, f) => u.role === 'OWNER' || (u.perms || []).includes(f) });
  const server = await new Promise<import('http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (who: string, route: string, method = 'GET', body?: unknown) => {
    const r = await fetch(origin + route, { method, headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, type, headers: r.headers, body: type.includes('json') ? await r.json() as any : Buffer.from(await r.arrayBuffer()) };
  };
  await call('owner', '/api/modules/certificates', 'POST', { signature: certificateEnvelope(root, devHex, 'dev') });
  const publish = async (id: string, name: string, version: string, patch: Record<string, unknown> = {}, channel: 'test' | 'production' = 'production', changelog = `Что нового в ${version}`) => {
    const bundle = pack(id, name, version, patch);
    const sent = await call('dev', '/api/modules/requests', 'POST', { signature: requestEnvelope(dev, bundle, { moduleId: id, version, changelog }), bundle: Buffer.from(bundle).toString('base64') });
    assert.equal(sent.status, 200, sent.body.error);
    const r = await call('owner', `/api/modules/requests/${sent.body.id}/release`, 'POST', { signature: releaseEnvelope(root, bundle, { moduleId: id, version, author: devHex, request: sent.body.id, channel }) });
    assert.equal(r.status, 200, r.body.error);
    return r.body.release.id as string;
  };
  const listings = async (who: string) => (await call(who, '/api/modules/store')).body.listings as any[];
  const listing = async (who: string, id: string) => (await listings(who)).find((l) => l.moduleId === id);

  console.log('Витрина и допуск администратором');
  await publish('calc-a', 'Расчёт А', '1.0.0', store('Считает А'));
  ok('новая подпрограмма ждёт допуска и обычному человеку не видна', !(await listing('ann', 'calc-a')));
  const adminView = await listing('admin', 'calc-a');
  ok('администратор видит её со статусом «ждёт допуска»', adminView?.status === 'pending');
  ok('допуск даёт только администратор', (await call('ann', '/api/modules/store/calc-a/admission', 'POST', { status: 'admitted' })).status === 403);
  ok('администратор допустил', (await call('admin', '/api/modules/store/calc-a/admission', 'POST', { status: 'admitted' })).status === 200);
  const card = await listing('ann', 'calc-a');
  ok('карточка: название, категория, цвет, описание и «что нового»', card.name === 'Расчёт А' && card.category === 'calc' && card.color === '#2563eb' && card.description === 'Описание: Считает А' && card.changelog === 'Что нового в 1.0.0');
  ok('разработчик — имя из сертификата', card.developer === 'Разработчик');
  ok('разрешения выведены из манифеста выпуска', card.permissions.some((p: any) => /Читает во Flux: оборудование/.test(p.text)) && card.permissions.some((p: any) => /Ничего не записывает/.test(p.text)));
  ok('рейтинга и установок нет', card.rating.count === 0 && card.installs === 0 && card.mine === null);
  const shot = await call('ann', card.screenshots[0]);
  ok('снимок отдаётся картинкой без догадок браузера', shot.status === 200 && shot.type === 'image/png' && shot.headers.get('x-content-type-options') === 'nosniff' && shot.body.toString() === PNG);
  ok('не снимок отдать нельзя', (await call('ann', `/api/modules/releases/${card.releaseId}/file?path=${encodeURIComponent('manifest.json')}`)).status === 404);

  console.log('Установка, зависимости, удаление');
  await publish('calc-b', 'Расчёт Б', '1.0.0', store('Нужен А', { dependsOn: ['calc-a'], category: 'link' }));
  await call('admin', '/api/modules/store/calc-b/admission', 'POST', { status: 'admitted' });
  const put = (who: string, id: string, version: string, extra: object = {}) => call(who, `/api/modules/installs/${id}`, 'PUT', { version, ...extra });
  ok('без зависимости установить нельзя, причина названа', await put('ann', 'calc-b', '1.0.0').then((r) => r.status === 409 && /calc-a/.test(r.body.error)));
  ok('несуществующую версию поставить нельзя', (await put('ann', 'calc-a', '9.9.9')).status === 409);
  ok('установка А', (await put('ann', 'calc-a', '1.0.0')).body.action === 'install');
  ok('установка Б после А', (await put('ann', 'calc-b', '1.0.0')).status === 200);
  ok('в карточке «установлена», счётчик растёт', (await listing('bob', 'calc-a')).installs === 1 && (await listing('ann', 'calc-a')).mine.version === '1.0.0');
  ok('А нельзя удалить, пока от неё зависит Б', (await call('ann', '/api/modules/installs/calc-a', 'DELETE', { keepData: true })).status === 409);
  ok('Б удаляется у себя, у других стоит', (await call('ann', '/api/modules/installs/calc-b', 'DELETE', { keepData: false })).status === 200);
  await put('bob', 'calc-a', '1.0.0');
  ok('у Бориса А осталась', !!(await listing('bob', 'calc-a')).mine && !(await listing('ann', 'calc-b')).mine);
  ok('мои установки — список для другого компьютера', (await call('ann', '/api/modules/installs')).body.installs.map((i: any) => i.moduleId).join() === 'calc-a');

  console.log('Новая версия, закрепление, обновление и возврат');
  await publish('calc-a', 'Расчёт А', '1.1.0', store('Считает А', { screenshots: ['store/a.png'] }), 'production', 'Быстрее считает');
  await publish('calc-a', 'Расчёт А', '1.2.0', store('Считает А'), 'production', 'Новая форма');
  const annA = await listing('ann', 'calc-a');
  ok('обновление ждёт решения человека: версия не меняется сама', annA.mine.version === '1.0.0' && annA.version === '1.2.0' && updateAvailable(annA));
  ok('история версий с «что нового»', annA.versions.map((v: any) => `${v.version}:${v.changelog}`).join() === '1.2.0:Новая форма,1.1.0:Быстрее считает,1.0.0:Что нового в 1.0.0');
  ok('закрепить версию может только администратор', (await call('ann', '/api/modules/store/calc-a/pin', 'POST', { version: '1.1.0', roles: [] })).status === 403);
  ok('администратор закрепил 1.1.0 для инженеров КИПиА', (await call('admin', '/api/modules/store/calc-a/pin', 'POST', { version: '1.1.0', roles: ['ENGINEER_AUTO'] })).status === 200);
  ok('Анна видит потолок 1.1.0, Борис — 1.2.0', (await listing('ann', 'calc-a')).version === '1.1.0' && (await listing('ann', 'calc-a')).pinned === '1.1.0' && (await listing('bob', 'calc-a')).version === '1.2.0');
  ok('выше закреплённой Анна обновиться не может', (await put('ann', 'calc-a', '1.2.0')).status === 409);
  ok('Анна обновляется до закреплённой', (await put('ann', 'calc-a', '1.1.0')).body.action === 'update');
  ok('Борис — до новейшей', (await put('bob', 'calc-a', '1.2.0')).body.action === 'update');
  ok('возврат записывается как возврат', (await put('ann', 'calc-a', '1.0.0', { auto: 'off' })).body.action === 'rollback');
  const back = (await listing('ann', 'calc-a')).mine;
  ok('после возврата автообновление этой подпрограммы выключено', back.version === '1.0.0' && back.auto === 'off');
  ok('автообновление по умолчанию выключено у всех', (await call('ann', '/api/modules/store')).body.autoUpdate === false);
  await call('ann', '/api/modules/installs/auto', 'PUT', { enabled: true });
  ok('общий переключатель — у каждого свой', (await call('ann', '/api/modules/store')).body.autoUpdate === true && (await call('bob', '/api/modules/store')).body.autoUpdate === false);

  console.log('Отзыв выпуска, устаревшая, запрет, обязательные');
  const releaseRow = (await call('owner', '/api/modules/releases')).body.releases.find((r: any) => r.moduleId === 'calc-a' && r.version === '1.2.0');
  await call('owner', '/api/modules/revocations', 'POST', { signature: revocationEnvelope(root, 'release', 'calc-a@1.2.0') });
  ok('отозванный выпуск поставить нельзя', (await put('bob', 'calc-a', '1.2.0')).status === 409 && !!releaseRow);
  ok('в истории он помечен отозванным', (await listing('admin', 'calc-a')).versions.find((v: any) => v.version === '1.2.0').revoked === true);
  ok('для новых пользователей новейшая — не отозванная', (await listing('bob', 'calc-a')).version === '1.1.0');
  await call('admin', '/api/modules/store/calc-a/admission', 'POST', { status: 'admitted', deprecated: true });
  ok('устаревшую новым не ставят, у установивших работает', (await listing('bob', 'calc-a')).mine && (await put('admin', 'calc-a', '1.1.0')).status === 409);
  await call('admin', '/api/modules/store/calc-a/admission', 'POST', { status: 'admitted', deprecated: false });
  ok('обязательная для должности: Анне видна как обязательная', (await call('admin', '/api/modules/store/calc-b/required', 'POST', { version: '1.0.0', roles: ['ENGINEER_AUTO'] })).status === 200
    && (await listing('ann', 'calc-b')).required === '1.0.0' && (await listing('bob', 'calc-b')).required === null);
  await put('ann', 'calc-b', '1.0.0', { source: 'required' });
  ok('обязательную удалить нельзя', (await call('ann', '/api/modules/installs/calc-b', 'DELETE', {})).status === 409);
  await call('admin', '/api/modules/store/calc-b/admission', 'POST', { status: 'delisted' });
  ok('снятая из Store не видна тем, у кого не стоит, и видна тем, у кого стоит', !(await listing('bob', 'calc-b')) && !!(await listing('ann', 'calc-b')));
  await call('admin', '/api/modules/store/calc-b/admission', 'POST', { status: 'banned' });
  ok('запрещённая удаляется у всех и не видна', !(await listing('ann', 'calc-b')) && (await db.moduleInstall.count({ where: { moduleId: 'calc-b' } })) === 0);

  console.log('Отзывы и журнал');
  ok('оценить можно только установленную', (await call('bob', '/api/modules/store/calc-b/review', 'PUT', { rating: 5 })).status === 409);
  ok('оценка от 1 до 5', (await call('ann', '/api/modules/store/calc-a/review', 'PUT', { rating: 7 })).status === 400);
  await call('ann', '/api/modules/store/calc-a/review', 'PUT', { rating: 4, text: 'Удобно' });
  await call('bob', '/api/modules/store/calc-a/review', 'PUT', { rating: 2, text: 'Не хватает вывода' });
  await call('ann', '/api/modules/store/calc-a/review', 'PUT', { rating: 5, text: 'Удобно, спасибо' });
  const rated = await listing('ann', 'calc-a');
  ok('средняя оценка и полосы 5…1; повторный отзыв заменяет прежний', rated.rating.count === 2 && rated.rating.avg === 3.5 && rated.rating.stars.join() === '1,0,0,1,0');
  const reviews = (await call('ann', '/api/modules/store/calc-a/reviews')).body.reviews;
  ok('отзывы видны, свой помечен', reviews.length === 2 && reviews.find((r: any) => r.mine).text === 'Удобно, спасибо');
  const borisReview = reviews.find((r: any) => !r.mine);
  ok('пожаловаться можно, скрыть — только администратору', (await call('ann', `/api/modules/store/reviews/${borisReview.id}/report`, 'POST', {})).status === 200
    && (await call('ann', `/api/modules/store/reviews/${borisReview.id}/hide`, 'POST', {})).status === 403);
  await call('admin', `/api/modules/store/reviews/${borisReview.id}/hide`, 'POST', { hidden: true });
  ok('скрытый отзыв не считается', (await listing('ann', 'calc-a')).rating.count === 1);
  const admin = (await call('admin', '/api/modules/store-admin')).body;
  ok('журнал: кто что поставил, обновил, вернул, удалил, решил', ['install', 'update', 'rollback', 'uninstall', 'admission-admitted', 'pin', 'admission-banned', 'required'].every((a) => admin.logs.some((l: any) => l.action === a)));
  ok('у администратора видно, у кого какая версия', admin.spread['calc-a']['1.0.0'] === 1 && admin.spread['calc-a']['1.2.0'] === 1);
  ok('экран администратора закрыт остальным', (await call('ann', '/api/modules/store-admin')).status === 403);

  console.log('Тестовый канал в Store');
  await publish('calc-t', 'Тестовая', '0.1.0', store('Проба'), 'test');
  await call('admin', '/api/modules/store/calc-t/admission', 'POST', { status: 'admitted' });
  ok('тестовая видна только назначенным', !(await listing('ann', 'calc-t')));
  await call('owner', '/api/modules/testers', 'PUT', { testers: ['ann'] });
  const testing = await listing('ann', 'calc-t');
  ok('тестировщик видит её с пометкой «тестовая»', testing?.testing === true && testing.channel === 'test');

  console.log('Компьютер: выбор установленного, возврат без связи, отзыв');
  let clock = Date.now();
  const cacheDir = path.join(dir, 'cache');
  const cache = new ModuleCache(cacheDir, rootHex, () => clock);
  await syncModuleReleases(cache, async (route) => (await call('owner', route)).body);
  const selFile = path.join(dir, 'selection.json');
  const selection = new ModuleSelection(selFile, () => clock++);
  await selection.load();
  ok('без входа выбирать нечего', await selection.install('calc-a', '1.1.0').then(() => false, () => true));
  await selection.activate('ann');
  await selection.install('calc-a', '1.1.0', { dirty: true });
  const resolved = await cache.resolve(selection.versions(), selection.channels);
  ok('запускается только установленное: calc-a есть, остальных нет', [...resolved.keys()].join() === 'calc-a' && resolved.get('calc-a')!.claim.version === '1.1.0');
  await selection.activate('bob');
  ok('у каждого человека на компьютере свой выбор', Object.keys(selection.installed).length === 0 && (await cache.resolve(selection.versions(), selection.channels)).size === 0);
  await selection.activate('ann');
  const offline = new ModuleCache(cacheDir, rootHex, () => clock);
  const prev = await offline.previous('calc-a', '1.1.0');
  ok('предыдущая версия находится в кэше без связи с сервером', prev?.claim.version === '1.0.0');
  await selection.install('calc-a', prev!.claim.version, { dirty: true, noAuto: true });
  ok('после возврата запускается 1.0.0, автообновление выключено', (await offline.resolve(selection.versions(), selection.channels)).get('calc-a')!.claim.version === '1.0.0' && selection.installed['calc-a'].noAuto === true);
  const reread = new ModuleSelection(selFile);
  await reread.load(); await reread.activate('ann');
  ok('выбор переживает перезапуск, «не дошло до сервера» помечено', reread.installed['calc-a'].version === '1.0.0' && reread.installed['calc-a'].dirty === true);
  await reread.markSynced('calc-a', reread.installed['calc-a'].at);
  ok('после ответа сервера пометка снимается', !reread.installed['calc-a'].dirty);
  await selection.install('calc-a', '1.1.0');
  await call('owner', '/api/modules/revocations', 'POST', { signature: revocationEnvelope(root, 'release', 'calc-a@1.1.0') });
  await syncModuleReleases(cache, async (route) => (await call('owner', route)).body);
  const fallen = await cache.resolve(selection.versions(), selection.channels);
  ok('выпуск отозван — у установивших версия откатывается на прошлую неотозванную без их участия', fallen.get('calc-a')!.claim.version === '1.0.0');
  ok('выбор человека при этом не стёрт (откат виден как «запущена старая»)', selection.installed['calc-a'].version === '1.1.0');
  await fs.promises.writeFile(selFile, '{не json');
  const broken = new ModuleSelection(selFile); await broken.load();
  ok('повреждённый файл выбора — пустой выбор, а не падение', broken.active === '' && Object.keys(broken.installed).length === 0);
  ok('пустой выбор подпрограмм не запускает', (await cache.resolve(broken.versions(), broken.channels)).size === 0);

  console.log('Чистка кэша хранит последние версии и выбранную');
  for (const v of ['2.0.0', '2.1.0', '2.2.0', '2.3.0']) await publish('calc-c', 'Расчёт В', v, store('В'));
  await syncModuleReleases(cache, async (route) => (await call('owner', route)).body);
  const versionsOf = async () => (await cache.cached()).filter((c) => c.moduleId === 'calc-c').map((c) => c.version).sort();
  ok(`после чистки в кэше ${KEEP_VERSIONS} последних версии`, (await versionsOf()).join() === '2.1.0,2.2.0,2.3.0');
  await publish('calc-c', 'Расчёт В', '2.4.0', store('В'));
  const rows = (await call('owner', '/api/modules/releases')).body.releases;
  const row = rows.find((r: any) => r.moduleId === 'calc-c' && r.version === '2.4.0');
  const chunks = (await call('owner', `/api/modules/releases/${row.id}/chunks`)).body.chunks.map((c: string) => new Uint8Array(Buffer.from(c, 'base64')));
  await cache.install(row, chunks);
  await cache.prune(['calc-c@2.1.0']);
  ok('выбранная человеком версия не вычищается, даже если новее неё уже три', (await versionsOf()).join() === '2.1.0,2.2.0,2.3.0,2.4.0');
  await cache.prune();
  ok('а без выбора лишняя убирается', (await versionsOf()).join() === '2.2.0,2.3.0,2.4.0');

  console.log('Чистая модель витрины');
  const manifest = (m: Partial<ModuleManifest>): ModuleManifest => ({ id: 'x', name: 'X', version: '1.0.0', author: 'a', contractVersion: 1, entries: ['start'], reads: ['project'], logic: 'logic/main.ts', ...m });
  ok('требования: старый Flux и не Windows', unmetRequirements(manifest({ store: { category: 'link', summary: '', requires: { flux: '2.0.0', platform: 'windows' } } }), { fluxVersion: '1.5.0', windows: false }).length === 2);
  ok('требования выполнены — причин нет', unmetRequirements(manifest({ store: { category: 'link', summary: '', requires: { flux: '1.0.0' } } }), { fluxVersion: '1.5.0', windows: false }).length === 0);
  ok('договор новее Flux — нельзя', unmetRequirements(manifest({ contractVersion: 2 }), { fluxVersion: '1.0.0', windows: true }).length === 1);
  ok('новые разрешения выделяются', addedPermissions(manifest({ reads: ['project'] }), manifest({ reads: ['project', 'catalog'] })).join() === 'Читает во Flux: справочник каталога');
  ok('меньше разрешений — подтверждать нечего', addedPermissions(manifest({ reads: ['project', 'catalog'] }), manifest({ reads: ['project'] })).length === 0);
  ok('отпечаток разрешений меняется вместе с ними', permissionsDigest(manifest({ reads: ['project'] })) !== permissionsDigest(manifest({ reads: ['project', 'tag'] })));
  const all = await listings('admin');
  ok('поиск по названию, описанию и категории', searchListings(all, 'расчёт а').some((l) => l.moduleId === 'calc-a') && searchListings(all, 'нет такого').length === 0);
  ok('ряды главной не содержат неодобренного и пустых рядов', storeRows(all).every((r) => r.items.length > 0 && r.items.every((l) => l.status === 'admitted')));

  server.close();
  await db.$disconnect();
  console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${passed})`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('✗', e); process.exit(1); });
