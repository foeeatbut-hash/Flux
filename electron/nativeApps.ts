import { app, BrowserWindow, dialog, ipcMain, screen, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  internalAppHref, NATIVE_APP_OPEN, NATIVE_APP_LIST, NATIVE_APP_ACTION, NATIVE_APP_CHANGED,
  NATIVE_APP_CLOSE_REQUEST, NATIVE_APP_CLOSE_REPLY, NATIVE_APP_LOCATION, type NativeAppWindow,
} from '../workspace/nativeApps';

interface AppEntry { id: string; href: string; win: BrowserWindow; closing: boolean; waiting: boolean; approval?: (allowed: boolean) => void; closeTimeout?: ReturnType<typeof setTimeout>; askingClose?: boolean }
export function setupNativeAppWindows(options: {
  isTrusted(event: IpcMainInvokeEvent): boolean;
  mayRead(event: IpcMainInvokeEvent): Promise<boolean> | boolean;
  getMainWindow(): BrowserWindow | null;
  preload: string; rendererFile: string;
  onClosed?(win: BrowserWindow): void;
}) {
  const entries = new Map<string, AppEntry>();
  const list = (): NativeAppWindow[] => [...entries.values()].filter(e => !e.win.isDestroyed()).map(e => ({
    id: e.id, href: e.href, title: e.win.getTitle(), minimized: e.win.isMinimized(), focused: e.win.isFocused(),
  }));
  const broadcast = () => {
    const value = list();
    const main = options.getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send(NATIVE_APP_CHANGED, value);
    for (const e of entries.values()) if (!e.win.isDestroyed()) e.win.webContents.send(NATIVE_APP_CHANGED, value);
  };
  const guard = async (event: IpcMainInvokeEvent) => {
    if (!options.isTrusted(event) || !await options.mayRead(event)) throw new Error('Войдите в Flux для открытия программы.');
  };
  ipcMain.handle(NATIVE_APP_LIST, async event => { await guard(event); return list(); });
  ipcMain.handle(NATIVE_APP_LOCATION, async (event, id: unknown, input: unknown) => {
    await guard(event);
    const entry = typeof id === 'string' ? entries.get(id) : null;
    const href = internalAppHref(input);
    if (!entry || entry.win.isDestroyed() || event.sender !== entry.win.webContents || !href) return false;
    entry.href = href; broadcast(); return true;
  });
  ipcMain.handle(NATIVE_APP_OPEN, async (event, input: unknown) => {
    await guard(event);
    const href = internalAppHref(input);
    if (!href) throw new Error('Неверный адрес программы Flux.');
    const existing = [...entries.values()].find(e => e.href === href && !e.win.isDestroyed());
    if (existing) {
      if (existing.win.isMinimized()) existing.win.restore();
      existing.win.show(); existing.win.focus(); return existing.id;
    }
    if (entries.size >= 48) throw new Error('Закройте неиспользуемые окна Flux.');
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.workArea;
    const width = Math.min(1280, area.width), height = Math.min(800, area.height);
    const id = randomUUID();
    // Самостоятельное окно Windows сохраняет один WebContents при переносе
    // между мониторами и участвует в обычном Alt+Tab вместе с Word и Excel.
    const win = new BrowserWindow({ x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2), width, height,
      minWidth: Math.min(640, area.width), minHeight: Math.min(400, area.height),
      frame: false, autoHideMenuBar: true, show: false, title: 'Flux', backgroundColor: '#f8fafc',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: options.preload } });
    const entry: AppEntry = { id, href, win, closing: false, waiting: false };
    entries.set(id, entry);
    const query = new URLSearchParams({ target: href, id });
    const hash = `#/native-app?${query}`;
    const url = app.isPackaged ? `${pathToFileURL(options.rendererFile).href}${hash}` : `http://localhost:3000/${hash}`;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (navigation, next) => {
      if (next.split('#')[0] !== url.split('#')[0]) navigation.preventDefault();
    });
    win.on('close', closeEvent => {
      if (entry.closing) return;
      closeEvent.preventDefault();
      if (!entry.waiting) {
        entry.waiting = true;
        win.webContents.send(NATIVE_APP_CLOSE_REQUEST, id);
        entry.closeTimeout = setTimeout(async () => {
          if (!entry.waiting || entry.askingClose || win.isDestroyed()) return;
          entry.askingClose = true;
          try {
            const result = await dialog.showMessageBox(win, { type: 'warning',
              title: 'Flux не отвечает на запрос закрытия',
              message: 'Сохранение ещё не подтверждено. Закрыть это окно принудительно?',
              detail: 'Несохранённые изменения могут быть потеряны. Можно оставить окно открытым и подождать.',
              buttons: ['Оставить открытым', 'Закрыть принудительно'], defaultId: 0, cancelId: 0 });
            if (!entry.waiting || win.isDestroyed()) return;
            entry.waiting = false;
            if (entry.approval) { const complete = entry.approval; entry.approval = undefined; complete(result.response === 1); }
            else if (result.response === 1) { entry.closing = true; win.close(); }
          } catch {
            entry.waiting = false;
            if (entry.approval) { const complete = entry.approval; entry.approval = undefined; complete(false); }
          }
          finally { entry.askingClose = false; }
        }, 8_000);
      }
    });
    win.on('closed', () => { clearTimeout(entry.closeTimeout); entry.approval?.(false); entries.delete(id); options.onClosed?.(win); broadcast(); });
    for (const name of ['focus', 'blur', 'minimize', 'restore', 'maximize', 'unmaximize'] as const) win.on(name, broadcast);
    win.on('maximize', () => win.webContents.send('window:maximized-changed', true));
    win.on('unmaximize', () => win.webContents.send('window:maximized-changed', false));
    win.on('page-title-updated', broadcast);
    try { await win.loadURL(url); } catch (error) { entry.closing = true; win.close(); throw error; }
    if (!win.isDestroyed()) win.show();
    broadcast(); return id;
  });
  ipcMain.handle(NATIVE_APP_CLOSE_REPLY, async (event, id: unknown, accepted: unknown) => {
    // Истёкшая сессия не должна запирать окно: разрешение на чтение здесь
    // уже не нужно, но ответ принимается только от WebContents этого окна.
    if (!options.isTrusted(event)) return false;
    const entry = typeof id === 'string' ? entries.get(id) : null;
    if (!entry || event.sender !== entry.win.webContents || !entry.waiting || typeof accepted !== 'boolean') return false;
    entry.waiting = false; clearTimeout(entry.closeTimeout);
    if (entry.approval) { const complete = entry.approval; entry.approval = undefined; complete(accepted); }
    else if (accepted) { entry.closing = true; entry.win.close(); }
    return accepted;
  });
  ipcMain.handle(NATIVE_APP_ACTION, async (event, id: unknown, action: unknown) => {
    await guard(event);
    const entry = typeof id === 'string' ? entries.get(id) : null;
    if (!entry || entry.win.isDestroyed()) return false;
    if (action === 'focus') { if (entry.win.isMinimized()) entry.win.restore(); entry.win.show(); entry.win.focus(); }
    else if (action === 'minimize') entry.win.minimize();
    else if (action === 'close') entry.win.close();
    else return false;
    return true;
  });
  const approveCloseAll = async () => {
    for (const entry of [...entries.values()]) {
      if (entry.win.isDestroyed()) continue;
      if (entry.waiting) return false;
      const allowed = await new Promise<boolean>(resolve => {
        let settled = false;
        const timeout = setTimeout(() => { if (!settled) { settled = true; entry.approval = undefined; entry.waiting = false; resolve(false); } }, 30_000);
        entry.approval = value => { if (!settled) { settled = true; clearTimeout(timeout); resolve(value); } };
        entry.win.close();
      });
      if (!allowed) return false;
    }
    return true;
  };
  return { list, approveCloseAll, has: (senderId: number) => [...entries.values()].some(e => e.win.webContents.id === senderId) };
}
