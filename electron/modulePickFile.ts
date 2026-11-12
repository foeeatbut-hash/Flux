/**
 * Файл пользователя для программы (flux.openFile, добавлено к договору v2).
 *
 * Диалог выбора файла показывает главный процесс Flux, а не программа и не её окно: человек видит обычный системный
 * диалог с названием программы и сам выбирает файл. Программа получает имя и содержимое только этого файла;
 * путь к нему, соседние файлы и папка до программы не доходят. Вызвать канал может только окно Flux (`trusted`);
 * окно программы к IPC доступа не имеет, его просьба доходит сюда через мост окна Flux, где проверена по схеме.
 * Правила выбора и чтения — modules/page/pickFile.ts (те же, что в пробном запуске Studio).
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { pickForProgram, type PickReply } from '../modules/page/pickFile';
import { trustedAuthSender } from './authStorage';

export function registerModulePickFile() {
  ipcMain.handle('modules:pick-file', async (event, request: { program?: unknown; accept?: unknown }): Promise<PickReply> => {
    if (!trustedAuthSender(event)) return { ok: false, code: 'DENIED' };
    const window = BrowserWindow.fromWebContents(event.sender);
    return pickForProgram(request || {}, async options => {
      const config = { ...options, buttonLabel: 'Отдать программе', properties: ['openFile' as const] };
      const result = window ? await dialog.showOpenDialog(window, config) : await dialog.showOpenDialog(config);
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
    });
  });
}
