/**
 * Временные папки загрузки обновления: `%TEMP%\flux-update-XXXXXX\Flux-<версия>.exe`.
 *
 * Папка создаётся на каждую загрузку, а удалялась только при неудаче: после
 * успешной установки exe весом в сотню мегабайт оставался в %TEMP% навсегда, и
 * каждое обновление добавляло ещё один. Удалить папку сразу после установки
 * нельзя — из неё же запущен помощник подмены, а Windows не даёт стереть
 * работающий exe. Поэтому: прежняя загрузка убирается, когда качается новая, а
 * всё, что осталось от прошлых установок, — при старте программы, если оно
 * старше суток (помощнику хватает секунд, сутки — с запасом на медленный диск).
 *
 * Модуль без Electron: проверяется scripts/test-update-temp.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

export const UPDATE_FOLDER_PREFIX = 'flux-update-';
export const STALE_UPDATE_FOLDER_MS = 24 * 3600 * 1000;

const ours = (name: string) => name.startsWith(UPDATE_FOLDER_PREFIX) && /^[A-Za-z0-9]+$/.test(name.slice(UPDATE_FOLDER_PREFIX.length));

/** Удалить папку загрузки, если это действительно наша папка во временном каталоге */
export async function removeUpdateFolder(folder: string, tempDir: string): Promise<boolean> {
  if (!folder || path.dirname(path.resolve(folder)) !== path.resolve(tempDir) || !ours(path.basename(folder))) return false;
  try { await fs.promises.rm(folder, { recursive: true, force: true }); return true; } catch (_) { return false; }
}

/**
 * Убрать папки загрузок старше суток. `keep` — пути, внутри которых работает
 * сам процесс (помощник подмены запущен из такой папки), их не трогаем,
 * сколько бы им ни было лет.
 */
export async function cleanStaleUpdateFolders(tempDir: string, keep: string[], now = Date.now(), maxAge = STALE_UPDATE_FOLDER_MS): Promise<string[]> {
  const root = path.resolve(tempDir), removed: string[] = [];
  const inside = (folder: string) => keep.some((k) => k && (path.resolve(k) + path.sep).toLowerCase().startsWith((folder + path.sep).toLowerCase()));
  let names: string[] = [];
  try { names = await fs.promises.readdir(root); } catch (_) { return removed; }
  for (const name of names) {
    if (!ours(name)) continue;
    const folder = path.join(root, name);
    try {
      const info = await fs.promises.lstat(folder);
      // Ссылка или файл с таким именем — не наша загрузка, трогать нельзя
      if (!info.isDirectory() || now - info.mtimeMs < maxAge || inside(folder)) continue;
      if (await removeUpdateFolder(folder, root)) removed.push(folder);
    } catch (_) { /* занято или уже нет — повторим при следующем запуске */ }
  }
  return removed;
}
