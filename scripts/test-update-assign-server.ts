/**
 * Обычное обновление выбранным: сотрудникам и подразделениям, отказ при возврате, напоминание раз в сутки.
 * Без базы и сети: клиент базы подменён, маршруты настоящие.
 *
 * Запуск: npx tsx scripts/test-update-assign-server.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signUpdateEnvelope } from '../electron/updateCommand';
import { setNotifier } from '../server/context';
import { registerUpdateAssignmentRoutes } from '../server/routes/updateAssignments';
import { registerUpdateCampaignRoutes } from '../server/routes/updateCampaigns';
import { coversUser, departmentScope, pickAssignment, type UpdateAssignment } from '../server/updateAudience';

const owner = crypto.generateKeyPairSync('ed25519'), actor = crypto.generateKeyPairSync('ed25519');
const hex = (k: crypto.KeyObject) => (k.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
const ownerHex = hex(owner.publicKey), actorHex = hex(actor.publicKey);
let count = 0;
const test = async (label: string, fn: () => unknown) => { try { await fn(); count++; } catch (error) { console.error('✗', label); throw error; } };

// ---- Чистые правила состава
const tree = [{ id: 'root', parentId: null }, { id: 'vent', parentId: 'root' }, { id: 'vent-a', parentId: 'vent' }, { id: 'gas', parentId: 'root' }];
const assign = (p: Partial<UpdateAssignment> = {}): UpdateAssignment => ({ v: 1, id: 'a1', version: '2.0.0', generation: 'g', userIds: [], departmentIds: ['vent'], createdAt: 1, createdBy: 'owner', ...p });
void (async () => {
  await test('подразделение включает вложенные', () => assert.deepEqual([...departmentScope(tree, ['vent'])].sort(), ['vent', 'vent-a']));
  await test('цикл в дереве не зацикливает', () => assert.equal(departmentScope([{ id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' }], ['x']).size, 2));
  await test('сотрудник во вложенном подразделении охвачен', () => assert.equal(coversUser(assign(), { id: 'u', departmentId: 'vent-a' }, tree), true));
  await test('сотрудник чужого подразделения не охвачен', () => assert.equal(coversUser(assign(), { id: 'u', departmentId: 'gas' }, tree), false));
  await test('добавленный позже получает обновление', () => {
    const user = { id: 'u', departmentId: 'gas' as string | null };
    assert.equal(coversUser(assign(), user, tree), false);
    user.departmentId = 'vent'; // перевели в подразделение уже после назначения
    assert.equal(coversUser(assign(), user, tree), true);
  });
  await test('выведенный из подразделения перестаёт получать', () => {
    const user = { id: 'u', departmentId: 'vent' as string | null };
    assert.equal(pickAssignment([assign()], user, tree, '1.0.0')?.id, 'a1');
    user.departmentId = 'gas';
    assert.equal(pickAssignment([assign()], user, tree, '1.0.0'), null);
  });
  await test('сотрудник назначен по номеру', () => assert.equal(coversUser(assign({ departmentIds: [], userIds: ['u'] }), { id: 'u' }, tree), true));
  await test('отменённое назначение не охватывает', () => assert.equal(coversUser(assign({ cancelledAt: 5 }), { id: 'u', departmentId: 'vent' }, tree), false));
  await test('закрытый профиль не получает', () => assert.equal(coversUser(assign(), { id: 'u', departmentId: 'vent', isActive: false }, tree), false));
  await test('установившему новое не предлагается', () => assert.equal(pickAssignment([assign()], { id: 'u', departmentId: 'vent' }, tree, '2.0.0'), null));
  await test('предлагается самая новая версия из назначенных', () => assert.equal(pickAssignment([assign({ id: 'low', version: '1.5.0' }), assign({ id: 'high', version: '2.1.0' })], { id: 'u', departmentId: 'vent' }, tree, '1.0.0')?.id, 'high'));

  // ---- Маршруты на подменённой базе
  const rows = new Map<string, any>();
  const users: any[] = [
    { id: 'owner', name: 'Владелец', symbol: '0', isActive: true, departmentId: null, role: 'OWNER' },
    { id: 'ivan', name: 'Иванов', symbol: '1', isActive: true, departmentId: 'vent-a', role: 'ENGINEER_VENT' },
    { id: 'petr', name: 'Петров', symbol: '2', isActive: true, departmentId: 'gas', role: 'ENGINEER_VENT' },
    { id: 'anna', name: 'Анна', symbol: '3', isActive: true, departmentId: null, role: 'ENGINEER_VENT' },
  ];
  const departments: any[] = [
    { id: 'vent', name: 'Вентиляция', parentId: 'root', kind: 'division', sortOrder: 0, archivedAt: null },
    { id: 'vent-a', name: 'Группа А', parentId: 'vent', kind: 'group', sortOrder: 0, archivedAt: null },
    { id: 'gas', name: 'Газ', parentId: 'root', kind: 'division', sortOrder: 0, archivedAt: null },
    { id: 'old', name: 'Архив', parentId: 'root', kind: 'division', sortOrder: 0, archivedAt: new Date() },
  ];
  const releases = new Map<string, any>();
  const sign = (version: string) => signUpdateEnvelope('FLUXUPD1', { version, size: 4096, sha256: 'b'.repeat(64) }, owner.privateKey);
  const publish = (version: string, state = 'published') => releases.set(version, { version, generation: crypto.randomUUID(), state, signature: sign(version), sha256: 'b'.repeat(64), size: 4096, changelog: `Изменения ${version}` });
  publish('1.0.0'); publish('2.0.0'); publish('3.0.0');
  const sparse = (r: any, where: any) => Object.entries(where || {}).every(([k, v]: [string, any]) => v && typeof v === 'object'
    ? ('in' in v ? v.in.includes(r[k]) : 'endsWith' in v ? String(r[k]).endsWith(v.endsWith) : 'not' in v ? r[k] !== v.not : true) : r[k] === v);
  const db: any = {
    appSetting: {
      findUnique: async ({ where }: any) => rows.get(where.id) || null,
      findMany: async ({ where }: any) => [...rows.values()].filter(r => sparse(r, where)),
      create: async ({ data }: any) => { if (rows.has(data.id)) throw Object.assign(Error('duplicate'), { code: 'P2002' }); rows.set(data.id, { ...data }); return data; },
      upsert: async ({ where, create, update }: any) => { const r = rows.has(where.id) ? { ...rows.get(where.id), ...update } : create; rows.set(where.id, r); return r; },
      updateMany: async ({ where, data }: any) => { const r = rows.get(where.id); if (!r || r.value !== where.value) return { count: 0 }; rows.set(where.id, { ...r, ...data }); return { count: 1 }; },
    },
    user: { findMany: async ({ where }: any) => users.filter(u => sparse(u, where)), findUnique: async ({ where }: any) => users.find(u => u.id === where.id) || null },
    department: { findMany: async ({ where }: any = {}) => departments.filter(d => !where || sparse(d, where)) },
    appUpdate: { findUnique: async ({ where }: any) => releases.get(where.version) || null, findMany: async () => [...releases.values()].filter(r => r.state === 'published') },
    $transaction: async (fn: any) => { const snapshot = new Map([...rows].map(([k, v]) => [k, { ...v }])); try { return await fn(db); } catch (e) { rows.clear(); for (const [k, v] of snapshot) rows.set(k, v); throw e; } },
  };
  const events: [string, any][] = [], notified: string[] = [];
  setNotifier(async (userId, _c, title) => { notified.push(`${userId}:${title}`); });
  const routes = new Map<string, Function[]>();
  const app = { get: (u: string, ...h: Function[]) => routes.set(`GET ${u}`, h), post: (u: string, ...h: Function[]) => routes.set(`POST ${u}`, h) };
  const broadcast = (event: string, payload: unknown) => { events.push([event, payload]); };
  const availability = async (_db: any, r: any) => r.state === 'published' ? { ok: true, size: r.size, why: '', signature: r.signature } : { ok: false, size: 0, why: 'отозван' };
  registerUpdateAssignmentRoutes(app, { getPrisma: () => db, broadcast, availability, updatePublicKeyHex: ownerHex });
  registerUpdateCampaignRoutes(app as any, { getPrisma: () => db, broadcast, installationId: async () => 'company', updatePublicKeyHex: ownerHex });
  const call = async (route: string, req: any) => {
    let status = 200, body: any;
    const res: any = { status: (n: number) => { status = n; return res; }, json: (v: unknown) => { body = v; }, setHeader: () => {} };
    const handlers = routes.get(route)!;
    if (handlers.length === 2) { let ok = false; handlers[0](req, res, () => { ok = true; }); if (ok) await handlers[1](req, res); } else await handlers[0](req, res);
    return { status, body };
  };
  const asOwner = (body: any = {}, params: any = {}, query: any = {}) => ({ authUser: { id: 'owner', role: 'OWNER' }, body, params, query });
  const asUser = (id: string, query: any = {}, body: any = {}) => ({ authUser: { id, role: 'ENGINEER_VENT' }, query, body, params: {} });
  const assigned = async (id: string, current = '1.0.0') => (await call('GET /api/updates/assigned', asUser(id, { current }))).body;

  await test('сотрудник и администратор не управляют назначениями', async () => {
    for (const route of ['GET /api/updates/audience', 'POST /api/updates/assignments', 'POST /api/updates/assignments/:id/cancel']) {
      for (const role of ['ENGINEER_VENT', 'ADMIN']) {
        const r = await call(route, { authUser: { id: 'ivan', role }, body: { version: '2.0.0', departmentIds: ['vent'] }, params: { id: 'x' } });
        assert.equal(r.status, 403, `${route} ${role}`);
        assert.equal(r.body.code, 'UPDATE_OWNER_ONLY');
      }
    }
  });
  await test('до назначения плашки нет ни у кого', async () => { for (const id of ['ivan', 'petr', 'anna']) assert.equal((await assigned(id)).release, null); });
  await test('пустой состав отвергается с кодом', async () => {
    const r = await call('POST /api/updates/assignments', asOwner({ version: '2.0.0' }));
    assert.equal(r.status, 400); assert.equal(r.body.code, 'UPDATE_BAD_AUDIENCE');
  });
  await test('неизвестный или отозванный выпуск отвергается', async () => {
    assert.equal((await call('POST /api/updates/assignments', asOwner({ version: '9.9.9', departmentIds: ['vent'] }))).body.code, 'UPDATE_RELEASE_UNAVAILABLE');
    publish('1.5.0', 'revoked');
    assert.equal((await call('POST /api/updates/assignments', asOwner({ version: '1.5.0', departmentIds: ['vent'] }))).status, 409);
  });
  await test('архивное подразделение и чужой сотрудник отвергаются', async () => {
    assert.equal((await call('POST /api/updates/assignments', asOwner({ version: '2.0.0', departmentIds: ['old'] }))).body.code, 'UPDATE_AUDIENCE_CHANGED');
    assert.equal((await call('POST /api/updates/assignments', asOwner({ version: '2.0.0', userIds: ['ghost'] }))).body.code, 'UPDATE_AUDIENCE_CHANGED');
  });
  let id1 = '';
  await test('назначение подразделению сохраняется и рассылается событием', async () => {
    events.length = 0;
    const r = await call('POST /api/updates/assignments', asOwner({ version: '2.0.0', departmentIds: ['vent'], userIds: ['anna'] }));
    assert.equal(r.status, 200); id1 = r.body.id;
    assert.deepEqual(events[0][0], 'app:update-assigned');
  });
  await test('плашка у выбранных и только у них', async () => {
    assert.equal((await assigned('ivan')).release.version, '2.0.0');        // во вложенной группе подразделения
    assert.equal((await assigned('anna')).release.version, '2.0.0');        // выбран по имени
    assert.equal((await assigned('petr')).release, null);                   // другое подразделение
    assert.equal((await assigned('ivan')).release.changelog, 'Изменения 2.0.0');
  });
  await test('уже установившему плашки нет', async () => assert.equal((await assigned('ivan', '2.0.0')).release, null));
  await test('сотрудник, добавленный в подразделение позже, получает', async () => {
    users.find(u => u.id === 'petr').departmentId = 'vent';
    assert.equal((await assigned('petr')).release.version, '2.0.0');
  });
  await test('выведенный из подразделения перестаёт получать', async () => {
    users.find(u => u.id === 'petr').departmentId = 'gas';
    assert.equal((await assigned('petr')).release, null);
  });
  await test('отзыв выпуска убирает плашку', async () => {
    const saved = releases.get('2.0.0'); releases.set('2.0.0', { ...saved, state: 'revoked' });
    assert.equal((await assigned('ivan')).release, null);
    releases.set('2.0.0', saved);
  });
  await test('перевыпуск той же версии другим файлом не подхватывает старое назначение', async () => {
    const saved = releases.get('2.0.0'); releases.set('2.0.0', { ...saved, generation: crypto.randomUUID() });
    assert.equal((await assigned('ivan')).release, null);
    releases.set('2.0.0', saved);
  });
  await test('закрытому профилю плашки нет', async () => {
    users.find(u => u.id === 'ivan').isActive = false;
    assert.equal((await assigned('ivan')).release, null);
    users.find(u => u.id === 'ivan').isActive = true;
  });
  await test('список для владельца: состав, число охваченных, выпуски', async () => {
    const r = (await call('GET /api/updates/audience', asOwner())).body;
    assert.equal(r.departments.some((d: any) => d.id === 'old'), false, 'архивные подразделения не предлагаются');
    assert.equal(r.assignments[0].covered, 2);
    assert.deepEqual(r.assignments[0].units, ['Вентиляция']);
    assert.ok(r.releases.some((x: any) => x.version === '3.0.0'));
  });
  await test('отмена убирает плашку и рассылает событие; повтор безвреден', async () => {
    events.length = 0;
    assert.equal((await call('POST /api/updates/assignments/:id/cancel', asOwner({}, { id: id1 }))).status, 200);
    assert.equal(events[0][0], 'app:update-assigned');
    assert.equal((await assigned('ivan')).release, null);
    events.length = 0;
    assert.equal((await call('POST /api/updates/assignments/:id/cancel', asOwner({}, { id: id1 }))).status, 200);
    assert.equal(events.length, 0, 'повторная отмена ничего не рассылает');
    assert.equal((await call('POST /api/updates/assignments/:id/cancel', asOwner({}, { id: 'missing' }))).body.code, 'UPDATE_ASSIGNMENT_NOT_FOUND');
  });
  await test('версия клиента обязательна', async () => assert.equal((await call('GET /api/updates/assigned', asUser('ivan', {}))).status, 400));

  // ---- Напоминание: только назначенным, раз в сутки, при запуске после «Позже» — сразу
  const a2 = (await call('POST /api/updates/assignments', asOwner({ version: '2.0.0', departmentIds: ['vent'] }))).body.id;
  const remind = async (user: string, version: string, launch = false) => call('POST /api/updates/reminder', asUser(user, {}, { version, launch }));
  await test('чужому обновлению напоминание не создаётся', async () => {
    const r = await remind('petr', '2.0.0');
    assert.equal(r.status, 409); assert.equal(r.body.code, 'UPDATE_NOT_ASSIGNED');
    assert.equal(notified.filter(x => x.startsWith('petr')).length, 0);
  });
  await test('назначенному напоминание приходит один раз', async () => {
    assert.equal((await remind('ivan', '2.0.0')).body.reminded, true);
    assert.equal((await remind('ivan', '2.0.0')).body.reminded, false);
    assert.equal(notified.filter(x => x.startsWith('ivan')).length, 1);
  });
  await test('не чаще раза в сутки', async () => {
    const key = 'update.reminder:ivan:2.0.0', now = Date.now();
    rows.set(key, { ...rows.get(key), value: String(now - 23 * 3600000) });
    assert.equal((await remind('ivan', '2.0.0')).body.reminded, false);
    rows.set(key, { ...rows.get(key), value: String(now - 25 * 3600000) });
    assert.equal((await remind('ivan', '2.0.0')).body.reminded, true);
  });
  await test('при запуске после «Позже» напоминание не ждёт суток, но не дублируется окнами', async () => {
    const key = 'update.reminder:ivan:2.0.0', now = Date.now();
    rows.set(key, { ...rows.get(key), value: String(now - 2 * 3600000) });
    assert.equal((await remind('ivan', '2.0.0', true)).body.reminded, true);
    assert.equal((await remind('ivan', '2.0.0', true)).body.reminded, false);
  });

  // ---- Возврат: подписанная команда с rollback
  const deviceId = crypto.randomUUID();
  const release = (v: string) => releases.get(v).signature;
  const device = (version: string, userId = 'ivan') => ({ authUser: { id: userId }, body: { publicKey: actorHex, proof: signUpdateEnvelope('FLUXUPDDEVICE1', { deviceId, userId, version, platform: 'win32', arch: 'x64', status: 'idle', commandId: null, code: '', at: Date.now() }, actor.privateKey) } });
  const now = Date.now();
  const grant = signUpdateEnvelope('FLUXUPDAUTH1', { v: 1, id: 'g', inst: 'company', userId: 'owner', publicKey: actorHex, issuedAt: now - 1000, expiresAt: now + 3600000, maxTargets: 10, maxMinutes: 1440 }, owner.privateKey);
  const command = (extra: any, version = '2.0.0', previous: string | null = null) => {
    const r = releases.get(version);
    const body = { v: 1, id: crypto.randomUUID(), inst: 'company', actor: 'owner', issuedAt: now, deadline: now + 600000, action: 'schedule', version, generation: r.generation, sha256: r.sha256, targets: [{ deviceId, userId: 'ivan', previous }], ...extra };
    return { command: signUpdateEnvelope('FLUXUPDCMD1', body, actor.privateKey), delegation: grant, releaseSignature: release(version), id: body.id };
  };
  await test('устройство регистрируется на версии 3.0.0', async () => assert.equal((await call('POST /api/updates/devices/heartbeat', device('3.0.0'))).status, 200));
  const a3 = (await call('POST /api/updates/assignments', asOwner({ version: '3.0.0', userIds: ['ivan', 'anna'] }))).body.id;
  await test('понижение без пометки возврата отвергается', async () => {
    const r = await call('POST /api/updates/campaigns', asOwner(command({}, '2.0.0')));
    assert.equal(r.status, 409); assert.equal(r.body.code, 'UPDATE_DEVICE_CURRENT');
  });
  await test('возврат на версию, которая не ниже работающей, отвергается', async () => {
    const r = await call('POST /api/updates/campaigns', asOwner(command({ rollback: true }, '3.0.0')));
    assert.equal(r.status, 409); assert.equal(r.body.code, 'UPDATE_DEVICE_NOT_AHEAD');
  });
  await test('возврат принят и отменяет назначения выше возвращаемой версии', async () => {
    const before = JSON.parse(rows.get(`update.assign:${a3}`).value); assert.equal(before.cancelledAt, undefined);
    const r = await call('POST /api/updates/campaigns', asOwner(command({ rollback: true }, '2.0.0')));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(JSON.parse(rows.get(`update.assign:${a3}`).value).cancelledAt, 'назначение 3.0.0 отменено');
    assert.equal(JSON.parse(rows.get(`update.assign:${a2}`).value).cancelledAt, undefined, 'назначение той же версии остаётся');
    assert.equal((await assigned('ivan', '2.0.0')).release, null, 'откатившемуся не предлагают снова 3.0.0');
  });
  await test('список устройств помечает возврат', async () => {
    const r = (await call('GET /api/updates/devices', asOwner())).body;
    assert.equal(r.devices.find((d: any) => d.deviceId === deviceId).rollback, true);
  });
  await test('конфликт при отмене назначения откатывает и сам возврат', async () => {
    const b = (await call('POST /api/updates/assignments', asOwner({ version: '3.0.0', userIds: ['anna'] }))).body.id;
    const real = db.appSetting.updateMany;
    db.appSetting.updateMany = async (args: any) => String(args.where.id).startsWith('update.assign:') ? { count: 0 } : real(args);
    const head = rows.get(`update.head:${deviceId}:ivan`).value;
    const r = await call('POST /api/updates/campaigns', asOwner(command({ rollback: true }, '1.0.0', head)));
    db.appSetting.updateMany = real;
    assert.equal(r.status, 409);
    assert.equal(rows.get(`update.head:${deviceId}:ivan`).value, head, 'голова цепочки не сдвинулась');
    assert.equal(JSON.parse(rows.get(`update.assign:${b}`).value).cancelledAt, undefined);
  });

  console.log(`${count} проверок пройдено, 0 провалено`);
})().catch(error => { console.error(error); process.exitCode = 1; });
