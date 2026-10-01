import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import { createSessionVault } from './sessionVault';

export function trustedAuthSender(event: Electron.IpcMainInvokeEvent): boolean {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) return false;
  const url = event.sender.getURL();
  if (process.env.NODE_ENV === 'development') {
    try { return new URL(url).origin === 'http://localhost:3000'; } catch { return false; }
  }
  try { return new URL(url).protocol === 'file:' && decodeURIComponent(new URL(url).pathname).replace(/^\/(\w:)/, '$1') === path.resolve(__dirname, '../dist/index.html').replace(/\\/g, '/'); }
  catch { return false; }
}
/** No plaintext fallback. Linux basic_text is not OS encryption. */
export function secureStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
}
export function setupAuthStorage(configuredServer: () => string) {
  const vault = () => createSessionVault(app.getPath('userData'), new URL(configuredServer() || 'http://localhost:3000').origin, {
    available: secureStorageAvailable,
    encrypt: value => safeStorage.encryptString(value),
    decrypt: value => safeStorage.decryptString(value),
  });
  const check = (event: Electron.IpcMainInvokeEvent, origin: unknown) => {
    if (!trustedAuthSender(event)) throw new Error('Сессия доступна только окну Flux.');
    if (origin !== new URL(configuredServer() || 'http://localhost:3000').origin) throw new Error('Адрес сервера изменился. Перезапустите окно Flux.');
  };
  ipcMain.handle('auth:read-session', (event, origin: unknown) => {
    check(event, origin);
    return vault().read();
  });
  ipcMain.handle('auth:write-session', (event, token: unknown, origin: unknown) => {
    check(event, origin);
    return vault().write(token);
  });
}
