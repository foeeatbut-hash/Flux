import { app, globalShortcut, type BrowserWindow } from 'electron';
import { bringToFront } from './windowForeground';

export function setupDraftsShortcut(getWindow: () => BrowserWindow | null) {
  const accelerator = 'CommandOrControl+Alt+D';
  // DOM не получает клавиши из встроенного Office или другой программы.
  const registered = globalShortcut.register(accelerator, () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    bringToFront(window);
    window.webContents.send('drafts:toggle');
  });
  if (!registered) console.warn('Ctrl+Alt+D занят другой программой. Кнопка «Черновики» доступна на панели задач.');
  app.once('will-quit', () => { if (registered) globalShortcut.unregister(accelerator); });
}
