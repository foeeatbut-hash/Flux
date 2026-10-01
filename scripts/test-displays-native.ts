import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';

async function main() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-displays-test-'));
  const handlers = new Map<string, (...args: any[]) => any>();
  const app = Object.assign(new EventEmitter(), { getPath: () => data });
  let monitors = [
    { id: 1, label: 'Основной', scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { id: 2, label: 'Левый', scaleFactor: 1.5, bounds: { x: -1280, y: -200, width: 1280, height: 1024 }, workArea: { x: -1280, y: -200, width: 1280, height: 984 } },
  ];
  const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => monitors, getPrimaryDisplay: () => monitors[0] });
  class Window extends EventEmitter {
    id = 1;
    sent: any[] = [];
    webContents = { send: (...args: any[]) => this.sent.push(args) };
    bounds = { x: 100, y: 100, width: 1280, height: 800 };
    normal = { ...this.bounds };
    minimum = [960, 620];
    movable = true; resizable = true; maximized = false; fullscreen = false;
    isDestroyed() { return false; }
    getNormalBounds() { return { ...this.normal }; }
    getBounds() { return { ...this.bounds }; }
    isMovable() { return this.movable; }
    isResizable() { return this.resizable; }
    isMaximized() { return this.maximized; }
    isFullScreen() { return this.fullscreen; }
    getMinimumSize() { return this.minimum; }
    setMinimumSize(w: number, h: number) { this.minimum = [w, h]; }
    setFullScreen(v: boolean) { this.fullscreen = v; }
    setMovable(v: boolean) { this.movable = v; }
    setResizable(v: boolean) { this.resizable = v; }
    maximize() { this.maximized = true; }
    unmaximize() { this.maximized = false; }
    setBounds(r: any) { this.bounds = { ...r }; this.emit('resize'); this.emit('move'); }
  }
  const win = new Window();
  let trusted = true;
  let count = 0;
  const check = (label: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, label); count++; console.log(`✓ ${label}`); };
  try {
    const bundled = await build({ entryPoints: ['electron/displays.ts'], bundle: true, write: false,
      platform: 'node', format: 'cjs', plugins: [{ name: 'electron-fixture', setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }));
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents:
          'export const { app, screen, ipcMain } = globalThis.__mock;', loader: 'js' }));
      } }] });
    const module = { exports: {} as any };
    vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, require,
      __mock: { app, screen, ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn) } } });
    const api = module.exports.setupDisplayWorkspace(() => win, () => trusted);
    api.attach();
    const event = { sender: win.webContents };
    const get = () => handlers.get('workspace:displays-get')!(event);
    const set = (value: unknown) => handlers.get('workspace:displays-set')!(event, value);
    check('По умолчанию обычное окно', get().enabled, false);
    check('Число и DPI мониторов не потеряны', get().mixedScale, true);
    set(true);
    check('Native bounds включают левый экран и отрицательную высоту', win.bounds, { x: -1280, y: -200, width: 3200, height: 1280 });
    check('Режим временно снимает ограничение минимального размера', win.minimum, [1, 1]);
    check('Native перемещение в общем режиме отключено', win.movable, false);
    check('Режим сохраняется отдельно от ключей и БД', JSON.parse(fs.readFileSync(path.join(data, 'display-workspace.json'), 'utf8')), { allMonitors: true });
    monitors = [monitors[0]];
    screen.emit('display-removed');
    check('Отключение экрана пересчитывает native bounds', win.bounds, { x: 0, y: 0, width: 1920, height: 1080 });
    check('После hotplug renderer получает новый состав экранов', win.sent.at(-1)?.[1]?.displays.length, 1);
    set(false);
    check('Обычный размер и положение возвращаются', win.bounds, { x: 100, y: 100, width: 1280, height: 800 });
    check('Минимальный размер восстанавливается', win.minimum, [960, 620]);
    check('В обычном режиме снова можно менять размер', win.resizable, true);
    assert.throws(() => set('true'), /Неверный/); count++;
    trusted = false;
    assert.throws(get, /только главному/); count++;
    trusted = true;
    assert.throws(() => handlers.get('workspace:displays-get')!({ sender: {} }), /только главному/); count++;
    monitors = [{ ...monitors[0], bounds: { x: 0, y: 0, width: 40000, height: 1080 } }];
    assert.throws(() => set(true), /превышает/); count++;
    check('Недопустимое общее окно не меняет действующий режим', get().enabled, false);
    app.emit('will-quit');
    check('При выходе системные подписки удалены', screen.listenerCount('display-removed'), 0);
    console.log(`\nПроверено ${count} сценариев native-интеграции мониторов.`);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
