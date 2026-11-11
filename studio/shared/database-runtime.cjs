'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const fluxVersion = require('../../package.json').version;

class RuntimeError extends Error {}
const failure = message => new RuntimeError(message);
/** Только настоящая отмена человеком; остальные отказы называют свою причину */
const canceled = () => failure('Подключение к общей базе отменено.');

/** Адрес не разобран: что именно не так, сказано словами, но без самого адреса (в нём пароль) */
const addressFailure = reason => failure(`Адрес базы не подходит: ${reason} Образец: mysql://ПОЛЬЗОВАТЕЛЬ:ПАРОЛЬ@сервер:3306/база.`);

function parseDatabaseUri(value) {
  if (typeof value !== 'string' || !value.trim()) throw addressFailure('он пуст.');
  if (value.length > 4096) throw addressFailure('он слишком длинный.');
  if (/[\\#\u0000-\u0020\u007f]/.test(value) || /%(?![\da-fA-F]{2})/.test(value)) {
    throw addressFailure('в нём есть пробел, «\\», «#» или некорректная последовательность «%». Специальные знаки пароля записываются как %XX.');
  }
  let url;
  try { url = new URL(value); }
  catch {
    // URL не принимает порт вне 0–65535: это самая частая опечатка, скажем о ней прямо
    const port = /@[^/@]*:([^/@:]*)(?:\/|$)/.exec(value)?.[1];
    if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw addressFailure('порт должен быть числом от 1 до 65535.');
    throw addressFailure('он не разбирается как адрес.');
  }
  const dialect = { 'mysql:': 'mysql', 'mariadb:': 'mysql' }[url.protocol];
  if (!dialect) throw addressFailure(`адрес должен начинаться с mysql:// или mariadb:// (сейчас «${url.protocol.replace(/:$/, '')}://»).`);
  if (!url.hostname) throw addressFailure('не указан сервер базы (после «@»).');
  let username, password, database;
  try { username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); database = decodeURIComponent(url.pathname.slice(1)); }
  catch { throw addressFailure('в нём некорректная последовательность «%».'); }
  if (!username || !password) throw addressFailure('не указан пользователь или пароль базы.');
  if (!database || database.includes('/')) throw addressFailure('не указано имя базы (после последней «/»).');
  if (/[\u0000-\u001f\u007f]/.test(username + password + database) || url.hash) throw addressFailure('в нём есть недопустимые знаки.');
  if (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) throw addressFailure('порт должен быть числом от 1 до 65535.');
  for (const [name, flag] of url.searchParams) if (name !== 'ssl' || !['true', 'false'].includes(flag)) throw addressFailure('из параметров поддерживается только ssl=true или ssl=false.');
  const port = url.port || '3306';
  return { uri: url.toString(), dialect, display: `MariaDB / MySQL · ${url.hostname}:${port}/${database}` };
}

