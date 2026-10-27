import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import { BAR_H } from '../src/lib/metrics';
import { localDisplayAreas, workspaceFrame, type DisplayWorkspace } from '../workspace/displays';

async function main() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-displays-test-'));
  fs.writeFileSync(path.join(data, 'display-workspace.json'), JSON.stringify({ allMonitors: false, showWindowsTaskbar: false }));
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
    shape: any[] = [];
    movable = true; resizable = true; maximized = false; fullscreen = false;
    shadow = true;
    setBoundsCalls = 0;
    // Имитация Windows при дробном масштабе: окно получает не ровно то, что просили.
    drift = { x: 0, y: 0, width: 0, height: 0 };
    shapeCalls = 0;
    isDestroyed() { return false; }
    getNormalBounds() { return { ...this.normal }; }
    getBounds() { return { ...this.bounds }; }
    isMovable() { return this.movable; }
    isResizable() { return this.resizable; }
    isMaximized() { return this.maximized; }
    isFullScreen() { return this.fullscreen; }
    getMinimumSize() { return this.minimum; }
    setMinimumSize(w: number, h: number) { this.minimum = [w, h]; }
    setShape(rectangles: any[]) { this.shapeCalls++; this.shape = JSON.parse(JSON.stringify(rectangles)); }
    setHasShadow(value: boolean) { this.shadow = value; }
    setFullScreen(v: boolean) { this.fullscreen = v; }
    setMovable(v: boolean) { this.movable = v; }
    setResizable(v: boolean) { this.resizable = v; }
    maximize() { this.maximized = true; }
    unmaximize() { this.maximized = false; }
    setBounds(r: any) {
      this.setBoundsCalls++;
      this.bounds = { x: r.x + this.drift.x, y: r.y + this.drift.y, width: r.width + this.drift.width, height: r.height + this.drift.height };
      this.emit('resize'); this.emit('move');
    }
  }
  const win = new Window();
  let trusted = true;
  const records: any[] = [];
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
    vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, require, process: { platform: 'win32' },
      __mock: { app, screen, ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn) } } });
    const api = module.exports.setupDisplayWorkspace(() => win, () => trusted,
      (name: string, fields: any) => records.push({ name, ...fields }));
    api.attach();
    const event = { sender: win.webContents };
    const get = () => handlers.get('workspace:displays-get')!(event);
    const set = (value: unknown) => handlers.get('workspace:displays-set')!(event, value);
    check('По умолчанию обычное окно', get().enabled, false);
    check('Старое значение скрытия панели не попадает в состояние', 'showWindowsTaskbar' in get(), false);
    check('Число и DPI мониторов не потеряны', get().mixedScale, true);
    set(true);
    check('Окно стоит на охвате рабочих областей, а не границ мониторов', win.bounds, { x: -1280, y: -200, width: 3200, height: 1240 });
    check('Нативная форма оставляет Пуск и промежутки мониторов доступными Windows', win.shape, [
      { x: 1280, y: 200, width: 1920, height: 1040 }, { x: 0, y: 0, width: 1280, height: 984 },
    ]);
    check('Режим временно снимает ограничение минимального размера', win.minimum, [1, 1]);
    check('Native перемещение в общем режиме отключено', win.movable, false);
    check('Тень отключается на общем HWND, чтобы не попадать на панель Windows', win.shadow, false);
    check('Режим сохраняется отдельно от ключей и БД', JSON.parse(fs.readFileSync(path.join(data, 'display-workspace.json'), 'utf8')), { allMonitors: true });
    monitors[0] = { ...monitors[0], workArea: { x: 48, y: 0, width: 1872, height: 1080 } };
    screen.emit('display-metrics-changed');
    check('Вертикальная панель Windows тоже не закрывается окном Flux', win.shape[0], { x: 1328, y: 200, width: 1872, height: 1080 });
    check('Вертикальная панель Windows остаётся вне окна по ширине', win.bounds, { x: -1280, y: -200, width: 3200, height: 1280 });

    // Сценарии геометрии: окно, форма и положение панели Flux (локальные координаты окна).
    const scenario = (label: string, list: any[], expected: { bounds: any; shape: any[]; bars: Record<number, number>; bars_x?: Record<number, [number, number]> }) => {
      monitors = list;
      screen.emit('display-metrics-changed');
      check(`${label}: границы окна`, win.bounds, expected.bounds);
      check(`${label}: форма окна`, win.shape, expected.shape);
      const workspace = get() as DisplayWorkspace;
      const areas = localDisplayAreas(workspace, 0);
      const bars = Object.fromEntries(areas.map(d => [d.id, d.workArea.y + d.workArea.h - BAR_H]));
      check(`${label}: панель Flux у нижнего края workArea каждого монитора`, bars, expected.bars);
      // Панель Flux не вылезает за окно и не заходит на системную панель Windows.
      for (const d of areas) {
        assert.ok(d.workArea.y >= 0 && d.workArea.x >= 0 && d.workArea.x + d.workArea.w <= win.bounds.width
          && d.workArea.y + d.workArea.h <= win.bounds.height, `${label}: workArea ${d.id} внутри окна`); count++;
      }
    };
    scenario('Два монитора одной высоты, панель Windows снизу', [
      { id: 1, label: 'A', scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
      { id: 2, label: 'B', scaleFactor: 1, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } },
    ], { bounds: { x: 0, y: 0, width: 3840, height: 1040 }, shape: [], bars: { 1: 1040 - BAR_H, 2: 1040 - BAR_H } });
    check('Прямоугольное объединение не требует формы окна', workspaceFrame(get().displays.map((d: any) => d)).exact, true);
    scenario('Мониторы разной высоты', [
      { id: 1, label: 'A', scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
      { id: 2, label: 'B', scaleFactor: 1, bounds: { x: 1920, y: 0, width: 1280, height: 1024 }, workArea: { x: 1920, y: 0, width: 1280, height: 984 } },
    ], { bounds: { x: 0, y: 0, width: 3200, height: 1040 },
      shape: [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1280, height: 984 }], bars: { 1: 1040 - BAR_H, 2: 984 - BAR_H } });
    scenario('Монитор смещён по вертикали', [
      { id: 1, label: 'A', scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
      { id: 2, label: 'B', scaleFactor: 1, bounds: { x: 1920, y: 300, width: 1920, height: 1080 }, workArea: { x: 1920, y: 300, width: 1920, height: 1040 } },
    ], { bounds: { x: 0, y: 0, width: 3840, height: 1340 },
      shape: [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 300, width: 1920, height: 1040 }], bars: { 1: 1040 - BAR_H, 2: 1340 - BAR_H } });
    scenario('Масштаб 125 % (DIP), шов округления в 1 px', [
      { id: 1, label: 'A', scaleFactor: 1.25, bounds: { x: 0, y: 0, width: 1536, height: 864 }, workArea: { x: 0, y: 0, width: 1536, height: 824 } },
      { id: 2, label: 'B', scaleFactor: 1.25, bounds: { x: 1536, y: 0, width: 1536, height: 864 }, workArea: { x: 1536, y: 1, width: 1536, height: 823 } },
    ], { bounds: { x: 0, y: 0, width: 3072, height: 824 }, shape: [], bars: { 1: 824 - BAR_H, 2: 824 - BAR_H } });

    // Подгонка по кругу: округление Windows на 1 px не вызывает повторный setBounds.
    win.drift = { x: 0, y: 0, width: -1, height: 1 };
    monitors = [{ ...monitors[0], workArea: { x: 0, y: 0, width: 1500, height: 800 } }];
    let before = win.setBoundsCalls;
    screen.emit('display-metrics-changed');
    check('Одна подгонка при смене мониторов', win.setBoundsCalls - before, 1);
    before = win.setBoundsCalls;
    for (let i = 0; i < 5; i++) { win.emit('resize'); win.emit('move'); }
    check('Округление на 1 px не вызывает новую подгонку', win.setBoundsCalls - before, 0);
    // Windows упорно возвращает другие границы: не больше трёх попыток, дальше — запись в журнал.
    win.drift = { x: 0, y: 50, width: 0, height: 0 };
    monitors = [{ ...monitors[0], workArea: { x: 0, y: 0, width: 1600, height: 900 } }];
    before = win.setBoundsCalls;
    screen.emit('display-metrics-changed');
    for (let i = 0; i < 20; i++) { win.emit('resize'); win.emit('move'); }
    check('Подгонка по кругу ограничена тремя попытками', win.setBoundsCalls - before, 3);
    check('Отказ от подгонки записан в журнал', records.some(r => r.trigger === 'give-up' && r.action === 'window'), true);
    win.drift = { x: 0, y: 0, width: 0, height: 0 };
    check('Журнал: каждый монитор записан с границами, workArea и масштабом',
      records.filter(r => r.trigger === 'enable' && r.action === 'monitor').map(r => [r.id, r.scalePct, r.x, r.w, r.ax, r.ah]),
      [[1, 100, 0, 1920, 0, 1040], [2, 150, -1280, 1280, -1280, 984]]);
    const enableWindow = records.find(r => r.trigger === 'enable' && r.action === 'window');
    check('Журнал: желаемые и фактические границы окна и форма при включении',
      [enableWindow.x, enableWindow.y, enableWindow.w, enableWindow.h, enableWindow.aw, enableWindow.ah, enableWindow.exact, enableWindow.shapes],
      [-1280, -200, 3200, 1240, 3200, 1240, false, 2]);
    check('Журнал: смена мониторов тоже записана', records.some(r => r.trigger === 'display-metrics' && r.action === 'monitor'), true);
    monitors = [{ id: 1, label: 'Основной', scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 48, y: 0, width: 1872, height: 1080 } },
      { id: 2, label: 'Левый', scaleFactor: 1.5, bounds: { x: -1280, y: -200, width: 1280, height: 1024 }, workArea: { x: -1280, y: -200, width: 1280, height: 984 } }];
    screen.emit('display-metrics-changed');
    monitors = [monitors[0]];
    screen.emit('display-removed');
    check('Отключение экрана пересчитывает native bounds', win.bounds, { x: 48, y: 0, width: 1872, height: 1080 });
    check('После hotplug renderer получает новый состав экранов', win.sent.at(-1)?.[1]?.displays.length, 1);
    set(false);
    check('Обычное окно восстанавливает полную нативную форму', win.shape, []);
    check('Обычный режим возвращает внешнюю тень окна', win.shadow, true);
    check('Выключение общего режима сохраняется отдельно от ключей и БД', JSON.parse(fs.readFileSync(path.join(data, 'display-workspace.json'), 'utf8')), { allMonitors: false });
    check('Обычный размер и положение возвращаются', win.bounds, { x: 100, y: 100, width: 1280, height: 800 });
    check('Минимальный размер восстанавливается', win.minimum, [960, 620]);
    check('В обычном режиме снова можно менять размер', win.resizable, true);
    assert.throws(() => set('true'), /Неверный/); count++;
    trusted = false;
    assert.throws(get, /только главному/); count++;
    trusted = true;
    assert.throws(() => handlers.get('workspace:displays-get')!({ sender: {} }), /только главному/); count++;
    monitors = [{ ...monitors[0], bounds: { x: 0, y: 0, width: 40000, height: 1080 }, workArea: { x: 0, y: 0, width: 40000, height: 1040 } }];
    assert.throws(() => set(true), /превышает/); count++;
    check('Недопустимое общее окно не меняет действующий режим', get().enabled, false);
    app.emit('will-quit');
    check('При выходе системные подписки удалены', screen.listenerCount('display-removed'), 0);
    console.log(`\nПроверено ${count} сценариев native-интеграции мониторов.`);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
