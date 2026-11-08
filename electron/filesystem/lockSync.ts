/**
 * Список заблокированных файлов для моста (docs/docflow-program.md, 3.7). Главный процесс сам спрашивает сервер
 * (замки связей и привязки папок проекта) и переводит «папка + путь внутри неё» в ссылки на этом компьютере:
 * страница мосту список не диктует, а только просит обновить.
 */
import type { WindowsFileRef, PortableFolderLocator } from '../../filesystem/contracts';

export interface LockSyncDeps {
  serverJson: (path: string) => Promise<any>;
  resolveFolder: (locator: PortableFolderLocator) => Promise<WindowsFileRef | null>;
}

export async function collectServerLocks(deps: LockSyncDeps): Promise<WindowsFileRef[]> {
  const [ledger, locks] = await Promise.all([deps.serverJson('/api/explorer/project-bindings'), deps.serverJson('/api/docflow/locks')]);
  const bindings: any[] = Array.isArray(ledger?.bindings) ? ledger.bindings : [];
  const links: any[] = Array.isArray(locks?.links) ? locks.links.slice(0, 50_000) : [];
  const folders = new Map<string, WindowsFileRef | null>();
  const refs: WindowsFileRef[] = [];
  for (const link of links) {
    if (typeof link?.folderKey !== 'string' || typeof link?.relativePath !== 'string') continue;
    if (!folders.has(link.folderKey)) {
      const binding = bindings.find((b) => b?.locationKey === link.folderKey && b?.locator);
      folders.set(link.folderKey, binding ? await deps.resolveFolder(binding.locator).catch(() => null) : null);
    }
    const base = folders.get(link.folderKey);
    if (base) refs.push({ rootId: base.rootId, relativePath: [base.relativePath, link.relativePath].filter(Boolean).join('/') });
  }
  return refs;
}
