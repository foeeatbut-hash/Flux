/**
 * Скрытый раздел «Экстренная установка»: связь окна Flux с логикой emergencyInstall.ts.
 *
 * Раздел не зависит ни от сервера, ни от входа: каналы не проверяют сессию и лицензию (при неудачном обновлении
 * человек может не войти вовсе), но принимают вызовы только от окна самой программы (trustedAuthSender) и никогда
 * не берут путь к файлу от окна — файл выбирается системным диалогом главного процесса. Что ставится, решает
 * подпись владельца под пакетом, проверенная открытым ключом из сборки (updateKey.ts).
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { trustedAuthSender } from './authStorage';
import { appendLog, appendLogNow } from './logs';
import { UPDATE_PUBLIC_KEY_HEX } from './updateKey';
import { createEmergencyInstaller } from './emergencyInstall';
import { PACKAGE_EXTENSION } from './updatePackage';

export function registerEmergencyUpdate(o: { window: () => BrowserWindow | null; approveClose: () => Promise<boolean> }): void {
  const installer = createEmergencyInstaller({
    keyHex: UPDATE_PUBLIC_KEY_HEX,
    current: () => app.getVersion(),
    tempDir: app.getPath('temp'),
    portableExe: () => { const exe = process.env.PORTABLE_EXECUTABLE_FILE || ''; return exe && fs.existsSync(exe) ? exe : ''; },
    pid: process.pid,
    pickFile: async () => {
      const parent = o.window();
      const options: Electron.OpenDialogOptions = {
        title: 'Пакет обновления Flux',
        // «Все файлы» оставлены намеренно: голый exe, выбранный по ошибке, получает понятный отказ, а не молчание
        filters: [{ name: 'Пакет обновления Flux', extensions: [PACKAGE_EXTENSION] }, { name: 'Все файлы', extensions: ['*'] }],
        properties: ['openFile'],
      };
      const picked = parent && !parent.isDestroyed() ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      return picked.canceled || !picked.filePaths[0] ? null : picked.filePaths[0];
    },
    spawnHelper: (exe, args) => new Promise<void>((resolve, reject) => {
      const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('spawn', () => { child.unref(); resolve(); });
      child.once('error', reject);
    }),
    approveClose: o.approveClose,
    // Следом программа выходит: запись в журнал синхронная, иначе очередь не успеет сброситься
    quit: () => { setTimeout(() => app.quit(), 0); },
    log: (level, text) => { (level === 'ERROR' ? appendLogNow : appendLog)(level, 'Экстренная установка', text); },
    onProgress: percent => { const w = o.window(); if (w && !w.isDestroyed()) w.webContents.send('emergency:progress', percent); },
  });
  const trusted = (event: Electron.IpcMainInvokeEvent) => trustedAuthSender(event);
  const refused = { ok: false, error: 'Раздел доступен только окну Flux.' };
  ipcMain.handle('emergency:pick', async event => (trusted(event) ? installer.pick() : refused));
  ipcMain.handle('emergency:install', async event => (trusted(event) ? installer.install() : refused));
  ipcMain.handle('emergency:discard', async event => { if (trusted(event)) installer.discard(); return { ok: true }; });
}
