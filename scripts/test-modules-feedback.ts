/** Настоящие HTTP-маршруты и одноразовая база: доступ, разделение пакета и счётчики. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { ensureRemoteSchema } from '../server/schema-sync';
import { setPrisma } from '../server/context';
import { registerModulePublishingRoutes } from '../server/routes/modulePublishing';
import { registerFeedbackRoutes } from '../server/routes/feedback';
import { fingerprintOfEvents } from '../server/feedback/bundle';
import { sweepUploads } from '../server/feedback/cleanup';
import { settings } from '../server/feedback/policy';
import { technicalFingerprint } from '../feedback/fingerprint';
import { validateSubmit } from '../feedback/contracts';
import { safeModuleDiagnostics } from '../feedback/moduleContext';
import { ModuleCrashQueue } from '../src/services/moduleCrashQueue';
import { certificateEnvelope, hexOf, moduleBundle, newKey, releaseEnvelope, requestEnvelope, revocationEnvelope } from './fixtures/moduleTrust';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log('  ✓', name); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-modules-feedback-'));
const root = newKey(), rootHex = hexOf(root), dev = newKey(), devHex = hexOf(dev), other = newKey();
const { PrismaClient } = require('@prisma/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${path.join(dir, 'db.sqlite')}` }) });
const people: Record<string, any> = {
  owner: { id: 'owner', role: 'OWNER' }, admin: { id: 'admin', role: 'ADMIN' },
  dev: { id: 'dev', role: 'MODULE_DEVELOPER' }, other: { id: 'other', role: 'MODULE_DEVELOPER' },
  ann: { id: 'ann', role: 'ENGINEER_AUTO' }, bob: { id: 'bob', role: 'ENGINEER_VENT' },
};
async function main() {
  const logs: string[] = [];
  await ensureRemoteSchema(db, 'sqlite', fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8'), (s) => logs.push(s));
  ok('схема создана без ошибок', !logs.some((s) => /Не удалось|Ошибка при/.test(s)));
  setPrisma(db);
  const app = express(); app.use(express.json({ limit: '50mb' }));
  app.use('/api', (req: any, res, next) => { req.authUser = people[String(req.headers.authorization || '').replace(/^Bearer /, '')]; return req.authUser ? next() : res.status(401).end(); });
  const can = (u: any, f: string) => ['OWNER', 'ADMIN'].includes(u?.role) || (f === 'module.develop' && u?.role === 'MODULE_DEVELOPER') || f === 'feedback.create';
  registerModulePublishingRoutes(app, { getPrisma: () => db, broadcast: () => {}, modulePublicKeyHex: rootHex, can });
  registerFeedbackRoutes(app, { modulePublicKeyHex: rootHex, can, appVersion: () => '1.2.3', feedbackChunkBytes: async () => 65536 });
  const server = await new Promise<import('http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (who: string, route: string, method = 'GET', body?: unknown) => {
    const r = await fetch(origin + '/api' + route, { method, headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (r.headers.get('content-type') || '').includes('json') ? await r.json() as any : await r.text() };
  };
  await call('owner', '/modules/certificates', 'POST', { signature: certificateEnvelope(root, devHex, 'dev') });
  await call('owner', '/modules/certificates', 'POST', { signature: certificateEnvelope(root, hexOf(other), 'other') });
  const publish = async (key: any, who: string, moduleId: string, version: string) => {
    const b = moduleBundle(version, {}, { id: moduleId });
    const sent = await call(who, '/modules/requests', 'POST', { signature: requestEnvelope(key, b, { moduleId, version }), bundle: Buffer.from(b).toString('base64') });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const released = await call('owner', `/modules/requests/${sent.body.id}/release`, 'POST', { signature: releaseEnvelope(root, b, { moduleId, version, author: hexOf(key), request: sent.body.id, channel: 'production' }) });
    assert.equal(released.status, 200, JSON.stringify(released.body));
  };
  await publish(dev, 'dev', 'calc-a', '1.0.0'); await publish(other, 'other', 'calc-b', '1.0.0');
  await call('admin', '/modules/store/calc-a/admission', 'POST', { status: 'admitted' });
  const conf = await settings();
  const submit = () => ({ schemaVersion: 1, clientRequestId: randomUUID(), deploymentId: conf.deploymentId,
    type: 'BUG', title: 'Не считает программа', description: 'При открытии расчёт остановился', sectionKey: '/module/calc-a',
    projectId: 'секрет-проекта', incidentAt: new Date().toISOString(), appVersion: '1.2.3', frequency: 'ALWAYS', impact: 'HIGH', uploadIds: [],
    consent: { technicalEvents: true, appContext: true, reviewedAt: new Date().toISOString() },
    moduleId: 'calc-a', moduleVersion: '1.0.0', moduleChannel: 'production', moduleApiVersion: '1', moduleDeveloper: 'Разработчик',
    actual: 'авто-проект-секрет', expected: 'авто-проект-секрет', reproduction: ['авто-проект-секрет'],
    moduleDiagnostics: { code: 'crash', frames: ['at f (/секрет-проекта/logic.ts:12:3)'] },
  });
  ok('неполный адресат не проходит договор', !validateSubmit({ ...submit(), moduleVersion: undefined }).ok);
  ok('произвольные данные не проходят как модульная диагностика', !validateSubmit({ ...submit(), moduleDiagnostics: { project: 'секрет-проекта' } }).ok);
  const fp = { errorCode: 'crash', moduleId: 'calc-a', moduleVersion: '1.0.0' };
  ok('другая программа меняет отпечаток', technicalFingerprint(fp) !== technicalFingerprint({ ...fp, moduleId: 'calc-b' }));
  ok('другая версия меняет отпечаток', technicalFingerprint(fp) !== technicalFingerprint({ ...fp, moduleVersion: '1.0.1' }));
  ok('сводка полного пакета различает версии модуля', fingerprintOfEvents([{ event: 'log.error', data: { code: 'E' } }], '1.2.3', '/module/calc-a', fp) !== fingerprintOfEvents([{ event: 'log.error', data: { code: 'E' } }], '1.2.3', '/module/calc-a', { ...fp, moduleVersion: '1.0.1' }));
  const body = submit(); const made = await call('ann', '/feedback/reports', 'POST', body);
  assert.equal(made.status, 201, JSON.stringify(made.body)); const id = made.body.data.id;
  ok('адресат хранится в общей карточке', made.body.data.moduleId === 'calc-a' && made.body.data.moduleVersion === '1.0.0');
  ok('повтор отправки не создаёт вторую карточку', (await call('ann', '/feedback/reports', 'POST', body)).body.meta.repeat);
  ok('иная версия под тем же ключом — конфликт', (await call('ann', '/feedback/reports', 'POST', { ...body, moduleChannel: 'test' })).status === 409);
  const outbox = await db.feedbackOutbox.findMany({ where: { reportId: id } });
  ok('разработчик получает то же обращение', outbox.some((r: any) => r.recipientId === 'dev'));
  ok('разработчик другого модуля не получает обращение', !outbox.some((r: any) => r.recipientId === 'other'));
  const devCard = await call('dev', `/feedback/reports/${id}`);
  ok('разработчик читает карточку своего модуля', devCard.status === 200 && devCard.body.data.capabilities.triage);
  ok('у разработчика нет проекта и полных вложений', devCard.body.data.projectId === null && devCard.body.data.attachments.length === 0 && devCard.body.data.diagnostics.length === 0);
  ok('автоматические поля карточки не уходят разработчику', !JSON.stringify(devCard.body).includes('авто-проект-секрет'));
  ok('чужая карточка закрыта другому разработчику и сотруднику', (await call('other', `/feedback/reports/${id}`)).status === 404 && (await call('bob', `/feedback/reports/${id}`)).status === 404);
  const pack = await call('dev', `/feedback/reports/${id}/module-package`);
  ok('разработчик получает только модульный пакет', pack.status === 200 && pack.body.data.moduleId === 'calc-a' && !JSON.stringify(pack.body).includes('секрет-проекта'));
  ok('стек сохраняет лишь исходный файл и координаты', JSON.stringify(pack.body.data.diagnostics.frames) === JSON.stringify(['logic.ts:12:3']));
  ok('полный ZIP разработчику закрыт', (await call('dev', `/feedback/reports/${id}/package`)).status === 403);
  ok('чужой модульный пакет закрыт', (await call('other', `/feedback/reports/${id}/module-package`)).status === 404);
  ok('проект сохранён в полной карточке Flux', (await call('admin', `/feedback/reports/${id}`)).body.data.projectId === 'секрет-проекта');
  ok('очередь разработчика содержит только его модуль', (await call('dev', '/feedback/reports?scope=modules')).body.data.every((r: any) => r.moduleId === 'calc-a'));
  ok('общая очередь разработчику закрыта', (await call('dev', '/feedback/reports?scope=queue')).status === 403);
  ok('общий фильтр по программам работает', (await call('admin', '/feedback/reports?scope=queue&modules=1')).body.data.some((r: any) => r.id === id));
  const mutate = async (who: string, action: string, extra: any) => {
    const r = await db.feedbackReport.findUnique({ where: { id } });
    return call(who, `/feedback/reports/${id}/${action}`, 'POST', { clientRequestId: randomUUID(), expectedRevision: r.revision, ...extra });
  };
  ok('разработчик начинает разбор', (await mutate('dev', 'transition', { to: 'TRIAGE' })).status === 200);
  ok('разработчик берёт в работу', (await mutate('dev', 'transition', { to: 'IN_PROGRESS', assigneeId: 'dev' })).status === 200);
  ok('исправление модуля требует номер версии', (await mutate('dev', 'transition', { to: 'VERIFY', noReleaseReason: 'без выпуска' })).status === 400);
  ok('версия исправления общая', (await mutate('dev', 'transition', { to: 'VERIFY', resolvedVersion: '1.1.0' })).status === 200);
  await db.feedbackReport.update({ where: { id }, data: { resolvedVersion: null } });
  ok('старое обращение модуля без версии нельзя закрыть как готовое', (await mutate('ann', 'transition', { to: 'DONE' })).status === 400);
  await db.feedbackReport.update({ where: { id }, data: { resolvedVersion: '1.1.0' } });
  ok('ещё не выпущенное исправление нельзя предложить обновить', !(await call('ann', `/feedback/reports/${id}`)).body.data.moduleFixAvailable);
  await publish(dev, 'dev', 'calc-a', '1.1.0');
  ok('доступный выпуск открывает предложение обновить', (await call('ann', `/feedback/reports/${id}`)).body.data.moduleFixVersion === '1.1.0');
  await call('ann', '/modules/store'); await call('ann', '/modules/store');
  ok('уведомление о выпуске создаётся ровно один раз', await db.feedbackOutbox.count({ where: { reportId: id, kind: 'moduleFix' } }) === 1);
  ok('ответ «Нет» возвращает в разбор', (await mutate('ann', 'transition', { to: 'TRIAGE', reason: 'Проблема осталась' })).status === 200);
  ok('неподтверждённое обращение не раскрывается постороннему', !(await call('bob', '/feedback/modules/calc-a/similar')).body.data.some((r: any) => r.id === id));
  await mutate('admin', 'module-known', { known: true, workaround: 'Ещё не проверено разработчиком' });
  ok('отметки администратора недостаточно для раскрытия заголовка', !(await call('bob', '/feedback/modules/calc-a/similar')).body.data.some((r: any) => r.id === id));
  ok('неподтверждённая известная проблема не попадает в Store', !(await call('ann', '/modules/store')).body.listings.find((l: any) => l.moduleId === 'calc-a').known.some((r: any) => r.id === id));
  ok('к неподтверждённой проблеме нельзя присоединиться', (await call('bob', `/feedback/reports/${id}/affected`, 'POST', {})).status === 404);
  ok('разработчик помечает известную проблему', (await mutate('dev', 'module-known', { known: true, workaround: 'Откройте заново' })).status === 200);
  ok('известная проблема появляется в Store', (await call('ann', '/modules/store')).body.listings[0].known.some((r: any) => r.id === id));
  ok('похожая известная проблема доступна автору', (await call('bob', '/feedback/modules/calc-a/similar')).body.data.some((r: any) => r.id === id));
  await call('bob', `/feedback/reports/${id}/affected`, 'POST', {}); await call('bob', `/feedback/reports/${id}/affected`, 'POST', {});
  ok('«У меня тоже» не удваивает одного человека', await db.appSetting.count({ where: { key: `modules.affected.${id}` } }) === 1);
  const batch = { id: randomUUID(), events: [{ moduleId: 'calc-a', version: '1.1.0', kind: 'timeout', count: 3 }] };
  ok('несуществующая программа не принимает счётчики', (await call('ann', '/modules/crashes', 'POST', { id: randomUUID(), events: [{ ...batch.events[0], moduleId: 'missing-module' }] })).status === 400);
  ok('несуществующая версия не принимает счётчики', (await call('ann', '/modules/crashes', 'POST', { id: randomUUID(), events: [{ ...batch.events[0], version: '99.0.0' }] })).status === 400);
  const mixedId = randomUUID();
  ok('пакет с одной несуществующей версией отклоняется целиком', (await call('ann', '/modules/crashes', 'POST', { id: mixedId, events: [batch.events[0], { ...batch.events[0], version: '99.0.0' }] })).status === 400 && !await db.appSetting.findUnique({ where: { id: `module-crash-${mixedId}` } }));
  ok('пакет свыше 100 событий не принимается', (await call('ann', '/modules/crashes', 'POST', { id: randomUUID(), events: Array.from({ length: 101 }, () => batch.events[0]) })).status === 400);
  ok('обезличенный счётчик принят', (await call('ann', '/modules/crashes', 'POST', batch)).status === 200);
  await call('ann', '/modules/crashes', 'POST', batch);
  const counts = (await call('dev', '/modules/crashes')).body.data;
  ok('повтор пакета не удваивает счётчик', counts.find((r: any) => r.version === '1.1.0').count === 3);
  ok('чужой разработчик счётчик не видит', (await call('other', '/modules/crashes')).body.data.length === 0);
  ok('данные и имя нельзя отправить как счётчик', (await call('ann', '/modules/crashes', 'POST', { ...batch, id: randomUUID(), userName: 'секрет-проекта' })).status === 400);
  const saved = await db.appSetting.findUnique({ where: { id: `module-crash-${batch.id}` } });
  ok('в записи счётчика нет автора', saved.userId === null && !saved.value.includes('ann') && !saved.value.includes('секрет-проекта'));
  ok('администратор видит счётчик версии в Store', (await call('admin', '/modules/store')).body.listings.find((l: any) => l.moduleId === 'calc-a').crashes.count === 3);
  const expiredId = randomUUID(), expiredDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  await db.appSetting.create({ data: { id: `module-crash-${expiredId}`, key: `modules.crash.batch.${expiredId}`, userId: null, updatedAt: expiredDate, value: JSON.stringify({ id: expiredId, events: [{ ...batch.events[0], count: 999 }] }) } });
  ok('сводка не включает пакеты старше 30 дней', (await call('dev', '/modules/crashes')).body.data.find((r: any) => r.moduleId === 'calc-a' && r.version === '1.1.0').count === 3);
  await sweepUploads();
  ok('часовая уборка удаляет старые пакеты счётчиков', !await db.appSetting.findUnique({ where: { id: `module-crash-${expiredId}` } }));
  ok('уборка сохраняет действующую расписку пакета', !!await db.appSetting.findUnique({ where: { id: `module-crash-${batch.id}` } }));
  const realNow = Date.now, fixedMinute = Math.floor(realNow() / 60000) * 60000 + 10000;
  Date.now = () => fixedMinute;
  try {
    const rateBatch = () => ({ id: randomUUID(), events: [{ moduleId: 'calc-b', version: '1.0.0', kind: 'crash', count: 1 }] });
    const statuses: number[] = [];
    for (let n = 0; n < 30; n++) statuses.push((await call('bob', '/modules/crashes', 'POST', rateBatch())).status);
    ok('30 пакетов за минуту принимаются', statuses.every((s) => s === 200));
    const blocked = rateBatch();
    ok('превышение лимита пакетов отклоняется', (await call('bob', '/modules/crashes', 'POST', blocked)).status === 429);
    ok('отказ по лимиту не сохраняет пакет', !await db.appSetting.findUnique({ where: { id: `module-crash-${blocked.id}` } }));
    ok('повтор принятого пакета после лимита идемпотентен', (await call('bob', '/modules/crashes', 'POST', batch)).status === 200);
  } finally { Date.now = realNow; }
  ok('передача Flux закрывает доступ разработчика', (await mutate('dev', 'module-routing', { toFlux: true, reason: 'Отказ общего API' })).status === 200 && (await call('dev', `/feedback/reports/${id}`)).status === 404);
  ok('администратор возвращает тому же модулю', (await mutate('admin', 'module-routing', { moduleId: 'calc-a', moduleVersion: '1.0.0', moduleChannel: 'production', reason: 'Проблема в расчёте' })).status === 200);
  await call('owner', '/modules/revocations', 'POST', { signature: revocationEnvelope(root, 'key', devHex) });
  ok('отзыв сертификата закрывает карточку и пакет', (await call('dev', `/feedback/reports/${id}`)).status === 404 && (await call('dev', `/feedback/reports/${id}/module-package`)).status === 404);
  ok('после отзыва обращение остаётся у Flux', (await call('admin', `/feedback/reports/${id}`)).status === 200);
  server.close(); await db.$disconnect();

  let text = '', online = false, requests = 0;
  const storage = { getItem: () => text, setItem: (_: string, v: string) => { text = v; } };
  const send = async (_: unknown) => { requests++; if (!online) throw new Error('нет связи'); };
  const q = new ModuleCrashQueue(storage, send); q.record('calc-a', '1.0.0', 'crash');
  await q.flush().catch(() => {}); const before = text;
  ok('без связи счётчики остаются на диске', JSON.parse(text).length === 1);
  online = true; await new ModuleCrashQueue(storage, send).flush();
  ok('после перезапуска очередь отправляет тот же ключ и очищается', requests === 2 && text === '[]' && !!JSON.parse(before)[0].id);
  ok('произвольные поля стека не попадают в пакет', JSON.stringify(safeModuleDiagnostics({ code: 'crash', project: 'секрет-проекта', frames: ['secret project values'] })) === '{"code":"crash"}');
  console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${passed})`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('✗', e); process.exit(1); });
