/**
 * Архив проекта: «скачать проект архивом» и «импорт проекта из архива».
 *
 * В архив идёт то же, что в пакет (правила исключения, пределы), плюс сам .fluxignore. Распаковка защищена от записи
 * за пределы папки (имена с `..`, абсолютные пути, обратная косая), числа файлов и размера «бомбы».
 */
import JSZip from 'jszip';
import fs from 'node:fs';
import { MODULE_BUNDLE_MAX } from '../../modules/trust/claims';
import { IGNORE_FILE, MAX_FILES, Workspace, WorkspaceFailure } from './workspace';

export async function zipProject(space: Workspace): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(space.pack())) zip.file(name, bytes);
  if (space.exists(IGNORE_FILE)) zip.file(IGNORE_FILE, space.read(IGNORE_FILE));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** Распаковка в пустую (или новую) папку. Возвращает число файлов */
export async function unzipInto(bytes: Uint8Array, folder: string): Promise<number> {
  if (bytes.length > MODULE_BUNDLE_MAX) throw new WorkspaceFailure('Архив больше 32 МиБ.');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new WorkspaceFailure('Это не архив ZIP или он повреждён.'); }
  const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  if (!names.length || names.length > MAX_FILES + 1) throw new WorkspaceFailure(`В архиве должно быть от 1 до ${MAX_FILES} файлов.`);
  // Архив с общей верхней папкой (проект.zip/проект/…) распаковывается без неё
  const top = names.every(n => n.includes('/')) && new Set(names.map(n => n.split('/')[0])).size === 1 ? `${names[0].split('/')[0]}/` : '';
  if (fs.existsSync(folder) && fs.readdirSync(folder).length) throw new WorkspaceFailure('Папка для проекта не пуста: выберите пустую или новую.');
  fs.mkdirSync(folder, { recursive: true });
  const space = new Workspace(folder);
  let total = 0;
  try {
    for (const name of names) {
      const rel = top && name.startsWith(top) ? name.slice(top.length) : name;
      // Служебные каталоги чужих инструментов в проект не переносятся
      if (/(^|\/)(\.git|node_modules|\.flux)\//.test(rel)) continue;
      // Заявленный размер проверяется до распаковки: «бомба» не раздувается в памяти
      const declared = Number((zip.files[name] as any)._data?.uncompressedSize || 0);
      if (total + declared > MODULE_BUNDLE_MAX) throw new WorkspaceFailure('Распакованный проект больше 32 МиБ.');
      const data = await zip.files[name].async('uint8array');
      total += data.length;
      if (total > MODULE_BUNDLE_MAX) throw new WorkspaceFailure('Распакованный проект больше 32 МиБ.');
      space.write(rel, data); // те же проверки путей, что у любой записи: `..`, `\`, абсолютные пути отвергаются здесь
    }
  } catch (e) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw e;
  }
  return names.length;
}
