/**
 * Оболочка Flux Studio: главное окно разработчика.
 *
 * Одна и та же оболочка собирается в обе программы. Разделы, которых нет у
 * разработчика, приходят в неё параметром `sections` из точки входа сборки
 * владельца; в сборке разработчика этого параметра просто нет, и кода этих
 * разделов в бандле нет тоже (scripts/check-studio-bundle.ts).
 */
import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage } from 'electron';
import path from 'node:path';
import { startDatabaseRuntime } from '../shared/database-runtime.cjs';
import { createControlsEngine } from '../shared/controlsEngine';
import { MODULE_SCHEME, pageNavigationAllowed } from '../../modules/protocol';
import { ownModules, signIn, StudioFailure, type StudioModule, type StudioUser } from './api';
import { ALL_ACTIONS, SHELL_ACTIONS, type DeveloperAction } from './actions';
import { DeveloperService } from './developer';
import { RememberedBase } from './remembered';

declare const __STUDIO_VERSION__: string;
declare const __STUDIO_BUILD__: string;

export interface ShellSection { id: string; title: string; open: () => void | Promise<void> }

const ACTIONS = ALL_ACTIONS;
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

  const snapshot = () => ({
    version: __STUDIO_VERSION__, build: __STUDIO_BUILD__,
    connected: !!runtime, display: runtime?.display || '', user, warning,
    remembered: remembered?.display() || '',
    sections: sections.map(({ id, title }) => ({ id, title })),
  });
  const push = () => { if (win && !win.isDestroyed()) win.webContents.send('studio:state', snapshot()); };
  const progress = (phase: string) => { if (win && !win.isDestroyed()) win.webContents.send('studio:progress', { phase }); };

  const disconnect = async () => {
    operation?.abort();
    token = ''; user = null; owner = false; warning = '';
    const previous = runtime; runtime = null;
    if (previous) await previous.stop().catch(() => {});
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
    await disconnect();
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
    logout: async () => { token = ''; user = null; owner = false; return snapshot(); },
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
      width: 1180, height: 800, minWidth: 880, minHeight: 600, title: `Flux Studio ${__STUDIO_VERSION__}`,
      backgroundColor: '#0f172a', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
    });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    // CSP ограничивает ресурсы, но не самостоятельный переход iframe подпрограммы по ссылке
    // Страницы программы-приложения (договор v2) переходят друг на друга внутри пакета — как во Flux
    win.webContents.on('will-frame-navigate', event => { if (event.frame?.url.startsWith(`${MODULE_SCHEME}:`) && !pageNavigationAllowed(event.frame.url, event.url)) event.preventDefault(); });
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
