/** Настоящие PostgreSQL и два API-сервера, только одноразовая локальная база. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { ensureRemoteSchema } from '../server/schema-sync';
import { PLAY_PLAYER_ENTITLEMENTS } from '../play/features';

const endpoint = process.env.FLUX_PG_URL;
const root = path.resolve(__dirname, '..');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 25 && child.exitCode === null; i++) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}
function runScript(file: string, env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', file], { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${file}: exit ${code}`)));
  });
}
async function main() {
  if (!endpoint) { console.log('НЕ ПРОВЕРЕНО: требуется FLUX_PG_URL с настоящим PostgreSQL на localhost.'); return; }
  const clusterUrl = new URL(endpoint);
  assert.ok(['postgresql:', 'postgres:'].includes(clusterUrl.protocol), 'Требуется PostgreSQL');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(clusterUrl.hostname), 'Проверка создаёт временную базу только в локальном тестовом PostgreSQL');
  const cluster = new Client({ connectionString: clusterUrl.toString() });
  const name = `flux_play_test_${crypto.randomBytes(6).toString('hex')}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-play-pg-network-'));
  const servers: ChildProcess[] = [];
  const logStreams: fs.WriteStream[] = [];
  let prisma: any;
  let created = false;
  try {
    await cluster.connect();
    const version = await cluster.query('SELECT version()');
    assert.match(String(version.rows[0]?.version), /^PostgreSQL /);
    console.log(`Настоящая БД: ${String(version.rows[0].version).split(',')[0]}`);
    await cluster.query(`CREATE DATABASE "${name}"`);
    created = true;
    const databaseUrl = new URL(clusterUrl);
    databaseUrl.pathname = `/${name}`;
    const { PrismaClient } = require('@prisma/client-pg');
    const { PrismaPg } = require('@prisma/adapter-pg');
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl.toString() }) });
    const schemaErrors: string[] = [];
    await ensureRemoteSchema(prisma, 'postgresql', fs.readFileSync(path.join(root, 'prisma/schema.postgresql.prisma'), 'utf8'), message => {
      if (/Ошибка|Не удалось|Пропуск/.test(message)) schemaErrors.push(message);
    });
    assert.deepEqual(schemaErrors, [], 'Проверочная схема создаётся без пропущенных таблиц');
    const fixture = (index: number) => ({ symbol: `pg-play-${index}-${name}`, password: crypto.randomBytes(16).toString('hex') });
    const credentials = [fixture(1), fixture(2), fixture(3), fixture(4)];
    const permissions = JSON.stringify(Object.fromEntries(PLAY_PLAYER_ENTITLEMENTS.map(({ id: k }) => [k, { enabled: true, mode: 'ALLOW', until: null }])));
    for (const [index, person] of credentials.entries()) {
      const salt = crypto.randomBytes(16);
      const hashed = `scrypt$${salt.toString('hex')}$${crypto.scryptSync(person.password, salt, 64).toString('hex')}`;
      await prisma.user.create({ data: { symbol: person.symbol, password: hashed, name: `Проверочный игрок ${index + 1}`, role: 'ENGINEER_VENT', permissions } });
    }
    await prisma.appSetting.create({ data: { key: 'play_enabled', userId: null, value: '1' } });
    const port = Number(process.env.FLUX_PG_API_PORT || 3228);
    assert.ok(Number.isInteger(port) && port > 1024 && port < 65534, 'Неверный тестовый порт');
    for (let index = 0; index < 2; index++) {
      const dir = path.join(data, `server-${index + 1}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ current_db_type: 'REMOTE', database_url: databaseUrl.toString() }), { mode: 0o600 });
      const log = fs.createWriteStream(path.join(data, `server-${index + 1}.log`));
      logStreams.push(log);
      const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: root, env: { ...process.env,
        PORT: String(port + index), FLUX_LISTEN_HOST: '127.0.0.1', NODE_ENV: 'production', VENT_APP_DATA: dir,
        FLUX_DIAGNOSTICS_DIR: path.join(dir, 'diagnostics'), FLUX_TEST_LICENSE: '1', FLUX_TEST_LICENSE_AUTO: '1', FLUX_TEST_OWNER: '1',
      }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.pipe(log); child.stderr?.pipe(log);
      servers.push(child);
      let alive = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        if (child.exitCode !== null) break;
        try { const response = await fetch(`http://127.0.0.1:${port + index}/api/health`); if (response.ok) { alive = true; break; } } catch {}
        await sleep(250);
      }
      assert.ok(alive, `API ${index + 1} не запустился; журнал: ${path.join(data, `server-${index + 1}.log`)}`);
      console.log(`✓ Независимый API ${index + 1} подключён к общей проверочной БД`);
    }
    const env = { ...process.env, FLUX_PG_URL: databaseUrl.toString(), FLUX_API: `http://127.0.0.1:${port}`,
      FLUX_API2: `http://127.0.0.1:${port + 1}`, FLUX_USER: credentials[0].symbol, FLUX_PASS: credentials[0].password,
      FLUX_USER2: credentials[1].symbol, FLUX_PASS2: credentials[1].password,
      FLUX_USER3: credentials[2].symbol, FLUX_PASS3: credentials[2].password, FLUX_USER4: credentials[3].symbol, FLUX_PASS4: credentials[3].password };
    await runScript('scripts/test-play-postgres-live.ts', env);
    await runScript('scripts/test-play-builtin-live.ts', env);
    await runScript('scripts/test-play-durak-live.ts', env);
    const durakRows = await prisma.playSession.findMany({ where: { gameId: 'cards' } });
    assert.ok(durakRows.filter((row: any) => row.state === 'FINISHED').length >= 2, 'Полная партия Дурака и партия с уходом игроков сохранены FINISHED в настоящей PostgreSQL');
    const durakResults = await prisma.playResult.findMany({ where: { sessionId: { in: durakRows.map((row: any) => row.id) } } });
    assert.ok(durakResults.length >= 2 && durakResults.every((row: any) => row.signature === 'builtin'), 'Итоги Дурака рассчитаны и сохранены сервером');
    console.log('✓ Полная партия Дурака и уход игроков сохранены настоящим PostgreSQL');
    const rows = await prisma.playSession.findMany({ where: { gameId: 'billiards' } });
    assert.ok(rows.some((r: any) => r.state === 'FINISHED'), 'Результат реального бильярда сохранён в PostgreSQL');
    console.log('✓ Матч и результат сохранены настоящим PostgreSQL');
    console.log('POSTGRESQL + ДВА СЕРВЕРА: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  } finally {
    for (const child of servers) await stop(child);
    for (const log of logStreams) log.end();
    if (prisma) await prisma.$disconnect();
    if (created) await cluster.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await cluster.end();
    // Журналы нужны для разбора отказа, но не включают рабочие секреты.
    console.log(`Проверочные журналы: ${data}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
