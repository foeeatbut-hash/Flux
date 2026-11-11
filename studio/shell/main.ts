/**
 * Оболочка Flux Studio: главное окно разработчика.
 *
 * Одна и та же оболочка собирается в обе программы. Разделы, которых нет у
 * разработчика, приходят в неё параметром `sections` из точки входа сборки
 * владельца; в сборке разработчика этого параметра просто нет, и кода этих
 * разделов в бандле нет тоже (scripts/check-studio-bundle.ts).
 */
import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, safeStorage } from 'electron';
import path from 'node:path';
import { startDatabaseRuntime } from '../shared/database-runtime.cjs';
import { createControlsEngine } from '../shared/controlsEngine';
import { MODULE_SCHEME } from '../../modules/protocol';
import { ownModules, signIn, StudioFailure, type StudioModule, type StudioUser } from './api';
import { ALL_ACTIONS, SHELL_ACTIONS, type DeveloperAction } from './actions';
import { DeveloperService } from './developer';
import { RememberedBase } from './remembered';
import { OwnerKeyLogin } from './ownerLogin';

declare const __STUDIO_VERSION__: string;
declare const __STUDIO_BUILD__: string;
declare const __STUDIO_NAME__: string;

export interface ShellSection { id: string; title: string; open: () => void | Promise<void> }

const ACTIONS = ALL_ACTIONS;
const PRODUCT_NAME = typeof __STUDIO_NAME__ === 'string' ? __STUDIO_NAME__ : 'Flux Studio';

/** Значок окна и панели задач — тот же файл, что значок exe (studio/build.cjs кладёт его рядом с main.cjs) */
const windowIcon = () => nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
type ShellAction = typeof SHELL_ACTIONS[number];

// Подпрограмма запускается в окне Studio тем же протоколом и в той же изоляции, что во Flux (modules/protocol.ts)
protocol.registerSchemesAsPrivileged([{ scheme: MODULE_SCHEME, privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: true } }]);

/** Файл рабочего потока лежит рядом с программой; из app.asar поток не запустить, поэтому он распакован */
const unpacked = (file: string) => file.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

