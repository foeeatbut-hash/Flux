/**
 * Проверяет, что серверный режим Flux не занимает блокировку GUI.
 * Транспилирует настоящий electron/main.ts, но не запускает Electron: его API
 * заменяется короткими заглушками, а whenReady намеренно никогда не завершается.
 * Запуск: node --import tsx scripts/test-process-mode.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { parseApplyArgs } from '../electron/updates';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../electron/main.ts'), 'utf8');
const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node22' }).code;

function launch(argv: string[], lockGranted: boolean) {
  const calls = { lock: 0, quit: 0, events: [] as string[] };
  const app = {
    requestSingleInstanceLock() { calls.lock++; return lockGranted; },
    quit() { calls.quit++; },
    on(event: string) { calls.events.push(event); },
    whenReady() { return new Promise<void>(() => {}); },
  };
  const electron = { app };
  const module = { exports: {} as Record<string, unknown> };
  const context = {
    require: (name: string) => {
      if (name === 'electron') return electron;
      if (name === 'path') return path;
      if (name === './updates') return { parseApplyArgs };
      return {};
    },
    module,
    exports: module.exports,
    process: { argv, env: {}, platform: 'win32', resourcesPath: '' },
    __dirname: path.join(here, '../electron'),
    console,
    Buffer,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(compiled, context, { filename: 'electron/main.ts' });
  return calls;
}

const gui = launch(['Flux.exe'], false);
assert.equal(gui.lock, 1, 'обычный GUI запрашивает единственную блокировку');
assert.equal(gui.quit, 1, 'GUI завершается, когда блокировка занята');

const companyServer = launch(['Flux.exe', '--flux-company-server'], false);
assert.equal(companyServer.lock, 0, 'локальный API не запрашивает GUI-блокировку');
assert.equal(companyServer.quit, 0, 'занятый GUI не завершает серверный режим');

const applyArgs = ['Flux.exe', '--flux-apply-update', 'C:\\Flux.exe', '--flux-wait-pid', '123'];
const apply = launch(applyArgs, false);
assert.ok(parseApplyArgs(applyArgs), 'сценарий действительно распознаётся как apply');
assert.equal(apply.lock, 0, 'режим применения обновления проходит мимо блокировки');
assert.equal(apply.quit, 0, 'режим применения обновления не завершает сам себя из-за блокировки');

console.log('Все проверки режимов запуска main.ts пройдены');
