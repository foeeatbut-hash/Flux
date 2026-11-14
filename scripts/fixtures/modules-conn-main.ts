import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { registerModuleScheme, setupModuleProtocol } from '../../electron/modules';
import { FakeCom } from './fakeCom';

// Настоящий протокол, кэш выпусков и подключения; от выпуска отличается корнем доверия и каталогом.
// На Windows COM настоящий (помощник PowerShell), на других ОС — поддельный (FLUX_FAKE_COM=1).
registerModuleScheme();
// Разбор TIMEOUT на Windows: видно, дошёл ли вызов подключения до главного процесса, сколько он там шёл и чем кончился.
// Строки с «[com]» набор переправляет в журнал шага (scripts/test-modules-connections-native.ts)
{
  const handle = ipcMain.handle.bind(ipcMain);
  const t0 = Date.now();
  (ipcMain as any).handle = (channel: string, listener: (event: any, ...args: any[]) => any) => handle(channel, async (event: any, ...args: any[]) => {
    const traced = channel === 'modules:connect' && args[0]?.connection === 'fso';
    const at = Date.now();
    if (traced) console.log(`[com] ipc ${channel}: вызов получен через ${at - t0} мс после запуска главного процесса, программа ${args[0]?.moduleId}, op ${args[0]?.call?.op}`);
    try {
      const result = await listener(event, ...args);
      if (traced) console.log(`[com] ipc ${channel}: ответ через ${Date.now() - at} мс, ok=${result?.ok}, code=${result?.code ?? ''}`);
      return result;
    } catch (error: any) {
      if (traced) console.log(`[com] ipc ${channel}: исключение через ${Date.now() - at} мс: ${String(error?.message || error).slice(0, 200)}`);
      throw error;
    }
  });
}
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
