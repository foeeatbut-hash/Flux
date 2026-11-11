/**
 * Разделы владельца Studio — Владелец насквозь: настоящие действия главного процесса
 * (studio/owner/src/console.cjs) ходят по HTTP на настоящие маршруты Flux с одноразовой SQLite,
 * подпись ставит синтетическое хранилище (настоящих ключей нет).
 *
 * Доказывается: выпуск, правка владельца, возврат, отказ, сертификаты, откат/отзыв/перевод и
 * назначение обновлений работают от владельца; администратор и разработчик получают 403;
 * подписывается ровно тот пакет, что показан (хеш), отказ в диалоге ничего не пишет, запасное
 * хранилище не подписывает, маршруты вне списка недоступны.
 *
 * Запуск: npx tsx scripts/test-studio-owner-console.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { ensureRemoteSchema } from '../server/schema-sync';
import { registerModulePublishingRoutes } from '../server/routes/modulePublishing';
import { registerUpdateCampaignRoutes } from '../server/routes/updateCampaigns';
import { requiresOwner } from '../server/accessPolicy';
import { signUpdateEnvelope, verifiedDeviceChain } from '../electron/updateCommand';
import { packBundle, unpackBundle } from '../modules/trust/bundle';
import { openEnvelope, sealEnvelope } from '../modules/trust/envelope';
import { describeBundle } from '../modules/trust/verify';
import { hexOf, moduleBundle, newKey, requestEnvelope } from './fixtures/moduleTrust';

const Database = require('better-sqlite3');
const vaultApi = require('../studio/owner/src/vault.cjs');

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const rejects = async (name: string, promise: Promise<unknown>, pattern: RegExp) => {
  await assert.rejects(promise, pattern, name); passed++; console.log(`  ✓ ${name}`);
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-owner-console-'));

async function main() {
  const out = path.join(dir, 'electron-stub.cjs');
  fs.writeFileSync(out, 'module.exports = {};');
  const built = path.join(dir, 'console.cjs');
  await build({ entryPoints: [path.join(__dirname, '..', 'studio/owner/src/console.cjs')], outfile: built, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', alias: { electron: out } });
  const consoleApi = require(built) as typeof import('../studio/owner/src/console.cjs');

  const generated = vaultApi.generateVaults();
  const vault = generated.main;
  const rootKey = crypto.createPrivateKey(vault.keys.update.privatePem), rootHex: string = vault.keys.update.publicHex;
  const dev = newKey(), devHex = hexOf(dev);

  const file = path.join(dir, 'flux.sqlite');
  new Database(file).close();
  const { PrismaClient } = require('@prisma/client-sqlite');
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  await ensureRemoteSchema(db, 'sqlite', fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8'), () => {});

  // Вход по токену: владелец, администратор с полным набором прав управления сотрудниками, разработчик
  const sessions: Record<string, any> = {
    owner: { id: 'flux-owner', name: 'Владелец', role: 'OWNER' },
    admin: { id: 'admin', name: 'Админ', role: 'ADMIN', isActive: true, permissions: { 'admin.users.manage': { enabled: true, until: null } } },
    developer: { id: 'developer', name: 'Разработчик', role: 'ENGINEER_AUTO' },
    stranger: { id: 'stranger', name: 'Чужой', role: 'ENGINEER_VENT' },
  };
  const app = express(); app.use(express.json({ limit: '50mb' }));
  app.use('/api', (req: any, res, next) => {
    req.authUser = sessions[String(req.headers.authorization || '').replace(/^Bearer /, '')];
    if (!req.authUser) return res.status(401).end();
    // Тот же общий запрет, что в server.ts: владельцу — всё, что меняет доверие к установке
    if (requiresOwner(req.path === '/' ? req.originalUrl : req.originalUrl.split('?')[0], req.method) && req.authUser.role !== 'OWNER') return res.status(403).json({ error: 'Доступно только владельцу Flux' });
    next();
  });
  registerModulePublishingRoutes(app, { getPrisma: () => db, broadcast: () => {}, modulePublicKeyHex: rootHex, can: (user, feature) => feature === 'module.develop' && user.role === 'ENGINEER_AUTO' });
  registerUpdateCampaignRoutes(app, { getPrisma: () => db, broadcast: () => {}, updatePublicKeyHex: rootHex, installationId: async () => 'company' });
  const server = await new Promise<import('http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (who: string, route: string, method = 'GET', body?: unknown) => {
    const r = await fetch(origin + route, { method, headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };

  // Контекст главного процесса: хранилище, токен и диалог подтверждения подменяются
  const asked: Array<{ message: string; detail: string }> = [];
  let answer = true;
  const make = (who: string, vaultValue: any = vault) => consoleApi.createConsoleActions({
    vault: () => vaultValue, token: () => who, origin: () => origin, user: () => (who ? { id: sessions[who]?.id, name: sessions[who]?.name } : null),
    confirm: async (message: string, detail: string) => { asked.push({ message, detail }); return answer; },
    forward: {},
  } as any);
  const owner = make('owner');
  const count = async (table: string) => Number((await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "${table}"`))[0].n);

  console.log('Сертификаты разработчиков');
  ok('разработчик без сертификата просит его (ключ приходит от Studio)', (await call('developer', '/api/modules/certificate-requests', 'POST', { key: devHex, name: 'Разработчик' })).status === 200);
  ok('чужой профиль без права разработки просить не может', (await call('stranger', '/api/modules/certificate-requests', 'POST', { key: hexOf(newKey()) })).status === 403);
  ok('ключ не в формате отвергается', (await call('developer', '/api/modules/certificate-requests', 'POST', { key: 'abc' })).status === 400);
  ok('очередь запросов видит только владелец', (await call('developer', '/api/modules/certificate-requests')).status === 403);
  const listed = await owner.certificates();
  ok('владелец видит запрос на сертификат', listed.requests.length === 1 && listed.requests[0].key === devHex && listed.requests[0].userId === 'developer');
  answer = false;
  await rejects('отказ в диалоге подтверждения ничего не выдаёт', owner.certify({ key: devHex, userId: 'developer', name: 'Разработчик' }), /отменена/);
  ok('сертификатов нет после отказа', await count('ModuleCertificate') === 0);
  answer = true;
  await owner.certify({ key: devHex, userId: 'developer', name: 'Разработчик' });
  ok('сертификат выдан, подпись принята сервером', await count('ModuleCertificate') === 1);
  ok('выданный запрос закрыт', (await owner.certificates()).requests.length === 0);
  ok('сертификат подписан ключом издателя из хранилища', openEnvelope('certificate', (await call('owner', '/api/modules/certificates')).body.certificates[0].signature, rootHex) !== null);
  await call('developer', '/api/modules/certificate-requests', 'POST', { key: hexOf(newKey()), name: 'Второй' });
  const second = (await owner.certificates()).requests[0];
  await owner.declineCertificate({ key: second.key });
  ok('отклонённый запрос исчезает, сертификата нет', (await owner.certificates()).requests.length === 0 && await count('ModuleCertificate') === 1);
  // Очередь: чужую ожидающую запись не перезаписать, у профиля не больше трёх ожидающих запросов
  const takenKey = hexOf(newKey());
  ok('первый запрос с ключом принят', (await call('developer', '/api/modules/certificate-requests', 'POST', { key: takenKey, name: 'Первый' })).status === 200);
  sessions.dev3 = { id: 'dev3', name: 'Третий', role: 'ENGINEER_AUTO' };
  const hijack = await call('dev3', '/api/modules/certificate-requests', 'POST', { key: takenKey, name: 'Подмена' });
  ok('другой разработчик не перезаписывает чужую запись, зная ключ (409)', hijack.status === 409);
  ok('запись осталась за первым профилем', (await owner.certificates()).requests.find((r: any) => r.key === takenKey).userId === 'developer');
  ok('повтор своего запроса допустим и обновляет имя', (await call('developer', '/api/modules/certificate-requests', 'POST', { key: takenKey, name: 'Новое имя' })).status === 200
    && (await owner.certificates()).requests.find((r: any) => r.key === takenKey).name === 'Новое имя');
  ok('второй и третий запросы одного профиля приняты', (await call('developer', '/api/modules/certificate-requests', 'POST', { key: hexOf(newKey()) })).status === 200
    && (await call('developer', '/api/modules/certificate-requests', 'POST', { key: hexOf(newKey()) })).status === 200);
  const fourth = await call('developer', '/api/modules/certificate-requests', 'POST', { key: hexOf(newKey()) });
  ok('четвёртый запрос профиля отвергнут понятным текстом (429)', fourth.status === 429 && /уже 3 ожидающих/.test(fourth.body.error));
  ok('другой профиль очередью не заблокирован', (await call('dev3', '/api/modules/certificate-requests', 'POST', { key: hexOf(newKey()) })).status === 200);
  for (const ask of (await owner.certificates()).requests) await owner.declineCertificate({ key: ask.key });
  ok('очередь разобрана', (await owner.certificates()).requests.length === 0);
  await rejects('запасное хранилище сертификат не подписывает', make('owner', { ...vault, kind: 'backup' }).certify({ key: devHex, userId: 'developer' }), /основное хранилище/);
  await rejects('без подключения к базе подписывать нельзя', make('').certify({ key: devHex, userId: 'developer' }), /Подключитесь/);

  console.log('Тестовый канал: назначение тестировщиков');
  await db.user.create({ data: { id: 'tester-1', symbol: 't1', password: 'x', name: 'Тестировщик 1' } });
  await db.user.create({ data: { id: 'tester-2', symbol: 't2', password: 'x', name: 'Тестировщик 2' } });
  await owner.saveTesters({ testers: ['tester-1', 'tester-2', 'tester-1'] });
  ok('сохранённый список читается обратно без повторов', (await owner.testers()).testers.join() === 'tester-1,tester-2' && (await owner.testers()).users.some((u: any) => u.id === 'tester-1'));
  await rejects('не массив отвергается', owner.saveTesters({ testers: 'tester-1' } as any), /Некорректный список/);
  await rejects('несуществующий профиль отвергается главным процессом по формату', owner.saveTesters({ testers: ['tester 1; DROP'] }), /Некорректный номер/);
  await rejects('несуществующий профиль отвергается сервером', owner.saveTesters({ testers: ['tester-1', 'нет-такого-профиля'.replace(/[^a-z-]/g, 'x')] }), /Неизвестные профили/);
  ok('после отказов список прежний', (await owner.testers()).testers.join() === 'tester-1,tester-2');
  ok('не массив на сервере — 400, значения не строки — 400', (await call('owner', '/api/modules/testers', 'PUT', { testers: 'x' })).status === 400 && (await call('owner', '/api/modules/testers', 'PUT', { testers: [1, {}] })).status === 400);
  ok('чужой профиль без прав владельца список не меняет', (await call('admin', '/api/modules/testers', 'PUT', { testers: [] })).status === 403 && (await owner.testers()).testers.length === 2);

  console.log('Запросы на публикацию: просмотр');
  const b100 = moduleBundle('1.0.0');
  const sig100 = requestEnvelope(dev, b100, { version: '1.0.0', channel: 'test' });
  const sent = await call('developer', '/api/modules/requests', 'POST', { signature: sig100, bundle: Buffer.from(b100).toString('base64') });
  ok('запрос разработчика принят', sent.status === 200);
  const queue = await owner.requests();
  ok('владелец видит очередь с «что нового»', queue.requests.length === 1 && queue.requests[0].state === 'pending' && queue.requests[0].meta.changelog === 'Версия 1.0.0');
  const view = await owner.request({ id: sent.body.id });
  ok('карточка: подпись разработчика, разница и пакет байт в байт', view.signature === sig100 && view.diff.files.length > 0 && Buffer.from(view.bundle, 'base64').equals(Buffer.from(b100)));
  ok('хеш показанного пакета', /^[0-9a-f]{64}$/.test(view.sha256));
  ok('пробный запуск берёт собранную подпрограмму из того же пакета', (await owner.trialLoad({ id: sent.body.id })).manifest.id === 'equipment-inspector' && consoleApi.trialState()?.id === sent.body.id);

  console.log('Выпуск подписывает владелец');
  await rejects('пакет изменился после просмотра — подпись не ставится', owner.release({ id: sent.body.id, channel: 'test', notBefore: 0, sha256: 'f'.repeat(64) }), /изменился/);
  ok('выпусков нет', await count('ModuleRelease') === 0);
  answer = false;
  await rejects('отказ в диалоге — выпуска нет', owner.release({ id: sent.body.id, channel: 'test', notBefore: 0, sha256: view.sha256 }), /отменена/);
  ok('выпусков по-прежнему нет', await count('ModuleRelease') === 0);
  answer = true;
  await rejects('неизвестный канал отвергается', owner.release({ id: sent.body.id, channel: 'beta', notBefore: 0, sha256: view.sha256 }), /канал/);
  await rejects('запасное хранилище не выпускает', make('owner', { ...vault, kind: 'backup' }).release({ id: sent.body.id, channel: 'test', notBefore: 0, sha256: view.sha256 }), /основное хранилище/);
  asked.length = 0;
  const released = await owner.release({ id: sent.body.id, channel: 'test', notBefore: 0, sha256: view.sha256 });
  ok('выпуск записан сервером (подпись ключом издателя принята)', released.release.moduleId === 'equipment-inspector' && await count('ModuleRelease') === 1);
  ok('перед подписью владельцу показали модуль, версию и канал', asked.length === 1 && /1\.0\.0/.test(asked[0].message) && /тестовый/.test(asked[0].detail));
  await rejects('решённый запрос второй раз не выпускается', owner.release({ id: sent.body.id, channel: 'test', notBefore: 0, sha256: view.sha256 }), /уже решён/);
  ok('перевод в рабочий канал', (await owner.promote({ releaseId: released.release.id })) && (await call('owner', '/api/modules/promotions')).body.promotions.length === 1);
  await owner.pin({ moduleId: 'equipment-inspector', channel: 'production', version: '1.0.0', reason: 'проверка' });
  ok('откат канала записан', (await call('owner', '/api/modules/pins')).body.pins.length === 1);
  await owner.pin({ moduleId: 'equipment-inspector', channel: 'production', version: null, reason: 'снять' });
  ok('снятие отката записано', (await call('owner', '/api/modules/pins')).body.pins.length === 2);
  await owner.revoke({ target: 'release', value: 'equipment-inspector@1.0.0', reason: 'проверка' });
  ok('отзыв выпуска записан и выпуск отозван', (await call('owner', '/api/modules/releases')).body.releases[0].state === 'revoked');

  console.log('Правка владельца, возврат, отказ');
  const b110 = moduleBundle('1.1.0', { 'logic/extra.ts': 'export const x = 1;' });
  const r110 = await call('developer', '/api/modules/requests', 'POST', { signature: requestEnvelope(dev, b110, { version: '1.1.0', baseRelease: 'equipment-inspector@1.0.0' }), bundle: Buffer.from(b110).toString('base64') });
  const v110 = await owner.request({ id: r110.body.id });
  await rejects('править можно только разрешённые файлы: «нет/файла.ts» отвергается', owner.ownerEdit({ id: r110.body.id, texts: { 'нет/файла.ts': 'x' }, sha256: v110.sha256 }), /только manifest\.json/);
  await rejects('исходный код владелец не правит', owner.ownerEdit({ id: r110.body.id, texts: { 'logic/extra.ts': 'export const x = 2;' }, sha256: v110.sha256 }), /Исходный код/);
  await rejects('form.json владелец не правит: форма вшита в runtime.js', owner.ownerEdit({ id: r110.body.id, texts: { 'form.json': '{}' }, sha256: v110.sha256 }), /form\.json/);
  await rejects('build/runtime.js владелец не правит', owner.ownerEdit({ id: r110.body.id, texts: { 'build/runtime.js': '/* другое */' }, sha256: v110.sha256 }), /build\/runtime\.js/);
  ok('после отказов правок в базе нет', await count('ModuleRequest') === 2);
  await rejects('без изменений правка не подписывается', owner.ownerEdit({ id: r110.body.id, texts: {}, sha256: v110.sha256 }), /Нет изменений/);
  const edited = await owner.ownerEdit({ id: r110.body.id, texts: { 'examples/basic.json': '{"input":{},"expect":{"parameterCount":1}}' }, comment: 'поправил', sha256: v110.sha256 });
  const ownerRequest = (await owner.requests()).requests.find((r: any) => r.id === edited.id);
  ok('правка владельца — отдельный запрос от владельца, прежний помечен', ownerRequest.byOwner && ownerRequest.meta.comment === 'поправил'
    && (await owner.requests()).requests.find((r: any) => r.id === r110.body.id).state === 'edited');
  const editedView = await owner.request({ id: edited.id });
  const editedBundle = unpackBundle(Buffer.from(editedView.bundle, 'base64'));
  ok('в правке именно изменённый файл данных, код прежний', Buffer.from(editedBundle['examples/basic.json']).toString().includes('"parameterCount":1')
    && Buffer.from(editedBundle['logic/extra.ts']).toString() === 'export const x = 1;');
  ok('хеш пересчитан из байт правки и отличается от хеша пакета разработчика', edited.sha256 === editedView.sha256 && edited.sha256 !== v110.sha256);
  ok('хеш правки записан в запрос на сервере', (await db.$queryRawUnsafe(`SELECT "sha256" FROM "ModuleRequest" WHERE "id" = '${edited.id}'`))[0].sha256 === edited.sha256);
  // Сервер не полагается на окно: правка кода, присланная мимо главного процесса, тоже отвергается
  const sneaky = packBundle({ ...unpackBundle(Buffer.from(v110.bundle, 'base64')), 'logic/extra.ts': 'steal()' });
  const sneakySig = sealEnvelope('request', { v: 1, moduleId: 'equipment-inspector', version: '1.1.0', baseRelease: null, parentRequest: r110.body.id, author: vault.keys.update.publicHex, iat: Date.now(),
    meta: { ...v110.request.meta, comment: 'мимо окна', contractVersion: 1 }, ...describeBundle(sneaky) }, rootKey);
  const sneakyResult = await call('owner', '/api/modules/requests', 'POST', { signature: sneakySig, bundle: Buffer.from(sneaky).toString('base64') });
  ok('сервер отвергает правку владельца с изменённым кодом', sneakyResult.status === 400 && /Исходный код/.test(sneakyResult.body.error));
  await rejects('выпуск правки с хешем пакета разработчика не подписывается', owner.release({ id: edited.id, channel: 'test', notBefore: 0, sha256: v110.sha256 }), /изменился/);
  const releasedEdit = await owner.release({ id: edited.id, channel: 'test', notBefore: 0, sha256: edited.sha256 });
  ok('выпуск правки подписан именно по её хешу и хеш остался в записи выпуска', releasedEdit.sha256 === edited.sha256
    && (await db.$queryRawUnsafe(`SELECT "sha256" FROM "ModuleRelease" WHERE "id" = '${releasedEdit.release.id}'`))[0].sha256 === edited.sha256);
  const b120 = moduleBundle('1.2.0');
  const r120 = await call('developer', '/api/modules/requests', 'POST', { signature: requestEnvelope(dev, b120, { version: '1.2.0' }), bundle: Buffer.from(b120).toString('base64') });
  await owner.returnRequest({ id: r120.body.id, note: 'поправь', comments: [{ path: 'logic/main.ts', line: 3, text: 'имя' }, { path: 'x', line: 0, text: 'без строки' }] });
  const returned = (await call('developer', '/api/modules/requests')).body.requests.find((r: any) => r.id === r120.body.id);
  ok('разработчик видит замечания к строкам', returned.state === 'returned' && returned.review.comments[0].line === 3 && returned.review.comments[1].line === null);
  await rejects('отклонить без причины нельзя', owner.rejectRequest({ id: r120.body.id, reason: '  ' }), /причину/);
  const b130 = moduleBundle('1.3.0');
  const r130 = await call('developer', '/api/modules/requests', 'POST', { signature: requestEnvelope(dev, b130, { version: '1.3.0' }), bundle: Buffer.from(b130).toString('base64') });
  await owner.rejectRequest({ id: r130.body.id, reason: 'не нужно' });
  ok('отклонённый запрос записан', (await owner.requests()).requests.find((r: any) => r.id === r130.body.id).state === 'rejected');

  console.log('Права на сервере: всем, кроме владельца, 403');
  for (const who of ['admin', 'developer', 'stranger']) {
    const label = who === 'admin' ? 'администратор' : who === 'developer' ? 'разработчик' : 'посторонний';
    ok(`${label}: выпуск — 403`, (await call(who, `/api/modules/requests/${r120.body.id}/release`, 'POST', { signature: 'x' })).status === 403);
    ok(`${label}: сертификат — 403`, (await call(who, '/api/modules/certificates', 'POST', { signature: 'x' })).status === 403);
    ok(`${label}: отзыв — 403`, (await call(who, '/api/modules/revocations', 'POST', { signature: 'x' })).status === 403);
    ok(`${label}: назначение обновления — 403`, (await call(who, '/api/updates/campaigns', 'POST', {})).status === 403);
    ok(`${label}: список устройств — 403`, (await call(who, '/api/updates/devices')).status === 403);
    ok(`${label}: тестовый канал — 403`, (await call(who, '/api/modules/testers')).status === 403);
  }
  await rejects('действие под входом администратора отказывает целиком', make('admin').devices(), /только владелец|Доступно только владельцу/);
  await rejects('и подпись выпуска под входом администратора', make('admin').certify({ key: devHex, userId: 'developer' }), /Доступно только владельцу|только владелец/);

  console.log('Обновления Flux: назначение компьютерам');
  const sign = (p: object) => `FLUXUPD1.${Buffer.from(JSON.stringify(p)).toString('base64url')}`;
  const releaseBody = { version: '2.0.0', size: 1024, sha256: 'a'.repeat(64), iat: Date.now() };
  const releaseSignature = (() => { const body = sign(releaseBody); return `${body}.${crypto.sign(null, Buffer.from(body), rootKey).toString('base64url')}`; })();
  await db.appUpdate.create({ data: { version: '2.0.0', changelog: 'новое', fileUrl: '', generation: crypto.randomUUID(), state: 'published', signature: releaseSignature, size: 1024, sha256: 'a'.repeat(64) } });
  const deviceKey = crypto.generateKeyPairSync('ed25519');
  const deviceHex = (deviceKey.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
  const heartbeat = async (deviceId: string, userId: string, version = '1.0.0') => {
    sessions[userId] ||= { id: userId, name: `Сотрудник ${userId}`, role: 'ENGINEER_AUTO' };
    const proof = signUpdateEnvelope('FLUXUPDDEVICE1', { deviceId, userId, version, platform: 'win32', arch: 'x64', status: 'idle', code: '', commandId: null, at: Date.now() }, deviceKey.privateKey);
    return call(userId, '/api/updates/devices/heartbeat', 'POST', { publicKey: deviceHex, proof });
  };
  await db.user.create({ data: { id: 'emp1', symbol: 'e1', password: 'x', name: 'Иван Первый' } }).catch(() => {});
  await db.user.create({ data: { id: 'emp2', symbol: 'e2', password: 'x', name: 'Пётр Второй' } }).catch(() => {});
  const d1 = crypto.randomUUID(), d2 = crypto.randomUUID();
  ok('компьютеры сотрудников сообщили о себе', (await heartbeat(d1, 'emp1')).status === 200 && (await heartbeat(d2, 'emp2')).status === 200);
  const state = await owner.devices();
  ok('владелец видит устройства и выпуск', state.devices.length === 2 && state.releases[0].version === '2.0.0');
  await rejects('выпуск, которого нет в списке, не назначается', owner.assignUpdate({ action: 'schedule', version: '9.9.9', minutes: 10, devices: [`${d1}:emp1`] }), /недоступен/);
  await rejects('чужое устройство не назначается', owner.assignUpdate({ action: 'schedule', version: '2.0.0', minutes: 10, devices: [`${crypto.randomUUID()}:emp1`] }), /изменились/);
  await rejects('срок меньше пяти минут отвергается', owner.assignUpdate({ action: 'schedule', version: '2.0.0', minutes: 1, devices: [`${d1}:emp1`] }), /от 5 минут/);
  answer = false;
  await rejects('отказ в диалоге — назначения нет', owner.assignUpdate({ action: 'schedule', version: '2.0.0', minutes: 10, devices: [`${d1}:emp1`] }), /отменена/);
  ok('команд нет после отказа', Number((await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "AppSetting" WHERE "key" = 'update.command'`))[0].n) === 0);
  answer = true;
  const assigned = await owner.assignUpdate({ action: 'schedule', version: '2.0.0', minutes: 10, devices: [`${d1}:emp1`] });
  ok('назначение принято сервером', assigned.ids.length === 1);
  const beat = await heartbeat(d1, 'emp1');
  const chain = verifiedDeviceChain(beat.body.commands, { inst: 'company', deviceId: d1, userId: 'emp1', keyHex: rootHex });
  ok('клиент Flux проверяет назначение так же, как раньше: подпись, разрешение, цепочка', chain?.command.action === 'schedule' && chain.command.version === '2.0.0' && chain.command.actor === 'flux-owner');
  ok('второе устройство не затронуто', verifiedDeviceChain((await heartbeat(d2, 'emp2')).body.commands, { inst: 'company', deviceId: d2, userId: 'emp2', keyHex: rootHex }) === null);
  const after = await owner.devices();
  ok('в списке устройство запланировано', after.devices.find((d: any) => d.deviceId === d1).action === 'schedule');
  const d3 = crypto.randomUUID();
  await db.user.create({ data: { id: 'emp3', symbol: 'e3', password: 'x', name: 'Сергей Третий' } }).catch(() => {});
  await heartbeat(d3, 'emp3', '2.0.0');
  await rejects('устройство с актуальной версией не назначается', owner.assignUpdate({ action: 'schedule', version: '2.0.0', minutes: 10, devices: [`${d3}:emp3`] }), /не сохранено|актуальной/);
  await owner.assignUpdate({ action: 'cancel', devices: [`${d1}:emp1`] });
  const cancelled = verifiedDeviceChain((await heartbeat(d1, 'emp1')).body.commands, { inst: 'company', deviceId: d1, userId: 'emp1', keyHex: rootHex });
  ok('отмена продолжила цепочку', cancelled?.command.action === 'cancel');
  await rejects('отменять нечего', owner.assignUpdate({ action: 'cancel', devices: [`${d2}:emp2`] }), /нет назначения/);
  await rejects('запасное хранилище обновления не назначает', make('owner', { ...vault, kind: 'backup' }).assignUpdate({ action: 'schedule', version: '2.0.0', minutes: 10, devices: [`${d2}:emp2`] }), /основное хранилище/);
  ok('старые маршруты разрешения администратору удалены', (await call('owner', '/api/updates/delegation')).status === 404 && (await call('owner', '/api/updates/delegation', 'POST', { code: 'x' })).status === 404);

  console.log('Список маршрутов и общий запрет сервера');
  const allowed = consoleApi.routeAllowed;
  ok('нужные разделам маршруты разрешены', allowed('GET', '/api/modules/requests') && allowed('POST', '/api/updates/campaigns') && allowed('GET', '/api/updates/devices') && allowed('PUT', '/api/modules/testers'));
  ok('чужие маршруты и методы закрыты', !allowed('GET', '/api/users') && !allowed('POST', '/api/db/query') && !allowed('DELETE', '/api/modules/requests/1') && !allowed('GET', '/api/updates/delegation')
    && !allowed('POST', '/api/modules/requests/../../users/return') && !allowed('GET', '/api/modules/requests/a b'));
  ok('общий запрет сервера: назначение и разрешение — владельцу, а сообщения устройства — всем', requiresOwner('/api/updates/campaigns', 'POST') && requiresOwner('/api/updates/delegation', 'POST')
    && !requiresOwner('/api/updates/devices/heartbeat', 'POST') && !requiresOwner('/api/updates/reminder', 'POST'));
  ok('окно получает только публичное состояние', !JSON.stringify(consoleApi.publicState({ snapshot: () => ({ version: '1', unlocked: true, vaultExists: true, backupSession: false, kind: 'main', licenses: [1], publicKeys: { a: 1 } }), token: () => 't', display: () => 'db', user: () => ({ id: 'u', name: 'n', role: 'OWNER' }) } as any)).match(/licenses|publicKeys|"t"/));

  server.close();
  console.log(`\n${passed} проверок пройдено, 0 провалено`);
}
main().then(() => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); }, error => { console.error(error); fs.rmSync(dir, { recursive: true, force: true }); process.exit(1); });
