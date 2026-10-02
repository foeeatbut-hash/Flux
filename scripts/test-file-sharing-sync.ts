/** Оригинал на устройстве: конфликт, обрыв, смена входа и сетевые папки никогда не перезаписываются вслепую. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ENV_CONFIG } from '../src/config/env';
import { sourceBindings, stageLocalShare, syncSource, type SourceBinding } from '../src/services/fileSharingService';

const storage = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) };
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const actorId = 'owner';
const ref = { rootId: 'desktop', relativePath: 'План.docx' };
const key = `flux.shared-sources:${ENV_CONFIG.apiUrl}:${actorId}`;
const binding: SourceBinding = { sourceKey: sha('source'), fileId: 'file', ref, name: 'План.docx', baseSha: sha('начало') };
let local = 'начало', remote = 'правка коллеги', downloaded = remote;
let network = false, pending = false, online = true, current = true;
let writes: any[] = [], requests: Array<{ url: string; method: string }> = [];
const reset = () => { storage.set(key, JSON.stringify([binding])); writes = []; requests = []; current = true; network = false; pending = false; online = true; };
(globalThis as any).window = { electron: { windowsFiles: { invoke: async (request: any) => {
  if (request.action === 'roots') return { ok: true, data: [{ id: 'desktop', name: 'Рабочий стол', kind: 'desktop', available: true, network }] };
  if (request.action === 'read') return { ok: true, data: { name: 'План.docx', sha256: sha(local), base64: Buffer.from(local).toString('base64'), size: Buffer.byteLength(local) } };
  if (request.action === 'write') { writes.push(request); assert.equal(request.baseSha256, sha(local)); local = Buffer.from(request.base64, 'base64').toString(); return { ok: true, data: {} }; }
  throw Error('Неожиданный запрос Windows');
} } } };
(globalThis as any).fetch = async (input: string, init?: RequestInit) => {
  requests.push({ url: input, method: init?.method || 'GET' });
  if (!online) throw Error('Нет связи');
  if (input.includes('/file-sharing/')) return Response.json({ fileId: 'file', ownerId: actorId, state: 'READY', audience: 'ALL', epoch: 1, permission: 'EDIT', recipients: [] });
  if (input.endsWith('/meta')) return Response.json({ sha256: sha(remote), pendingSharedEdits: pending });
  if (input.endsWith('/raw')) return new Response(Buffer.from(downloaded));
  if (init?.method === 'PUT') { remote = Buffer.from(init.body as Uint8Array).toString(); return Response.json({ sha256: sha(remote) }); }
  throw Error('Неожиданный запрос сервера');
};

async function main() {
  reset(); local = 'начало'; remote = downloaded = 'правка коллеги';
  const one = syncSource(actorId, binding), two = syncSource(actorId, binding);
  assert.equal(one, two, 'ручная и фоновая синхронизация одного исходника объединяются');
  assert.equal(await one, 'Синхронизировано');
  assert.equal(writes.length, 1); assert.equal(local, remote);
  assert.equal(sourceBindings(actorId)[0].baseSha, sha(remote));

  reset(); local = 'мои изменения'; remote = 'чужие изменения';
  assert.match(await syncSource(actorId, binding), /^Конфликт/);
  assert.equal(writes.length, 0); assert.equal(requests.some(request => request.method === 'PUT'), false);
  assert.equal(local, 'мои изменения'); assert.equal(remote, 'чужие изменения');

  reset(); local = 'мои изменения'; remote = 'начало'; pending = true;
  assert.match(await syncSource(actorId, binding), /^Конфликт/);
  assert.equal(requests.some(request => request.method === 'PUT'), false, 'несохранённый журнал коллег не затирается исходником');

  reset(); local = 'начало'; remote = 'новая версия'; downloaded = 'другие байты';
  assert.match(await syncSource(actorId, binding), /изменилась во время загрузки/);
  assert.equal(writes.length, 0, 'несовпадающий хеш выгрузки не пишется на устройство');

  reset(); online = false; local = 'начало'; remote = 'новая версия';
  assert.match(await syncSource(actorId, binding), /^Синхронизация приостановлена/);
  assert.equal(writes.length, 0); assert.equal(local, 'начало');
  online = true; downloaded = remote;
  assert.equal(await syncSource(actorId, sourceBindings(actorId)[0]), 'Синхронизировано');
  assert.equal(local, remote, 'возврат после обрыва продолжает безопасную синхронизацию');

  reset(); current = false;
  await syncSource(actorId, binding, () => current);
  assert.equal(requests.length, 0); assert.equal(writes.length, 0, 'завершённый вход не синхронизирует исходники');

  reset(); network = true;
  await assert.rejects(() => stageLocalShare(actorId, ref, () => {}), /правами Windows/);
  assert.equal(requests.length, 0, 'сетевая папка не публикуется личной копией в базу');
  await syncSource(actorId, binding);
  assert.equal(writes.length, 0); assert.equal(requests.length, 0, 'сетевой оригинал не участвует в личной синхронизации');
  console.log('✓ Синхронизация исходника: конфликты, обрыв, хеш, смена входа и права сетевой папки');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
