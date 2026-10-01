import { app, ipcMain, webContents, type IpcMainInvokeEvent } from 'electron';
import { LocalOfficeSessions, type LocalOfficeRequest } from './localOfficeSessions';
import type { WindowsFilesService } from './filesystem/service';
import { WindowsFilesError } from './filesystem/paths';
import { windowsFilesFailure } from './filesystem/ipc';

export interface LocalOfficeIpcOptions {
  files: WindowsFilesService;
  userData?: string;
  resourcesDir?: string;
  isTrusted(event: IpcMainInvokeEvent): boolean;
  mayRead(event: IpcMainInvokeEvent): boolean | Promise<boolean>;
  mayWrite(event: IpcMainInvokeEvent): boolean | Promise<boolean>;
}
/** register once, after registerWindowsFilesIpc; preload exposes these two channels only. */
export function registerLocalOfficeIpc(options: LocalOfficeIpcOptions): LocalOfficeSessions {
  const owners = new Set<number>();
  const manager = new LocalOfficeSessions({
    files: options.files, userData: options.userData || app.getPath('userData'), resourcesDir: options.resourcesDir,
    onEvent(owner, event) {
      const sender = webContents.fromId(owner);
      if (sender && !sender.isDestroyed()) sender.send('windows-office:event', event);
    },
  });
  ipcMain.handle('windows-office:invoke', async (event, request: LocalOfficeRequest) => {
    try {
      if (!options.isTrusted(event)) throw new WindowsFilesError('UNAUTHORIZED', 'Локальный редактор доступен только в окне Flux.');
      if (!owners.has(event.sender.id)) {
        owners.add(event.sender.id);
        event.sender.once('destroyed', () => { owners.delete(event.sender.id); void manager.closeOwner(event.sender.id); });
      }
      const auth = { mayRead: () => !event.sender.isDestroyed() && options.isTrusted(event) && options.mayRead(event),
        mayWrite: () => !event.sender.isDestroyed() && options.isTrusted(event) && options.mayWrite(event) };
      const data = await manager.handle(event.sender.id, request, auth);
      return { ok: true, data };
    } catch (error) { return windowsFilesFailure(error); }
  });
  app.once('before-quit', () => { void manager.dispose(); });
  return manager;
}
