'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { startDatabaseRuntime, parseDatabaseUri } = require('../src/database-runtime.cjs');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (error) { failed++; console.error(`✗ ${name}: ${error.message}`); }
}
const uri = 'mysql://test-user:temporary-test-pass@db.example.test/Flux';
const goodHealth = { statusCode: 200, body: { ok: true, databaseMode: 'REMOTE', dialect: 'mysql', needsSetup: true } };

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-owner-runtime-tests-'));
  const executable = path.join(temp, 'Flux-test-x64.exe');
  const bytes = Buffer.alloc(1024); bytes.write('MZ');
  await fs.writeFile(executable, bytes);
  let nextPid = 62000;
  function fixture(extra = {}) {
    const children = [], kills = [], requests = [], spawns = [], progress = [];
    const deps = {
      env: { PORTABLE_EXECUTABLE_DIR: temp, PORTABLE_EXECUTABLE_FILE: 'owner.exe', TEST_INHERITED: 'yes' },
      version: 'test', tmpdir: temp, platform: 'win32', startupTimeoutMs: 150, pollMs: 5, requestTimeoutMs: 50,
      allocatePort: async () => 43210,
      requestHealth: async port => { requests.push(port); return goodHealth; },
      spawn(file, args, options) {
        spawns.push({ file, args, options });
        const child = new EventEmitter();
        child.pid = nextPid++; child.exitCode = null; child.signalCode = null;
        child.kill = () => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); return true; };
        children.push(child); return child;
      },
      execFile(file, args, options, callback) {
        kills.push({ file, args, options });
        const owned = children.find(child => String(child.pid) === args[1]);
        assert.ok(owned, 'остановка должна затронуть только созданный дочерний процесс');
        owned.exitCode = 0; owned.emit('exit', 0, null); callback(null, '', '');
      },
      ...extra,
    };
    const options = { uri, onProgress: (...values) => progress.push(values) };
    return { deps, options, children, kills, requests, spawns, progress };
  }
  async function sessions() { return (await fs.readdir(temp)).filter(name => name.startsWith('flux-owner-db-')); }
  async function clean() { assert.deepEqual(await sessions(), [], 'временный конфиг с URI должен быть удалён'); }
  async function rejection(f, pattern, options = f.options) {
    const error = await startDatabaseRuntime(options, f.deps).then(() => null, error => error);
    assert.ok(error instanceof Error, 'подключение должно завершиться ошибкой');
    if (pattern) assert.match(error.message, pattern);
    assert.ok(!error.message.includes('temporary-test-pass') && !error.message.includes('@db.example.test'), 'ошибка не раскрывает пароль или реквизиты URI');
    await clean(); return error;
  }
  try {
    await test('URI с несколькими @ и спецсимволами сохраняет пароль и скрывает его в подписи', async () => {
      const raw = 'mysql://test-user:test@part@word^$@db.example.test/Flux';
      const parsed = parseDatabaseUri(raw), value = new URL(parsed.uri);
      assert.equal(decodeURIComponent(value.password), 'test@part@word^$');
      assert.equal(parsed.display, 'MariaDB / MySQL · db.example.test:3306/Flux');
      assert.ok(!parsed.display.includes('test-user') && !parsed.display.includes('word'));
      assert.equal(parseDatabaseUri('mariadb://u:p@db.example.test:3307/Flux').dialect, 'mysql');
      assert.equal(decodeURIComponent(new URL(parseDatabaseUri('mysql://u:p%2540@db.example.test/Flux').uri).password), 'p%40');
    });
    await test('Неверные URI отклоняются без раскрытия введённых данных', async () => {
      for (const value of ['http://u:p@host/db', 'https://u:p@host/db', 'postgres://u:p@host/db', 'postgresql://u:p@host/db', 'mysql://host/db', 'mysql://u:@host/db', 'mysql://u:p@host/', 'mysql://u:p@host:99999/db', 'mysql://u:%ZZ@host/db', 'mysql://u:p@host/db#secret', 'mysql://u:p@host/db#', 'mysql://u:p@host/db/other', 'mysql://u:p@host/db?option=%ZZ', 'mysql://u:p@host/db?option=%', 'mysql://u:p@host/db?option=%0', 'mysql://u:p@host/db?option=a\\b', 'mysql://u:p@host/db?option=' + 'x'.repeat(4096)]) {
        assert.throws(() => parseDatabaseUri(value), error => !error.message.includes(value) && /Введите адрес/.test(error.message));
      }
    });
    await test('REMOTE-конфиг, локальный адрес, состояние настройки и остановка собственного дерева', async () => {
      const f = fixture(); const runtime = await startDatabaseRuntime(f.options, f.deps);
      try {
        assert.equal(runtime.origin, 'http://127.0.0.1:43210');
        assert.equal(runtime.display, 'MariaDB / MySQL · db.example.test:3306/Flux');
        assert.deepEqual(f.progress, [['Подключение к общей базе', 0, 0]]);
        assert.equal(f.spawns[0].file, executable);
        assert.deepEqual(f.spawns[0].args, ['--flux-company-server']);
        assert.equal(f.spawns[0].options.windowsHide, true);
        assert.deepEqual(f.spawns[0].options.stdio, ['ignore','pipe','pipe']);
        const env = f.spawns[0].options.env;
        assert.equal(env.PORT, '43210'); assert.equal(env.FLUX_LISTEN_HOST, '127.0.0.1');
        assert.equal(env.TEST_INHERITED, 'yes');
        assert.equal(env.PORTABLE_EXECUTABLE_FILE, undefined); assert.equal(env.PORTABLE_EXECUTABLE_DIR, undefined);
        assert.equal(path.dirname(env.VENT_APP_DATA), temp);
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(env.VENT_APP_DATA, 'config.json'), 'utf8')), { current_db_type: 'REMOTE', database_url: uri });
        if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(env.VENT_APP_DATA, 'config.json'))).mode & 0o777, 0o600);
        const stopping = runtime.stop(); assert.equal(runtime.stop(), stopping); await stopping;
        assert.equal(f.kills.length, 1);
        assert.equal(f.kills[0].file, 'taskkill.exe');
        assert.deepEqual(f.kills[0].args, ['/PID', String(f.children[0].pid), '/T', '/F']);
        assert.equal(f.kills[0].options.windowsHide, true);
      } finally { await runtime.stop(); }
      await clean();
    });
    await test('Отсутствующая точная версия предлагает EXE в родительском native dialog', async () => {
      const f = fixture({ version: 'missing-version' }); const parentWindow = {};
      let called = false;
      f.options.dialog = { showOpenDialog: async (parent, options) => {
        called = true; assert.equal(parent, parentWindow); assert.deepEqual(options.properties, ['openFile']);
        assert.deepEqual(options.filters[0].extensions, ['exe']); return { canceled: false, filePaths: [executable] };
      } };
      f.options.parentWindow = parentWindow;
      const runtime = await startDatabaseRuntime(f.options, f.deps);
      await runtime.stop(); assert.ok(called); await clean();
    });
    await test('Отмена выбора и неверный формат EXE не создают сервер или конфиг', async () => {
      const f = fixture({ version: 'missing-version' });
      f.options.dialog = { showOpenDialog: async () => ({ canceled: true }) };
      await rejection(f, /отменено/); assert.equal(f.spawns.length, 0);
      for (const [name, data] of [['Flux-short.exe', Buffer.from('MZ')], ['Flux-bad.exe', Buffer.alloc(1024)], ['Flux-file.txt', bytes]]) {
        const file = path.join(temp, name); await fs.writeFile(file, data);
        const g = fixture({ version: 'missing-version' });
        g.options.dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) };
        await rejection(g, /EXE/); assert.equal(g.spawns.length, 0);
      }
    });
    await test('SQLite, другой диалект и отсутствие metadata не дают принять чужую базу', async () => {
      for (const body of [ { ok: true, databaseMode: 'LOCAL', dialect: 'sqlite' }, { ok: true, databaseMode: 'REMOTE', dialect: 'postgresql' }, { ok: true } ]) {
        const f = fixture({ requestHealth: async () => ({ statusCode: 200, body }) });
        await rejection(f, /не подтвердил/); assert.equal(f.kills.length, 1);
      }
    });
    await test('HTTP и PostgreSQL URI отклоняются до запуска дочернего Flux', async () => {
      for (const address of ['http://127.0.0.1:3000', 'https://flux.example.test', 'postgres://test-user:temporary-test-pass@db.example.test/Flux', 'postgresql://test-user:temporary-test-pass@db.example.test/Flux']) {
        const f = fixture(); f.options.uri = address;
        await rejection(f, /Введите адрес общей MariaDB \/ MySQL/);
        assert.equal(f.spawns.length, 0, `дочерний Flux не запускается для ${new URL(address).protocol}`);
      }
    });
    await test('HTTP 503 и недоступный health заканчиваются таймаутом с очисткой', async () => {
      for (const requestHealth of [async () => ({ ...goodHealth, statusCode: 503 }), async () => { throw new Error(uri); }, () => new Promise(() => {})]) {
        const f = fixture({ requestHealth, startupTimeoutMs: 40 });
        await rejection(f, /не подтвердил подключение/); assert.equal(f.kills.length, 1);
      }
    });
    await test('Отмена запуска останавливает дочерний процесс и удаляет конфиг', async () => {
      const controller = new AbortController();
      const f = fixture({ requestHealth: async () => { controller.abort(); throw new Error(uri); } });
      f.options.signal = controller.signal;
      await rejection(f, /отменено/); assert.equal(f.kills.length, 1);
      const preCanceled = fixture(); preCanceled.options.signal = AbortSignal.abort();
      await rejection(preCanceled, /отменено/); assert.equal(preCanceled.spawns.length, 0);
    });
    await test('Отмена после подключения очищает конфиг и stop остаётся идемпотентным', async () => {
      const f = fixture(), controller = new AbortController(); f.options.signal = controller.signal;
      let unexpectedExits = 0; f.options.onUnexpectedExit = () => { unexpectedExits++; };
      const runtime = await startDatabaseRuntime(f.options, f.deps);
      controller.abort(); await runtime.stop(); await runtime.stop();
      assert.equal(f.kills.length, 1); assert.equal(unexpectedExits, 0); await clean();
    });
    await test('Аварийный выход готового сервера сообщает об отключении ровно один раз', async () => {
      const f = fixture(); let unexpectedExits = 0;
      f.options.onUnexpectedExit = () => { unexpectedExits++; };
      const runtime = await startDatabaseRuntime(f.options, f.deps);
      f.children[0].emit('error', new Error(uri));
      f.children[0].emit('error', new Error(uri));
      f.children[0].exitCode = 1; f.children[0].emit('exit', 1);
      await runtime.stop(); assert.equal(unexpectedExits, 1); await clean();
      const exited = fixture(); exited.options.onUnexpectedExit = () => { unexpectedExits++; };
      const exitedRuntime = await startDatabaseRuntime(exited.options, exited.deps);
      exited.children[0].exitCode = 1; exited.children[0].emit('exit', 1);
      await exitedRuntime.stop(); assert.equal(unexpectedExits, 2); await clean();
      const normal = fixture(); normal.options.onUnexpectedExit = () => { unexpectedExits++; };
      const second = await startDatabaseRuntime(normal.options, normal.deps);
      await second.stop(); assert.equal(unexpectedExits, 2); await clean();
      const startup = fixture(); startup.options.onUnexpectedExit = () => { unexpectedExits++; };
      startup.deps.requestHealth = async () => { startup.children[0].emit('error', new Error(uri)); return goodHealth; };
      await rejection(startup, /завершился/); assert.equal(unexpectedExits, 2);
    });
    await test('Ошибка запуска и аварийный exit не раскрывают stderr или URI', async () => {
      const spawnFailure = fixture({ spawn: () => { throw new Error(uri); } }); await rejection(spawnFailure);
      for (const event of ['error', 'exit']) {
        const f = fixture(); f.deps.requestHealth = async () => {
          f.children[0].emit(event, event === 'error' ? new Error(uri) : 1);
          return goodHealth;
        };
        await rejection(f, /завершился/); assert.equal(f.kills.length, 1);
      }
      const f = fixture(); const runtime = await startDatabaseRuntime(f.options, f.deps);
      f.children[0].exitCode = 1; f.children[0].emit('exit', 1);
      await runtime.stop(); await clean();
    });
    await test('Оборванный native dialog не блокирует отмену подключения', async () => {
      const f = fixture({ version: 'missing-version' }), controller = new AbortController();
      f.options.signal = controller.signal;
      f.options.dialog = { showOpenDialog: () => { controller.abort(); return new Promise(() => {}); } };
      await rejection(f, /отменено/); assert.equal(f.spawns.length, 0);
    });
    await test('Настоящий loopback HTTP health опрашивается без обращения к базе', async () => {
      const server = http.createServer((request, response) => {
        assert.equal(request.url, '/api/health');
        assert.equal(request.headers.authorization, undefined);
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(goodHealth.body));
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      try {
        const f = fixture({ allocatePort: async () => server.address().port, startupTimeoutMs: 1000 });
        delete f.deps.requestHealth;
        const runtime = await startDatabaseRuntime(f.options, f.deps);
        assert.equal(runtime.origin, `http://127.0.0.1:${server.address().port}`);
        await runtime.stop(); await clean();
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
    await test('Сессии получают разные каталоги, адрес базы не зависит от loopback-порта', async () => {
      const f = fixture(), g = fixture({ allocatePort: async () => 43211 });
      const first = await startDatabaseRuntime(f.options, f.deps), second = await startDatabaseRuntime(g.options, g.deps);
      try {
        assert.notEqual(f.spawns[0].options.env.VENT_APP_DATA, g.spawns[0].options.env.VENT_APP_DATA);
        assert.equal(first.display, second.display); assert.notEqual(first.origin, second.origin);
      } finally { await first.stop(); await second.stop(); }
      await clean();
    });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
  console.log(`${passed} проверок пройдено, ${failed} провалено`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(() => { console.error('✗ Не удалось завершить локальные проверки database runtime.'); process.exitCode = 1; });
