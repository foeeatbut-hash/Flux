/**
 * Модуль «electron» для главных процессов редакторов GenOffice на сервере Flux.
 *
 * Главный процесс Таблицы и PDF написан для Electron: регистрирует
 * обработчики `ipcMain.handle(канал, (event, …))`, различает окна по
 * `event.sender.id`, пишет файлы по путям. Сервер Flux собирает его как есть
 * (tools/genoffice/build.mjs), подменив «electron» этим файлом:
 *   - ipcMain — реестр обработчиков; сервер вызывает их через `__flux.invoke`;
 *   - окно (WebContents) — сеанс одного окна Flux: `send` уходит в окно по
 *     сокету (`__flux.onSend`);
 *   - диалоги отвечают «отменено»: открыть и «сохранить как» — через Flux;
 *   - сеть, меню, экран, системные уведомления — пустышки: на сервере их нет,
 *     и наружу редакторы ходить не должны (flux-data-safety, правило 8).
 */
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Handler = (event: any, ...args: any[]) => any;
type Sink = (wcId: number, channel: string, args: unknown[]) => void;

const handlers = new Map<string, Handler>();
const onHandlers = new Map<string, Set<Handler>>();
const contents = new Map<number, FakeWebContents>();
const sinks = new Set<Sink>();
let nextId = 1;

