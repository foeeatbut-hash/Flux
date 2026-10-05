'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const fluxVersion = require('../../../package.json').version;

class RuntimeError extends Error {}
const failure = message => new RuntimeError(message);
const canceled = () => failure('Подключение к общей базе отменено.');

function parseDatabaseUri(value) {
  try {
    if (typeof value !== 'string' || value.length > 4096 || /[\\#\u0000-\u0020\u007f]/.test(value) || /%(?![\da-fA-F]{2})/.test(value)) throw new Error();
    const url = new URL(value);
    const dialect = { 'mysql:': 'mysql', 'mariadb:': 'mysql' }[url.protocol];
    const username = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!dialect || !url.hostname || !username || !password || !database || url.hash ||
        /[\u0000-\u001f\u007f]/.test(username + password + database) || database.includes('/') ||
        (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535))) throw new Error();
    for (const [name, value] of url.searchParams) if (name !== 'ssl' || !['true', 'false'].includes(value)) throw new Error();
    const port = url.port || '3306';
    return { uri: url.toString(), dialect, display: `MariaDB / MySQL · ${url.hostname}:${port}/${database}` };
  } catch {
    throw failure('Введите адрес общей MariaDB / MySQL в формате mysql:// или mariadb:// с пользователем, паролем и именем базы.');
  }
}

async function inspectExecutable(file, fileSystem) {
  if (typeof file !== 'string' || !/\.exe$/i.test(file)) throw failure('Выберите portable Flux в формате EXE.');
  const stat = await fileSystem.stat(file);
  if (!stat.isFile() || stat.size < 1024) throw failure('Выбранный файл не является portable Flux EXE.');
  const handle = await fileSystem.open(file, 'r');
  try {
    const magic = Buffer.alloc(2);
    const { bytesRead } = await handle.read(magic, 0, 2, 0);
    if (bytesRead !== 2 || magic.toString('ascii') !== 'MZ') throw failure('Выбранный файл не является portable Flux EXE.');
  } finally { await handle.close(); }
  return file;
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function requestHealth(port, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/health', agent: false, signal }, response => {
      let text = '', size = 0;
      response.setEncoding('utf8');
      response.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > 65536) request.destroy(new Error('Health response too large'));
        else text += chunk;
      });
      response.once('error', reject);
      response.once('end', () => {
        let body;
        try { body = JSON.parse(text); } catch { body = null; }
        resolve({ statusCode: response.statusCode, body });
      });
    });
    request.once('error', reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Health timeout')));
  });
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function terminateChild(child, deps) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;
  if (child.exitCode !== null || child.signalCode) return;
  if (deps.platform === 'win32') {
    await new Promise((resolve, reject) => {
      deps.execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, error => {
        if (!error || child.exitCode !== null || child.signalCode) resolve();
        else { try { child.kill(); } catch {} reject(failure('Не удалось остановить локальный сервер Flux. Закройте его перед повторным подключением.')); }
      });
    });
    return;
  }
  await new Promise(resolve => {
    const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} done(); }, 1000);
    child.once('exit', done);
    try { child.kill('SIGTERM'); } catch { done(); }
  });
}

