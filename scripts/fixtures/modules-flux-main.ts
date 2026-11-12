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
  // Журнал каждой попытки нужен, чтобы первая причина не терялась при повторе
  let lastFail: { code: number; text: string } | null = null;
  win.webContents.on('did-fail-load', (_event, code, text, url, isMainFrame) => {
    console.error(`FLUX_LOAD_FAILED ${JSON.stringify({ code, text, url, isMainFrame })}`);
    // -3 (ERR_ABORTED) — отмена навигации самим загрузчиком, не сетевой отказ
    if (isMainFrame && code !== -3) lastFail = { code, text };
  });
  // Сервер Vite на Windows CI мог ещё не отвечать на первом запросе (chrome-error://chromewebdata/):
  // повторяем загрузку, каждая попытка пишется строкой FLUX_LOAD_ATTEMPT
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastFail = null;
    console.error(`FLUX_LOAD_ATTEMPT ${JSON.stringify({ attempt, of: attempts, url: process.env.FLUX_MODULE_FLUX_URL })}`);
    let rejected: string | null = null;
    await win.loadURL(process.env.FLUX_MODULE_FLUX_URL!).catch(error => {
      rejected = String(error?.message || error);
      console.error(`FLUX_LOAD_REJECTED ${JSON.stringify({ attempt, message: rejected })}`);
    });
    if (!lastFail && !rejected) { console.error(`FLUX_LOAD_OK ${JSON.stringify({ attempt, url: win.webContents.getURL() })}`); break; }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
  }
});
app.on('window-all-closed', () => app.quit());
