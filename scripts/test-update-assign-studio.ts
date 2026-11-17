/**
 * Studio — Владелец: обновление сотрудникам и подразделениям и «Вернуть предыдущую версию всем».
 * Настоящие действия главного процесса (studio/owner/src/console.cjs → updateActions.cjs) ходят по HTTP на
 * настоящие маршруты Flux с одноразовой SQLite; подпись ставит синтетическое хранилище.
 *
 * Запуск: npx tsx scripts/test-update-assign-studio.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { ensureRemoteSchema } from '../server/schema-sync';
import { registerUpdateCampaignRoutes } from '../server/routes/updateCampaigns';
import { registerUpdateAssignmentRoutes } from '../server/routes/updateAssignments';
import { requiresOwner } from '../server/accessPolicy';
import { readUpdateSignature } from '../electron/updateSignature';
import { signUpdateEnvelope, verifiedDeviceChain } from '../electron/updateCommand';

const Database = require('better-sqlite3');
const vaultApi = require('../studio/owner/src/vault.cjs');
const { UPDATE_ACTION_NAMES } = require('../studio/owner/src/updateActions.cjs');

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const rejects = async (name: string, promise: Promise<unknown>, pattern: RegExp) => { await assert.rejects(promise, pattern, name); passed++; console.log(`  ✓ ${name}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-update-assign-studio-'));

async function main() {
  const stub = path.join(dir, 'electron-stub.cjs'); fs.writeFileSync(stub, 'module.exports = {};');
  const built = path.join(dir, 'console.cjs');
  await build({ entryPoints: [path.join(__dirname, '..', 'studio/owner/src/console.cjs')], outfile: built, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', alias: { electron: stub } });
  const consoleApi = require(built) as typeof import('../studio/owner/src/console.cjs');

  const vault = vaultApi.generateVaults().main;
  const rootKey = crypto.createPrivateKey(vault.keys.update.privatePem), rootHex: string = vault.keys.update.publicHex;

  const file = path.join(dir, 'flux.sqlite'); new Database(file).close();
  const { PrismaClient } = require('@prisma/client-sqlite');
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  await ensureRemoteSchema(db, 'sqlite', fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8'), () => {});

  const sessions: Record<string, any> = {
    owner: { id: 'flux-owner', name: 'Владелец', role: 'OWNER' },
    admin: { id: 'admin', name: 'Админ', role: 'ADMIN', isActive: true },
    ivan: { id: 'ivan', name: 'Иван Первый', role: 'ENGINEER_VENT' }, petr: { id: 'petr', name: 'Пётр Второй', role: 'ENGINEER_VENT' }, anna: { id: 'anna', name: 'Анна Третья', role: 'ENGINEER_VENT' },
  };
  const app = express(); app.use(express.json({ limit: '5mb' }));
  app.use('/api', (req: any, res, next) => {
    req.authUser = sessions[String(req.headers.authorization || '').replace(/^Bearer /, '')];
    if (!req.authUser) return res.status(401).end();
    if (requiresOwner(req.originalUrl.split('?')[0], req.method) && req.authUser.role !== 'OWNER') return res.status(403).json({ error: 'Доступно только владельцу Flux' });
    next();
  });
  const events: string[] = [];
  const broadcast = (event: string) => { events.push(event); };
  const availability = async (_db: any, r: any) => { const s = r.state === 'published' ? readUpdateSignature(r.signature, rootHex) : null; return s ? { ok: true, size: s.size, why: '', signature: r.signature } : { ok: false, size: 0, why: 'нет' }; };
  registerUpdateAssignmentRoutes(app, { getPrisma: () => db, broadcast, availability, updatePublicKeyHex: rootHex });
  registerUpdateCampaignRoutes(app, { getPrisma: () => db, broadcast, updatePublicKeyHex: rootHex, installationId: async () => 'company' });
  const server = await new Promise<import('http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (who: string, route: string, method = 'GET', body?: unknown) => {
    const r = await fetch(origin + route, { method, headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const asked: Array<{ message: string; detail: string }> = [];
  let answer = true;
  const make = (who: string, vaultValue: any = vault) => consoleApi.createConsoleActions({
    vault: () => vaultValue, token: () => who, origin: () => origin, user: () => ({ id: sessions[who]?.id, name: sessions[who]?.name }),
    confirm: async (message: string, detail: string) => { asked.push({ message, detail }); return answer; }, forward: {},
  } as any) as any;
  const owner = make('owner');
  const count = async (key: string) => Number((await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "AppSetting" WHERE "key" = '${key}'`))[0].n);

  // Данные: подразделения «Вентиляция» → «Группа А», «Газ»; три сотрудника; три выпуска
  await db.department.create({ data: { id: 'vent', name: 'Вентиляция', parentId: null } });
  await db.department.create({ data: { id: 'vent-a', name: 'Группа А', parentId: 'vent' } });
  await db.department.create({ data: { id: 'gas', name: 'Газ', parentId: null } });
  await db.user.create({ data: { id: 'ivan', symbol: 'e1', password: 'x', name: 'Иван Первый', departmentId: 'vent-a' } });
  await db.user.create({ data: { id: 'petr', symbol: 'e2', password: 'x', name: 'Пётр Второй', departmentId: 'gas' } });
  await db.user.create({ data: { id: 'anna', symbol: 'e3', password: 'x', name: 'Анна Третья' } });
  const sign = (version: string) => { const body = `FLUXUPD1.${Buffer.from(JSON.stringify({ version, size: 1024, sha256: 'a'.repeat(64), iat: Date.now() })).toString('base64url')}`; return `${body}.${crypto.sign(null, Buffer.from(body), rootKey).toString('base64url')}`; };
  for (const version of ['1.0.0', '2.0.0', '3.0.0']) await db.appUpdate.create({ data: { version, changelog: `Изменения ${version}`, fileUrl: '', generation: crypto.randomUUID(), state: 'published', signature: sign(version), size: 1024, sha256: 'a'.repeat(64) } });
  const assigned = async (who: string, current = '1.0.0') => (await call(who, `/api/updates/assigned?current=${current}`)).body.release;

  console.log('Список для выбора и права');
  const audience = await owner.updateAudience();
  ok('владелец видит подразделения, сотрудников и выпуски', audience.departments.length === 3 && audience.users.length === 3 && audience.releases[0].version === '3.0.0');
  await rejects('под входом администратора действие отказывает', make('admin').updateAudience(), /только владелец|Доступно только владельцу/);
  ok('запись назначений закрыта общим запретом сервера: только владельцу', requiresOwner('/api/updates/assignments', 'POST') && requiresOwner('/api/updates/assignments/x/cancel', 'POST') && !requiresOwner('/api/updates/assigned', 'GET'));
  ok('сотрудник не читает список и не назначает', (await call('ivan', '/api/updates/audience')).status === 403 && (await call('ivan', '/api/updates/assignments', 'POST', { version: '2.0.0', userIds: ['ivan'] })).status === 403);

  console.log('Назначение подразделению и сотруднику');
  ok('до назначения плашки нет ни у кого', !(await assigned('ivan')) && !(await assigned('petr')) && !(await assigned('anna')));
  answer = false;
  await rejects('отказ в диалоге — назначения нет', owner.assignAudience({ version: '2.0.0', departmentIds: ['vent'], userIds: ['anna'] }), /отменена/);
  ok('после отказа записей нет', await count('update.assign') === 0);
  answer = true;
  await rejects('выпуска нет в списке — отказ', owner.assignAudience({ version: '9.9.9', departmentIds: ['vent'] }), /недоступен/);
  await rejects('неизвестное подразделение — отказ', owner.assignAudience({ version: '2.0.0', departmentIds: ['ghost'] }), /изменился|недоступны/);
  asked.length = 0; events.length = 0;
  const done = await owner.assignAudience({ version: '2.0.0', departmentIds: ['vent'], userIds: ['anna'] });
  ok('назначение принято, событие разослано', !!done.id && events.includes('app:update-assigned'));
  ok('диалог называет охват, подразделение и сотрудника', /Получат сейчас: 2 чел\./.test(asked[0].detail) && /Вентиляция/.test(asked[0].detail) && /Анна Третья/.test(asked[0].detail));
  ok('плашка у сотрудника из вложенной группы и у выбранного по имени', (await assigned('ivan'))?.version === '2.0.0' && (await assigned('anna'))?.version === '2.0.0');
  ok('у сотрудника другого подразделения плашки нет', !(await assigned('petr')));
  ok('описание выпуска идёт вместе с назначением', (await assigned('ivan')).changelog === 'Изменения 2.0.0');
  await db.user.update({ where: { id: 'petr' }, data: { departmentId: 'vent' } });
  ok('переведённый в подразделение позже получает обновление', (await assigned('petr'))?.version === '2.0.0');
  await db.user.update({ where: { id: 'petr' }, data: { departmentId: 'gas' } });
  ok('выведенный из подразделения перестаёт получать', !(await assigned('petr')));
  ok('установившему плашки нет', !(await assigned('ivan', '2.0.0')));
  const shown = (await owner.updateAudience()).assignments[0];
  ok('в списке владельца: охват и названия', shown.covered === 2 && shown.units[0] === 'Вентиляция' && shown.people[0] === 'Анна Третья');
  answer = false;
  await rejects('отказ в диалоге — назначение не отменяется', owner.cancelAudience({ id: done.id }), /отменена/);
  answer = true;
  ok('после отказа плашка осталась', !!(await assigned('ivan')));
  await owner.cancelAudience({ id: done.id });
  ok('отмена убирает плашку', !(await assigned('ivan')) && !(await assigned('anna')));

  console.log('Вернуть предыдущую версию всем');
  const deviceKey = crypto.generateKeyPairSync('ed25519');
  const deviceHex = (deviceKey.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
  const heartbeat = (deviceId: string, userId: string, version: string) => call(userId, '/api/updates/devices/heartbeat', 'POST', { publicKey: deviceHex,
    proof: signUpdateEnvelope('FLUXUPDDEVICE1', { deviceId, userId, version, platform: 'win32', arch: 'x64', status: 'idle', code: '', commandId: null, at: Date.now() }, deviceKey.privateKey) });
  const [d1, d2, d3] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  ok('компьютеры сообщили версии', (await heartbeat(d1, 'ivan', '3.0.0')).status === 200 && (await heartbeat(d2, 'petr', '3.0.0')).status === 200 && (await heartbeat(d3, 'anna', '1.0.0')).status === 200);
  const stay = (await owner.assignAudience({ version: '3.0.0', userIds: ['ivan'] })).id;
  await owner.assignAudience({ version: '2.0.0', userIds: ['anna'] });
  answer = false;
  await rejects('отказ в диалоге — возврата нет', owner.rollbackAll({ minutes: 10 }), /отменена/);
  ok('после отказа команд нет', await count('update.command') === 0);
  answer = true;
  await rejects('срок меньше пяти минут отвергается', owner.rollbackAll({ minutes: 1 }), /от 5 минут/);
  await rejects('запасное хранилище не подписывает возврат', make('owner', { ...vault, kind: 'backup' }).rollbackAll({ minutes: 10 }), /основное хранилище/);
  asked.length = 0;
  const back = await owner.rollbackAll({ minutes: 10 });
  ok('возврат назначен двум компьютерам на версию 2.0.0', back.version === '2.0.0' && back.devices === 2);
  ok('диалог говорит, что произойдёт', /Вернуть всем версию 2\.0\.0/.test(asked[0].message) && /до 3\.0\.0/.test(asked[0].detail) && /2 чел\./.test(asked[0].detail) && /отложить его нельзя/.test(asked[0].detail) && /Новый выпуск не создаётся/.test(asked[0].detail));
  const chain = verifiedDeviceChain((await heartbeat(d1, 'ivan', '3.0.0')).body.commands, { inst: 'company', deviceId: d1, userId: 'ivan', keyHex: rootHex });
  ok('клиент проверяет возврат так же, как обычное задание: подпись, разрешение, цепочка', chain?.command.action === 'schedule' && chain.command.version === '2.0.0' && chain.command.rollback === true);
  ok('компьютер на версии ниже возвращаемой не затронут', verifiedDeviceChain((await heartbeat(d3, 'anna', '1.0.0')).body.commands, { inst: 'company', deviceId: d3, userId: 'anna', keyHex: rootHex }) === null);
  ok('назначение на версию выше возвращаемой отменено', !(await assigned('ivan', '1.0.0')));
  const row = JSON.parse((await db.appSetting.findUnique({ where: { id: `update.assign:${stay}` } })).value);
  ok('запись об отмене сохранена вместе с автором', !!row.cancelledAt && row.cancelledBy === 'flux-owner');
  ok('назначение на возвращаемую версию осталось', (await assigned('anna', '1.0.0'))?.version === '2.0.0');
  const again = await owner.rollbackAll({ minutes: 15 });
  ok('пока компьютеры не заменили программу, повтор продолжает цепочку и меняет срок', again.devices === 2 && verifiedDeviceChain((await heartbeat(d1, 'ivan', '3.0.0')).body.commands, { inst: 'company', deviceId: d1, userId: 'ivan', keyHex: rootHex })?.command.deadline! - Date.now() > 12 * 60000);
  await heartbeat(d1, 'ivan', '2.0.0'); await heartbeat(d2, 'petr', '2.0.0');
  asked.length = 0; answer = false;
  await rejects('после возврата следующий возврат предлагает версию ещё ниже и называет её в диалоге', owner.rollbackAll({ minutes: 10 }), /отменена/);
  ok('диалог второго шага называет 1.0.0', /Вернуть всем версию 1\.0\.0/.test(asked[0].message) && /до 2\.0\.0/.test(asked[0].detail));
  answer = true;
  await heartbeat(d1, 'ivan', '1.0.0'); await heartbeat(d2, 'petr', '1.0.0');
  await rejects('когда ниже некуда, возврат отказывает', owner.rollbackAll({ minutes: 10 }), /возвращать нечего|возвращаться некуда/);
  ok('список компьютеров помечает возврат', (await call('owner', '/api/updates/devices')).body.devices.find((d: any) => d.deviceId === d1).rollback === true);

  console.log('Список разрешённых действий и маршрутов');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'studio/owner/src/console-preload.cjs'), 'utf8');
  ok('мост окна разрешает все новые действия', UPDATE_ACTION_NAMES.every((name: string) => preload.includes(`'${name}'`)));
  const allowed = consoleApi.routeAllowed;
  ok('нужные маршруты разрешены окну', allowed('GET', '/api/updates/audience') && allowed('POST', '/api/updates/assignments') && allowed('POST', '/api/updates/assignments/abc-1/cancel'));
  ok('лишнее закрыто', !allowed('GET', '/api/updates/assignments') && !allowed('POST', '/api/updates/assignments/../x/cancel') && !allowed('DELETE', '/api/updates/assignments'));

  server.close();
  console.log(`\n${passed} проверок пройдено, 0 провалено`);
}
main().then(() => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); }, error => { console.error(error); fs.rmSync(dir, { recursive: true, force: true }); process.exit(1); });