class FakeWebContents extends EventEmitter {
  id = nextId++;
  private dead = false;
  session = { on() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  constructor() { super(); contents.set(this.id, this); }
  send(channel: string, ...args: unknown[]) { if (!this.dead) for (const s of sinks) s(this.id, channel, args); }
  isDestroyed() { return this.dead; }
  destroy() { if (this.dead) return; this.dead = true; contents.delete(this.id); this.emit('destroyed'); }
  close() { this.destroy(); }
  setWindowOpenHandler() {}
  loadURL() { return Promise.resolve(); }
  loadFile() { return Promise.resolve(); }
  getURL() { return ''; }
  getTitle() { return ''; }
  focus() {}
  isFocused() { return false; }
  executeJavaScript() { return Promise.resolve(undefined); }
  setZoomFactor() {}
  getZoomFactor() { return 1; }
  print(_o?: unknown, cb?: (ok: boolean, why: string) => void) { cb?.(false, 'Печать — через Flux'); }
  printToPDF() { return Promise.reject(new Error('Печать в PDF на сервере недоступна')); }
  capturePage() { return Promise.reject(new Error('Снимок окна на сервере недоступен')); }
  getOwnerBrowserWindow() { return null; }
}

export class WebContentsView extends EventEmitter {
  webContents = new FakeWebContents();
  setBounds() {}
  getBounds() { return { x: 0, y: 0, width: 0, height: 0 }; }
  setVisible() {}
  setBackgroundColor() {}
}

export class BrowserWindow extends EventEmitter {
  static fromWebContents() { return null; }
  static getAllWindows() { return []; }
  static getFocusedWindow() { return null; }
  static fromId() { return null; }
  webContents = new FakeWebContents();
  contentView = { addChildView() {}, removeChildView() {}, children: [] };
  id = this.webContents.id;
  loadURL() { return Promise.resolve(); }
  loadFile() { return Promise.resolve(); }
  show() {}
  hide() {}
  close() { this.webContents.destroy(); this.emit('closed'); }
  destroy() { this.close(); }
  isDestroyed() { return this.webContents.isDestroyed(); }
  focus() {}
  setTitle() {}
  getTitle() { return ''; }
  isMaximized() { return false; }
  isMinimized() { return false; }
  getBounds() { return { x: 0, y: 0, width: 1280, height: 800 }; }
  setBounds() {}
  getContentBounds() { return this.getBounds(); }
  setMenu() {}
  setMenuBarVisibility() {}
}

export const ipcMain = {
  handle(channel: string, fn: Handler) { handlers.set(channel, fn); },
  handleOnce(channel: string, fn: Handler) { handlers.set(channel, fn); },
  removeHandler(channel: string) { handlers.delete(channel); },
  on(channel: string, fn: Handler) {
    if (!onHandlers.has(channel)) onHandlers.set(channel, new Set());
    onHandlers.get(channel)!.add(fn);
    return ipcMain;
  },
  once(channel: string, fn: Handler) {
    const wrap: Handler = (...a) => { ipcMain.removeListener(channel, wrap); return fn(...a); };
    return ipcMain.on(channel, wrap);
  },
  removeListener(channel: string, fn: Handler) { onHandlers.get(channel)?.delete(fn); return ipcMain; },
  removeAllListeners(channel?: string) { if (channel) onHandlers.delete(channel); else onHandlers.clear(); return ipcMain; },
};

const base = () => join(tmpdir(), 'flux-genoffice');
export const app = {
  name: 'Flux Office',
  isPackaged: false,
  getPath: (name: string) => join(base(), name),
  getAppPath: () => base(),
  getVersion: () => '0.0.0',
  getName: () => 'Flux Office',
  getLocale: () => 'ru',
  getSystemLocale: () => 'ru-RU',
  getPreferredSystemLanguages: () => ['ru-RU'],
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  on() { return app; },
  once() { return app; },
  off() { return app; },
  quit() {},
  exit() {},
  focus() {},
  setAppUserModelId() {},
  requestSingleInstanceLock: () => true,
  addRecentDocument() {},
  clearRecentDocuments() {},
  commandLine: { appendSwitch() {}, hasSwitch: () => false, getSwitchValue: () => '' },
};

export const dialog = {
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showSaveDialogSync: () => undefined,
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showOpenDialogSync: () => undefined,
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showMessageBoxSync: () => 0,
  showErrorBox() {},
};

export const shell = {
  openExternal: async () => {},
  openPath: async () => 'Открытие файлов на сервере недоступно',
  showItemInFolder() {},
  trashItem: async () => {},
  beep() {},
};

const emptyImage = (buf: Buffer = Buffer.alloc(0)) => ({
  toPNG: () => buf, toJPEG: () => buf, toBitmap: () => buf, toDataURL: () => '',
  getSize: () => ({ width: 0, height: 0 }), isEmpty: () => buf.length === 0,
  resize() { return this; }, crop() { return this; }, getAspectRatio: () => 1,
});
export const nativeImage = {
  createFromBuffer: (b: Buffer) => emptyImage(b),
  createFromPath: () => emptyImage(),
  createFromDataURL: () => emptyImage(),
  createEmpty: () => emptyImage(),
};

export const Menu = {
  buildFromTemplate: () => ({ popup() {}, closePopup() {}, items: [], append() {} }),
  setApplicationMenu() {},
  getApplicationMenu: () => null,
};
export class MenuItem { constructor(public options: unknown) {} }
export const net = { fetch: () => Promise.reject(new Error('Во Flux Office это отключено: программа работает без внешних сервисов')), request() { throw new Error('offline'); } };
export const screen = {
  getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
  getAllDisplays: () => [],
  getDisplayMatching: () => screen.getPrimaryDisplay(),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  on() {},
};
export const session = { defaultSession: { on() {}, setPermissionRequestHandler() {}, webRequest: { onBeforeRequest() {} }, protocol: { handle() {} } }, fromPartition: () => session.defaultSession };
export const protocol = { registerSchemesAsPrivileged() {}, handle() {}, unhandle() {}, isProtocolHandled: () => false };
export const systemPreferences = { getAccentColor: () => '', on() {}, isDarkMode: () => false, getUserDefault: () => '' };
export const nativeTheme = { shouldUseDarkColors: false, themeSource: 'system', on() {} };
export const clipboard = { writeText() {}, readText: () => '', write() {}, readImage: () => emptyImage(), writeImage() {} };
export const Notification = class { static isSupported() { return false; } show() {} on() {} };
export const powerMonitor = { on() {} };
export const powerSaveBlocker = { start: () => 0, stop() {} };
export const desktopCapturer = { getSources: async () => [] };
export const webContents = { getAllWebContents: () => Array.from(contents.values()), fromId: (id: number) => contents.get(id) || null, getFocusedWebContents: () => null };
export const utilityProcess = { fork() { throw new Error('Отдельные процессы на сервере недоступны'); } };
export const crashReporter = { start() {} };
export const autoUpdater = { on() {}, checkForUpdates() {} };
export const globalShortcut = { register() {}, unregister() {}, unregisterAll() {} };
export const Tray = class {};
export const TouchBar = class {};
// Кусочки окна, которые главный процесс подтягивает через общие пакеты
// (electron-utils/drop-open): на сервере им нечего делать
export const ipcRenderer = { invoke: async () => undefined, send() {}, on() {}, removeListener() {} };
export const webUtils = { getPathForFile: () => '' };
export const contextBridge = { exposeInMainWorld() {} };

/** Хозяйство сервера Flux: вызвать обработчик окна, слушать его «send» */
export const __flux = {
  /** Новое окно (без редактора) — для главных процессов, что ждут WebContents */
  makeWebContents: () => new FakeWebContents(),
  webContents: (id: number) => contents.get(id) || null,
  async invoke(wcId: number, channel: string, args: unknown[]) {
    const wc = contents.get(wcId);
    const fn = handlers.get(channel);
    if (!wc) throw new Error('Окно редактора закрыто');
    if (!fn) throw new Error(`Нет обработчика «${channel}»`);
    return fn({ sender: wc, senderFrame: { url: '' }, processId: 0, frameId: 0 }, ...args);
  },
  send(wcId: number, channel: string, args: unknown[]) {
    const wc = contents.get(wcId);
    if (!wc) return;
    const event = { sender: wc, senderFrame: { url: '' }, returnValue: undefined, reply() {} };
    for (const fn of Array.from(onHandlers.get(channel) || [])) { try { fn(event, ...args); } catch (_) {} }
  },
  onSend(fn: Sink) { sinks.add(fn); return () => sinks.delete(fn); },
  destroy(wcId: number) { contents.get(wcId)?.destroy(); },
  channels: () => Array.from(handlers.keys()),
};

export default {
  app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, nativeImage, Menu, MenuItem, net, screen, session,
  protocol, systemPreferences, nativeTheme, clipboard, Notification, powerMonitor, powerSaveBlocker, desktopCapturer,
  webContents, utilityProcess, crashReporter, autoUpdater, globalShortcut, Tray, TouchBar, ipcRenderer, webUtils, contextBridge, __flux,
};
