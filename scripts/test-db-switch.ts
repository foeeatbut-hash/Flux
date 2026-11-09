/**
 * Смена базы: откат при неудаче (клиент, движок SQL, DATABASE_URL), адрес
 * общей базы не стирается при переходе на локальную, второй запрос — 409,
 * проверка типа и пути, закрытие временного соединения проверки.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import assert from 'node:assert/strict';
import express from 'express';
import { registerSystemRoutes } from '../server/routes/system';
import { getPrisma, setPrisma } from '../server/context';
import { getDialect, setDialect } from '../server/ddl';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-db-switch-'));
  const server = http.createServer();
  try {
    let config: any = { current_db_type: 'LOCAL', database_url: 'mysql://u:p@shared.test/flux', local_db_path: '' };
    const disconnects: string[] = [];
    let failRemote = true;
    let gate: Promise<void> | null = null;
    const mk = (name: string, fail = false) => ({
      name,
      $queryRawUnsafe: async () => { if (gate) await gate; if (fail) throw new Error('нет связи'); return []; },
      $disconnect: async () => { disconnects.push(name); },
      user: { count: async () => 1 },
    });
    const old = mk('old');
    setPrisma(old);
    setDialect('sqlite');
    process.env.DATABASE_URL = 'file:old';
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.authUser = { role: 'OWNER' }; next(); });
    registerSystemRoutes(app, {
      appVersion: 't', appDataPath: dir,
      loadAppConfig: () => ({ ...config }), saveAppConfig: c => { config = { ...c }; },
      resolveLocalDbPath: () => path.join(dir, 'database.sqlite'),
      createPrismaClient: (type: string, url: string) => {
        setDialect(type === 'REMOTE' ? 'mysql' : 'sqlite');
        return mk(`new-${type}`, type === 'REMOTE' && failRemote);
      },
      ensureHealthyLocalDb: () => {}, ensureSchemaColumns: () => {},
      syncRemoteSchema: async () => [], hashPassword: x => x,
      replaceClient: c => setPrisma(c),
    });
    await new Promise<void>(r => { server.on('request', app); server.listen(0, '127.0.0.1', r); });
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const post = async (url: string, body: any) => { const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };

    // 81/125: неудача на REMOTE — всё как было
    let r = await post('/api/db/switch', { current_db_type: 'REMOTE', database_url: 'mysql://u:p@other.test/x' });
    assert.equal(r.status, 500);
    assert.equal(getPrisma(), old, 'клиент вернулся');
    assert.equal(getDialect(), 'sqlite', 'движок SQL вернулся');
    assert.equal(process.env.DATABASE_URL, 'file:old', 'DATABASE_URL вернулся');
    assert(!disconnects.includes('old'), 'старый клиент не отключён');
    assert(disconnects.includes('new-REMOTE'), 'новый закрыт');
    assert.equal(config.database_url, 'mysql://u:p@shared.test/flux');
    console.log('✓ неудачная смена: клиент, диалект и DATABASE_URL восстановлены');

    // 83: тип
    r = await post('/api/db/switch', { current_db_type: 'bogus' });
    assert.equal(r.status, 400);
    r = await post('/api/db/test', { current_db_type: 'bogus' });
    assert.equal(r.status, 400);
    // 86: пути
    r = await post('/api/db/switch', { current_db_type: 'LOCAL', database_path: 'relative/db.sqlite' });
    assert.equal(r.status, 400);
    r = await post('/api/config/logs', { crash_log_dir: 'logs' });
    assert.equal(r.status, 400);
    console.log('✓ тип базы и пути проверяются');

    // 85: проверка подключения закрывает временный клиент и при неудаче
    disconnects.length = 0;
    r = await post('/api/db/test', { current_db_type: 'REMOTE', database_url: 'mysql://u:p@other.test/x' });
    assert.equal(r.body.success, false);
    assert(disconnects.includes('new-REMOTE'));
    console.log('✓ временное соединение проверки закрывается');

    // 84: переход на LOCAL не стирает адрес общей базы
    r = await post('/api/db/switch', { current_db_type: 'LOCAL', database_url: '', database_path: path.join(dir, 'x.sqlite') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(config.current_db_type, 'LOCAL');
    assert.equal(config.database_url, 'mysql://u:p@shared.test/flux');
    assert.equal(config.local_db_path, path.join(dir, 'x.sqlite'));
    assert(disconnects.includes('old'), 'после успеха старый отключён');
    console.log('✓ переход на LOCAL сохраняет адрес общей базы');

    // 87: одновременные запросы
    let release!: () => void;
    gate = new Promise<void>(res => { release = res; });
    const first = post('/api/db/switch', { current_db_type: 'LOCAL' });
    await new Promise(res => setTimeout(res, 100));
    const second = await post('/api/db/switch', { current_db_type: 'LOCAL' });
    assert.equal(second.status, 409);
    release(); gate = null;
    assert.equal((await first).status, 200);
    console.log('✓ второй одновременный запрос — 409');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
