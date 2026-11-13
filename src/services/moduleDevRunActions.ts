/**
 * Программы из разработки («Запустить во Flux» из Studio) — действия человека в окне Flux.
 *
 * Окно ничего не решает: «принять разрешения» и «убрать» уходят в главный процесс, который сверяет хеш сборки и
 * отпечаток разрешений с проверенным пакетом (electron/moduleDevRuns.ts). Список обновляется по событию главного
 * процесса (пакет появился, истёк, убран), а не опросом.
 */
import { permissionsDigest, permissionLines } from '../../modules/store/model';
import { DEV_BADGE, type DevRunItem } from '../../modules/store/devRun';
import { bridge } from './moduleReleaseService';
import { local } from './moduleStoreService';
import { reloadLocal } from './moduleStoreActions';

export { DEV_BADGE };

/** Строки разрешений для окна согласия: те же, что показывает Store при установке */
export const devPermissions = (item: DevRunItem) => (item.manifest ? permissionLines(item.manifest) : []);

export async function acceptDevRun(item: DevRunItem): Promise<void> {
  if (!item.manifest) throw new Error('Пакет не прошёл проверку: принимать нечего');
  await local('modules:devAccept', { moduleId: item.moduleId, sha256: item.sha256, digest: permissionsDigest(item.manifest) });
  await reloadLocal();
}

export async function removeDevRun(moduleId: string): Promise<void> {
  await local('modules:devRemove', { moduleId });
  await reloadLocal();
}

/** Главный процесс сообщает об изменении: пакет появился, срок аренды вышел, убран или принят */
export function watchDevRuns(): () => void {
  const ipc = (window as any).electron?.ipcRenderer as { on?: (channel: string, fn: () => void) => (() => void) | void } | undefined;
  if (!ipc?.on || !bridge()) return () => {};
  let stop: unknown;
  try { stop = ipc.on('modules:devChanged', () => { void reloadLocal(); }); } catch { return () => {}; }
  return () => { try { if (typeof stop === 'function') stop(); } catch { /* окно закрывается */ } };
}
