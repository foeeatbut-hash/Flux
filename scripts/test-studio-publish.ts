/**
 * Сервер для разделов разработчика Studio: явное право, чужая программа, запросы, сертификат, выпуски.
 *
 * Настоящие маршруты на одноразовой SQLite с таблицами из prisma/schema.prisma. Что доказывается:
 * - все маршруты разработчика закрыты ЯВНЫМ правом module.develop: администратору без него — 403, хотя общая
 *   проверка Flux (can) ему всё разрешает; мутация — тот же приём запроса без крючка Studio его пропускает;
 * - разработчик видит и скачивает только свои запросы; чужой пакет отвечает «не найден»;
 * - присылать версию под идентификатором, который занят другим разработчиком (запросом или выпуском), нельзя;
 * - состояние сертификата: нет / выдан / отозван; чужие ключи и имена не раскрываются;
 * - замечания владельца видны автору запроса; выпуски отдаются только своей программы.
 *
 * Запуск: npx tsx scripts/test-studio-publish.ts
 */
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRemoteSchema } from '../server/schema-sync';
import { registerStudioRoutes } from '../server/routes/studio';
import { registerStudioDeveloperRoutes, studioPublishGate } from '../server/routes/studioDeveloper';
import { registerModulePublishingRoutes } from '../server/routes/modulePublishing';
import { certificateEnvelope, hexOf, moduleBundle, newKey, pinEnvelope, releaseEnvelope, requestEnvelope, revocationEnvelope } from './fixtures/moduleTrust';

const Database = require('better-sqlite3');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-publish-'));

