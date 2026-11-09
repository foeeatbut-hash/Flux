/**
 * Скачивание вложений чата в системную «Загрузки» (app.getPath('downloads')).
 *
 * Вся логика — в chatDownloadCore.ts (проверяется скриптом без Electron);
 * здесь только каналы: сохранить по ссылке и показать сохранённое в папке.
 * Окну достаются имя и путь, а не доступ к файловой системе: «показать»
 * принимает только путь внутри «Загрузок».
 */
import { app, ipcMain, net, shell } from 'electron';
import { isChatFileUrl, isInside, saveToDownloads } from './chatDownloadCore';

export function setupChatDownload() {
  ipcMain.handle('chat:save-attachment', async (_event, url: string, name: string) => {
    if (!isChatFileUrl(url)) return { ok: false, error: 'Это не вложение чата.' };
    return saveToDownloads({
      dir: app.getPath('downloads'),
      name: String(name || 'Файл'),
      open: async () => {
        const response = await net.fetch(url);
        return { ok: response.ok, status: response.status, body: response.body };
      },
    });
  });

  ipcMain.handle('chat:reveal-download', (_event, target: string) => {
    if (!isInside(app.getPath('downloads'), String(target || ''))) return { ok: false, error: 'Файл не из папки «Загрузки».' };
    shell.showItemInFolder(String(target));
    return { ok: true };
  });
}
