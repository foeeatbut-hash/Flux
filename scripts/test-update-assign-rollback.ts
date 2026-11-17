/**
 * Возврат предыдущей версии: версию ниже работающей Flux ставит только по подписанному заданию с
 * `rollback: true`; остальные проверки выпуска (подпись, размер, хеш) остаются в силе.
 *
 * Запуск: npx tsx scripts/test-update-assign-rollback.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { signUpdateEnvelope, verifyUpdateCommand } from '../electron/updateCommand';
import { createUpdateCampaignRuntime, assertCampaignRestartState } from '../electron/updateCampaign';
import { updateRefusalFor } from '../electron/updateRollback';
import { downloadVerifiedUpdate } from '../electron/updateDownload';
import { applyArgs, parseApplyArgs, APPLY_FLAG } from '../electron/updates';
import { needsInstall } from '../src/lib/updates';

const owner = crypto.generateKeyPairSync('ed25519'), actor = crypto.generateKeyPairSync('ed25519');
const hex = (k: crypto.KeyObject) => (k.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
const ownerHex = hex(owner.publicKey), actorHex = hex(actor.publicKey);
let count = 0;
const test = async (label: string, fn: () => unknown) => { try { await fn(); count++; } catch (error) { console.error('✗', label); throw error; } };

const body = Buffer.alloc(6 * 1024 * 1024, 7); body.write('MZ');
const sha256 = crypto.createHash('sha256').update(body).digest('hex');
const signature = signUpdateEnvelope('FLUXUPD1', { version: '1.0.0', size: body.length, sha256 }, owner.privateKey);
const refusal = (current: string, rollback: boolean, over: any = {}) => updateRefusalFor({ signature, version: '1.0.0', current, size: body.length, sha256, keyHex: ownerHex, ...over }, rollback);

void (async () => {
  await test('версия ниже работающей без возврата отвергается', () => assert.match(refusal('2.0.0', false), /откат не ставится/));
  await test('версия ниже работающей при возврате ставится', () => assert.equal(refusal('2.0.0', true), ''));
  await test('обычное обновление вверх по-прежнему проходит', () => assert.equal(refusal('0.9.0', false), ''));
  await test('при возврате хеш всё равно проверяется', () => assert.match(refusal('2.0.0', true, { sha256: 'f'.repeat(64) }), /не совпадает/));
  await test('при возврате размер всё равно проверяется', () => assert.match(refusal('2.0.0', true, { size: body.length + 1 }), /не совпадает/));
  await test('при возврате нужна подпись владельца', () => assert.match(refusal('2.0.0', true, { signature: '' }), /нет подписи/));
  await test('при возврате чужая подпись отвергается', () => {
    const forged = signUpdateEnvelope('FLUXUPD1', { version: '1.0.0', size: body.length, sha256 }, crypto.generateKeyPairSync('ed25519').privateKey);
    assert.match(refusal('2.0.0', true, { signature: forged }), /не подтверждена/);
  });
  await test('при возврате версия подписи должна совпасть с запрошенной', () => assert.match(refusal('2.0.0', true, { version: '1.5.0' }), /относится к версии/));

  // Какая версия ждёт установки у сотрудника
  await test('обычное назначение: нужно, пока работающая версия ниже', () => {
    assert.equal(needsInstall({ version: '2.0.0' }, '1.0.0'), true);
    assert.equal(needsInstall({ version: '2.0.0' }, '2.0.0'), false);
    assert.equal(needsInstall({ version: '2.0.0' }, '3.0.0'), false);
  });
  await test('возврат: нужен, пока работающая версия выше возвращаемой', () => {
    assert.equal(needsInstall({ version: '1.0.0', rollback: true }, '2.0.0'), true);
    assert.equal(needsInstall({ version: '1.0.0', rollback: true }, '1.0.0'), false);
    assert.equal(needsInstall({ version: '1.0.0', rollback: true }, '0.9.0'), false);
  });

  // Подписанная команда
  const now = Date.now(), release = signUpdateEnvelope('FLUXUPD1', { version: '1.0.0', size: 4096, sha256: 'a'.repeat(64) }, owner.privateKey);
  const delegation = signUpdateEnvelope('FLUXUPDAUTH1', { v: 1, id: 'g', inst: 'company', userId: 'owner', publicKey: actorHex, issuedAt: now - 1000, expiresAt: now + 3600000, maxTargets: 5, maxMinutes: 1440 }, owner.privateKey);
  const generation = crypto.randomUUID();
  const base = { v: 1, id: 'cmd', inst: 'company', actor: 'owner', issuedAt: now, deadline: now + 600000, action: 'schedule', version: '1.0.0', generation, sha256: 'a'.repeat(64), targets: [{ deviceId: 'dev', userId: 'ivan', previous: null }] };
  const envelope = (p: any) => ({ command: signUpdateEnvelope('FLUXUPDCMD1', p, actor.privateKey), delegation, releaseSignature: release });
  const ctx = { inst: 'company', keyHex: ownerHex };
  await test('команда с rollback:true принимается', () => assert.equal(verifyUpdateCommand(envelope({ ...base, rollback: true }), ctx)?.rollback, true));
  await test('rollback:false и чужие значения отвергаются', () => {
    for (const bad of [false, 'yes', 1, null]) assert.equal(verifyUpdateCommand(envelope({ ...base, rollback: bad }), ctx), null, String(bad));
  });
  await test('отмена не может быть возвратом', () => assert.equal(verifyUpdateCommand(envelope({ ...base, action: 'cancel', deadline: now, rollback: true }), ctx), null));

  // Главный процесс доверяет только принятому заданию
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-rollback-'));
  try {
    const encryption = { available: () => true, encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() };
    const runtime = createUpdateCampaignRuntime(dir, () => '2.0.0', encryption, ownerHex);
    const deviceId = runtime.identity().deviceId;
    const targets = [{ deviceId, userId: 'ivan', previous: null }];
    await test('до приёма задания возврат не разрешён', () => assert.equal(runtime.allowsRollback('cmd', '1.0.0'), false));
    await test('обычное задание не разрешает возврат', () => {
      runtime.accept('company', 'ivan', [envelope({ ...base, id: 'plain', targets })]);
      assert.equal(runtime.allowsRollback('plain', '1.0.0'), false);
    });
    const rollbackCommand = envelope({ ...base, id: 'rb', rollback: true, targets: [{ deviceId, userId: 'ivan', previous: 'plain' }] });
    const chain = [envelope({ ...base, id: 'plain', targets }), rollbackCommand];
    await test('принятое задание на возврат разрешает ровно свою версию', () => {
      runtime.accept('company', 'ivan', chain);
      assert.equal(runtime.allowsRollback('rb', '1.0.0'), true);
      assert.equal(runtime.allowsRollback('rb', '1.5.0'), false, 'другая версия');
      assert.equal(runtime.allowsRollback('other', '1.0.0'), false, 'чужой номер задания');
    });
    await test('перезапуск по возврату требует совпадения вида задания', () => {
      const data = { inst: 'company', commands: chain };
      assert.doesNotThrow(() => assertCampaignRestartState(runtime, 'rb', '1.0.0', data, ownerHex, true));
      assert.throws(() => assertCampaignRestartState(runtime, 'rb', '1.0.0', data, ownerHex, false), /Вид назначения/);
    });
    await test('обычное задание не ставится как возврат', () => {
      const plain = createUpdateCampaignRuntime(fs.mkdtempSync(path.join(dir, 'p-')), () => '2.0.0', encryption, ownerHex);
      const id = plain.identity().deviceId, t = [{ deviceId: id, userId: 'ivan', previous: null }];
      const data = { inst: 'company', commands: [envelope({ ...base, id: 'plain', targets: t })] };
      plain.accept('company', 'ivan', data.commands);
      assert.throws(() => assertCampaignRestartState(plain, 'plain', '1.0.0', data, ownerHex, true), /Вид назначения/);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // Помощник подмены получает пометку возврата в доводах запуска
  await test('довод возврата доходит до помощника подмены', () => {
    const argv = applyArgs('C:\\Flux.exe', 77, { signature, current: '2.0.0', rollback: true });
    assert.equal(parseApplyArgs(['x', ...argv])?.rollback, true);
    assert.equal(parseApplyArgs(['x', ...applyArgs('C:\\Flux.exe', 77, { signature, current: '2.0.0' })])?.rollback, undefined);
    assert.ok(argv.includes(APPLY_FLAG));
  });

  // Скачивание: без пометки версия ниже работающей не качается вовсе, с ней — качается и проверяется
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/updates/download/1.0.0') { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Length', String(body.length)); res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-rollback-dl-'));
  try {
    const params = { version: '1.0.0', signature, current: '2.0.0', server: origin, keyHex: ownerHex };
    await test('скачивание версии ниже работающей без возврата отвергается до загрузки', async () => {
      await assert.rejects(downloadVerifiedUpdate(`${origin}/api/updates/download/1.0.0`, path.join(tmp, 'a.exe'), params), /откат не ставится/);
      assert.equal(fs.existsSync(path.join(tmp, 'a.exe')), false);
    });
    await test('скачивание при возврате проходит полную проверку', async () => {
      await downloadVerifiedUpdate(`${origin}/api/updates/download/1.0.0`, path.join(tmp, 'b.exe'), { ...params, rollback: true });
      assert.equal(fs.statSync(path.join(tmp, 'b.exe')).size, body.length);
    });
  } finally { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }

  console.log(`${count} проверок пройдено, 0 провалено`);
})().catch(error => { console.error(error); process.exitCode = 1; });
