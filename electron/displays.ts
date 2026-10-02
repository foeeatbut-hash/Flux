import { app, BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { recoverRect, unionDisplays, type DisplayWorkspace, type WorkspaceDisplay } from '../workspace/displays';

/** Один renderer сохраняет несохранённые редакторы при переносе между экранами. */
export function setupDisplayWorkspace(getMainWindow: () => BrowserWindow | null,
  isTrusted: (event: IpcMainInvokeEvent) => boolean) {
  const preference = path.join(app.getPath('userData'), 'display-workspace.json');
  let enabled = false;
  let requested = false;
  let showWindowsTaskbar = true;
  try {
    const saved = JSON.parse(fs.readFileSync(preference, 'utf8'));
    requested = saved?.allMonitors === true;
    showWindowsTaskbar = saved?.showWindowsTaskbar !== false;
  } catch {}
  let attachedId = 0;
  let previous: { bounds: Electron.Rectangle; maximized: boolean; movable: boolean; resizable: boolean; minimum: number[] } | null = null;
  let adjusting = false;
  const displays = (): WorkspaceDisplay[] => screen.getAllDisplays().map(d => ({
    id: d.id, label: d.label || `Монитор ${d.id}`, primary: d.id === screen.getPrimaryDisplay().id,
    scaleFactor: d.scaleFactor,
    bounds: { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height },
    workArea: { x: d.workArea.x, y: d.workArea.y, w: d.workArea.width, h: d.workArea.height },
  }));
  const snapshot = (): DisplayWorkspace => {
    const list = displays();
    return { enabled, showWindowsTaskbar, displays: list, bounds: unionDisplays(list), primaryId: screen.getPrimaryDisplay().id,
      mixedScale: new Set(list.map(d => d.scaleFactor)).size > 1 };
  };
  const broadcast = () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('workspace:displays-changed', snapshot());
  };
  const fit = () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || !enabled || adjusting) return;
    const r = unionDisplays(displays());
    const current = win.getBounds();
    if (!win.isFullScreen() && !win.isMaximized() && current.x === r.x && current.y === r.y && current.width === r.w && current.height === r.h) return;
    adjusting = true;
    try {
      if (win.isFullScreen()) win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
      win.setBounds({ x: r.x, y: r.y, width: r.w, height: r.h });
    } finally { adjusting = false; }
  };
  const change = (value: boolean) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) throw new Error('Главное окно недоступно.');
    if (value === enabled) return snapshot();
    if (value) {
      const r = unionDisplays(displays());
      if (r.w > 32767 || r.h > 32767) throw new Error('Расположение мониторов превышает размер одного окна Windows. Используйте оконный режим.');
      previous = { bounds: win.getNormalBounds(), maximized: win.isMaximized(),
        movable: win.isMovable(), resizable: win.isResizable(), minimum: win.getMinimumSize() };
      enabled = true;
      win.setMinimumSize(1, 1);
      fit();
      win.setMovable(false);
      win.setResizable(false);
    } else {
      enabled = false;
      win.setMovable(previous?.movable ?? true);
      win.setResizable(previous?.resizable ?? true);
      if (previous) win.setMinimumSize(previous.minimum[0], previous.minimum[1]);
      if (previous) {
        const r = recoverRect({ x: previous.bounds.x, y: previous.bounds.y,
          w: previous.bounds.width, h: previous.bounds.height }, displays());
        win.setBounds({ x: r.x, y: r.y, width: r.w, height: r.h });
        if (previous.maximized) win.maximize();
      }
      previous = null;
    }
    requested = value;
    // Ошибка записи настроек не должна удерживать пользователя в этом режиме.
    try { fs.writeFileSync(preference, JSON.stringify({ allMonitors: value, showWindowsTaskbar }), { mode: 0o600 }); } catch {}
    broadcast();
    return snapshot();
  };
  const attach = () => {
    const win = getMainWindow();
    if (!win || win.id === attachedId) return;
    attachedId = win.id;
    enabled = false;
    previous = null;
    win.on('move', fit);
    win.on('resize', fit);
    if (requested) {
      try { change(true); } catch { requested = false; enabled = false; }
    }
  };
  const guard = (event: IpcMainInvokeEvent) => {
    const win = getMainWindow();
    if (!isTrusted(event) || !win || event.sender !== win.webContents)
      throw new Error('Настройки мониторов доступны только главному окну Flux.');
    attach();
  };
  ipcMain.handle('workspace:displays-get', event => { guard(event); return snapshot(); });
  ipcMain.handle('workspace:displays-set', (event, value) => {
    guard(event);
    if (typeof value !== 'boolean') throw new Error('Неверный режим мониторов.');
    return change(value);
  });
  ipcMain.handle('workspace:displays-preferences', (event, value) => {
    guard(event);
    if (!value || typeof value.showWindowsTaskbar !== 'boolean') throw new Error('Неверные настройки экрана.');
    const previousValue = showWindowsTaskbar;
    showWindowsTaskbar = value.showWindowsTaskbar;
    try { fs.writeFileSync(preference, JSON.stringify({ allMonitors: requested, showWindowsTaskbar }), { mode: 0o600 }); }
    catch { showWindowsTaskbar = previousValue; throw new Error('Не удалось сохранить настройки экрана.'); }
    broadcast();
    return snapshot();
  });
  const updated = () => {
    if (enabled) {
      const r = unionDisplays(displays());
      if (r.w > 32767 || r.h > 32767) { change(false); return; }
    }
    fit(); broadcast();
  };
  screen.on('display-added', updated);
  screen.on('display-removed', updated);
  screen.on('display-metrics-changed', updated);
  app.once('will-quit', () => {
    screen.removeListener('display-added', updated);
    screen.removeListener('display-removed', updated);
    screen.removeListener('display-metrics-changed', updated);
  });
  return { attach, isEnabled: () => enabled, exit: () => change(false) };
}
