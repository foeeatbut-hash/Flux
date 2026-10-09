import { app, dialog, ipcMain, shell, clipboard, BrowserWindow, nativeImage, webContents, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WINDOWS_FILES_CHANNEL, WINDOWS_FILES_CHANGED, WINDOWS_FILES_DROP, WINDOWS_FILES_SEARCH, type WindowsFilesRequest, type WindowsFilesResponse } from '../../filesystem/contracts';
import { createArchive } from './archives';
import { replaceCopy } from './replacementCopy';
import { WindowsFilesService } from './service';
import { WindowsFilesError } from './paths';
import { windowsPublicDesktopFolder } from '../desktopShell';
import { enumerateWindowsVolumes, openWindowsRecycleBin } from './nativePlaces';
import { NativeShellHost } from '../nativeShellHost';
import { ShellCommands } from './shellCommands';
import { ExplorerBridge, EXPLORER_WRITE_ACTIONS, isExplorerAction, undoGroup } from './explorerBridge';
import { ViewStateStore } from './viewState';

export interface WindowsFilesIpcOptions {
  isTrusted: (event: IpcMainInvokeEvent) => boolean;
  mayRead: (event: IpcMainInvokeEvent) => boolean | Promise<boolean>;
  mayWrite: (event: IpcMainInvokeEvent) => boolean | Promise<boolean>;
}
const WRITE_ACTIONS = new Set(['write', 'publish', 'createDraft', 'createDraftFolder', 'publishDraft', 'publishDraftTree', 'restoreDraft', 'mkdir', 'rename', 'copy', 'move', 'trash', 'permanentDelete', 'replaceCopy', 'archive', 'purgeDraft', 'setMetadata', ...EXPLORER_WRITE_ACTIONS]);
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
/** Том для интерфейса: метка, буква и занятое место — всё, что нужно плитке «Локальный диск (C:)». */
const volumeFields = (volume: Awaited<ReturnType<typeof enumerateWindowsVolumes>>[number]) => ({
  id: volume.id, name: volume.name, kind: volume.kind, networkPath: volume.networkPath, size: volume.size, free: volume.free,
  label: volume.label, letter: volume.letter, used: volume.used, ...(volume.fileSystem ? { fileSystem: volume.fileSystem } : {}),
});
export function windowsFilesFailure(error: any): WindowsFilesResponse {
  if (error instanceof WindowsFilesError) return { ok: false, error: { code: error.code, message: error.message } };
  const code = typeof error?.code === 'string' ? error.code : 'FILESYSTEM_ERROR';
  return { ok: false, error: { code, message: ERROR_MESSAGES[code] || 'Не удалось выполнить действие с файлом. Исходные данные сохранены; повторите действие.' } };
}
export async function registerWindowsFilesIpc(options: WindowsFilesIpcOptions): Promise<WindowsFilesService> {
  const activeSenders = new Set<number>();
  const icons = new Map<string, { at: number; value: Promise<string | null> }>();
  // Нативный помощник поднимается при первом обращении и сам засыпает; до этого он ничего не стоит.
  const nativeHost = new NativeShellHost();
  let shellCommands: ShellCommands;
  const service = await WindowsFilesService.create({
    userData: app.getPath('userData'),
    fileDetails: process.platform === 'win32' ? async paths => await nativeHost.call('file-info', { paths }) as { hidden: boolean }[] : undefined,
    knownFolders: { desktop: app.getPath('desktop'), documents: app.getPath('documents'), downloads: app.getPath('downloads') },
    trashItem: filename => shell.trashItem(filename),
    showItemInFolder: filename => shell.showItemInFolder(filename),
    openPath: filename => shell.openPath(filename),
    restoreFromTrash: info => shellCommands.restoreFromTrash(info),
    startDrag: async (owner, files) => {
      const target = webContents.fromId(owner);
      if (!target || target.isDestroyed()) throw new WindowsFilesError('NOT_SUPPORTED', 'Окно закрыто.');
      // Значок перетаскиваемого файла берётся у Windows; без него Electron отказывается начинать перетаскивание.
      const icon = await app.getFileIcon(files[0], { size: 'normal' }).catch(() => nativeImage.createEmpty());
      target.startDrag({ file: files[0], files, icon: icon.isEmpty() ? nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=') : icon });
    },
    onChanged: change => {
      // События несут лишь capability и относительный путь; содержимое повторно читается с проверкой сессии.
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && activeSenders.has(window.webContents.id)) window.webContents.send(WINDOWS_FILES_CHANGED, change);
    },
  });
  shellCommands = new ShellCommands(service, nativeHost);
  const viewState = await ViewStateStore.load(app.getPath('userData'));
  const explorer = new ExplorerBridge({ service, shell: shellCommands, viewState,
    // Страница поиска уходит только окну, которое его запустило и ещё живо.
    emitSearch: (owner, event) => { const target = webContents.fromId(owner); if (target && !target.isDestroyed() && activeSenders.has(owner)) target.send(WINDOWS_FILES_SEARCH, event); } });
  // Пути брошенных файлов приходят из preload по каналу, которого страница не видит; страница получает только билет.
  ipcMain.on(WINDOWS_FILES_DROP, (event: IpcMainEvent, payload: { ticket?: unknown; paths?: unknown } | undefined) => {
    try { if (options.isTrusted(event as unknown as IpcMainInvokeEvent)) explorer.registerDrop(event.sender.id, payload?.ticket, payload?.paths); } catch { /* неверный билет — просто нет билета */ }
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
        event.sender.once('destroyed', () => { activeSenders.delete(event.sender.id); service.closeOwner(event.sender.id); explorer.closeOwner(event.sender.id); });
      }
      let data: unknown;
      switch (request.action) {
        case 'roots': data = await service.roots(); break;
        case 'volumes': {
          const volumes = await enumerateWindowsVolumes();
          data = await Promise.all(volumes.map(async volume => {
            try {
              const root = await service.addRoot(volume.path, volume.name);
              return { ...volumeFields(volume), root };
            } catch {
              return { ...volumeFields(volume), root: { id: '', name: volume.name, kind: 'custom', available: false } };
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
        case 'fileHash': data = await service.fileHash(request.ref); break;
        case 'stat': data = await service.entry(request.ref); break;
        case 'copyPath': {
          if (!Array.isArray(request.refs) || !request.refs.length || request.refs.length > 100) throw new WindowsFilesError('INVALID_REQUEST', 'Выберите от 1 до 100 объектов.');
          const paths = await Promise.all(request.refs.map(ref => service.filename(ref)));
          clipboard.writeText(paths.map(filename => `"${filename}"`).join('\r\n')); data = { copied: true }; break;
        }
        case 'archive': data = await createArchive(service, request, app.isPackaged && process.platform === 'win32' ? path.join(process.resourcesPath, 'archive', '7z.exe') : undefined); break;
        case 'purgeDraft': data = await service.purgeDraft(request.ref); break;
        case 'replaceCopy': data = await replaceCopy(service, request, undoGroup(request.group)); break;
        case 'permanentDelete': data = await service.permanentDelete(request.ref, request.baseSha256); break;
        case 'write': data = await service.write(request.ref, request.base64, request.baseSha256); break;
        case 'publish': data = await service.publish(request.parent, request.name, request.base64, request.draftId); break;
        // group — номер пакета для отмены: вставка нескольких файлов отменяется одним Ctrl+Z.
        case 'createDraft': data = await service.createDraft(request.parent, request.name, request.base64, { group: undoGroup(request.group) }); break;
        case 'createDraftFolder': data = await service.createDraftFolder(request.parent, request.name, { group: undoGroup(request.group) }); break;
        case 'publishDraft': data = await service.publishDraft(request.ref, request.choices); break;
        case 'publishDraftTree': data = await service.publishDraftTree(request.ref, request.choices); break;
        case 'mkdir': data = await service.mkdir(request.parent, request.name, { group: undoGroup(request.group) }); break;
        case 'rename': data = await service.rename(request.ref, request.name, { group: undoGroup(request.group) }); break;
        case 'copy': data = await service.copy(request.ref, request.parent, request.name, { group: undoGroup(request.group), carryMeta: request.carryMeta === true }); break;
        case 'move': data = await service.move(request.ref, request.parent, request.name, request.baseSha256, { group: undoGroup(request.group) }); break;
        case 'trash': data = await service.trash(request.ref, request.baseSha256, { group: undoGroup(request.group) }); break;
        case 'reveal': data = await service.reveal(request.ref); break;
        case 'open': data = await service.open(request.ref); break;
        case 'metadata': data = await service.metadata(request.ref); break;
        case 'setMetadata': data = await service.setMetadata(request.ref, request.metadata); break;
        case 'watch': data = await service.watch(request.ref, event.sender.id); break;
        case 'unwatch': data = await service.unwatch(request.ref, event.sender.id); break;
        default:
          if (!isExplorerAction(request.action)) throw new WindowsFilesError('INVALID_ACTION', 'Команда проводника неизвестна.');
          data = await explorer.handle(request, event.sender.id);
      }
      return { ok: true, data };
    } catch (error) { return windowsFilesFailure(error); }
  });
  app.once('before-quit', () => { service.close(); nativeHost.close(); });
  return service;
}
