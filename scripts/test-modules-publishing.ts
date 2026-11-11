/**
 * Публикация модулей насквозь: настоящий сервер маршрутов, одноразовая SQLite
 * с таблицами из prisma/schema.prisma и кэш главного процесса, который
 * качает выпуски по HTTP и проверяет их сам.
 *
 * Главное, что здесь доказывается: Flux запускает только выпуск с подписью
 * владельца. Выпуск, вписанный в базу SQL-запросом без подписи или с подписью
 * разработчика, с изменённым куском, отозванный или с отозванным ключом, не
 * запускается, и работает прошлый проверенный.
 *
 * Запуск: npx tsx scripts/test-modules-publishing.ts
 */
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRemoteSchema } from '../server/schema-sync';
import { registerModulePublishingRoutes } from '../server/routes/modulePublishing';
import { ModuleCache, syncModuleReleases } from '../electron/moduleCache';
import { splitChunks } from '../modules/trust/bundle';
import { releaseKey } from '../modules/trust/claims';
import {
  certificateEnvelope, hexOf, moduleBundle, newKey, releaseEnvelope, requestEnvelope, revocationEnvelope,
} from './fixtures/moduleTrust';

const Database = require('better-sqlite3');
// Тот же путь на PostgreSQL и MariaDB — по одноразовой базе из переменной (пустая, на loopback, «fixture» в имени)
const pgUrl = String(process.env.FLUX_MODULES_PG_FIXTURE_URL || '').trim();
const mariaUrl = String(process.env.FLUX_MODULES_MARIA_FIXTURE_URL || '').trim();
const dialect = pgUrl ? 'postgresql' : mariaUrl ? 'mysql' : 'sqlite';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-module-publishing-'));
const root = newKey(), rootHex = hexOf(root);
const dev = newKey(), devHex = hexOf(dev), dev2 = newKey(), dev2Hex = hexOf(dev2), stranger = newKey();
const MODULE = 'equipment-inspector';