export function startShell(sections: ShellSection[] = []): void {
  let win: BrowserWindow | null = null;
  let runtime: { origin: string; display: string; stop: () => Promise<void> } | null = null;
  let token = '';
  let user: StudioUser | null = null;
  let owner = false;
  let operation: AbortController | null = null;
  let warning = '';
  let developer: DeveloperService | null = null;
  let remembered: RememberedBase | null = null;
  const ownerKey = new OwnerKeyLogin(dialog);

  const snapshot = () => ({
    version: __STUDIO_VERSION__, build: __STUDIO_BUILD__,
    connected: !!runtime, display: runtime?.display || '', user, warning,
    remembered: remembered?.display() || '',
    // Разделы владельца видны только вошедшему владельцем: вошедший по логину разработчик их не получает
    sections: owner ? sections.map(({ id, title }) => ({ id, title })) : [],
  });
  const push = () => { if (win && !win.isDestroyed()) win.webContents.send('studio:state', snapshot()); };
  const progress = (phase: string) => { if (win && !win.isDestroyed()) win.webContents.send('studio:progress', { phase }); };

  /** Сбрасывает соединение и вход, не трогая текущую операцию: подключение к другой базе начинается с этого сброса, внутри своей же операции */
  const release = async () => {
    token = ''; user = null; owner = false; warning = '';
    ownerKey.forget();
    const previous = runtime; runtime = null;
    if (previous) await previous.stop().catch(() => {});
  };
  /** Отключение по просьбе человека: заодно прерывает долгую операцию (иначе подключение продолжило бы работу над сброшенным состоянием) */
  const disconnect = async () => {
    operation?.abort();
    await release();
  };
  /** Одна длинная операция за раз: второй щелчок не запускает вторую базу */
  const busy = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (operation) throw new StudioFailure('Дождитесь завершения текущей операции или отмените её.');
    const controller = new AbortController();
    operation = controller;
    try { return await fn(controller.signal); }
    finally { operation = null; progress(''); }
  };
  const text = (value: unknown, max: number): string => {
    if (typeof value !== 'string' || value.length > max) throw new StudioFailure('Некорректные данные формы.');
    return value;
  };

  const connectTo = (uri: string, remember: boolean) => busy(async signal => {
    // Не disconnect(): он прерывает текущую операцию, то есть само это подключение, и человек видел «Подключение к общей базе отменено»
    await release();
    runtime = await startDatabaseRuntime({
      uri, signal, dialog, parentWindow: win, onProgress: (phase: string) => progress(phase),
      onUnexpectedExit: () => { void disconnect().then(push); },
    });
    // Адрес с паролем запоминается только зашифрованным защищённым хранилищем; нет его — не запоминается вовсе
    if (remember) remembered?.save(uri, runtime.display);
    warning = developer ? await developer.warning(runtime.origin) : '';
    return snapshot();
  });

  const actions: Record<ShellAction, (args: any) => Promise<unknown>> = {
    state: async () => snapshot(),
    connect: async args => connectTo(text(args.uri, 4096).trim(), args.remember === true),
    connectRemembered: async () => {
      const uri = remembered?.load() || '';
      if (!uri) throw new StudioFailure('Сохранённого адреса нет или он не расшифровался на этом компьютере. Введите адрес заново.');
      return connectTo(uri, false);
    },
    forgetBase: async () => { remembered?.forget(); return snapshot(); },
    login: async args => busy(async signal => {
      if (!runtime) throw new StudioFailure('Сначала подключитесь к общей базе.');
      const signed = await signIn(runtime.origin, text(args.symbol, 200), text(args.password, 1024), signal);
      token = signed.token; user = signed.user; owner = signed.owner;
      return snapshot();
    }),
    ownerSelectKey: async () => {
      if (!win) throw new StudioFailure('Окно недоступно.');
      return ownerKey.select(win);
    },
    ownerLogin: async args => busy(async signal => {
      if (!runtime) throw new StudioFailure('Сначала подключитесь к общей базе.');
      const signed = await ownerKey.login(runtime.origin, text(args.password, 1024), signal);
      token = signed.token; user = signed.user; owner = signed.owner;
      return snapshot();
    }),
    logout: async () => { token = ''; user = null; owner = false; ownerKey.forget(); return snapshot(); },
    disconnect: async () => { await disconnect(); return snapshot(); },
    modules: async (): Promise<StudioModule[]> => {
      if (!runtime || !token) throw new StudioFailure('Войдите в Flux Studio.');
      return ownModules(runtime.origin, token);
    },
    openSection: async args => {
      const section = sections.find(item => item.id === args.id);
      if (!section) throw new StudioFailure('Раздел недоступен.');
      await section.open();
      return { opened: true };
    },
    cancel: async () => { operation?.abort(); return { canceled: true }; },
  };

  app.whenReady().then(() => {
    const dataDir = app.getPath('userData');
    remembered = new RememberedBase(dataDir, safeStorage);
    developer = new DeveloperService({
      dir: dataDir, storage: safeStorage, version: __STUDIO_VERSION__,
      session: () => runtime && token && user ? { origin: runtime.origin, token, user, owner } : null,
      assets: { templatesRoot: path.join(__dirname, 'templates'), runtimeDir: path.join(__dirname, 'runtime') },
      engine: createControlsEngine({ workerFile: unpacked(path.join(__dirname, 'controls-worker.cjs')) }),
      capture: async rect => (await win!.webContents.capturePage(rect)).toPNG(),
    });
    win = new BrowserWindow({
      width: 1280, height: 800, minWidth: 960, minHeight: 620, title: `${PRODUCT_NAME} ${__STUDIO_VERSION__}`,
      // Окно такое же, как у Flux: без системной рамки, кнопки окна рисует плавающая панелька (src/components/window)
      backgroundColor: '#0f172a', autoHideMenuBar: true, frame: false, titleBarStyle: 'hidden', hasShadow: true, roundedCorners: true, show: false,
      icon: windowIcon(),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
    });
    win.setMenu(null);
    // Показываем окно, когда страница готова: человек сразу видит стартовую заставку, а не белый экран
    win.once('ready-to-show', () => win?.show());
    win.on('maximize', () => win?.webContents.send('window:maximized-changed', true));
    win.on('unmaximize', () => win?.webContents.send('window:maximized-changed', false));
    const fromWindow = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => (win && event.sender === win.webContents ? win : null);
    ipcMain.on('window:minimize', event => { fromWindow(event)?.minimize(); });
    ipcMain.on('window:maximize', event => { const w = fromWindow(event); if (w) (w.isMaximized() ? w.unmaximize() : w.maximize()); });
    ipcMain.on('window:close', event => { fromWindow(event)?.close(); });
    ipcMain.handle('window:is-maximized', event => !!fromWindow(event)?.isMaximized());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    // CSP ограничивает ресурсы, но не самостоятельный переход iframe подпрограммы по ссылке
    win.webContents.on('will-frame-navigate', event => { if (event.frame?.url.startsWith(`${MODULE_SCHEME}:`)) event.preventDefault(); });
    protocol.handle(MODULE_SCHEME, request => {
      const asset = request.method === 'GET' ? developer?.asset(request.url) : null;
      return asset ? new Response(asset.body, { status: asset.status, headers: asset.headers }) : new Response(null, { status: 404 });
    });
    ipcMain.handle('studio:call', async (event, action: string, args: unknown) => {
      // Принимаем вызовы только из главного окна и только перечисленные действия
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !ACTIONS.includes(action)) {
        return { ok: false, error: 'Недоступное действие.' };
      }
      const given = args && typeof args === 'object' ? args as Record<string, any> : {};
      try {
        const value = (SHELL_ACTIONS as readonly string[]).includes(action)
          ? await actions[action as ShellAction](given)
          : await developer!.handle(action as DeveloperAction, given);
        return { ok: true, value };
      } catch (error: any) { return { ok: false, error: error instanceof StudioFailure ? error.message : String(error?.message || 'Операция не выполнена.').slice(0, 400) }; }
    });
    void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    win.on('closed', () => { win = null; });
  });
  app.on('window-all-closed', () => { void disconnect().finally(() => app.quit()); });
}
