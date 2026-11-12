import { app, BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { readDisplayPrefs, writeDisplayPrefs } from './displayPrefs';
import { recoverRect, sameRect, workspaceFrame, type DisplayWorkspace, type WorkspaceDisplay } from '../workspace/displays';

/** Один renderer сохраняет несохранённые редакторы при переносе между экранами. */
export function setupDisplayWorkspace(getMainWindow: () => BrowserWindow | null,
  isTrusted: (event: IpcMainInvokeEvent) => boolean,
  /** Запись в диагностику; передаёт main.ts, чтобы модуль не тянул её зависимости. */
  record: (event: 'display.layout', fields: Record<string, unknown>) => void = () => {}) {
  const preference = path.join(app.getPath('userData'), 'display-workspace.json');
  let enabled = false;
  let requested = readDisplayPrefs(preference).allMonitors;
  let attachedId = 0;
  let previous: { bounds: Electron.Rectangle; maximized: boolean; movable: boolean; resizable: boolean; minimum: number[] } | null = null;
  let adjusting = false;
  // Какая форма сейчас на окне: повторный setShape на каждый move/resize
  // перерисовывает окно зря.
  let shapeKey = '';
  let shadowOff = false;
  // Предохранитель от подгонки по кругу: Windows при дробном масштабе может
  // вернуть чуть иные границы, чем мы задали. Больше трёх setBounds за две
  // секунды без смены мониторов не делаем и пишем это в журнал.
  let attempts: number[] = [];
  let gaveUp = false;
  const displays = (): WorkspaceDisplay[] => screen.getAllDisplays().map(d => ({
    id: d.id, label: d.label || `Монитор ${d.id}`, primary: d.id === screen.getPrimaryDisplay().id,
    scaleFactor: d.scaleFactor,
    bounds: { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height },
    workArea: { x: d.workArea.x, y: d.workArea.y, w: d.workArea.width, h: d.workArea.height },
  }));
  const snapshot = (): DisplayWorkspace => {
    const list = displays();
    return { enabled, displays: list, bounds: workspaceFrame(list).rect, primaryId: screen.getPrimaryDisplay().id,
      mixedScale: new Set(list.map(d => d.scaleFactor)).size > 1 };
  };
  const broadcast = () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('workspace:displays-changed', snapshot());
  };
  /** Геометрия в журнал: для каждого монитора, окна и формы — что видит Windows. */
  const logLayout = (trigger: string) => {
    try {
      const list = displays();
      const frame = workspaceFrame(list);
      list.forEach((d, index) => record('display.layout', { action: 'monitor', trigger, index, id: d.id,
        primary: d.primary, scalePct: Math.round(d.scaleFactor * 100),
        x: d.bounds.x, y: d.bounds.y, w: d.bounds.w, h: d.bounds.h,
        ax: d.workArea.x, ay: d.workArea.y, aw: d.workArea.w, ah: d.workArea.h }));
      const win = getMainWindow();
      const actual = win && !win.isDestroyed() ? win.getBounds() : frame.rect;
      // x/y/w/h — желаемые границы окна, a* — фактические: расхождение и есть улика.
      record('display.layout', { action: 'window', trigger, exact: frame.exact, shapes: frame.shape?.length ?? 0,
        retries: attempts.length, x: frame.rect.x, y: frame.rect.y, w: frame.rect.w, h: frame.rect.h,
        ax: actual.x, ay: actual.y, aw: actual.width, ah: actual.height });
      frame.shape?.forEach((r, index) => record('display.layout', { action: 'shape', trigger, index,
        x: r.x, y: r.y, w: r.w, h: r.h }));
    } catch {}
  };
  const fit = () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || !enabled || adjusting) return;
    const frame = workspaceFrame(displays());
    const r = frame.rect;
    adjusting = true;
    try {
      if (win.isFullScreen()) win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
      const current = win.getBounds();
      // Окно ставится на охват workArea (системная панель Windows остаётся
      // снаружи и видна). События move/resize приходят и от нашего же
      // setBounds, и от округления Windows при дробном масштабе: расхождение
      // в пару пикселей не повод подгонять заново.
      if (!sameRect({ x: current.x, y: current.y, w: current.width, h: current.height }, r)) {
        const now = Date.now();
        attempts = attempts.filter(t => now - t < 2000);
        if (attempts.length >= 3) {
          if (!gaveUp) { gaveUp = true; logLayout('give-up'); }
        } else {
          attempts.push(now);
          win.setBounds({ x: r.x, y: r.y, width: r.w, height: r.h });
        }
      }
      // Форма нужна только когда рабочие области не заполняют охват (мониторы
      // разной высоты или со смещением): тогда она вырезает пустоту и панели.
      // transparent-окно вместо формы не годится: параметр задаётся при
      // создании окна, ломает обычный одиночный режим (изменение размера,
      // тень, максимизацию) и включает программную прорисовку слоя.
      if (process.platform === 'win32' || process.platform === 'linux') {
        const key = JSON.stringify(frame.shape);
        if (key !== shapeKey) {
          shapeKey = key;
          win.setShape(frame.shape ? frame.shape.map(a => ({ x: a.x, y: a.y, width: a.w, height: a.h })) : []);
        }
      }
      // Тень у общего HWND иначе может закрасить Windows taskbar под ним.
      if (!shadowOff) { win.setHasShadow(false); shadowOff = true; }
    } finally { adjusting = false; }
  };
  const change = (value: boolean) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) throw new Error('Главное окно недоступно.');
    if (value === enabled) return snapshot();
    if (value) {
      const r = workspaceFrame(displays()).rect;
      if (r.w > 32767 || r.h > 32767) throw new Error('Расположение мониторов превышает размер одного окна Windows. Используйте оконный режим.');
      previous = { bounds: win.getNormalBounds(), maximized: win.isMaximized(),
        movable: win.isMovable(), resizable: win.isResizable(), minimum: win.getMinimumSize() };
      enabled = true;
      attempts = []; gaveUp = false; shapeKey = ''; shadowOff = false;
      win.setMinimumSize(1, 1);
      fit();
      win.setMovable(false);
      win.setResizable(false);
      logLayout('enable');
    } else {
      enabled = false;
      shapeKey = '';
      if (process.platform === 'win32' || process.platform === 'linux') win.setShape([]);
      win.setHasShadow(true);
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
    writeDisplayPrefs(preference, { allMonitors: value });
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
  const updated = (trigger: string) => () => {
    if (enabled) {
      const r = workspaceFrame(displays()).rect;
      if (r.w > 32767 || r.h > 32767) { change(false); return; }
      // Смена мониторов — новая причина подгонять: счётчик попыток начинается заново.
      attempts = []; gaveUp = false;
    }
    fit(); broadcast();
    if (enabled) logLayout(trigger);
  };
  const onAdded = updated('display-added'), onRemoved = updated('display-removed'), onMetrics = updated('display-metrics');
  screen.on('display-added', onAdded);
  screen.on('display-removed', onRemoved);
  screen.on('display-metrics-changed', onMetrics);
  app.once('will-quit', () => {
    screen.removeListener('display-added', onAdded);
    screen.removeListener('display-removed', onRemoved);
    screen.removeListener('display-metrics-changed', onMetrics);
  });
  return { attach, isEnabled: () => enabled, exit: () => change(false) };
}
