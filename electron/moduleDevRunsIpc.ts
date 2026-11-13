/**
 * Каналы IPC программ из разработки («Запустить во Flux»): список, согласие на разрешения, «Убрать».
 *
 * Вызывать их может только окно Flux. Окно называет программу и хеш сборки, но разрешает или нет главный
 * процесс: согласие принимается только для проверенного пакета с живой арендой, а отпечаток разрешений
 * сверяется с манифестом из него, а не с тем, что показало окно.
 */
import { ipcMain } from 'electron';
import { trustedAuthSender } from './authStorage';
import type { ModuleDevRuns } from './moduleDevRuns';

const refuse = { ok: false, error: 'Доступно только окну Flux.' };
const str = (v: unknown, max = 160) => (typeof v === 'string' && v.length <= max ? v : '');

export function registerModuleDevRunsIpc(host: { devRuns: ModuleDevRuns; ready: Promise<unknown>; userId: () => string; trusted?: (event: Electron.IpcMainInvokeEvent) => boolean }) {
  const trusted = host.trusted ?? trustedAuthSender;

  ipcMain.handle('modules:devRuns', async event => {
    if (!trusted(event)) return refuse;
    await host.ready;
    await host.devRuns.touch();
    return { ok: true, userId: host.userId(), items: host.devRuns.list() };
  });

  /** Согласие на разрешения сборки: в памяти, на человека и хеш сборки */
  ipcMain.handle('modules:devAccept', async (event, data: any) => {
    if (!trusted(event)) return refuse;
    await host.ready;
    await host.devRuns.touch();
    const result = host.devRuns.accept(str(data?.moduleId, 64), str(data?.sha256, 64), str(data?.digest, 4000));
    return result.ok ? { ok: true, items: host.devRuns.list() } : result;
  });

  /** «Убрать»: остановить и удалить папку обмена */
  ipcMain.handle('modules:devRemove', async (event, data: any) => {
    if (!trusted(event)) return refuse;
    await host.ready;
    const result = await host.devRuns.remove(str(data?.moduleId, 64));
    return { ...result, items: host.devRuns.list() };
  });
}
