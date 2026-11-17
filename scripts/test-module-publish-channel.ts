/**
 * Выбор «в тест» или «сразу всем» при отправке версии: от окна разработчика до владельца и до людей.
 *
 * Что доказывается на настоящем коде:
 * - Studio (studio/shared/publish.ts, buildRequest) кладёт выбор в подписанный запрос: `meta.channel`; другой выбор — другая подпись;
 * - сервер (настоящие маршруты на одноразовой SQLite) принимает «в тест» от любого разработчика, а «сразу всем» — только от владельца
 *   и от разработчика с правом «Просить рабочий канал»; отказ несёт текст про это право, запрос не записан;
 * - выбор не теряется по пути: владелец видит в очереди `meta.channel` ровно как выбрал автор, автор видит его в своём списке;
 * - после «в тест» человек с уже установленной версией не получает новую (список выпусков для обычного человека её не содержит),
 *   пока владелец не выпустит всем; тестировщик и владелец её видят;
 * - ответ `/api/modules/me`, по которому окно Studio закрывает «Сразу всем», говорит правду о праве.
 *
 * Запуск: npx tsx scripts/test-module-publish-channel.ts
 */
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRemoteSchema } from '../server/schema-sync';
import { registerModulePublishingRoutes } from '../server/routes/modulePublishing';
import { buildRequest } from '../studio/shared/publish';
import type { DeveloperKeyring } from '../studio/shared/keyring';
import type { CheckReport } from '../studio/shared/checks';
import { peekEnvelope, sealEnvelope } from '../modules/trust/envelope';
import { parseRequestClaim } from '../modules/trust/claims';
import { certificateEnvelope, hexOf, newKey, releaseEnvelope } from './fixtures/moduleTrust';
import { unpackBundle } from '../modules/trust/bundle';

const Database = require('better-sqlite3');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-publish-channel-'));
const FIXTURE = path.join(__dirname, '..', 'modules', 'fixtures', 'equipment-inspector');

/** Файлы проекта разработчика: пример-программа из модулей Flux */
function projectFiles(version: string): Record<string, Uint8Array> {
  const read = (name: string) => fs.readFileSync(path.join(FIXTURE, name));
  const manifest = { ...JSON.parse(read('manifest.json').toString('utf8')), version };
  return {
    'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2)), 'form.json': read('form.json'), 'logic/main.ts': read('logic/main.ts'),
    'examples/basic.json': Buffer.from(JSON.stringify({ input: {}, expect: { parameterCount: 0 } })),
  };
}
const report: CheckReport = { v: 1, ok: true, at: Date.now(), studio: '1.0.0', items: [] };

/** Ключ разработчика в роли DeveloperKeyring: подписывает так же, как настоящий, только ключ одноразовый */
function keyringOf(key: ReturnType<typeof newKey>): DeveloperKeyring {
  return { info: () => ({ exists: true, available: true, publicKey: hexOf(key), createdAt: Date.now(), damaged: false }), sign: (kind: any, payload: unknown) => sealEnvelope(kind, payload, key) } as unknown as DeveloperKeyring;
}

