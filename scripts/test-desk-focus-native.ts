/**
 * «Окна Flux вместе с окнами Windows», простой вариант (docs/roadmap/windows-layer.md):
 * модель (когда окно активируемо), главный процесс на подставном Electron
 * (порядок вызовов, выключатель, доверие IPC, частота) и все пути «намеренно
 * вперёд». Реальный Windows здесь не проверяется — см. раздел «Проверка
 * владельцем» в windows-layer.md.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import { isEmptyDeskTarget, windowFocusable, DESK_POINTER_MIN_INTERVAL_MS } from '../workspace/deskFocus';

let count = 0;
// Объекты из vm-контекста имеют чужие прототипы: сравниваем по JSON.
const plain = (v: unknown) => v === undefined ? v : JSON.parse(JSON.stringify(v));
const check = (label: string, actual: unknown, expected: unknown) => { assert.deepEqual(plain(actual), expected, label); count++; console.log(`✓ ${label}`); };

/** Несколько файлов в одном пакете делят состояние модулей, как в настоящем main.js. */
async function load(entry: string | string[], mock: Record<string, unknown>, platform = 'win32') {
  const entries = Array.isArray(entry) ? entry : [entry];
  const bundled = await build({ stdin: { contents: entries.map(e => `export * from ${JSON.stringify('./' + e.replace(/\.ts$/, ''))};`).join('\n'),
    resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'electron-fixture', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents:
        'export const { app, ipcMain, globalShortcut } = globalThis.__mock;', loader: 'js' }));
    } }] });
  const module = { exports: {} as any };
  vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, require, process: { platform }, setTimeout, clearTimeout, __mock: mock });
  return module.exports;
}

