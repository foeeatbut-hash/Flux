import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signUpdateEnvelope, verifyUpdateCommand, verifiedDeviceChain } from '../electron/updateCommand';
import { createUpdateCampaignRuntime, assertCampaignRestartState } from '../electron/updateCampaign';
const owner = crypto.generateKeyPairSync('ed25519');
const ownerHex = (owner.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
const actor = crypto.generateKeyPairSync('ed25519');
const actorHex = (actor.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
const now = Date.now();
const releaseSignature = signUpdateEnvelope('FLUXUPD1', { version: '2.0.0', size: 1024, sha256: 'a'.repeat(64) }, owner.privateKey);
const grant = { v: 1, id: 'grant', inst: 'company', userId: 'admin', publicKey: actorHex, issuedAt: now - 60000, expiresAt: now + 3600000, maxTargets: 5, maxMinutes: 60 };
const delegation = signUpdateEnvelope('FLUXUPDAUTH1', grant, owner.privateKey);
const payload = { v: 1, id: 'one', inst: 'company', actor: 'admin', issuedAt: now, deadline: now + 300000, action: 'schedule', version: '2.0.0', generation: crypto.randomUUID(), sha256: 'a'.repeat(64), targets: [{ deviceId: 'device', userId: 'employee', previous: null }] };
const envelope = (p: any, d = delegation) => ({ command: signUpdateEnvelope('FLUXUPDCMD1', p, actor.privateKey), delegation: d, releaseSignature });
const context = { inst: 'company', deviceId: 'device', userId: 'employee', keyHex: ownerHex };
let count = 0;
const test = (label: string, fn: () => void) => { try { fn(); count++; } catch (error) { console.error(label); throw error; } };
test('подписанное назначение принимается', () => assert.equal(verifyUpdateCommand(envelope(payload), context)?.id, 'one'));
test('подмена команды отвергается', () => { const e = envelope(payload); e.command = e.command.replace('FLUXUPDCMD1.', 'FLUXUPDCMD1.A'); assert.equal(verifyUpdateCommand(e, context), null); });
test('другой профиль не принимает команду', () => assert.equal(verifyUpdateCommand(envelope(payload), { ...context, userId: 'other' }), null));
test('чужая роль подписанта отвергается', () => assert.equal(verifyUpdateCommand(envelope({ ...payload, actor: 'other' }), context), null));
test('подпись после истечения разрешения отвергается', () => assert.equal(verifyUpdateCommand(envelope({ ...payload, issuedAt: grant.expiresAt + 1, deadline: grant.expiresAt + 300001 }), context), null));
test('повреждённая цель отвергается без исключения', () => assert.equal(verifyUpdateCommand(envelope({ ...payload, targets: [null] }), context), null));
test('одно устройство принимает независимые профили', () => assert.ok(verifyUpdateCommand(envelope({ ...payload, targets: [...payload.targets, { deviceId: 'device', userId: 'other', previous: null }] }), context)));
const second = { ...payload, id: 'two', targets: [{ ...payload.targets[0], previous: 'one' }] };
const cancel = { ...payload, id: 'cancel', action: 'cancel', deadline: now, targets: [{ ...payload.targets[0], previous: 'two' }] };
test('новое назначение и отмена продолжают цепь', () => assert.equal(verifiedDeviceChain([envelope(payload), envelope(second), envelope(cancel)], { ...context, knownId: 'one' })?.command.action, 'cancel'));
test('пропуск головы отвергается', () => assert.equal(verifiedDeviceChain([envelope(second)], context), null));
test('откат до известной головы отвергается', () => assert.equal(verifiedDeviceChain([envelope(payload)], { ...context, knownId: 'two' }), null));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-campaign-'));
try {
  let failSave = false;
  const encryption = { available: () => true, encrypt: (s: string) => { if (failSave) throw Error('disk blocked'); return Buffer.from(s); }, decrypt: (b: Buffer) => b.toString() };
  const runtime = createUpdateCampaignRuntime(dir, () => '1.0.0', encryption, ownerHex);
  const deviceId = runtime.identity().deviceId;
  const local = { ...payload, targets: [{ deviceId, userId: 'employee', previous: null }] };
  test('сбой сохранения не оставляет принятую команду', () => { failSave = true; assert.throws(() => runtime.accept('company', 'employee', [envelope(local)])); assert.equal(runtime.assignment('company', 'employee'), null); failSave = false; });
  test('повтор после сбоя сохраняет команду', () => assert.equal(runtime.accept('company', 'employee', [envelope(local)])?.id, 'one'));
  test('подтверждённое назначение разрешает перезапуск', () => assert.doesNotThrow(() => assertCampaignRestartState(runtime, 'one', '2.0.0', { inst: 'company', commands: [envelope(local)] }, ownerHex)));
  test('повреждённая история запрещает перезапуск несмотря на сохранённое назначение', () => {
    const broken = envelope({ ...local, id: 'broken', targets: [{ deviceId, userId: 'employee', previous: 'missing' }] });
    assert.throws(() => assertCampaignRestartState(runtime, 'one', '2.0.0', { inst: 'company', commands: [envelope(local), broken] }, ownerHex));
  });
  test('удаление строки не отменяет команду', () => assert.equal(runtime.accept('company', 'employee', [])?.id, 'one'));
  test('профили на устройстве изолированы', () => assert.equal(runtime.assignment('company', 'other'), null));
  test('недоступное защищённое хранилище запрещает создание', () => assert.throws(() => createUpdateCampaignRuntime(dir, () => '1.0.0', { ...encryption, available: () => false })));
  test('проверенная отмена заменяет назначение', () => { const c = { ...local, id: 'cancel', action: 'cancel', deadline: now, targets: [{ deviceId, userId: 'employee', previous: 'one' }] }; assert.equal(runtime.accept('company', 'employee', [envelope(local), envelope(c)])?.action, 'cancel'); assert.throws(() => assertCampaignRestartState(runtime, 'one', '2.0.0', { inst: 'company', commands: [envelope(local), envelope(c)] }, ownerHex)); });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`${count} проверок пройдено, 0 провалено`);

async function routeChecks() {
  const { registerUpdateCampaignRoutes } = await import('../server/routes/updateCampaigns');
  const routes = new Map<string, Function[]>();
  const app = { get: (url: string, ...handlers: Function[]) => routes.set(`GET ${url}`, handlers), post: (url: string, ...handlers: Function[]) => routes.set(`POST ${url}`, handlers) };
  registerUpdateCampaignRoutes(app as any, { getPrisma: () => { throw Error('unexpected database write'); }, installationId: async () => 'company', updatePublicKeyHex: ownerHex, broadcast: () => {} });
  const invoke = async (req: any) => {
    let status = 200;
    const res = { status: (n: number) => { status = n; return res; }, json: (_body: unknown) => {} };
    const handlers = routes.get('POST /api/updates/campaigns')!;
    let allowed = false;
    handlers[0](req, res, () => { allowed = true; });
    if (allowed) await handlers[1](req, res);
    return status;
  };
  assert.equal(await invoke({ authUser: { id: 'admin', role: 'USER' }, body: envelope(payload) }), 403);
  assert.equal(await invoke({ authUser: { id: 'admin', role: 'ADMIN', permissions: {} }, body: envelope(payload) }), 403);
  const expired = signUpdateEnvelope('FLUXUPDAUTH1', { ...grant, issuedAt: now - 120000, expiresAt: now - 1000 }, owner.privateKey);
  const historical = { ...payload, issuedAt: now - 2000, deadline: now + 298000 };
  assert.equal(await invoke({ authUser: { id: 'admin', role: 'OWNER' }, body: envelope(historical, expired) }), 400);
  console.log('3 проверки маршрутов пройдено, 0 провалено');
}
void routeChecks().catch(error => { console.error(error); process.exitCode = 1; });

async function lifecycleChecks() {
  const { registerUpdateCampaignRoutes } = await import('../server/routes/updateCampaigns');
  const rows = new Map<string, any>();
  const appSetting = {
    findUnique: async ({ where }: any) => rows.get(where.id) || null,
    findMany: async ({ where }: any) => [...rows.values()].filter(r => r.key === where.key),
    upsert: async ({ where, create, update }: any) => { const r = rows.has(where.id) ? { ...rows.get(where.id), ...update } : create; rows.set(where.id, r); return r; },
    create: async ({ data }: any) => { if (rows.has(data.id)) throw Object.assign(Error('duplicate'), { code: 'P2002' }); rows.set(data.id, data); return data; },
    updateMany: async ({ where, data }: any) => { const r = rows.get(where.id); if (!r || r.value !== where.value) return { count: 0 }; rows.set(where.id, { ...r, ...data }); return { count: 1 }; },
  };
  const db = { appSetting, appUpdate: { findUnique: async () => ({ version: payload.version, generation: payload.generation, state: 'published', signature: releaseSignature, sha256: payload.sha256, size: 1024 }) },
    $transaction: async (fn: any) => { const snapshot = new Map(rows); try { return await fn(db); } catch (e) { rows.clear(); for (const [k, v] of snapshot) rows.set(k, v); throw e; } } };
  const routes = new Map<string, Function[]>();
  registerUpdateCampaignRoutes({ get: (url: string, ...handlers: Function[]) => routes.set(`GET ${url}`, handlers), post: (url: string, ...handlers: Function[]) => routes.set(`POST ${url}`, handlers) } as any,
    { getPrisma: () => db, installationId: async () => 'company', updatePublicKeyHex: ownerHex, broadcast: () => {} });
  const call = async (route: string, req: any) => {
    let status = 200, body: any;
    const res = { status: (n: number) => { status = n; return res; }, json: (value: unknown) => { body = value; } };
    const handlers = routes.get(route)!;
    if (handlers.length === 2) { let allowed = false; handlers[0](req, res, () => { allowed = true; }); if (allowed) await handlers[1](req, res); }
    else await handlers[0](req, res);
    return { status, body };
  };
  const deviceId = crypto.randomUUID();
  const heartbeat = (userId = 'employee') => ({ authUser: { id: userId }, body: { publicKey: actorHex, proof: signUpdateEnvelope('FLUXUPDDEVICE1', { deviceId, userId, version: '1.0.0', platform: 'win32', arch: 'x64', status: 'idle', commandId: null, code: '', at: Date.now() }, actor.privateKey) } });
  const actorReq = (p: any) => ({ authUser: { id: 'admin', role: 'OWNER' }, body: envelope(p) });
  const one = { ...payload, targets: [{ deviceId, userId: 'employee', previous: null }] };
  assert.equal((await call('POST /api/updates/devices/heartbeat', heartbeat())).status, 200);
  assert.equal((await call('POST /api/updates/campaigns', actorReq(one))).status, 200);
  assert.equal(rows.get(`update.head:${deviceId}:employee`).value, 'one');
  const delivered = await call('POST /api/updates/devices/heartbeat', heartbeat());
  assert.equal(verifiedDeviceChain(delivered.body.commands, { ...context, deviceId })?.command.id, 'one');
  assert.equal((await call('POST /api/updates/campaigns', actorReq({ ...one, id: 'stale' }))).status, 409);
  assert.equal((await call('POST /api/updates/devices/heartbeat', heartbeat('other'))).status, 200);
  assert.equal((await call('POST /api/updates/campaigns', actorReq({ ...one, id: 'other', targets: [{ deviceId, userId: 'other', previous: null }] }))).status, 200);
  assert.equal(rows.get(`update.head:${deviceId}:employee`).value, 'one');
  assert.equal(rows.get(`update.head:${deviceId}:other`).value, 'other');
  const otherDelivery = await call('POST /api/updates/devices/heartbeat', heartbeat('other'));
  assert.equal(verifiedDeviceChain(otherDelivery.body.commands, { ...context, deviceId, userId: 'other' })?.command.id, 'other');
  await call('POST /api/updates/devices/heartbeat', heartbeat());
  const cancellation = { ...one, id: 'cancel', action: 'cancel', deadline: now, targets: [{ deviceId, userId: 'employee', previous: 'one' }] };
  assert.equal((await call('POST /api/updates/campaigns', actorReq(cancellation))).status, 200);
  const cancelled = await call('POST /api/updates/devices/heartbeat', heartbeat());
  assert.equal(verifiedDeviceChain(cancelled.body.commands, { ...context, deviceId, knownId: 'one' })?.command.action, 'cancel');
  // Transaction head mismatch must roll back command insertion even if signed history still looks current.
  rows.set(`update.head:${deviceId}:employee`, { ...rows.get(`update.head:${deviceId}:employee`), value: 'concurrent' });
  const raced = { ...one, id: 'raced', targets: [{ deviceId, userId: 'employee', previous: 'cancel' }] };
  assert.equal((await call('POST /api/updates/campaigns', actorReq(raced))).status, 409);
  assert.equal(rows.has('update.command:raced'), false);
  console.log('14 проверок полного цикла маршрутов пройдено, 0 провалено');
}
void lifecycleChecks().catch(error => { console.error(error); process.exitCode = 1; });
