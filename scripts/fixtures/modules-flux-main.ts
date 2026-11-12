import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { registerModuleScheme, setupModuleProtocol } from '../../electron/modules';

registerModuleScheme();
app.setPath('userData', process.env.FLUX_MODULE_FLUX_DATA!);
app.whenReady().then(async () => {
  // Образец стоит установленным подписанным выпуском (scripts/fixtures/installedSample.ts): свой корень доверия и каталог
  setupModuleProtocol(path.resolve('dist'), { rootHex: process.env.FLUX_TEST_ROOT!, dir: path.join(process.env.FLUX_MODULE_FLUX_DATA!, 'programs') });
  // Полный веб-клиент идёт в настоящий API фикстуры. Нативные IPC отдельно
  // проверяются modules-native с промышленным preload, здесь нет их подмены.
  const win = new BrowserWindow({
    width: 1440, height: 900, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // Окно иногда остаётся на chrome-error:// (Windows CI, «тайм-аут входа»), а причину Chromium говорит только здесь:
  // код и текст отказа уходят в stderr, набор печатает их в диагностике падения
  win.webContents.on('did-fail-load', (_event, code, text, url, isMainFrame) => {
    console.error(`FLUX_LOAD_FAILED ${JSON.stringify({ code, text, url, isMainFrame })}`);
  });
  await win.loadURL(process.env.FLUX_MODULE_FLUX_URL!).catch(error => {
    console.error(`FLUX_LOAD_REJECTED ${JSON.stringify({ message: String(error?.message || error) })}`);
  });
});
app.on('window-all-closed', () => app.quit());