async function main() {
  const file = path.join(dir, 'flux.sqlite');
  new Database(file).close();
  const { PrismaClient } = require('@prisma/client-sqlite');
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  await ensureRemoteSchema(db, 'sqlite', fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8'), () => {});

  const root = newKey(), rootHex = hexOf(root);
  const keys = { a: newKey(), b: newKey(), c: newKey(), admin: newKey() };
  const grant = JSON.stringify({ 'module.develop': { enabled: true } });
  const people: Record<string, any> = {
    owner: { id: 'flux-owner', name: 'Владелец', role: 'OWNER' },
    a: { id: 'dev-a', name: 'Анна', role: 'ENGINEER_VENT', permissions: grant },
    b: { id: 'dev-b', name: 'Борис', role: 'ENGINEER_VENT', permissions: grant },
    admin: { id: 'admin-1', name: 'Админ', role: 'ADMIN', permissions: '{}' },
    c: { id: 'dev-c', name: 'Вера', role: 'ENGINEER_VENT', permissions: grant },
    plain: { id: 'plain', name: 'Инженер', role: 'ENGINEER_VENT', permissions: '{}' },
  };
  // Общая проверка прав Flux (userCan): администратору разрешает всё, кроме admin.*
  const can = (user: any, feature: string) => user?.role === 'OWNER' || (user?.role === 'ADMIN' && !feature.startsWith('admin.')) || !!JSON.parse(user?.permissions || '{}')[feature]?.enabled;
  const permissionsOf = async (user: any) => JSON.parse(user.permissions || '{}');
  const build = (strict: boolean) => {
    const app = express();
    app.use(express.json({ limit: '60mb' }));
    app.use('/api', (req: any, res, next) => { req.authUser = people[String(req.headers.authorization || '').replace(/^Bearer /, '')]; return req.authUser ? next() : res.status(401).end(); });
    registerStudioRoutes(app, { getPrisma: () => db, permissionsOf });
    registerStudioDeveloperRoutes(app, { getPrisma: () => db, permissionsOf, modulePublicKeyHex: rootHex });
    registerModulePublishingRoutes(app, { getPrisma: () => db, broadcast: () => {}, can, modulePublicKeyHex: rootHex,
      ...(strict ? { studioGate: studioPublishGate({ permissionsOf, modulePublicKeyHex: rootHex }) } : {}) });
    return new Promise<{ origin: string; close: () => void }>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${(s.address() as any).port}`, close: () => s.close() })); });
  };
  const strict = await build(true), loose = await build(false);
  const call = async (server: { origin: string }, who: string, route: string, body?: unknown) => {
    const r = await fetch(server.origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() as any : null, bytes: type.includes('json') ? null : Buffer.from(await r.arrayBuffer()) };
  };
  const send = (server: { origin: string }, who: string, key: any, moduleId: string, version: string, extra: { checks?: string; parentRequest?: string } = {}) => {
    const bundle = moduleBundle(version, {}, { id: moduleId });
    return call(server, who, '/api/modules/requests', { signature: requestEnvelope(key, bundle, { moduleId, version, ...extra }), bundle: Buffer.from(bundle).toString('base64') });
  };
  const certify = async (key: any, userId: string, name: string) => {
    const signature = certificateEnvelope(root, hexOf(key), userId);
    await db.moduleCertificate.create({ data: { keyHex: hexOf(key), userId, name, signature } });
  };
  await certify(keys.a, 'dev-a', 'Анна'); await certify(keys.b, 'dev-b', 'Борис'); await certify(keys.c, 'dev-c', 'Вера'); await certify(keys.admin, 'admin-1', 'Админ');

  try {
    console.log('Явное право');
    const routes = ['/api/studio/requests', '/api/studio/releases?moduleId=alpha', '/api/studio/pins?moduleId=alpha', `/api/studio/certificate?key=${hexOf(keys.a)}`];
    for (const who of ['plain', 'admin']) {
      for (const route of routes) ok(`${who} без права: ${route.split('?')[0]} — 403`, (await call(strict, who, route)).status === 403);
    }
    ok('разработчик с правом входит во все разделы', (await Promise.all(routes.map(r => call(strict, 'a', r)))).every(r => r.status === 200));
    ok('владелец входит', (await call(strict, 'owner', '/api/studio/requests')).status === 200);
    const adminSend = await send(strict, 'admin', keys.admin, 'admin-mod', '0.1.0');
    ok('администратор с сертификатом, но без явного права: отправка закрыта (403)', adminSend.status === 403 && /Разработка программ/.test(adminSend.body.error));
    const looseSend = await send(loose, 'admin', keys.admin, 'admin-mod', '0.1.0');
    ok('мутация: без крючка Studio та же отправка проходит — проверка не пустая', looseSend.status === 200 && !!looseSend.body.id);
    await db.moduleRequest.deleteMany({ where: { moduleId: 'admin-mod' } });

    console.log('Свои запросы и чужая программа');
    const first = await send(strict, 'a', keys.a, 'alpha', '0.1.0');
    ok('Анна отправляет «alpha»', first.status === 200 && first.body.id);
    const foreign = await send(strict, 'b', keys.b, 'alpha', '0.2.0');
    ok('Борис не может прислать версию чужой «alpha» (403)', foreign.status === 403 && /принадлежит другому разработчику/.test(foreign.body.error));
    ok('отказ не создал запрос', await db.moduleRequest.count({ where: { moduleId: 'alpha', authorId: 'dev-b' } }) === 0);
    ok('мутация: без крючка Борис чужую программу присылает', (await send(loose, 'b', keys.b, 'alpha', '0.3.0')).status === 200);
    await db.moduleRequest.deleteMany({ where: { moduleId: 'alpha', authorId: 'dev-b' } });
    ok('Борис отправляет свою «beta»', (await send(strict, 'b', keys.b, 'beta', '0.1.0')).status === 200);
    const listA = (await call(strict, 'a', '/api/studio/requests')).body.requests, listB = (await call(strict, 'b', '/api/studio/requests')).body.requests;
    ok('Анна видит только свою «alpha»', listA.map((r: any) => r.moduleId).join() === 'alpha');
    ok('Борис видит только свою «beta»', listB.map((r: any) => r.moduleId).join() === 'beta');
    const bundleA = await call(strict, 'a', `/api/studio/requests/${first.body.id}/bundle`);
    ok('автор скачивает свой пакет', bundleA.status === 200 && bundleA.bytes!.length > 100);
    ok('чужой пакет — «не найден»', (await call(strict, 'b', `/api/studio/requests/${first.body.id}/bundle`)).status === 404);
    ok('несуществующий запрос — «не найден»', (await call(strict, 'a', '/api/studio/requests/nope/bundle')).status === 404);

    console.log('Отчёт проверки и предел очереди');
    const refusedWith = async (checks: string | undefined) => (await send(strict, 'a', keys.a, 'gamma', '0.1.0', checks === undefined ? { checks: '' } : { checks }));
    ok('запрос без отчёта не принимается (400)', (await refusedWith(undefined)).status === 400 && /не приложен отчёт/.test((await refusedWith(undefined)).body.error));
    ok('отчёт не JSON не принимается', (await refusedWith('не json')).status === 400);
    ok('отчёт с ok:false не принимается', (await refusedWith('{"ok":false}')).status === 400);
    ok('отчёт ok:true, но со строкой «не прошло» не принимается', (await refusedWith('{"ok":true,"items":[{"id":"x","status":"fail"}]}')).status === 400 && /не прошло/.test((await refusedWith('{"ok":true,"items":[{"id":"x","status":"fail"}]}')).body.error));
    ok('отказ не создал запрос', await db.moduleRequest.count({ where: { moduleId: 'gamma' } }) === 0);
    ok('мутация: честный отчёт принимается', (await send(strict, 'a', keys.a, 'gamma', '0.1.0', { checks: '{"ok":true,"items":[{"id":"x","status":"ok"}]}' })).status === 200);
    for (let i = 2; i <= 5; i++) await send(strict, 'a', keys.a, 'gamma', `0.${i}.0`);
    const sixth = await send(strict, 'a', keys.a, 'gamma', '0.6.0');
    ok('шестой ожидающий запрос автора — 429 с понятным ответом', sixth.status === 429 && /5 запросов ждут проверки/.test(sixth.body.error));
    ok('другой автор не упирается в чужой предел', (await send(strict, 'b', keys.b, 'delta', '0.1.0')).status === 200);
    const firstGamma = (await db.moduleRequest.findFirst({ where: { moduleId: 'gamma' }, orderBy: { createdAt: 'asc' } })).id;
    ok('исправление к ожидающему запросу предел не увеличивает', (await send(strict, 'a', keys.a, 'gamma', '0.7.0', { parentRequest: firstGamma })).status === 200);
    const foreignParent = await send(strict, 'b', keys.b, 'gamma', '0.8.0', { parentRequest: firstGamma });
    ok('родитель — запрос другого автора: не принимается (чужая программа)', foreignParent.status === 403 || foreignParent.status === 400);
    const sameSignature = await call(strict, 'b', '/api/modules/requests', { signature: (await db.moduleRequest.findFirst({ where: { moduleId: 'gamma' } })).signature, bundle: '' });
    ok('повтор чужой подписи не раскрывает id чужого запроса', !sameSignature.body?.id);
    await db.moduleRequest.deleteMany({ where: { moduleId: { in: ['gamma', 'delta'] } } });

    console.log('Замечания владельца');
    await db.moduleRequest.update({ where: { id: first.body.id }, data: { state: 'returned', review: JSON.stringify({ note: 'Поправьте подпись поля', comments: [{ path: 'form.json', line: 3, text: 'длинная подпись' }] }) } });
    const returned = (await call(strict, 'a', '/api/studio/requests')).body.requests[0];
    ok('автор видит состояние, замечание и комментарий к строке', returned.state === 'returned' && returned.review.note === 'Поправьте подпись поля' && returned.review.comments[0].path === 'form.json');
    ok('«что нового» и канал видны в списке', returned.changelog === 'Версия 0.1.0' && returned.channel === 'test');
    ok('в списке нет подписи и чужих данных', !('signature' in returned) && !('authorId' in returned));

    console.log('Сертификат');
    const status = async (who: string, key: string) => (await call(strict, who, `/api/studio/certificate?key=${key}`)).body;
    ok('выданный сертификат своего ключа', (await status('a', hexOf(keys.a))).status === 'issued' && (await status('a', hexOf(keys.a))).name === 'Разработчик');
    ok('свой сертификат приходит конвертом (для «Запустить во Flux»), чужой — нет', /^FLUXMODCERT1\./.test((await status('a', hexOf(keys.a))).certificate) && !('certificate' in (await status('b', hexOf(keys.a)))));
    ok('чужой ключ отвечает как неизвестный, имя не раскрывается', (await status('b', hexOf(keys.a))).status === 'none' && (await status('b', hexOf(keys.a))).name === '');
    ok('неизвестный ключ — «нет»', (await status('a', hexOf(newKey()))).status === 'none');
    ok('некорректный ключ — 400', (await call(strict, 'a', '/api/studio/certificate?key=zz')).status === 400);
    await db.moduleRevocation.create({ data: { kind: 'key', target: hexOf(keys.b), reason: 'проверка', signature: revocationEnvelope(root, 'key', hexOf(keys.b)), signatureHash: 'rev-b' } });
    ok('отозванный сертификат: «отозван»', (await status('b', hexOf(keys.b))).status === 'revoked');
    ok('отозванный ключ больше не присылает запросы', (await send(strict, 'b', keys.b, 'beta', '0.2.0')).status === 400);

    console.log('Выпуски своей программы');
    const bundle = moduleBundle('0.1.0', {}, { id: 'alpha' });
    await db.moduleRelease.create({ data: { moduleId: 'alpha', version: '0.1.0', channel: 'test', signature: releaseEnvelope(root, bundle, { moduleId: 'alpha', version: '0.1.0', author: hexOf(keys.a), channel: 'test' }), requestId: first.body.id, blobId: first.body.id, size: bundle.length, sha256: 'x', chunkCount: 1 } });
    const releasesA = (await call(strict, 'a', '/api/studio/releases?moduleId=alpha')).body.releases;
    ok('автор видит выпуск своей программы', releasesA.length === 1 && releasesA[0].version === '0.1.0' && releasesA[0].channel === 'test');
    ok('чужой разработчик выпусков не видит', (await call(strict, 'b', '/api/studio/releases?moduleId=alpha')).body.releases.length === 0);
    ok('некорректный идентификатор — 400', (await call(strict, 'a', '/api/studio/releases?moduleId=Bad')).status === 400);
    // Откат владельца: назначение канала, подписанное владельцем; видно автору своей программы, действует последнее по времени
    const pin = (version: string | null, iat: number, hash: string) => db.moduleChannelPin.create({ data: { moduleId: 'alpha', channel: 'test', version: version || '', reason: 'проверка', signature: pinEnvelope(root, 'alpha', 'test', version, iat), signatureHash: hash } });
    await pin('0.0.5', 1000, 'pin-1');
    ok('автор видит откат владельца по своей программе', (await call(strict, 'a', '/api/studio/pins?moduleId=alpha')).body.pins?.[0]?.version === '0.0.5');
    await pin(null, 2000, 'pin-2');
    const pinsA = (await call(strict, 'a', '/api/studio/pins?moduleId=alpha')).body.pins;
    ok('действует последнее назначение канала (ограничение снято)', pinsA.length === 1 && pinsA[0].version === null && pinsA[0].channel === 'test');
    ok('чужой разработчик откатов чужой программы не видит', (await call(strict, 'b', '/api/studio/pins?moduleId=alpha')).body.pins.length === 0);
    ok('некорректный идентификатор откатов — 400', (await call(strict, 'a', '/api/studio/pins?moduleId=Bad')).status === 400);
    await db.moduleRequest.deleteMany({ where: { moduleId: 'alpha' } });
    const stillForeign = await send(strict, 'c', keys.c, 'alpha', '0.9.0');
    ok('выпуск чужого ключа закрывает программу и без запросов в очереди (403)', stillForeign.status === 403 && /другому разработчику/.test(stillForeign.body.error));
    ok('автор выпуска продолжает свою программу', (await send(strict, 'a', keys.a, 'alpha', '0.9.0')).status === 200);
  } finally {
    strict.close(); loose.close();
    await db.$disconnect?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nFlux Studio: сервер разделов разработчика — ${passed} проверок пройдено`);
}
main().catch((error) => { console.error(error); process.exit(1); });