// Запись мимо сервера — как это сделал бы любой с реквизитами SQL общей базы
let db: any;
const q = (name: string) => (dialect === 'mysql' ? `\`${name}\`` : `"${name}"`);
const cols = (...names: string[]) => names.map(q).join(', ');
const placeholders = (text: string) => { let i = 0; return dialect === 'postgresql' ? text.replace(/\?/g, () => `$${++i}`) : text; };
const exec = (text: string, ...params: unknown[]) => db.$executeRawUnsafe(placeholders(text), ...params);
const count = async (table: string) => Number((await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM ${q(table)}`))[0].n);
const stateOf = async (table: string, column: string, value: string) =>
  (await db.$queryRawUnsafe(placeholders(`SELECT ${q('state')} AS state FROM ${q(table)} WHERE ${q(column)} = ?`), value))[0]?.state;

async function openDatabase() {
  const fixture = pgUrl || mariaUrl;
  if (fixture) {
    const url = new URL(fixture);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.includes('fixture'), 'только одноразовая база на loopback с fixture в имени');
    const { PrismaClient } = require(pgUrl ? '@prisma/client-pg' : '@prisma/client-mysql');
    db = pgUrl ? new PrismaClient({ adapter: new (require('@prisma/adapter-pg').PrismaPg)({ connectionString: fixture }) })
      : new PrismaClient({ adapter: new (require('@prisma/adapter-mariadb').PrismaMariaDb)(fixture) });
    const tables = await db.$queryRawUnsafe(pgUrl ? "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public'"
      : 'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()');
    assert.equal(Number(tables[0].n), 0, 'база для проверки должна быть пустой');
    return;
  }
  const file = path.join(dir, 'flux.sqlite');
  new Database(file).close();
  const { PrismaClient } = require('@prisma/client-sqlite');
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
}

async function main() {
  await openDatabase();
  const schema = { sqlite: 'schema.prisma', postgresql: 'schema.postgresql.prisma', mysql: 'schema.mariadb.prisma' }[dialect];
  const schemaLog: string[] = [];
  await ensureRemoteSchema(db, dialect, fs.readFileSync(path.join(__dirname, '..', 'prisma', schema), 'utf8'), (m) => schemaLog.push(m));
  ok(`таблицы модулей созданы на ${dialect}`, !schemaLog.some((m) => /Не удалось|Ошибка при/.test(m)) && await count('ModuleRelease') === 0);

  const app = express(); app.use(express.json({ limit: '50mb' }));
  const sessions: Record<string, { id: string; role: string }> = {
    owner: { id: 'flux-owner', role: 'OWNER' }, developer: { id: 'developer', role: 'ENGINEER_AUTO' },
    developer2: { id: 'developer2', role: 'ENGINEER_AUTO' }, other: { id: 'other', role: 'ENGINEER_VENT' },
  };
  app.use('/api', (req: any, res, next) => { req.authUser = sessions[String(req.headers.authorization || '').replace(/^Bearer /, '')]; return req.authUser ? next() : res.status(401).end(); });
  // Право присылать код — у разработчиков; рабочий канал (module.publish) этому набору не нужен: запросы идут в тестовый
  registerModulePublishingRoutes(app, { getPrisma: () => db, broadcast: () => {}, modulePublicKeyHex: rootHex,
    can: (user, feature) => feature === 'module.develop' && user.role === 'ENGINEER_AUTO' });
  const server = await new Promise<import('http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (who: string, route: string, method = 'GET', body?: unknown) => {
    const r = await fetch(origin + route, { method, headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() as any : Buffer.from(await r.arrayBuffer()) };
  };
  const submit = (who: string, key: any, bundle: Uint8Array, p: Parameters<typeof requestEnvelope>[2]) =>
    call(who, '/api/modules/requests', 'POST', { signature: requestEnvelope(key, bundle, p), bundle: Buffer.from(bundle).toString('base64') });
  const release = async (requestId: string, bundle: Uint8Array, version: string, author: string, extra: { notBefore?: number; channel?: 'test' | 'production' } = {}) => {
    const signature = releaseEnvelope(root, bundle, { version, author, request: requestId, ...extra });
    return { signature, response: await call('owner', `/api/modules/requests/${requestId}/release`, 'POST', { signature }) };
  };
  let clock = Date.now();
  const cache = new ModuleCache(path.join(dir, 'cache'), rootHex, () => clock);
  const sync = () => syncModuleReleases(cache, async (route) => (await call('other', route)).body);
  const running = async () => (await cache.runnable()).get(MODULE)?.claim.version || null;

  console.log('Сертификат и запрос на публикацию');
  const b100 = moduleBundle('1.0.0');
  ok('без сертификата запрос не принимается', (await submit('developer', dev, b100, { version: '1.0.0' })).status === 400);
  ok('сертификат с чужой подписью не принимается', (await call('owner', '/api/modules/certificates', 'POST', { signature: certificateEnvelope(stranger, devHex) })).status === 400);
  ok('сертификат выдаёт только владелец', (await call('developer', '/api/modules/certificates', 'POST', { signature: certificateEnvelope(root, devHex) })).status === 403);
  ok('сертификат владельца принят', (await call('owner', '/api/modules/certificates', 'POST', { signature: certificateEnvelope(root, devHex, 'developer') })).status === 200);
  await call('owner', '/api/modules/certificates', 'POST', { signature: certificateEnvelope(root, dev2Hex, 'developer2') });
  ok('чужим ключом от своего имени нельзя', (await submit('other', dev, b100, { version: '1.0.0' })).status === 403);
  const sig100 = requestEnvelope(dev, b100, { version: '1.0.0' });
  const first = await call('developer', '/api/modules/requests', 'POST', { signature: sig100, bundle: Buffer.from(b100).toString('base64') });
  ok('запрос разработчика принят', first.status === 200 && first.body.id);
  const again = await call('developer', '/api/modules/requests', 'POST', { signature: sig100, bundle: Buffer.from(b100).toString('base64') });
  ok('повтор отправки не плодит запрос', again.body.duplicate && again.body.id === first.body.id && await count('ModuleRequest') === 1);
  const swapped = await call('developer', '/api/modules/requests', 'POST', { signature: requestEnvelope(dev, b100, { version: '1.0.0', changelog: 'другой' }),
    bundle: Buffer.from(moduleBundle('1.0.0', { 'logic/main.ts': 'x' })).toString('base64') });
  ok('пакет, не совпадающий с подписью, не принимается', swapped.status === 400 && /не совпадает/.test(swapped.body.error));
  ok('изменить отправленный запрос нечем', (await call('developer', `/api/modules/requests/${first.body.id}`, 'PUT', {})).status === 404);
  ok('чужой запрос не виден', (await call('other', '/api/modules/requests')).body.requests.length === 0);
  const queue = (await call('owner', '/api/modules/requests')).body.requests;
  ok('владелец видит очередь с «что нового»', queue.length === 1 && queue[0].meta.changelog === 'Версия 1.0.0' && queue[0].state === 'pending');
  const bundleBack = (await call('owner', `/api/modules/requests/${first.body.id}/bundle`)).body as Buffer;
  ok('владелец получает пакет байт в байт', Buffer.compare(bundleBack, Buffer.from(b100)) === 0);

  console.log('Выпуск подписывает только владелец');
  ok('выпуск с подписью разработчика сервер не принимает', (await call('owner', `/api/modules/requests/${first.body.id}/release`, 'POST', { signature: releaseEnvelope(dev, b100, { version: '1.0.0', author: devHex, request: first.body.id }) })).status === 400);
  ok('не владелец выпустить не может', (await call('developer', `/api/modules/requests/${first.body.id}/release`, 'POST', { signature: releaseEnvelope(root, b100, { version: '1.0.0', author: devHex, request: first.body.id }) })).status === 403);
  const r100 = await release(first.body.id, b100, '1.0.0', devHex);
  ok('выпуск 1.0.0 записан', r100.response.status === 200);
  const repeat = await call('owner', `/api/modules/requests/${first.body.id}/release`, 'POST', { signature: r100.signature });
  ok('повтор выпуска возвращает тот же и не плодит дубли', repeat.body.duplicate && await count('ModuleRelease') === 1);
  const resigned = await release(first.body.id, b100, '1.0.0', devHex);
  ok('другая подпись той же версии — отказ, строк не прибавилось', resigned.response.status === 409 && await count('ModuleRelease') === 1);
  ok('куски выпуска не продублированы', await count('ModuleChunk') === splitChunks(b100).length);
  ok('та же версия заново не отправляется', (await submit('developer', dev, b100, { version: '1.0.0', changelog: 'ещё раз' })).status === 409);
  let report = await sync();
  ok('Flux скачал и проверил 1.0.0', report.installed.includes(`${MODULE}@1.0.0`) && await running() === '1.0.0');

  console.log('Выпуск, вписанный в базу в обход владельца, не запускается');
  const insertRelease = async (version: string, signature: string, bundle: Uint8Array) => {
    const blob = `sql-${version}`;
    await exec(`INSERT INTO ${q('ModuleRelease')} (${cols('id', 'moduleId', 'version', 'channel', 'signature', 'requestId', 'blobId', 'size', 'sha256', 'chunkCount', 'state')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `sql-${version}`, MODULE, version, 'production', signature, 'none', blob, bundle.length, '', splitChunks(bundle).length, 'published');
    for (const [idx, chunk] of splitChunks(bundle).entries()) {
      await exec(`INSERT INTO ${q('ModuleChunk')} (${cols('id', 'blobId', 'idx', 'data')}) VALUES (?, ?, ?, ?)`, `${blob}-${idx}`, blob, idx, Buffer.from(chunk));
    }
  };
  const b900 = moduleBundle('9.0.0', { 'logic/main.ts': 'steal()' });
  await insertRelease('9.0.0', '', b900);
  const b910 = moduleBundle('9.1.0');
  await insertRelease('9.1.0', releaseEnvelope(dev, b910, { version: '9.1.0', author: devHex }), b910);
  report = await sync();
  ok('SQL-выпуск без подписи отвергнут', report.broken.some((b) => b.version === '9.0.0' && /нет подписи/.test(b.why)));
  ok('выпуск с подписью только разработчика отвергнут', report.broken.some((b) => b.version === '9.1.0' && /не владельцем/.test(b.why)));
  ok('работает прошлый проверенный 1.0.0', await running() === '1.0.0');

  console.log('Возврат на доработку, правки владельца, разница');
  const b110 = moduleBundle('1.1.0', { 'logic/extra.ts': 'export const x = 1;' });
  const a2 = await submit('developer', dev, b110, { version: '1.1.0', baseRelease: releaseKey(MODULE, '1.0.0') });
  const diff = (await call('owner', `/api/modules/requests/${a2.body.id}/diff`)).body;
  ok('разница с прошлым выпуском по файлам', diff.against?.release === `${MODULE}@1.0.0` && diff.files.some((f: any) => f.path === 'logic/extra.ts' && f.status === 'added'));
  ok('разрешения не расширены', diff.permissions.widened === false && diff.permissions.isNew === false);
  ok('вернуть на доработку с замечаниями', (await call('owner', `/api/modules/requests/${a2.body.id}/return`, 'POST', { note: 'поправь', comments: [{ path: 'logic/extra.ts', line: 1, text: 'имя' }] })).status === 200);
  const mine = (await call('developer', '/api/modules/requests')).body.requests.find((r: any) => r.id === a2.body.id);
  ok('разработчик видит замечания', mine.state === 'returned' && mine.review.comments[0].text === 'имя');
  ok('решённый запрос не решается второй раз', (await call('owner', `/api/modules/requests/${a2.body.id}/reject`, 'POST', { reason: 'нет' })).status === 409);
  const b110b = moduleBundle('1.1.0', { 'logic/extra.ts': 'export const renamed = 1;' });
  const a3 = await submit('developer', dev, b110b, { version: '1.1.0', baseRelease: releaseKey(MODULE, '1.0.0'), parentRequest: a2.body.id });
  ok('новая правка — новый запрос, прежний в истории', a3.status === 200 && a3.body.id !== a2.body.id
    && await stateOf('ModuleRequest', 'id', a2.body.id) === 'superseded');
  // Владелец правит только данные: код остаётся тем, что прислал разработчик (modules/trust/ownerEdit.ts)
  const b110o = moduleBundle('1.1.0', { 'logic/extra.ts': 'export const renamed = 1;', 'examples/basic.json': JSON.stringify({ input: {}, expect: { parameterCount: 1 } }) });
  ok('правка кода владельцем сервером отвергается', (await submit('owner', root, moduleBundle('1.1.0', { 'logic/extra.ts': 'export const renamed = 2;' }), { version: '1.1.0', baseRelease: releaseKey(MODULE, '1.0.0'), parentRequest: a3.body.id })).status === 400);
  ok('изменения владельца присылает только владелец', (await submit('developer', root, b110o, { version: '1.1.0', parentRequest: a3.body.id })).status === 403);
  const o3 = await submit('owner', root, b110o, { version: '1.1.0', baseRelease: releaseKey(MODULE, '1.0.0'), parentRequest: a3.body.id });
  const ownerDiff = (await call('developer', `/api/modules/requests/${a3.body.id}`)).status;
  ok('правка владельца — отдельный запрос', o3.status === 200 && ownerDiff === 200 && await stateOf('ModuleRequest', 'id', a3.body.id) === 'edited');
  const oDiff = (await call('owner', `/api/modules/requests/${o3.body.id}/diff`)).body;
  ok('изменения владельца видны отдельной разницей от запроса разработчика', oDiff.against?.request === a3.body.id
    && oDiff.files.filter((f: any) => f.status !== 'same').map((f: any) => f.path).join() === 'examples/basic.json');
  ok('отклонить можно только с причиной', (await call('owner', `/api/modules/requests/${o3.body.id}/reject`, 'POST', {})).status === 400);
  ok('правка владельца выпущена', (await release(o3.body.id, b110o, '1.1.0', rootHex)).response.status === 200);
  await sync();
  ok('работает 1.1.0', await running() === '1.1.0');

  console.log('Изменённый кусок не запускается');
  const b120 = moduleBundle('1.2.0');
  const a4 = await submit('developer', dev, b120, { version: '1.2.0', baseRelease: releaseKey(MODULE, '1.1.0') });
  await release(a4.body.id, b120, '1.2.0', devHex);
  await exec(`UPDATE ${q('ModuleChunk')} SET ${q('data')} = ? WHERE ${q('blobId')} = ? AND ${q('idx')} = 0`, Buffer.from(moduleBundle('1.2.0', { 'logic/main.ts': 'steal()' })).subarray(0, splitChunks(b120)[0].length), a4.body.id);
  report = await sync();
  ok('изменённый кусок отвергнут', report.broken.some((b) => b.version === '1.2.0' && /Кусок 1|не совпадает/.test(b.why)));
  ok('работает прошлый проверенный 1.1.0', await running() === '1.1.0');

  console.log('Отзыв ключа и выпуска');
  const b130 = moduleBundle('1.3.0');
  const a5 = await submit('developer2', dev2, b130, { version: '1.3.0', baseRelease: releaseKey(MODULE, '1.1.0') });
  await release(a5.body.id, b130, '1.3.0', dev2Hex);
  await sync();
  ok('выпуск второго разработчика работает', await running() === '1.3.0');
  ok('отзыв без подписи владельца не принимается', (await call('owner', '/api/modules/revocations', 'POST', { signature: revocationEnvelope(stranger, 'key', dev2Hex) })).status === 400);
  ok('владелец отозвал ключ', (await call('owner', '/api/modules/revocations', 'POST', { signature: revocationEnvelope(root, 'key', dev2Hex) })).status === 200);
  await sync();
  ok('выпуск отозванного ключа не запускается, работает 1.1.0', await running() === '1.1.0');
  ok('запрос отозванным ключом не принимается', (await submit('developer2', dev2, moduleBundle('1.4.0'), { version: '1.4.0' })).status === 400);
  await exec(`DELETE FROM ${q('ModuleRevocation')}`);
  await sync();
  ok('стёртый из базы отзыв не возвращает выпуск', await running() === '1.1.0');
  await call('owner', '/api/modules/revocations', 'POST', { signature: revocationEnvelope(root, 'release', releaseKey(MODULE, '1.1.0')) });
  await sync();
  ok('отозванный выпуск 1.1.0 не запускается, работает 1.0.0', await running() === '1.0.0');
  ok('строка выпуска помечена отозванной', await stateOf('ModuleRelease', 'version', '1.1.0') === 'revoked');

  console.log('Время выпуска и кэш без связи');
  const b140 = moduleBundle('1.4.0');
  const a6 = await submit('developer', dev, b140, { version: '1.4.0', baseRelease: releaseKey(MODULE, '1.0.0') });
  await release(a6.body.id, b140, '1.4.0', devHex, { notBefore: clock + 3600_000 });
  await sync();
  ok('выпуск «на завтра» скачан, но ещё не запускается', (await cache.cached()).some((c) => c.version === '1.4.0') && await running() === '1.0.0');
  clock += 2 * 3600_000;
  ok('время наступило — запускается без связи с базой', await running() === '1.4.0');
  const cached = path.join(dir, 'cache', 'releases', MODULE, '1.4.0', 'bundle.bin');
  const bytes = fs.readFileSync(cached); bytes[20] ^= 1; fs.writeFileSync(cached, bytes);
  ok('подменённый файл в кэше не запускается, работает прошлый', await running() === '1.0.0');
  const runtime = (await cache.runnable()).get(MODULE)?.files['build/runtime.js'];
  ok('оболочка получает runtime.js проверенного выпуска', Buffer.from(runtime!).toString() === '/* runtime 1.0.0 */');

  server.close(); await db.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${passed})`);
}
main().catch((e) => { console.error(e); fs.rmSync(dir, { recursive: true, force: true }); process.exit(1); });