class Window extends EventEmitter {
  id = 1;
  log: string[] = [];
  focusable: boolean[] = [];
  sent: any[] = [];
  webContents = { send: (...a: any[]) => this.sent.push(a) };
  active = false; visible = true; minimized = false; destroyed = false;
  isDestroyed() { return this.destroyed; }
  isFocused() { return this.active; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  setFocusable(v: boolean) { this.focusable.push(v); this.log.push(`setFocusable(${v})`); }
  restore() { this.minimized = false; this.log.push('restore'); }
  show() { this.visible = true; this.log.push('show'); }
  focus() { this.active = true; this.log.push('focus'); }
}

function model() {
  const base = { platform: 'win32', enabled: true, windowShown: true, windowActive: false, pointerOverDesk: true };
  check('Модель: неактивное окно, указатель над пустым столом — неактивируемо', windowFocusable(base), false);
  check('Модель: указатель над чем-то другим — активируемо', windowFocusable({ ...base, pointerOverDesk: false }), true);
  check('Модель: активное окно всегда активируемо', windowFocusable({ ...base, windowActive: true }), true);
  check('Модель: свёрнутое или скрытое окно активируемо', windowFocusable({ ...base, windowShown: false }), true);
  check('Модель: выключатель снят — прежнее поведение', windowFocusable({ ...base, enabled: false }), true);
  check('Модель: не Windows — режим не включается', ['linux', 'darwin'].map(platform => windowFocusable({ ...base, platform })), [true, true]);
  // Признак пустого стола окна — тот же, что у рамки выделения.
  const el = (inDesk: boolean, item: boolean) => ({ closest: (sel: string) =>
    sel === '[data-flux-desk]' ? (inDesk ? {} : null) : (item ? {} : null) });
  check('Окно: пустое место стола', isEmptyDeskTarget(el(true, false)), true);
  check('Окно: значок или кнопка на столе', isEmptyDeskTarget(el(true, true)), false);
  check('Окно: окно раздела, панель, Пуск (вне стола)', isEmptyDeskTarget(el(false, false)), false);
  check('Окно: нет цели', [isEmptyDeskTarget(null), isEmptyDeskTarget(undefined), isEmptyDeskTarget({} as any)], [false, false, false]);
}

async function controller() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-desk-focus-'));
  try {
    const prefsFile = path.join(dir, 'display-workspace.json');
    const handlers = new Map<string, (...a: any[]) => any>();
    const listeners = new Map<string, (...a: any[]) => any>();
    const ipcMain = { handle: (n: string, f: any) => handlers.set(n, f), on: (n: string, f: any) => listeners.set(n, f) };
    let t = 1000;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let seq = 0;
    const advance = (ms: number) => {
      t += ms;
      for (const x of [...timers].filter(x => x.at <= t).sort((a, b) => a.at - b.at)) { timers.splice(timers.indexOf(x), 1); x.fn(); }
    };
    // Спокойный промежуток: отложенное значение применилось и интервал вышел.
    const calm = () => { advance(DESK_POINTER_MIN_INTERVAL_MS * 2); advance(DESK_POINTER_MIN_INTERVAL_MS * 2); };
    const win = new Window();
    let trusted = true;
    const boot = async (platform: string) => {
      handlers.clear(); listeners.clear();
      const m = await load('electron/deskFocus.ts', { ipcMain });
      return m.setupDeskFocus({ getMainWindow: () => win, isTrusted: () => trusted, prefsFile, platform,
        now: () => t, schedule: (fn: () => void, ms: number) => { const id = ++seq; timers.push({ at: t + ms, fn, id }); return id; },
        cancel: (id: number) => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); } });
    };
    const event = { sender: win.webContents };
    const pointer = (v: unknown, ev: any = event) => listeners.get('workspace:desk-pointer')!(ev, v);
    const get = () => handlers.get('workspace:desk-get')!(event);
    const set = (v: unknown, ev: any = event) => handlers.get('workspace:desk-set')!(ev, v);

    const api = await boot('win32');
    api.attach();
    check('Состояние: на Windows доступно и включено по умолчанию', get(), { available: true, enabled: true });
    win.active = true;
    pointer(true);
    calm();
    check('Активное окно: указатель над столом ничего не меняет', win.focusable, []);
    win.active = false; win.emit('blur');
    check('Потеря активности без наведения на стол: окно обычное (повтор true не доходит до Electron)', win.focusable, []);
    calm();
    pointer(true);
    check('Неактивное окно, указатель над пустым столом: setFocusable(false)', win.focusable, [false]);
    pointer(true); calm(); pointer(true);
    check('Повтор того же значения не доходит до Electron', win.focusable, [false]);
    calm();
    pointer(false);
    check('Указатель ушёл на окно раздела или панель: setFocusable(true)', win.focusable, [false, true]);
    calm();
    pointer(true);
    win.active = true; win.emit('focus');
    check('Окно стало активным: снова активируемо', win.focusable, [false, true, false, true]);
    win.active = false; win.emit('blur');
    check('Блур сбрасывает «над столом»: окно не остаётся неактивируемым вслепую', win.focusable.length, 4);
    calm();
    pointer(true);
    win.minimized = true; win.emit('minimize');
    check('Свёрнутое окно активируемо, даже если указатель «над столом»', win.focusable.at(-1), true);
    win.minimized = false; win.emit('restore');
    check('После разворота снова следует за указателем', win.focusable.at(-1), false);
    calm();
    pointer(false);

    // Доверие и значение.
    const before = win.focusable.length;
    calm();
    pointer(true, { sender: {} });
    trusted = false; pointer(true); trusted = true;
    for (const bad of ['true', 1, null, undefined, {}, [true]]) pointer(bad);
    calm();
    check('Сигнал не от главного окна, без доверия или не boolean отбрасывается', win.focusable.length, before);
    assert.throws(() => handlers.get('workspace:desk-get')!({ sender: {} }), /только главному/); count++;
    trusted = false; assert.throws(get, /только главному/); assert.throws(() => set(false), /только главному/); trusted = true; count++;
    assert.throws(() => set('false'), /Неверное/); assert.throws(() => set(1), /Неверное/); count++;
    check('Отказы настроек не меняют состояние', get(), { available: true, enabled: true });

    // Частота: сотня переключений за интервал — одно применение сразу, последнее значение позже.
    advance(DESK_POINTER_MIN_INTERVAL_MS * 2);
    const start = win.focusable.length;
    pointer(true);
    for (let i = 0; i < 100; i++) pointer(i % 2 === 0);
    check('Частота: за один интервал в Electron уходит не больше одного вызова', win.focusable.length - start <= 1, true);
    advance(DESK_POINTER_MIN_INTERVAL_MS);
    check('Частота: последнее значение применяется по истечении интервала (99 → false, активируемо)', win.focusable.at(-1), true);
    check('Частота: после серии окно не зависло на устаревшем значении', timers.length, 0);
    let rate = 0; const marks: number[] = [];
    const wasLen = win.focusable.length;
    for (let i = 0; i < 40; i++) { pointer(i % 2 === 0); advance(10); }
    calm();
    rate = win.focusable.length - wasLen;
    check('Частота: 40 переключений за 0,4 с — не больше ~20 в секунду (8 + хвост)', rate <= 9, true); void marks;

    // Выключатель.
    win.active = false; calm(); pointer(true); calm();
    check('Перед выключением окно неактивируемо', win.focusable.at(-1), false);
    check('Выключатель: «выключено» возвращает окну активируемость', set(false), { available: true, enabled: false });
    check('Выключатель: окно активируемо', win.focusable.at(-1), true);
    const off = win.focusable.length;
    calm(); pointer(true); pointer(false); calm();
    check('Выключено: слежение не ведётся, Electron не дёргается', win.focusable.length, off);
    check('Выключатель хранится рядом с настройками мониторов', JSON.parse(fs.readFileSync(prefsFile, 'utf8')), { allMonitors: false, deskStaysBack: false });
    const api2 = await boot('win32'); api2.attach();
    check('Выключатель переживает перезапуск', get(), { available: true, enabled: false });
    set(true);
    check('Включение снова сохраняется без лишнего ключа', JSON.parse(fs.readFileSync(prefsFile, 'utf8')), { allMonitors: false });
    check('Включено вручную: слежение возобновилось', get(), { available: true, enabled: true });

    // Не Windows.
    const win2 = new Window(); win2.id = 2;
    handlers.clear(); listeners.clear();
    const m2 = await load('electron/deskFocus.ts', { ipcMain }, 'linux');
    const api3 = m2.setupDeskFocus({ getMainWindow: () => win2, isTrusted: () => true, prefsFile, platform: 'linux', now: () => t });
    api3.attach();
    const ev2 = { sender: win2.webContents };
    check('Не Windows: режим недоступен', handlers.get('workspace:desk-get')!(ev2), { available: false, enabled: false });
    assert.throws(() => handlers.get('workspace:desk-set')!(ev2, true), /только в Windows/); count++;
    listeners.get('workspace:desk-pointer')!(ev2, true); win2.emit('blur');
    check('Не Windows: setFocusable не вызывается вовсе', win2.focusable, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function forward() {
  // Общая функция «намеренно вперёд»: окно сначала активируемо, потом show/focus.
  const fg = await load('electron/windowForeground.ts', {});
  const win = new Window(); win.minimized = true; win.visible = false;
  fg.applyFocusable(win, false); fg.applyFocusable(win, false);
  check('applyFocusable: повтор значения не доходит до окна', win.focusable, [false]);
  fg.bringToFront(win);
  check('bringToFront: сначала активируемо, затем restore, show, focus', win.log, ['setFocusable(false)', 'setFocusable(true)', 'restore', 'show', 'focus']);
  fg.bringToFront(win);
  check('bringToFront без нужды не дёргает setFocusable', win.log.filter(x => x.startsWith('setFocusable')).length, 2);
  win.destroyed = true;
  fg.bringToFront(win); fg.bringToFront(null);
  check('bringToFront: уничтоженное окно и null не падают', win.log.length, 7);

  // Ctrl+Alt+D — настоящий модуль на подставном globalShortcut.
  let shortcut: (() => void) | undefined;
  const globalShortcut = { register: (_a: string, fn: () => void) => { shortcut = fn; return true; }, unregister() {} };
  const app = Object.assign(new EventEmitter(), { once: () => {} });
  const drafts = await load(['electron/draftsShortcut.ts', 'electron/windowForeground.ts'], { app, globalShortcut });
  const w2 = new Window(); w2.minimized = true;
  drafts.applyFocusable(w2, false); w2.log.length = 0;
  drafts.setupDraftsShortcut(() => w2);
  shortcut!();
  check('Ctrl+Alt+D: окно активируемо до show/focus и получает «drafts:toggle»',
    [w2.log, w2.sent.map((x: any) => x[0])], [['setFocusable(true)', 'restore', 'show', 'focus'], ['drafts:toggle']]);
}

/** Остальные пути вперёд — трей, уведомление, повторный запуск, запуск — не поднять без Electron: проверяем исходники. */
function sources() {
  const read = (f: string) => fs.readFileSync(f, 'latin1');
  const capture = read('electron/capture.ts'), main = read('electron/main.ts'), drafts = read('electron/draftsShortcut.ts');
  check('Трей и возврат после захвата: три пути идут через bringToFront', (capture.match(/bringToFront\(m\)/g) || []).length, 3);
  check('В трее и после захвата нет прямого show/focus главного окна', /\bm\.(show|focus)\(\)/.test(capture), false);
  check('main.ts: запуск, повторный запуск и уведомление — через bringToFront', (main.match(/bringToFront\(mainWindow\)/g) || []).length, 3);
  check('main.ts: нет прямого show/focus/restore главного окна', /mainWindow\.(show|focus|restore)\(\)/.test(main), false);
  check('Ctrl+Alt+D: нет прямого show/focus', /\.(show|focus)\(\)/.test(drafts), false);
}

async function main() {
  model();
  await controller();
  await forward();
  sources();
  console.log(`\nПроверено ${count} сценариев «окон Flux вместе с окнами Windows».`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
