/**
 * Оболочка Flux Studio: главное окно разработчика.
 *
 * Одна и та же оболочка собирается в обе программы. Разделы, которых нет у
 * разработчика, приходят в неё параметром `sections` из точки входа сборки
 * владельца; в сборке разработчика этого параметра просто нет, и кода этих
 * разделов в бандле нет тоже (scripts/check-studio-bundle.ts).
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { startDatabaseRuntime } from '../shared/database-runtime.cjs';
import { ownModules, signIn, StudioFailure, type StudioModule, type StudioUser } from './api';

declare const __STUDIO_VERSION__: string;
declare const __STUDIO_BUILD__: string;

export interface ShellSection { id: string; title: string; open: () => void | Promise<void> }

const ACTIONS = ['state', 'connect', 'login', 'logout', 'disconnect', 'modules', 'openSection', 'cancel'] as const;
type Action = typeof ACTIONS[number];

export function startShell(sections: ShellSection[] = []): void {
  let win: BrowserWindow | null = null;
  let runtime: { origin: string; display: string; stop: () => Promise<void> } | null = null;
  let token = '';
  let user: StudioUser | null = null;
  let operation: AbortController | null = null;

  const snapshot = () => ({
    version: __STUDIO_VERSION__, build: __STUDIO_BUILD__,
    connected: !!runtime, display: runtime?.display || '', user,
    sections: sections.map(({ id, title }) => ({ id, title })),
  });
  const push = () => { if (win && !win.isDestroyed()) win.webContents.send('studio:state', snapshot()); };
  const progress = (phase: string) => { if (win && !win.isDestroyed()) win.webContents.send('studio:progress', { phase }); };

  const disconnect = async () => {
    operation?.abort();
    token = ''; user = null;
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

  const actions: Record<Action, (args: any) => Promise<unknown>> = {
    state: async () => snapshot(),
    // Адрес базы содержит пароль, поэтому нигде не сохраняется: после закрытия его вводят снова
    connect: async args => busy(async signal => {
      await disconnect();
      const uri = text(args.uri, 4096).trim();
      runtime = await startDatabaseRuntime({
        uri, signal, dialog, parentWindow: win, onProgress: (phase: string) => progress(phase),
        onUnexpectedExit: () => { void disconnect().then(push); },
      });
      return snapshot();
    }),
    login: async args => busy(async signal => {
      if (!runtime) throw new StudioFailure('Сначала подключитесь к общей базе.');
      const signed = await signIn(runtime.origin, text(args.symbol, 200), text(args.password, 1024), signal);
      token = signed.token; user = signed.user;
      return snapshot();
    }),
    logout: async () => { token = ''; user = null; return snapshot(); },
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
    win = new BrowserWindow({
      width: 1180, height: 800, minWidth: 880, minHeight: 600, title: `Flux Studio ${__STUDIO_VERSION__}`,
      backgroundColor: '#0f172a', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
    });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    ipcMain.handle('studio:call', async (event, action: string, args: unknown) => {
      // Принимаем вызовы только из главного окна и только перечисленные действия
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !(ACTIONS as readonly string[]).includes(action)) {
        return { ok: false, error: 'Недоступное действие.' };
      }
      try { return { ok: true, value: await actions[action as Action](args && typeof args === 'object' ? args : {}) }; }
      catch (error: any) { return { ok: false, error: error instanceof StudioFailure ? error.message : String(error?.message || 'Операция не выполнена.').slice(0, 400) }; }
    });
    void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    win.on('closed', () => { win = null; });
  });
  app.on('window-all-closed', () => { void disconnect().finally(() => app.quit()); });
}
