/**
 * Скачивание вложений чата в системную «Загрузки» (app.getPath('downloads')).
 *
 * Вся логика — в chatDownloadCore.ts (проверяется скриптом без Electron);
 * здесь только каналы. Оба отвечают только основному окну Flux
 * (trustedAuthSender), скачивают только вложения чата с сервера Flux, а
 * «показать» принимает лишь пути, которые этот процесс сам выдал при сохранении.
 */
import { app, ipcMain, net, shell } from 'electron';
import { trustedAuthSender } from './authStorage';
import { createChatDownloadHandlers } from './chatDownloadCore';

/** Сервер Flux, с которым говорит окно (тот же адрес, что в main.ts) */
const SERVER_ORIGIN = 'http://localhost:3000';

export function setupChatDownload() {
  const handlers = createChatDownloadHandlers<Electron.IpcMainInvokeEvent>({
    trusted: trustedAuthSender,
    serverOrigin: SERVER_ORIGIN,
    downloadsDir: () => app.getPath('downloads'),
    fetch: async (url) => {
      const response = await net.fetch(url, { redirect: 'error' });
      return { ok: response.ok, status: response.status, body: response.body };
    },
    showItem: (target) => shell.showItemInFolder(target),
  });
  ipcMain.handle('chat:save-attachment', (event, url: string, name: string) => handlers.save(event, url, name));
  ipcMain.handle('chat:reveal-download', (event, target: string) => handlers.reveal(event, target));
}
