import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { registerModuleScheme, setupModuleProtocol } from '../../electron/modules';

registerModuleScheme();
app.whenReady().then(async () => {
  setupModuleProtocol(path.resolve('dist'));
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: {
    nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
    contextIsolation: true, sandbox: true, preload: path.join(process.env.FLUX_MODULE_FIXTURE_DIR!, 'preload.js'),
  } });
  await win.loadURL(process.env.FLUX_MODULE_FIXTURE_URL!);
});
app.on('window-all-closed', () => app.quit());
