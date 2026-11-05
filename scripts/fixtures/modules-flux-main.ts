import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { registerModuleScheme, setupModuleProtocol } from '../../electron/modules';

registerModuleScheme();
app.setPath('userData', process.env.FLUX_MODULE_FLUX_DATA!);
app.whenReady().then(async () => {
  setupModuleProtocol(path.resolve('dist'));
  // Полный веб-клиент идёт в настоящий API фикстуры. Нативные IPC отдельно
  // проверяются modules-native с промышленным preload, здесь нет их подмены.
  const win = new BrowserWindow({
    width: 1440, height: 900, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(process.env.FLUX_MODULE_FLUX_URL!);
});
app.on('window-all-closed', () => app.quit());
