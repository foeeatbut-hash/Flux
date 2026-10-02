import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const WINDOW_CLOSE_CONFIRM = 'window:close-confirm';

async function main() {
  const handlers = new Map<string, Function>();
  const timers: { callback: () => void; cleared: boolean }[] = [];
  const dialogs: { resolve: (value: { response: number }) => void }[] = [];
  class MockWindow extends EventEmitter {
    id = 1; destroyed = false; messages: unknown[][] = [];
    webContents = Object.assign(new EventEmitter(), { send: (...args: unknown[]) => this.messages.push(args) });
    isDestroyed() { return this.destroyed; }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault: () => { prevented = true; } });
      if (!prevented) { this.destroyed = true; this.emit('closed'); }
    }
  }
  const win = new MockWindow();
  const electron = {
    ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) },
    dialog: { showMessageBox: () => new Promise(resolve => dialogs.push({ resolve })) },
  };
  const bundled = await build({ entryPoints: ['electron/windowClose.ts'], bundle: true, write: false,
    platform: 'node', format: 'cjs', external: ['electron', 'node:crypto'] });
  const mod = { exports: {} as any };
  const require = createRequire(import.meta.url);
  vm.runInNewContext(bundled.outputFiles[0].text, { module: mod, exports: mod.exports,
    require: (name: string) => name === 'electron' ? electron : require(name),
    setTimeout: (callback: () => void) => { timers.push({ callback, cleared: false }); return timers.length; },
    clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  });
  const trusted = (event: any) => event.trusted === true;
  const { approveClose } = mod.exports.setupMainWindowClose(() => win, trusted);
  const call = (event: any, token: unknown, allowed: unknown) => handlers.get(WINDOW_CLOSE_CONFIRM)!(event, token, allowed);
  const own = { trusted: true, sender: win.webContents };
  const request = () => { win.close(); return win.messages.at(-1)?.[1] as string; };
  const tick = async () => { while (timers.some(t => !t.cleared)) { const timer = timers.find(t => !t.cleared)!; timer.cleared = true; timer.callback(); await Promise.resolve(); } };

  const readOnly = request();
  assert.equal(await call(own, readOnly, true), true);
  assert.equal(win.destroyed, true, 'Подтверждение read-only окна закрывает его');

  const rejectedWindow = new MockWindow();
  // Отдельная установка нужна, потому что закрытый WebContents уже завершён.
  handlers.clear(); timers.length = 0; dialogs.length = 0;
  const rejectedMod = { exports: {} as any };
  vm.runInNewContext(bundled.outputFiles[0].text, { module: rejectedMod, exports: rejectedMod.exports,
    require: (name: string) => name === 'electron' ? electron : require(name),
    setTimeout: (callback: () => void) => { timers.push({ callback, cleared: false }); return timers.length; },
    clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  });
  rejectedMod.exports.setupMainWindowClose(() => rejectedWindow, trusted);
  const rejectedEvent = { trusted: true, sender: rejectedWindow.webContents };
  rejectedWindow.close(); const rejectedToken = rejectedWindow.messages[0][1];
  assert.equal(await handlers.get(WINDOW_CLOSE_CONFIRM)!({ trusted: false, sender: rejectedWindow.webContents }, rejectedToken, true), false);
  assert.equal(await handlers.get(WINDOW_CLOSE_CONFIRM)!(rejectedEvent, 'stale-token', true), false);
  assert.equal(await handlers.get(WINDOW_CLOSE_CONFIRM)!(rejectedEvent, rejectedToken, false), false);
  assert.equal(rejectedWindow.destroyed, false, 'Чужой, устаревший или отрицательный ответ не закрывает окно');

  // Ответ на preflight закрытия подтверждает проверку, но оставляет окно
  // живым: помощнику обновления ещё нужна основная программа для запуска.
  const preflightWindow = new MockWindow(); handlers.clear(); timers.length = 0;
  const preflightMod = { exports: {} as any };
  vm.runInNewContext(bundled.outputFiles[0].text, { module: preflightMod, exports: preflightMod.exports,
    require: (name: string) => name === 'electron' ? electron : require(name),
    setTimeout: (callback: () => void) => { timers.push({ callback, cleared: false }); return timers.length; },
    clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  });
  const preflight = preflightMod.exports.setupMainWindowClose(() => preflightWindow, trusted);
  const approval = preflight.approveClose();
  const approvalToken = preflightWindow.messages[0][1];
  assert.equal(await handlers.get(WINDOW_CLOSE_CONFIRM)!({ trusted: true, sender: preflightWindow.webContents }, approvalToken, true), true);
  assert.equal(await approval, true);
  assert.equal(preflightWindow.destroyed, false, 'Предварительное одобрение обновления не уничтожает окно');

  const fallbackWindow = new MockWindow(); handlers.clear(); timers.length = 0; dialogs.length = 0;
  const fallbackMod = { exports: {} as any };
  vm.runInNewContext(bundled.outputFiles[0].text, { module: fallbackMod, exports: fallbackMod.exports,
    require: (name: string) => name === 'electron' ? electron : require(name),
    setTimeout: (callback: () => void) => { timers.push({ callback, cleared: false }); return timers.length; },
    clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  });
  fallbackMod.exports.setupMainWindowClose(() => fallbackWindow, trusted);
  fallbackWindow.close(); await tick();
  assert.equal(dialogs.length, 1, 'Молчание renderer открывает явный системный вопрос');
  dialogs[0].resolve({ response: 0 }); await Promise.resolve(); await Promise.resolve();
  assert.equal(fallbackWindow.destroyed, false, 'Выбор оставить открытым сохраняет окно');

  const failedWindow = new MockWindow(); handlers.clear(); timers.length = 0;
  const failedElectron = { ...electron, dialog: { showMessageBox: async () => { throw new Error('dialog unavailable'); } } };
  const failedMod = { exports: {} as any };
  vm.runInNewContext(bundled.outputFiles[0].text, { module: failedMod, exports: failedMod.exports,
    require: (name: string) => name === 'electron' ? failedElectron : require(name),
    setTimeout: (callback: () => void) => { timers.push({ callback, cleared: false }); return timers.length; },
    clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  });
  const failed = failedMod.exports.setupMainWindowClose(() => failedWindow, trusted);
  const failedApproval = failed.approveClose();
  await tick(); await Promise.resolve();
  assert.equal(await failedApproval, false, 'Сбой системного вопроса отклоняет preflight вместо вечного ожидания');
  assert.equal(failedWindow.destroyed, false, 'Сбой системного вопроса не уничтожает окно');
  console.log('✓ Главный крестик ждёт ответ, отвергает недоверенные и просроченные токены, сохраняет отказ, а обновление проверяет закрытие без уничтожения окна и имеет безопасный запасной вопрос');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
