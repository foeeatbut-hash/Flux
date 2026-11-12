import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { DESK_POINTER_MIN_INTERVAL_MS, windowFocusable } from '../workspace/deskFocus';
import { readDisplayPrefs, writeDisplayPrefs } from './displayPrefs';
import { applyFocusable } from './windowForeground';

export interface DeskFocusState { available: boolean; enabled: boolean }

/**
 * «Окна Flux вместе с окнами Windows», простой вариант: пока главное окно не
 * активно, окно следит за указателем (наведение доходит и до неактивного
 * окна) и сообщает сюда, стоит ли он над пустым столом. Над пустым столом
 * главное окно становится неактивируемым — щелчок по столу не поднимает Flux
 * над Word. Над чем угодно другим окно обычное, и щелчок выводит Flux вперёд,
 * как раньше. Решает `workspace/deskFocus.ts`; здесь — события окна, IPC и
 * выключатель.
 */
export function setupDeskFocus(options: {
  getMainWindow: () => BrowserWindow | null;
  isTrusted: (event: IpcMainInvokeEvent) => boolean;
  /** Файл настроек мониторов (`display-workspace.json`). */
  prefsFile: string;
  platform?: string;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}) {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const cancel = options.cancel ?? (handle => clearTimeout(handle as NodeJS.Timeout));
  const available = platform === 'win32';
  let enabled = available && readDisplayPrefs(options.prefsFile).deskStaysBack;
  let overDesk = false;
  let attachedId = 0;
  let lastAt = -Infinity;
  let pending: boolean | null = null;
  let timer: unknown = null;

  const state = (): DeskFocusState => ({ available, enabled });
  const mainOf = () => { const win = options.getMainWindow(); return win && !win.isDestroyed() ? win : null; };
  const evaluate = () => {
    const win = mainOf();
    if (!win) return;
    applyFocusable(win, windowFocusable({ platform, enabled, windowActive: win.isFocused(),
      windowShown: win.isVisible() && !win.isMinimized(), pointerOverDesk: overDesk }));
  };
  const accept = (value: boolean) => {
    lastAt = now();
    if (value === overDesk) return;
    overDesk = value;
    evaluate();
  };
  const pointer = (value: boolean) => {
    if (!enabled) return;
    const wait = lastAt + DESK_POINTER_MIN_INTERVAL_MS - now();
    if (wait <= 0 && timer === null) { accept(value); return; }
    // Слишком часто: берём последнее значение и применяем, когда интервал
    // выйдет, — иначе состояние зависло бы на устаревшем.
    pending = value;
    if (timer === null) timer = schedule(() => {
      timer = null;
      const next = pending; pending = null;
      if (next !== null && enabled) accept(next);
    }, Math.max(1, wait));
  };
  const reset = () => { pending = null; if (timer !== null) { cancel(timer); timer = null; } };

  const attach = () => {
    const win = mainOf();
    if (!win || win.id === attachedId) return;
    attachedId = win.id;
    overDesk = false;
    win.on('focus', evaluate);
    // После потери активности положение указателя неизвестно (мог уйти на
    // другое окно): считаем, что он не над столом, пока окно не увидит его
    // на столе. Так окно не остаётся неактивируемым вслепую.
    win.on('blur', () => { reset(); overDesk = false; evaluate(); });
    for (const name of ['minimize', 'restore', 'show', 'hide'] as const) win.on(name as any, evaluate);
    win.on('closed', reset);
  };

  const guard = (event: IpcMainInvokeEvent | IpcMainEvent) => {
    const win = options.getMainWindow();
    return !!win && !win.isDestroyed() && event.sender === win.webContents && options.isTrusted(event as IpcMainInvokeEvent);
  };

  ipcMain.handle('workspace:desk-get', event => {
    if (!guard(event)) throw new Error('Настройки стола доступны только главному окну Flux.');
    attach();
    return state();
  });
  ipcMain.handle('workspace:desk-set', (event, value) => {
    if (!guard(event)) throw new Error('Настройки стола доступны только главному окну Flux.');
    if (typeof value !== 'boolean') throw new Error('Неверное значение настройки стола.');
    if (value && !available) throw new Error('Режим доступен только в Windows.');
    attach();
    enabled = value;
    if (!value) { reset(); overDesk = false; }
    writeDisplayPrefs(options.prefsFile, { deskStaysBack: value });
    evaluate();
    return state();
  });
  // Сигнал указателя: молча отбрасывается, если пришёл не от главного окна или
  // не boolean, — окно и так шлёт его часто, шума в журнале не нужно.
  ipcMain.on('workspace:desk-pointer', (event, value) => {
    if (typeof value !== 'boolean' || !guard(event)) return;
    attach();
    pointer(value);
  });
  return { attach, state, evaluate };
}
