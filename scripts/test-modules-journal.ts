/**
 * Журнал подпрограмм и политика подключений на сервере (этап 3б): приём пачек,
 * идемпотентность, пределы, права на просмотр, обезличивание для разработчика,
 * срок и предел строк; запрос на публикацию с новым подключением и окно
 * установки. Настоящие маршруты и одноразовая SQLite.
 *
 * Запуск: npx tsx scripts/test-modules-journal.ts
 */
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRemoteSchema } from '../server/schema-sync';
import { registerModulePublishingRoutes } from '../server/routes/modulePublishing';
import { expireJournal } from '../server/moduleJournal';
import { JOURNAL_LIMITS } from '../modules/journal/model';
import { safeModuleDiagnostics, validateModuleContext } from '../feedback/moduleContext';
import { certificateEnvelope, hexOf, moduleBundle, newKey, releaseEnvelope, requestEnvelope } from './fixtures/moduleTrust';

const Database = require('better-sqlite3');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
let completed = false;
process.on('exit', () => { if (!completed) { console.error('ПРОВАЛ: проверка журнала не дошла до конца'); process.exitCode = 1; } });

const conn = (extra: Record<string, unknown> = {}) => ({ id: 'api', kind: 'http', url: 'http://127.0.0.1:8123', pathPrefix: '/api', app: 'Сервер расчётов', does: 'Отправляет параметры оборудования на расчёт', access: 'send', ...extra });

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-module-journal-'));
  const file = path.join(dir, 'flux.sqlite');
  new Database(file).close();
  const { PrismaClient } = require('@prisma/client-sqlite');
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  const log: string[] = [];
  await ensureRemoteSchema(db, 'sqlite', fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8'), m => log.push(m));
  ok('таблица журнала создана', !log.some(m => /Не удалось|Ошибка при/.test(m)) && (await db.moduleJournal.count()) === 0);

  const root = newKey(), rootHex = hexOf(root), dev = newKey(), devHex = hexOf(dev), dev2 = newKey(), dev2Hex = hexOf(dev2);
  const people: Record<string, any> = {
    owner: { id: 'flux-owner', name: 'Владелец', role: 'OWNER' }, admin: { id: 'admin', name: 'Админ', role: 'ADMIN' },
    dev: { id: 'dev', name: 'Разработчик', role: 'MODULE_DEVELOPER', perms: ['module.develop'] },
    dev2: { id: 'dev2', name: 'Другой', role: 'MODULE_DEVELOPER', perms: ['module.develop'] },
    ann: { id: 'ann', name: 'Анна', role: 'ENGINEER_AUTO' }, bob: { id: 'bob', name: 'Борис', role: 'ENGINEER_VENT' },
  };
  const app = express(); app.use(express.json({ limit: '50mb' }));
  app.use('/api', (req: any, res, next) => { req.authUser = people[String(req.headers.authorization || '').replace(/^Bearer /, '')]; return req.authUser ? next() : res.status(401).end(); });
  registerModulePublishingRoutes(app, { getPrisma: () => db, broadcast: () => {}, modulePublicKeyHex: rootHex, can: (u, f) => u.role === 'OWNER' || (u.perms || []).includes(f) });
  const server = await new Promise<import('http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (who: string, route: string, method = 'GET', body?: unknown) => {
    const r = await fetch(origin + route, { method, headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() as any : await r.text() };
  };
  await call('owner', '/api/modules/certificates', 'POST', { signature: certificateEnvelope(root, devHex, 'dev') });
  await call('owner', '/api/modules/certificates', 'POST', { signature: certificateEnvelope(root, dev2Hex, 'dev2') });
  const publish = async (who: string, key: any, keyHex: string, id: string, version: string, patch: Record<string, unknown> = {}, base?: string) => {
    const bundle = moduleBundle(version, {}, { id, name: id, ...patch });
    const sent = await call(who, '/api/modules/requests', 'POST', { signature: requestEnvelope(key, bundle, { moduleId: id, version, baseRelease: base ?? null }), bundle: Buffer.from(bundle).toString('base64') });
    assert.equal(sent.status, 200, sent.body.error);
    const r = await call('owner', `/api/modules/requests/${sent.body.id}/release`, 'POST', { signature: releaseEnvelope(root, bundle, { moduleId: id, version, author: keyHex, request: sent.body.id, channel: 'production' }) });
    assert.equal(r.status, 200, r.body.error);
    return sent.body.id as string;
  };

  console.log('Подключения в запросе на публикацию и в окне установки');
  const bad = moduleBundle('1.0.0', {}, { id: 'conn-a', name: 'conn-a', connections: [conn({ does: 'GET http://10.0.0.1/api' })] });
  const refused = await call('dev', '/api/modules/requests', 'POST', { signature: requestEnvelope(dev, bad, { moduleId: 'conn-a', version: '1.0.0' }), bundle: Buffer.from(bad).toString('base64') });
  ok('технический текст вместо человеческого не пропускается до владельца', refused.status >= 400);
  const evilCom = moduleBundle('1.0.0', {}, { id: 'conn-a', name: 'conn-a', connections: [{ id: 'sh', kind: 'com', progId: 'WScript.Shell', app: 'Оболочка', does: 'Запускает программы на компьютере', access: 'write' }] });
  ok('запрещённый COM-объект не пропускается', (await call('dev', '/api/modules/requests', 'POST', { signature: requestEnvelope(dev, evilCom, { moduleId: 'conn-a', version: '1.0.0' }), bundle: Buffer.from(evilCom).toString('base64') })).status >= 400);
  await publish('dev', dev, devHex, 'conn-a', '1.0.0', { connections: [conn()] });
  await call('admin', '/api/modules/store/conn-a/admission', 'POST', { status: 'admitted' });
  const card = (await call('ann', '/api/modules/store')).body.listings.find((l: any) => l.moduleId === 'conn-a');
  ok('в окне установки: имя программы, вид доступа, что делает и адрес мелко', card.permissions.some((p: any) => p.kind === 'connect' && p.text.includes('«Сервер расчётов»') && p.text.includes('отправлять данные') && p.text.includes('http://127.0.0.1:8123/api')));
  const second = await publish('dev', dev, devHex, 'conn-a', '1.1.0', { connections: [conn(), { id: 'e3', kind: 'com', progId: 'CT.Application', app: 'E3.series', does: 'Читает схемы открытого проекта E3', access: 'read' }] }, 'conn-a@1.0.0');
  const diff = (await call('owner', `/api/modules/requests/${second}/diff`)).body;
  ok('в запросе владельца новое подключение выделено отдельно', diff.permissions.widened && diff.permissions.added.connections.length === 1 && diff.permissions.added.connections[0].includes('COM-объект CT.Application'));
  await publish('dev2', dev2, dev2Hex, 'conn-b', '1.0.0');

  console.log('Приём пачек');
  const now = Date.now();
  const entry = (id: string, over: Record<string, unknown> = {}) => ({ id, at: now - 1000, moduleId: 'conn-a', version: '1.0.0', userId: 'подделка', category: 'connection', level: 'info', event: 'call',
    detail: 'HTTP http://127.0.0.1:8123/api · GET /api', outcome: 'ok', ms: 12, bytesIn: 100, bytesOut: 20, ...over });
  const sent1 = await call('ann', '/api/modules/journal', 'POST', { entries: [entry('e-1'), entry('e-2', { category: 'log', level: 'warn', event: 'message', detail: 'сообщение подпрограммы' }), entry('e-3', { moduleId: 'нет-такой' }), entry('e-bad', { level: 'fatal' })] });
  ok('принимаются верные записи; неизвестная подпрограмма и неверная форма — нет', sent1.body.accepted === 2 && sent1.body.rejected === 2);
  const again = await call('ann', '/api/modules/journal', 'POST', { entries: [entry('e-1'), entry('e-2', { category: 'log' })] });
  ok('повтор той же пачки не даёт дублей и считается принятым', again.body.accepted === 2 && (await db.moduleJournal.count()) === 2);
  const stored = await db.moduleJournal.findUnique({ where: { id: 'e-1' } });
  ok('человек берётся из сеанса, а не из записи: подделка userId не проходит', stored.userId === 'ann' && stored.userName === 'Анна');
  await call('bob', '/api/modules/journal', 'POST', { entries: [entry('b-1', { moduleId: 'conn-b' }), entry('b-2', { at: now - 40 * 86_400_000 }), entry('b-3', { at: now + 86_400_000 })] });
  ok('записи старше срока и из будущего не принимаются', (await db.moduleJournal.count()) === 3);
  const long = await call('ann', '/api/modules/journal', 'POST', { entries: Array.from({ length: 500 }, (_, i) => entry(`long-${i}`)) });
  ok('пачка больше предела обрезается до 200', long.body.accepted === JOURNAL_LIMITS.batch);
  let limited = 0;
  for (let i = 0; i < 40; i++) if ((await call('bob', '/api/modules/journal', 'POST', { entries: [entry(`r-${i}`, { moduleId: 'conn-b' })] })).status === 429) limited++;
  ok('частота пачек ограничена (30 в минуту)', limited >= 8);

  console.log('Просмотр и права');
  ok('обычный человек журнал не смотрит', (await call('ann', '/api/modules/journal')).status === 403);
  const all = (await call('admin', '/api/modules/journal?limit=500')).body;
  ok('администратор видит всё и с именами людей', all.entries.length > 200 && all.entries.some((e: any) => e.userName === 'Анна') && all.entries.some((e: any) => e.moduleId === 'conn-b'));
  ok('фильтры: подпрограмма, уровень, человек, период', (await call('admin', '/api/modules/journal?moduleId=conn-b')).body.entries.every((e: any) => e.moduleId === 'conn-b')
    && (await call('admin', '/api/modules/journal?level=warn')).body.entries.length === 1 && (await call('admin', '/api/modules/journal?userId=bob')).body.entries.every((e: any) => e.userId === 'bob')
    && (await call('admin', `/api/modules/journal?from=${now + 1}`)).body.entries.length === 0);
  const own = (await call('dev', '/api/modules/journal?limit=500')).body;
  ok('разработчик видит только свои подпрограммы', own.entries.length > 0 && own.entries.every((e: any) => e.moduleId === 'conn-a'));
  ok('разработчику не показываются ни люди, ни их идентификаторы', own.entries.every((e: any) => !('userName' in e) && !('userId' in e)) && !JSON.stringify(own).includes('Анна') && !JSON.stringify(own).includes('"ann"'));
  ok('чужую подпрограмму и отбор по человеку разработчик получить не может', (await call('dev', '/api/modules/journal?moduleId=conn-b')).body.entries.length === 0
    && (await call('dev', '/api/modules/journal?userId=ann&limit=500')).body.entries.every((e: any) => !('userId' in e)));
  const csvAdmin = (await call('admin', '/api/modules/journal?format=csv')).body as string;
  const csvDev = (await call('dev', '/api/modules/journal?format=csv')).body as string;
  ok('экспорт CSV: у администратора есть имена, у разработчика нет', csvAdmin.includes('userName') && csvAdmin.includes('Анна') && !csvDev.includes('userName') && !csvDev.includes('Анна'));
  await db.moduleJournal.create({ data: { id: 'csv-inj', userId: 'ann', moduleId: 'conn-a', version: '1.0.0', category: 'log', level: 'info', event: 'message', detail: '=HYPERLINK("x")', at: new Date(now) } });
  ok('в CSV формула с «=» экранируется', (await call('admin', '/api/modules/journal?format=csv&moduleId=conn-a')).body.includes(`"'=HYPERLINK`));

  console.log('Срок и предел строк');
  await db.moduleJournal.create({ data: { id: 'old-1', userId: 'ann', moduleId: 'conn-a', version: '1.0.0', category: 'log', level: 'info', event: 'message', at: new Date(now - 31 * 86_400_000) } });
  const removed = await expireJournal(db, now);
  ok('записи старше 30 дней удаляются уборкой', removed >= 1 && !(await db.moduleJournal.findUnique({ where: { id: 'old-1' } })));
  (JOURNAL_LIMITS as any).serverRows = 50;
  await expireJournal(db, now);
  ok('число строк не растёт выше предела: самые старые уходят', (await db.moduleJournal.count()) === 50);

  console.log('Политика подключений');
  ok('правила политики задаёт только администратор', (await call('ann', '/api/modules/connection-policy/rules', 'PUT', { rules: [] })).status === 403);
  ok('неверное правило отвергается', (await call('admin', '/api/modules/connection-policy/rules', 'PUT', { rules: [{ moduleId: 'Не ИД', connection: 'api' }] })).status === 400);
  await call('admin', '/api/modules/connection-policy/rules', 'PUT', { rules: [{ moduleId: 'conn-a', connection: 'api', roles: ['ENGINEER_AUTO'] }, { moduleId: 'conn-a', connection: 'e3', roles: [] }] });
  const annPolicy = (await call('ann', '/api/modules/connection-policy')).body.denied, bobPolicy = (await call('bob', '/api/modules/connection-policy')).body.denied;
  ok('запрет роли действует на её людей, запрет без ролей — на всех', annPolicy.length === 2 && bobPolicy.length === 1 && bobPolicy[0].connection === 'e3');

  console.log('Журнал в обращении');
  const ctx = (journal: unknown) => validateModuleContext({ moduleId: 'conn-a', moduleVersion: '1.0.0', moduleChannel: 'production', moduleDiagnostics: { journal } });
  ok('к обращению принимается до 30 строк журнала', ctx(Array.from({ length: 30 }, (_, i) => `строка ${i}`)).ok && !ctx(Array.from({ length: 31 }, () => 'x')).ok);
  ok('длинная строка и не строка отвергаются', !ctx(['я'.repeat(241)]).ok && !ctx([1]).ok);
  ok('управляющие символы в приложенном журнале вычищаются', safeModuleDiagnostics({ journal: ['а\u0000б\nв'] }).journal?.[0] === 'а б в');

  server.close();
  console.log(`\nПройдено проверок: ${passed}`);
  completed = true;
  process.exit(0);
}
void main();
