import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { registerModuleScheme, setupModuleProtocol } from '../../electron/modules';
import { FakeCom } from './fakeCom';

// Настоящий протокол, кэш выпусков и подключения; от выпуска отличается корнем доверия и каталогом.
// На Windows COM настоящий (помощник PowerShell), на других ОС — поддельный (FLUX_FAKE_COM=1).
registerModuleScheme();
app.whenReady().then(async () => {
  setupModuleProtocol(path.resolve('dist'), {
    rootHex: process.env.FLUX_TEST_ROOT!, dir: process.env.FLUX_TEST_DIR!, trusted: () => true,
    // Папка обмена с Studio — своя, а не настоящая папка данных Flux на этом компьютере
    devDir: process.env.FLUX_TEST_DEV_DIR || path.join(process.env.FLUX_TEST_DIR!, 'dev-run'),
    // Хранилище программ — своё, а не настоящая папка данных Flux на этом компьютере
    storageDir: process.env.FLUX_TEST_STORAGE_DIR || path.join(process.env.FLUX_TEST_DIR!, 'program-data'),
    ...(process.env.FLUX_FAKE_COM === '1' ? { com: new FakeCom() } : {}),
  });
  const win = new BrowserWindow({ show: true, width: 1200, height: 800, webPreferences: {
    nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
    contextIsolation: true, sandbox: true, preload: path.join(process.env.FLUX_MODULE_FIXTURE_DIR!, 'preload.js'),
  } });
  await win.loadURL(process.env.FLUX_MODULE_FIXTURE_URL!);
});
app.on('window-all-closed', () => app.quit());
