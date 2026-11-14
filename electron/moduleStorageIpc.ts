/**
 * Каналы IPC хранилища самостоятельной программы (electron/moduleStorage.ts).
 *
 * Вызывать их может только окно Flux. Окно называет программу и версию, но самостоятельная ли она и какая область, решает
 * главный процесс по проверенному выпуску; человека он берёт из своих данных. Удалить через IPC можно только области
 * `released` (явное удаление программы в Store) и `dev` («Очистить хранилище» у сборки из разработки); область Studio окну
 * Flux не принадлежит.
 */
import { ipcMain } from 'electron';
import { trustedAuthSender } from './authStorage';
import type { ModuleStorage } from './moduleStorage';

const refuse = { ok: false, error: 'Доступно только окну Flux.' };
const str = (v: unknown, max = 160) => (typeof v === 'string' && v.length <= max ? v : '');

export function registerModuleStorageIpc(host: { storage: ModuleStorage; ready: Promise<unknown>; trusted?: (event: Electron.IpcMainInvokeEvent) => boolean }) {
  const trusted = host.trusted ?? trustedAuthSender;
  const scopeOf = (v: unknown) => (v === 'released' || v === 'dev' ? v : null);

  ipcMain.handle('modules:state-load', async (event, data: any) => {
    if (!trusted(event)) return refuse;
    await host.ready;
    return host.storage.load(str(data?.moduleId, 64), str(data?.version, 40));
  });
  ipcMain.handle('modules:state-keep', async (event, data: any) => {
    if (!trusted(event)) return refuse;
    await host.ready;
    return host.storage.keep(str(data?.moduleId, 64), str(data?.version, 40), data?.state);
  });
  ipcMain.handle('modules:state-clear', async (event, data: any) => {
    if (!trusted(event)) return refuse;
    await host.ready;
    const scope = scopeOf(data?.scope);
    if (!scope) return { ok: false, error: 'Неизвестная область хранилища.' };
    const result = await host.storage.clear(str(data?.moduleId, 64), scope);
    return result.ok ? result : { ok: false, error: 'Хранилище программы не очищено.' };
  });
  ipcMain.handle('modules:state-usage', async (event, data: any) => {
    if (!trusted(event)) return refuse;
    await host.ready;
    const scope = scopeOf(data?.scope);
    if (!scope) return { ok: false, error: 'Неизвестная область хранилища.' };
    return { ok: true, bytes: await host.storage.usage(str(data?.moduleId, 64), scope) };
  });
}