// Зависимости заменяются в локальных проверках; приложение использует Node и диалог Electron.
async function startDatabaseRuntime({ uri, signal, dialog, parentWindow, onProgress, onUnexpectedExit, onEvent } = {}, overrides = {}) {
  const startedAt=Date.now();
  const record=(event,details={})=>{try{onEvent?.(`runtime.${event}`,{elapsedMs:Date.now()-startedAt,...details});}catch{}};
  const database = parseDatabaseUri(uri);
  record('uri.validated',{dialect:database.dialect});
  const deps = { fs, env: process.env, platform: process.platform, tmpdir: os.tmpdir(), version: fluxVersion,
    spawn, execFile, allocatePort, requestHealth, startupTimeoutMs: 120000, pollMs: 250, requestTimeoutMs: 2000, ...overrides };
  const controller = new AbortController();
  let child, folder, stopping, ready = false, unexpectedExitNotified = false, deadline;
  const abort = () => controller.abort(canceled());
  const check = () => { if (controller.signal.aborted) throw controller.signal.reason; };
  const stop = () => {
    if (stopping) return stopping;
    stopping = Promise.resolve().then(async () => {
      record('stop.start');
      try { await terminateChild(child, deps); }
      finally { if (folder) await deps.fs.rm(folder, { recursive: true, force: true });record('stop.complete'); }
    });
    controller.abort(canceled());
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
    return stopping;
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    check();
    onProgress?.('Подключение к общей базе', 0, 0);
    let file;
    if (deps.env.PORTABLE_EXECUTABLE_DIR) {
      const candidate = path.join(deps.env.PORTABLE_EXECUTABLE_DIR, `Flux-${deps.version}-x64.exe`);
      try { await deps.fs.stat(candidate); file = candidate; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if(!file){
        const entries=await deps.fs.readdir(deps.env.PORTABLE_EXECUTABLE_DIR);
        const candidates=entries.filter(name=>/^Flux-\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?-x64\.exe$/i.test(name));
        if(candidates.length===1)file=path.join(deps.env.PORTABLE_EXECUTABLE_DIR,candidates[0]);
        record('executable.search',{candidateCount:candidates.length,selected:!!file});
      }
    }
    check();
    if (!file) {
      if (!dialog?.showOpenDialog) throw failure('Выберите portable Flux EXE для подключения к общей базе.');
      const options = { title: 'Выберите portable Flux (Flux*.exe)', properties: ['openFile'], filters: [{ name: 'Portable Flux', extensions: ['exe'] }] };
      const selection = await abortable(parentWindow ? dialog.showOpenDialog(parentWindow, options) : dialog.showOpenDialog(options), controller.signal);
      if (selection.canceled || !selection.filePaths?.[0]) throw canceled();
      file = selection.filePaths[0];
    }
    await inspectExecutable(file, deps.fs);
    record('executable.validated',{name:path.basename(file)});
    check();
    folder = await deps.fs.mkdtemp(path.join(deps.tmpdir, 'flux-owner-db-'));
    await deps.fs.writeFile(path.join(folder, 'config.json'), JSON.stringify({ current_db_type: 'REMOTE', database_url: database.uri }), { mode: 0o600 });
    record('config.created');
    check();
    const port = await deps.allocatePort();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    check();
    const env = { ...deps.env, VENT_APP_DATA: folder, PORT: String(port), FLUX_LISTEN_HOST: '127.0.0.1' };
    // Переменные загрузчика Owner относятся к другому EXE и не должны передаваться Flux.
    delete env.PORTABLE_EXECUTABLE_DIR;
    delete env.PORTABLE_EXECUTABLE_FILE;
    child = deps.spawn(file, ['--flux-company-server'], { windowsHide: true, env, stdio: ['ignore','pipe','pipe'] });
    record('process.spawned',{pid:child.pid,port});
    // Регистрируем только коды ошибок и объём вывода: строки дочернего процесса
    // могут содержать SQL или реквизиты и не должны попадать в журнал Owner.
    for(const name of ['stdout','stderr'])child[name]?.on('data',chunk=>{const text=String(chunk);const codes=[...new Set(text.match(/\b(?:P\d{4}|EACCES|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ER_[A-Z_]{3,50})\b/g)||[])];if(codes.length)record('process.diagnostic',{stream:name,codes});});
    deadline = setTimeout(() => {record('startup.timeout');controller.abort(failure('Локальный обработчик Flux не подтвердил подключение к общей БД за две минуты. Проверьте журнал, права и доступность базы.'));}, deps.startupTimeoutMs);
    const childFailed = (code,childSignal) => {
      record('process.exit',{ready,code:typeof code==='number'?code:code?.code??null,signal:childSignal??null});
      const unexpected = ready && !stopping && !unexpectedExitNotified;
      if (unexpected) unexpectedExitNotified = true;
      controller.abort(failure('Локальный сервер Flux завершился. Проверьте portable EXE и доступность общей базы.'));
      if (unexpected) {
        try { Promise.resolve(onUnexpectedExit?.()).catch(() => {}); } catch {}
      }
      if (ready) void stop().catch(() => {});
    };
    child.on('error', childFailed);
    child.once('exit', childFailed);
    const origin = `http://127.0.0.1:${port}`;
    let polls=0;
    for (;;) {
      check();
      let health;
      try { health = await abortable(deps.requestHealth(port, controller.signal, deps.requestTimeoutMs), controller.signal); }
      catch(error) {if(++polls===1||polls%20===0)record('health.retry',{attempt:polls,code:error?.code??null});check(); }
      check();
      if (health?.statusCode === 200 && health.body?.ok === true) {
        if (health.body.databaseMode !== 'REMOTE' || health.body.dialect !== database.dialect) {
          throw failure('Flux не подтвердил подключение к указанной общей базе. Обновите portable Flux и проверьте настройки.');
        }
        clearTimeout(deadline);
        ready = true;
        record('health.ready',{version:health.body.version,databaseMode:health.body.databaseMode,dialect:health.body.dialect});
        controller.signal.addEventListener('abort', () => { void stop().catch(() => {}); }, { once: true });
        return { origin, display: database.display, stop };
      }
      await wait(deps.pollMs, controller.signal);
    }
  } catch (error) {
    record('startup.failure',{error});
    try { await stop(); } catch (cleanupError) { throw cleanupError instanceof RuntimeError ? cleanupError : failure('Не удалось завершить локальное подключение Flux.'); }
    throw error instanceof RuntimeError ? error : failure('Не удалось подключиться к общей базе. Проверьте portable Flux EXE, адрес и доступность базы.');
  }
}

module.exports = { startDatabaseRuntime, parseDatabaseUri };
