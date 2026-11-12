import type { BrowserWindow } from 'electron';

/**
 * Единственное место, где главное окно Flux меняет «активируемость» и
 * намеренно выходит вперёд. Без runtime-зависимости от electron: трей,
 * Ctrl+Alt+D, уведомления и повторный запуск подключают его без подставного
 * Electron в своих проверках.
 *
 * Состояние, которое мы последний раз передали окну, запоминается здесь, а не
 * спрашивается у Electron: так повтор того же значения не доходит до
 * `setFocusable`, а он на Windows меняет стиль окна и может мигать кнопкой на
 * панели задач.
 */
type FocusableWindow = Pick<BrowserWindow, 'setFocusable' | 'isDestroyed'>;
const applied = new WeakMap<object, boolean>();

/** Передаёт окну активируемость, только если она изменилась. */
export function applyFocusable(win: FocusableWindow, value: boolean): boolean {
  if (win.isDestroyed()) return false;
  if ((applied.get(win) ?? true) === value) return false;
  applied.set(win, value);
  win.setFocusable(value);
  return true;
}

/**
 * Намеренный выход Flux вперёд: запуск, повторный запуск, «Показать Flux» в
 * трее, нажатие на уведомление, Ctrl+Alt+D. Окно сначала снова делается
 * активируемым — иначе show/focus не подействуют, если стол до этого держал
 * его неактивируемым.
 */
export function bringToFront(win: BrowserWindow | null | undefined) {
  if (!win || win.isDestroyed()) return;
  applyFocusable(win, true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
