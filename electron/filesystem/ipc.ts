import { app, dialog, ipcMain, shell, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WINDOWS_FILES_CHANNEL, WINDOWS_FILES_CHANGED, type WindowsFilesRequest, type WindowsFilesResponse } from '../../filesystem/contracts';
import { WindowsFilesService } from './service';
import { WindowsFilesError } from './paths';
import { windowsPublicDesktopFolder } from '../desktopShell';
import { enumerateWindowsVolumes, openWindowsRecycleBin } from './nativePlaces';

export interface WindowsFilesIpcOptions {
  isTrusted: (event: IpcMainInvokeEvent) => boolean;
  mayRead: (event: IpcMainInvokeEvent) => boolean | Promise<boolean>;
  mayWrite: (event: IpcMainInvokeEvent) => boolean | Promise<boolean>;
}
const WRITE_ACTIONS = new Set(['write', 'publish', 'createDraft', 'createDraftFolder', 'publishDraft', 'publishDraftTree', 'restoreDraft', 'mkdir', 'rename', 'copy', 'move', 'trash', 'setMetadata']);
const ERROR_MESSAGES: Record<string, string> = {
  EACCES: 'Windows не разрешает доступ к файлу. Проверьте права папки.',
  EPERM: 'Файл занят другой программой или Windows запретила действие.',
  EBUSY: 'Файл открыт другой программой. Закройте его и повторите действие.',
  ENOSPC: 'На диске недостаточно свободного места. Черновик в Flux сохранён.',
  ENOENT: 'Файл или папка недоступны. Обновите список или проверьте подключение диска.',
  EEXIST: 'Файл с таким именем уже существует. Выберите другое имя; исходный файл не заменён.',
  ENOTDIR: 'Родитель файла больше не является папкой.',
  ELOOP: 'Ссылку нельзя открыть без отдельного подключения папки.',
};
export function windowsFilesFailure(error: any): WindowsFilesResponse {
  if (error instanceof WindowsFilesError) return { ok: false, error: { code: error.code, message: error.message } };
  const code = typeof error?.code === 'string' ? error.code : 'FILESYSTEM_ERROR';
  return { ok: false, error: { code, message: ERROR_MESSAGES[code] || 'Не удалось выполнить действие с файлом. Исходные данные сохранены; повторите действие.' } };
}
export async function registerWindowsFilesIpc(options: WindowsFilesIpcOptions): Promise<WindowsFilesService> {
  const activeSenders = new Set<number>();
  const icons = new Map<string, { at: number; value: Promise<string | null> }>();
  const service = await WindowsFilesService.create({
    userData: app.getPath('userData'),
    knownFolders: { desktop: app.getPath('desktop'), documents: app.getPath('documents'), downloads: app.getPath('downloads') },
    trashItem: filename => shell.trashItem(filename),
    showItemInFolder: filename => shell.showItemInFolder(filename),
    openPath: filename => shell.openPath(filename),
    onChanged: change => {
      // События несут лишь capability и относительный путь; содержимое повторно читается с проверкой сессии.
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && activeSenders.has(window.webContents.id)) window.webContents.send(WINDOWS_FILES_CHANGED, change);
    },
  });
  // Общий Desktop входит в вид Shell, но не находится в личном Desktop пользователя.
  const publicDesktop = await windowsPublicDesktopFolder();
  if (publicDesktop) await service.addRoot(publicDesktop, 'Общий рабочий стол').catch(() => undefined);
  ipcMain.handle(WINDOWS_FILES_CHANNEL, async (event, request: WindowsFilesRequest): Promise<WindowsFilesResponse> => {
    try {
      if (!options.isTrusted(event) || !await options.mayRead(event)) throw new WindowsFilesError('UNAUTHORIZED', 'Войдите в Flux для работы с файлами этого компьютера.');
      if (!request || typeof request !== 'object' || typeof request.action !== 'string') throw new WindowsFilesError('INVALID_REQUEST', 'Некорректная команда проводника.');
      if (WRITE_ACTIONS.has(request.action) && !await options.mayWrite(event)) throw new WindowsFilesError('READ_ONLY', 'Изменение файлов недоступно: проверьте права и лицензию Flux.');
      if (!activeSenders.has(event.sender.id)) {
        activeSenders.add(event.sender.id);
        event.sender.once('destroyed', () => { activeSenders.delete(event.sender.id); service.closeOwner(event.sender.id); });
      }
      let data: unknown;
      switch (request.action) {
        case 'roots': data = await service.roots(); break;
        case 'volumes': {
          const volumes = await enumerateWindowsVolumes();
          data = await Promise.all(volumes.map(async volume => {
            try {
              const root = await service.addRoot(volume.path, volume.name);
              return { id: volume.id, name: volume.name, kind: volume.kind, networkPath: volume.networkPath, size: volume.size, free: volume.free, root };
            } catch {
              return { id: volume.id, name: volume.name, kind: volume.kind, networkPath: volume.networkPath, size: volume.size, free: volume.free, root: { id: '', name: volume.name, kind: 'custom', available: false } };
            }
          }));
          break;
        }
        case 'openRecycleBin': await openWindowsRecycleBin(); data = { opened: true }; break;
        case 'draftTrash': data = await service.draftTrash(); break;
        case 'pickImport': {
          const requested = Array.isArray(request.extensions) ? request.extensions : [];
          const extensions = [...new Set(requested.map(value => String(value).toLowerCase().replace(/^\./u, '')).filter(value => /^[a-z0-9][a-z0-9_-]{0,15}$/u.test(value)))].slice(0, 20);
          const filters = extensions.length ? [{ name: `Файлы для импорта (${extensions.map(ext => `.${ext}`).join(', ')})`, extensions }, { name: 'Все файлы', extensions: ['*'] }] : [{ name: 'Все файлы', extensions: ['*'] }];
          const window = BrowserWindow.fromWebContents(event.sender);
          const config = { title: 'Выберите файл для импорта', buttonLabel: 'Выбрать', properties: request.multiple ? ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[] : ['openFile'] as ('openFile')[], filters };
          const result = window ? await dialog.showOpenDialog(window, config) : await dialog.showOpenDialog(config);
          if (result.canceled) { data = { canceled: true, files: [] }; break; }
          if (result.filePaths.length > (request.multiple ? 20 : 1)) throw new WindowsFilesError('INVALID_REQUEST', 'Выберите не более 20 файлов за один раз.');
          const files = [];
          let total = 0;
          for (const filename of result.filePaths) {
            const handle = await fs.open(filename, 'r');
            try {
              const before = await handle.stat();
              if (!before.isFile()) throw new WindowsFilesError('NOT_FILE', 'Выберите обычные файлы.');
              if (before.size > 64 * 1024 * 1024 || total + before.size > 64 * 1024 * 1024) throw new WindowsFilesError('FILE_TOO_LARGE', 'Суммарный размер файлов для импорта не должен превышать 64 МБ.');
              const bytes = Buffer.allocUnsafe(before.size + 1);
              let bytesRead = 0;
              while (bytesRead < bytes.length) {
                const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
                if (chunk.bytesRead === 0) break;
                bytesRead += chunk.bytesRead;
              }
              const after = await handle.stat();
              if (bytesRead !== before.size || bytesRead > 64 * 1024 * 1024 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw new WindowsFilesError('CONFLICT', 'Файл изменился во время чтения. Выберите его повторно.');
              total += bytesRead;
              files.push({ name: path.basename(filename), size: bytesRead, base64: bytes.subarray(0, bytesRead).toString('base64') });
            } finally { await handle.close(); }
          }
          data = { canceled: false, files };
          break;
        }
        case 'restoreDraft': data = await service.restoreDraft(request.ref); break;
        case 'addRoot': {
          const window = BrowserWindow.fromWebContents(event.sender);
          const config = { title: 'Подключить папку Windows', properties: ['openDirectory'] as ('openDirectory')[] };
          const result = window ? await dialog.showOpenDialog(window, config) : await dialog.showOpenDialog(config);
          data = result.canceled || !result.filePaths[0] ? { canceled: true } : await service.addRoot(result.filePaths[0]); break;
        }
        case 'list': data = await service.list(request.ref, request.offset, request.limit); break;
        case 'read': data = await service.read(request.ref); break;
        case 'icon': {
          const filename = await service.iconPath(request.ref);
          if (!filename) { data = null; break; }
          let cached = icons.get(filename);
          if (!cached || Date.now() - cached.at > 60000) {
            if (icons.size >= 512) icons.delete(icons.keys().next().value!);
            cached = { at: Date.now(), value: app.getFileIcon(filename, { size: 'large' })
              .then(icon => icon.isEmpty() ? null : icon.toDataURL()).catch(() => null) };
            icons.set(filename, cached);
          }
          data = await cached.value;
          break;
        }
        case 'write': data = await service.write(request.ref, request.base64, request.baseSha256); break;
        case 'publish': data = await service.publish(request.parent, request.name, request.base64, request.draftId); break;
        case 'createDraft': data = await service.createDraft(request.parent, request.name, request.base64); break;
        case 'createDraftFolder': data = await service.createDraftFolder(request.parent, request.name); break;
        case 'publishDraft': data = await service.publishDraft(request.ref); break;
        case 'publishDraftTree': data = await service.publishDraftTree(request.ref); break;
        case 'mkdir': data = await service.mkdir(request.parent, request.name); break;
        case 'rename': data = await service.rename(request.ref, request.name); break;
        case 'copy': data = await service.copy(request.ref, request.parent, request.name); break;
        case 'move': data = await service.move(request.ref, request.parent, request.name, request.baseSha256); break;
        case 'trash': data = await service.trash(request.ref, request.baseSha256); break;
        case 'reveal': data = await service.reveal(request.ref); break;
        case 'open': data = await service.open(request.ref); break;
        case 'metadata': data = await service.metadata(request.ref); break;
        case 'setMetadata': data = await service.setMetadata(request.ref, request.metadata); break;
        case 'watch': data = await service.watch(request.ref, event.sender.id); break;
        case 'unwatch': data = await service.unwatch(request.ref, event.sender.id); break;
        default: throw new WindowsFilesError('INVALID_ACTION', 'Команда проводника неизвестна.');
      }
      return { ok: true, data };
    } catch (error) { return windowsFilesFailure(error); }
  });
  app.once('before-quit', () => service.close());
  return service;
}
