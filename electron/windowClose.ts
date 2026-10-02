import { ipcMain, dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';

/** Системный крестик и Alt+F4 должны дождаться сохранения всех редакторов. */
export function setupMainWindowClose(getWindow: () => BrowserWindow | null,
  trusted: (event: IpcMainInvokeEvent) => boolean) {
  let attached = 0; let token = ''; let accepted = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let asking = false;
  let approval: ((allowed: boolean) => void) | null = null;
  const attach = () => {
    const win = getWindow();
    if (!win || win.id === attached) return;
    attached = win.id; token = ''; accepted = false;
    win.on('close', event => {
      if (accepted) return;
      event.preventDefault();
      if (token) return;
      token = randomUUID();
      win.webContents.send('window:close-request', token);
      const request = token;
      // Если renderer не запустился или упал, подтверждение из него не придёт.
      // Закрытие всё равно требует явного решения о несохранённых правках.
      timeout = setTimeout(async () => {
        if (asking || token !== request || win.isDestroyed()) return;
        asking = true;
        try {
          const result = await dialog.showMessageBox(win, { type: 'warning',
            title: 'Flux не отвечает на запрос закрытия',
            message: 'Сохранение ещё не подтверждено. Закрыть Flux принудительно?',
            detail: 'Несохранённые изменения могут быть потеряны. Можно оставить программу открытой и подождать.',
            buttons: ['Оставить открытой', 'Закрыть принудительно'], defaultId: 0, cancelId: 0 });
          if (token !== request || win.isDestroyed()) return;
          token = '';
          if (approval) { const complete = approval; approval = null; complete(result.response === 1); }
          else if (result.response === 1) { accepted = true; win.close(); }
        } catch {
          if (token === request) token = '';
          if (approval) { const complete = approval; approval = null; complete(false); }
        } finally { asking = false; }
      }, 8_000);
    });
    win.on('closed', () => { clearTimeout(timeout); token = ''; approval?.(false); approval = null; });
  };
  ipcMain.handle('window:close-confirm', (event, input: unknown, allowed: unknown) => {
    const win = getWindow();
    if (!trusted(event) || !win || event.sender !== win.webContents || input !== token || !token || typeof allowed !== 'boolean') return false;
    token = '';
    clearTimeout(timeout);
    if (approval) { const complete = approval; approval = null; complete(allowed); return allowed; }
    if (!allowed) return false;
    accepted = true; win.close(); return true;
  });
  attach();
  return { attach, approveClose: (): Promise<boolean> => {
    const win = getWindow();
    if (!win || win.isDestroyed() || token || approval) return Promise.resolve(false);
    return new Promise(resolve => { approval = resolve; win.close(); });
  } };
}