/** Строка из журнала Flux для человека: без адресов и паролей, одной строкой, не длиннее 160 знаков */
function logLine(text) {
  const line = String(text).split(/\r?\n/).map(part => part.trim()).filter(Boolean).pop() || '';
  return line.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[адрес скрыт]').replace(/(password|passwd|pwd|token|secret)\s*[=:]\s*\S+/gi, '$1=[скрыто]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
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
      const expected = `Flux-${deps.version}-x64.exe`;
      const where = deps.env.PORTABLE_EXECUTABLE_DIR ? `рядом со Studio (в папке ${deps.env.PORTABLE_EXECUTABLE_DIR})` : 'рядом со Studio';
      const notFound = `Не найден Flux ${where}: нужен файл ${expected}. Положите его в одну папку с этой программой и подключитесь снова или выберите файл вручную.`;
      if (!dialog?.showOpenDialog) throw failure(notFound);
      const options = { title: 'Выберите portable Flux (Flux*.exe)', properties: ['openFile'], filters: [{ name: 'Portable Flux', extensions: ['exe'] }] };
      const selection = await abortable(parentWindow ? dialog.showOpenDialog(parentWindow, options) : dialog.showOpenDialog(options), controller.signal);
      // Окно выбора закрыто без выбора: не «отмена вообще», а понятная причина, что делать
      if (selection.canceled || !selection.filePaths?.[0]) throw failure(`${notFound} Файл не выбран, подключение не выполнено.`);
      file = selection.filePaths[0];
    }
    await inspectExecutable(file, deps.fs);
    record('executable.validated',{name:path.basename(file)});
    check();
    folder = await deps.fs.mkdtemp(path.join(deps.tmpdir, 'flux-studio-db-'));
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
    try { child = deps.spawn(file, ['--flux-company-server'], { windowsHide: true, env, stdio: ['ignore','pipe','pipe'] }); }
    catch (error) { throw failure(`Windows не дал запустить Flux${error?.code ? ` (${error.code})` : ''}. Проверьте права на папку и антивирус, затем запустите ${path.basename(file)} вручную: если он не открывается, проблема в самом Flux.`); }
    record('process.spawned',{pid:child.pid,port});
    // В журнал Owner попадают только коды ошибок и объём вывода: строки дочернего процесса могут содержать SQL или
    // реквизиты. Последнюю строку (без адресов и паролей) оставляем только для сообщения человеку об отказе запуска.
    let lastLine = '';
    for(const name of ['stdout','stderr'])child[name]?.on('data',chunk=>{const text=String(chunk);const mine=logLine(text);if(mine)lastLine=mine;const codes=[...new Set(text.match(/\b(?:P\d{4}|EACCES|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ER_[A-Z_]{3,50})\b/g)||[])];if(codes.length)record('process.diagnostic',{stream:name,codes});});
    deadline = setTimeout(() => {record('startup.timeout');controller.abort(failure(`Flux запустился, но за две минуты не подтвердил подключение к базе${lastHealth ? ` (последний ответ проверки: ${lastHealth})` : ' (проверка /api/health не отвечала)'}. Проверьте, что сервер базы доступен с этого компьютера: адрес, порт, брандмауэр.`));}, deps.startupTimeoutMs);
    let lastHealth = '';
    const childFailed = (code,childSignal) => {
      record('process.exit',{ready,code:typeof code==='number'?code:code?.code??null,signal:childSignal??null});
      const unexpected = ready && !stopping && !unexpectedExitNotified;
      if (unexpected) unexpectedExitNotified = true;
      let reason;
      if (ready) reason = failure('Локальный сервер Flux завершился. Проверьте portable EXE и доступность общей базы.');
      else if (code instanceof Error) reason = failure(`Windows не дал запустить Flux${code.code ? ` (${code.code})` : ''}. Проверьте права на папку и антивирус, затем запустите ${path.basename(file)} вручную.`);
      else reason = failure(`Flux не запустился: процесс завершился${typeof code === 'number' ? ` с кодом ${code}` : childSignal ? ` (сигнал ${childSignal})` : ''}${lastLine ? `. Последняя строка его журнала: «${lastLine}»` : ''}. Запустите ${path.basename(file)} вручную: если он не открывается, проблема в самом Flux (версия, антивирус, права).`);
      controller.abort(reason);
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
      if (health) lastHealth = `${health.statusCode}${health.body?.code ? ` ${String(health.body.code).slice(0, 60)}` : ''}`;
      // Flux поднялся, но сам сообщает, что база недоступна: ждать две минуты нечего
      if (health?.statusCode === 503 && /^(REMOTE|LOCAL)_DATABASE_UNAVAILABLE$/.test(String(health.body?.code || ''))) {
        const said = logLine(health.body?.error || '');
        throw failure(`Flux запустился, но база не ответила${said ? `: «${said}»` : ''}. Проверьте адрес, порт, пользователя и пароль базы, а также что сервер базы доступен с этого компьютера.`);
      }
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
    throw error instanceof RuntimeError ? error : failure('Не удалось подключиться к общей базе: непредвиденная ошибка при запуске Flux. Проверьте portable Flux EXE, адрес и доступность базы.');
  }
}

module.exports = { startDatabaseRuntime, parseDatabaseUri };
