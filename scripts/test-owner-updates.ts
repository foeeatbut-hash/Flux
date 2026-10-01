/** Контракт маршрутов: обновления из общей базы публикует только владелец. */
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerUpdateRoutes } from '../server/updates';
import { testSignature } from './fixtures/updateTestSign';

let ok = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) ok++;
  else { fail++; console.log(`✗ ${name}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`); }
};
async function run() {
  const chunks: any[] = []; const releases = new Map<string, any>(); const settings: any[] = [];
  const body = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096, 72)]);
  const version = '9.8.7'; let refuseWrites = false;
  const prisma: any = {
    appUpdateChunk: {
      findFirst: async ({ where }: any) => chunks.find(c => !where || (c.version === where.version && c.idx === where.idx)) || null,
      findMany: async ({ where }: any) => chunks.filter(c => c.version === where.version).sort((a, b) => a.idx - b.idx),
      count: async ({ where }: any) => chunks.filter(c => c.version === where.version).length,
      create: async ({ data }: any) => { if (refuseWrites) throw new Error('Запись недоступна'); chunks.push(data); return data; },
      deleteMany: async ({ where }: any) => { for (let i = chunks.length - 1; i >= 0; i--) if (where.version === chunks[i].version || where.version?.notIn && !where.version.notIn.includes(chunks[i].version)) chunks.splice(i, 1); },
    },
    appUpdate: {
      findUnique: async ({ where }: any) => releases.get(where.version) || null,
      findMany: async () => [...releases.values()],
      upsert: async ({ where, create, update }: any) => { const r = releases.has(where.version) ? { ...releases.get(where.version), ...update } : create; releases.set(where.version, r); return r; },
      deleteMany: async ({ where }: any) => releases.delete(where.version),
    },
    appSetting: {
      deleteMany: async ({ where }: any) => { const i = settings.findIndex(s => s.key === where.key); if (i >= 0) settings.splice(i, 1); },
      create: async ({ data }: any) => { settings.push(data); return data; },
      findFirst: async ({ where }: any) => settings.find(s => s.key === where.key),
    },
    $queryRawUnsafe: async (sql: string) => /max_allowed_packet/.test(sql) ? [{ n: 16 * 1024 * 1024 }] : [{ total: chunks.filter(c => sql.includes(c.version)).reduce((n, c) => n + c.data.length, 0) }],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-owner-updates-'));
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.authUser = { id: 'fixture', role: req.headers['x-test-role'] || 'ENGINEER_VENT' }; next(); });
  registerUpdateRoutes(app, { getPrisma: () => prisma, dataDir: dir, broadcast: () => {}, notifyAll: async () => {} });
  const server = await new Promise<import('http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (url: string, method: string, role = 'OWNER', value?: any) => fetch(base + url, { method, headers: { 'X-Test-Role': role, 'Content-Type': Buffer.isBuffer(value) ? 'application/octet-stream' : 'application/json' }, body: value === undefined ? undefined : Buffer.isBuffer(value) ? value : JSON.stringify(value) });
  try {
    eq('ADMIN не загружает исполняемый файл', (await call(`/api/updates/upload?version=${version}`, 'POST', 'ADMIN', body)).status, 403);
    eq('ADMIN не публикует выпуск', (await call('/api/updates', 'POST', 'ADMIN', { version })).status, 403);
    eq('ADMIN не отзывает выпуск', (await call(`/api/updates/${version}`, 'DELETE', 'ADMIN')).status, 403);
    eq('инженер не публикует выпуск', (await call('/api/updates', 'POST', 'ENGINEER_VENT', { version })).status, 403);
    eq('владелец не публикует внешнюю ссылку', (await call('/api/updates', 'POST', 'OWNER', { version, fileUrl: 'https://outside.test/file.exe' })).status, 400);
    eq('владелец не публикует без байтов в БД', (await call('/api/updates', 'POST', 'OWNER', { version, signature: testSignature(body, version) })).status, 400);
    const uploaded = await call(`/api/updates/upload?version=${version}`, 'POST', 'OWNER', body);
    eq('владелец загружает все байты в БД', uploaded.status, 200);
    eq('положительный upload сообщает shared:true', (await uploaded.json() as any).shared, true);
    eq('неопубликованный exe недоступен сотруднику', (await call(`/api/updates/download/${version}`, 'GET', 'ENGINEER_VENT')).status, 404);
    eq('владелец не публикует без подписи', (await call('/api/updates', 'POST', 'OWNER', { version })).status, 400);
    // Диск содержит правильный файл, база подменена: сверять надо именно общую БД.
    chunks[0].data = Buffer.from(body); chunks[0].data[3] ^= 1;
    eq('подмена в БД не маскируется правильным дисковым кэшем', (await call('/api/updates', 'POST', 'OWNER', { version, signature: testSignature(body, version) })).status, 400);
    chunks[0].data = Buffer.from(body); chunks[0].idx = 1;
    eq('пропущенный кусок блокирует публикацию', (await call('/api/updates', 'POST', 'OWNER', { version, signature: testSignature(body, version) })).status, 400);
    chunks[0].idx = 0;
    eq('владелец публикует только подписанные байты общей БД', (await call('/api/updates', 'POST', 'OWNER', { version, changelog: 'Проверка', signature: testSignature(body, version) })).status, 200);
    eq('опубликованный exe нельзя заменить под старой версией', (await call(`/api/updates/upload?version=${version}`, 'POST', 'OWNER', body)).status, 409);
    fs.writeFileSync(path.join(dir, 'updates', `Flux-${version}.exe`), Buffer.alloc(body.length, 0));
    const downloaded = await call(`/api/updates/download/${version}`, 'GET', 'ENGINEER_VENT');
    eq('скачивание игнорирует подмененный дисковый кэш', Buffer.from(await downloaded.arrayBuffer()).equals(body), true);
    eq('владелец отзывает выпуск', (await call(`/api/updates/${version}`, 'DELETE')).status, 200);
    eq('отозванный выпуск недоступен сотруднику', (await call(`/api/updates/download/${version}`, 'GET', 'ENGINEER_VENT')).status, 404);
    refuseWrites = true;
    const failed = await call('/api/updates/upload?version=9.8.8', 'POST', 'OWNER', body);
    eq('неудачная запись в БД возвращает ошибку вместо локального успеха', failed.status, 503);
    eq('неудачная загрузка не сохраняет якобы готовый дисковый файл', fs.existsSync(path.join(dir, 'updates', 'Flux-9.8.8.exe')), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); }
}
run().then(() => { console.log(`\n${ok} проверок пройдено, ${fail} провалено`); process.exit(fail ? 1 : 0); }).catch(e => { console.error(e); process.exit(1); });
