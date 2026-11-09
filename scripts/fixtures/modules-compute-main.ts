import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { registerModuleScheme, setupModuleProtocol } from '../../electron/modules';

// Настоящий протокол и кэш выпусков; от выпуска отличается только корнем доверия (ключ проверки)
// и каталогом, которые передаёт проверка, и отправителем IPC (страница проверки не из файла Flux).
registerModuleScheme();
app.whenReady().then(async () => {
  setupModuleProtocol(path.resolve('dist'), { rootHex: process.env.FLUX_TEST_ROOT!, dir: process.env.FLUX_TEST_DIR!, trusted: () => true });
  const win = new BrowserWindow({ show: true, width: 1200, height: 800, webPreferences: {
    nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
    contextIsolation: true, sandbox: true, preload: path.join(process.env.FLUX_MODULE_FIXTURE_DIR!, 'preload.js'),
  } });
  await win.loadURL(process.env.FLUX_MODULE_FIXTURE_URL!);
});
app.on('window-all-closed', () => app.quit());