async function main() {
  const file = path.join(dir, 'flux.sqlite');
  new Database(file).close();
  const { PrismaClient } = require('@prisma/client-sqlite');
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  await ensureRemoteSchema(db, 'sqlite', fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8'), () => {});

  const root = newKey(), rootHex = hexOf(root);
  const plain = newKey(), withRight = newKey();
  const people: Record<string, any> = {
    owner: { id: 'flux-owner', role: 'OWNER' },
    plain: { id: 'dev-plain', role: 'ENGINEER_VENT', permissions: '{}' },
    right: { id: 'dev-right', role: 'ENGINEER_VENT', permissions: '{}' },
    user: { id: 'user-1', role: 'ENGINEER_VENT', permissions: '{}' },
    tester: { id: 'tester-1', role: 'ENGINEER_VENT', permissions: '{}' },
  };
  // Те же права, что раздаёт Flux: «Разработка программ» у обоих разработчиков, «Просить рабочий канал» — только у второго
  const can = (user: any, feature: string) => (feature === 'module.develop' && ['dev-plain', 'dev-right'].includes(user?.id)) || (feature === 'module.publish' && user?.id === 'dev-right');
  const app = express(); app.use(express.json({ limit: '50mb' }));
  app.use('/api', (req: any, res, next) => { req.authUser = people[String(req.headers.authorization || '').replace(/^Bearer /, '')]; return req.authUser ? next() : res.status(401).end(); });
  registerModulePublishingRoutes(app, { getPrisma: () => db, broadcast: () => {}, modulePublicKeyHex: rootHex, can });
  const server = await new Promise<import('http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (who: string, route: string, method = 'GET', body?: unknown) => {
    const r = await fetch(origin + route, { method, headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const build = (key: ReturnType<typeof newKey>, version: string, channel: 'test' | 'production') =>
    buildRequest(keyringOf(key), { moduleId: 'equipment-inspector', version, files: projectFiles(version), runtime: '/* runtime */', baseRelease: null, parentRequest: null, channel, changelog: `Версия ${version}`, comment: '', report, studioVersion: '1.0.0' });
  const submit = (who: string, built: ReturnType<typeof build>) => call(who, '/api/modules/requests', 'POST', { signature: built.signature, bundle: Buffer.from(built.bundle).toString('base64') });
  const sent = new Map<string, ReturnType<typeof build>>();
  const send = async (who: string, key: ReturnType<typeof newKey>, version: string, channel: 'test' | 'production') => {
    const built = build(key, version, channel); sent.set(version, built);
    return { built, ...(await submit(who, built)) };
  };

  console.log('Окно Studio: выбор уходит в подписанный запрос');
  const asTest = build(plain, '1.0.0', 'test'), asAll = build(withRight, '1.0.0', 'production');
  ok('«в тест» — meta.channel = test в подписи', parseRequestClaim(peekEnvelope('request', asTest.signature))?.meta.channel === 'test' && asTest.claim.meta.channel === 'test');
  ok('«сразу всем» — meta.channel = production в подписи', parseRequestClaim(peekEnvelope('request', asAll.signature))?.meta.channel === 'production');
  ok('другой выбор — другая подпись (выбор подписан, а не дописан сбоку)', build(plain, '1.0.0', 'production').signature !== asTest.signature);
  ok('пакет у обоих выборов один и тот же: меняется только запрос', Buffer.compare(Buffer.from(asTest.bundle), Buffer.from(asAll.bundle)) === 0 && Object.keys(unpackBundle(asTest.bundle)).includes('manifest.json'));

  console.log('Сервер: право и сохранение выбора');
  ok('сертификаты разработчиков выданы владельцем', (await call('owner', '/api/modules/certificates', 'POST', { signature: certificateEnvelope(root, hexOf(plain), 'dev-plain') })).status === 200
    && (await call('owner', '/api/modules/certificates', 'POST', { signature: certificateEnvelope(root, hexOf(withRight), 'dev-right') })).status === 200);
  const me = (who: string) => call(who, '/api/modules/me');
  ok('/api/modules/me: у разработчика без права «Просить рабочий канал» publish = false', (await me('plain')).body.publish === false && (await me('plain')).body.develop === true);
  ok('/api/modules/me: с правом — publish = true, у владельца — owner', (await me('right')).body.publish === true && (await me('owner')).body.owner === true);

  const testReply = await send('plain', plain, '1.0.0', 'test');
  ok('«в тест» от разработчика без права принято', testReply.status === 200 && typeof testReply.body.id === 'string');
  const refused = await send('plain', plain, '1.1.0', 'production');
  ok('«сразу всем» без права — отказ 403 с текстом про право «Просить рабочий канал»', refused.status === 403 && /Просить рабочий канал/.test(refused.body.error));
  ok('отказанный запрос в базу не записан', (await db.moduleRequest.count()) === 1);
  const allReply = await send('right', withRight, '2.0.0', 'production');
  ok('«сразу всем» от разработчика с правом принято', allReply.status === 200 && typeof allReply.body.id === 'string');

  console.log('Выбор не теряется по пути: автор → сервер → владелец');
  const queue = (await call('owner', '/api/modules/requests')).body.requests as any[];
  const byVersion = (version: string) => queue.find(r => r.version === version);
  ok('владелец видит запрос «в тест» с выбором test', byVersion('1.0.0')?.meta.channel === 'test');
  ok('владелец видит запрос «сразу всем» с выбором production', byVersion('2.0.0')?.meta.channel === 'production');
  ok('автор видит свой выбор в своём списке', (await call('plain', '/api/modules/requests')).body.requests.find((r: any) => r.version === '1.0.0')?.meta.channel === 'test'
    && (await call('right', '/api/modules/requests')).body.requests.find((r: any) => r.version === '2.0.0')?.meta.channel === 'production');
  ok('чужой выбор автору не виден', (await call('plain', '/api/modules/requests')).body.requests.every((r: any) => r.version !== '2.0.0'));
  // Выпуск подписывает владелец по описанию того же пакета, что прислал автор
  const ownerReleaseFor = (requestId: string, version: string, channel: 'test' | 'production', author: ReturnType<typeof newKey>) =>
    releaseEnvelope(root, sent.get(version)!.bundle, { version, author: hexOf(author), request: requestId, channel });

  console.log('После «в тест» остальные ничего не получают, пока владелец не выпустит всем');
  // Прежний рабочий выпуск 0.9.0 (его запрос и выпуск), затем 1.0.0 уходит «в тест»
  const previousReply = await send('plain', plain, '0.9.0', 'test');
  const releasePrevious = await call('owner', `/api/modules/requests/${previousReply.body.id}/release`, 'POST', { signature: ownerReleaseFor(previousReply.body.id, '0.9.0', 'production', plain) });
  ok('прежняя версия 0.9.0 выпущена всем (владелец вправе выпустить иначе, чем просил автор)', releasePrevious.status === 200 && releasePrevious.body.release.channel === 'production');
  const releaseTest = await call('owner', `/api/modules/requests/${testReply.body.id}/release`, 'POST', { signature: ownerReleaseFor(testReply.body.id, '1.0.0', 'test', plain) });
  ok('владелец выпускает 1.0.0 в тестовый канал, как просил автор', releaseTest.status === 200 && releaseTest.body.release.channel === 'test');
  const seen = async (who: string) => ((await call(who, '/api/modules/releases')).body.releases as any[]).map(r => `${r.version}:${r.channel}`).sort();
  ok('обычный человек видит только 0.9.0: новой версии «в тест» у него нет', (await seen('user')).join() === '0.9.0:production');
  ok('владелец видит обе', (await seen('owner')).join() === '0.9.0:production,1.0.0:test');
  const setTesters = await db.appSetting.create({ data: { key: 'modules.testers', userId: null, value: JSON.stringify(['tester-1']) } });
  ok('назначенный тестировщик пробной группы видит и 1.0.0', setTesters && (await seen('tester')).join() === '0.9.0:production,1.0.0:test');
  const releaseAll = await call('owner', `/api/modules/requests/${allReply.body.id}/release`, 'POST', { signature: ownerReleaseFor(allReply.body.id, '2.0.0', 'production', withRight) });
  ok('владелец выпускает 2.0.0 «сразу всем»', releaseAll.status === 200 && releaseAll.body.release.channel === 'production');
  ok('теперь обычный человек получает 2.0.0, а 1.0.0 «в тест» по-прежнему не видит', (await seen('user')).join() === '0.9.0:production,2.0.0:production');

  console.log('Окно владельца (чтение исходника: файл чужой, правит другой исполнитель)');
  const ownerView = fs.readFileSync(path.join(__dirname, '..', 'studio', 'owner', 'console', 'Requests.tsx'), 'utf8');
  ok('очередь владельца показывает «просит выпуск …» по выбору автора', /просит выпуск/.test(ownerView) && /meta\?\.channel/.test(ownerView));
  ok('форма выпуска предзаполнена выбором автора (владелец вправе изменить)', /useState<ModuleChannel>\(request\.meta\?\.channel/.test(ownerView));

  server.close();
  console.log(`\nmodule-publish-channel: ${passed} проверок прошли`);
}
// Провал не должен оставлять слушающий сервер: процесс завершается сам, иначе набор висел бы до таймаута
main().catch((e) => { console.error(e); process.exit(1); }).then(() => process.exit(process.exitCode ?? 0));
