import fs from 'node:fs/promises';
import path from 'node:path';
import type { WindowsFileRef, WindowsFolderNode } from '../../filesystem/contracts';
import { WindowsFilesError, joinRelative, validateWindowsName } from './paths';
import type { WindowsFilesService } from './service';

const MAX_FOLDERS = 5000;
const PEEK_FOLDERS = 200;
const PEEK_BUDGET_MS = 3000;
// Служебные папки корня тома: Windows прячет их в дереве, а открыть без прав всё равно нельзя.
const HIDDEN_AT_ROOT = new Set(['system volume information', '$recycle.bin', '$windows.~bt', '$windows.~ws', 'config.msi', 'recovery']);

/** Есть ли внутри хотя бы одна подпапка: читаются первые записи, не весь каталог. */
async function hasSubfolder(folder: string): Promise<boolean> {
  let directory;
  try { directory = await fs.opendir(folder); } catch { return false; }
  try {
    let seen = 0;
    for await (const item of directory) {
      if (item.isDirectory() && !item.isSymbolicLink()) return true;
      if (++seen >= 64) return true; // дальше смотреть дорого; стрелка раскрытия честнее пропавшей
    }
    return false;
  } catch { return false; } finally { await directory.close().catch(() => undefined); }
}

/**
 * Только подпапки — для дерева навигации. Здесь нет ни размеров, ни дат, ни
 * идентичности файлов: каждый такой запрос в list() стоил lstat на каждый
 * объект, а дерево раскрывается десятками папок подряд.
 */
export async function listChildFolders(service: WindowsFilesService, input: WindowsFileRef, peek = false) {
  const ref = service.resolveRef(input);
  const draft = ref.draftId ? service.state.data.drafts[ref.draftId] : null;
  if (draft && draft.kind !== 'directory') throw new WindowsFilesError('NOT_DIRECTORY', 'Откройте папку.');
  const virtual = !!draft && !draft.publishedRef;
  const folders: WindowsFolderNode[] = []; let truncated = false;
  let base: string | null = null;
  if (!virtual) {
    base = await service.filename({ rootId: ref.rootId, relativePath: ref.relativePath });
    if (!(await fs.stat(base)).isDirectory()) throw new WindowsFilesError('NOT_DIRECTORY', 'Откройте папку.');
    const directory = await fs.opendir(base);
    try {
      for await (const item of directory) {
        // Ссылка и junction в дереве не раскрываются: мост всё равно откажет в переходе по ним.
        if (!item.isDirectory() || item.isSymbolicLink()) continue;
        if (!ref.relativePath && HIDDEN_AT_ROOT.has(item.name.toLowerCase())) continue;
        try { validateWindowsName(item.name); } catch { continue; }
        if (folders.length >= MAX_FOLDERS) { truncated = true; break; }
        folders.push({ name: item.name, relativePath: joinRelative(ref.relativePath, item.name), storage: 'windows' });
      }
    } finally { await directory.close().catch(() => undefined); }
  }
  // Папки-черновики — ветви того же дерева: «папка — часть Проводника».
  const names = new Set(folders.map(folder => folder.name.toLocaleLowerCase('en-US')));
  for (const item of service.draftsIn(ref)) {
    if (item.kind !== 'directory' || names.has(item.name.toLocaleLowerCase('en-US'))) continue;
    folders.push({ name: item.name, relativePath: joinRelative(item.parent.relativePath, item.name), storage: 'flux', draftId: item.id,
      hasChildren: service.draftsIn({ rootId: item.parent.rootId, relativePath: joinRelative(item.parent.relativePath, item.name), draftId: item.id }).some(child => child.kind === 'directory') });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' }));
  if (peek && base) {
    const began = Date.now(); let peeked = 0;
    for (const folder of folders) {
      if (folder.storage !== 'windows') continue;
      if (++peeked > PEEK_FOLDERS || Date.now() - began > PEEK_BUDGET_MS) break; // остальные раскрываются стрелкой без подсказки
      folder.hasChildren = await hasSubfolder(path.join(base, folder.name))
        || service.draftsIn({ rootId: ref.rootId, relativePath: folder.relativePath }).some(child => child.kind === 'directory');
    }
  }
  const root = (await service.roots()).find(item => item.id === ref.rootId);
  return { root, relativePath: ref.relativePath, folders, truncated };
}
