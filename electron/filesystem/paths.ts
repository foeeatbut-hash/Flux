import path from 'node:path';
import fs from 'node:fs/promises';

export class WindowsFilesError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'WindowsFilesError'; }
}
export function validateWindowsName(name: unknown): string {
  if (typeof name !== 'string' || !name || name.length > 255 || /[<>:"/\\|?*\u0000-\u001f]/u.test(name)
    || /[. ]$/u.test(name) || name === '.' || name === '..'
    || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(name)) {
    throw new WindowsFilesError('INVALID_NAME', 'Недопустимое имя Windows. Уберите специальные символы и завершающие точки.');
  }
  return name;
}
export function relativeSegments(relative: unknown): string[] {
  if (typeof relative !== 'string' || relative.length > 4096 || relative.includes('\\') || path.isAbsolute(relative)) {
    throw new WindowsFilesError('INVALID_PATH', 'Укажите путь внутри подключённой папки.');
  }
  if (relative === '') return [];
  return relative.split('/').map(validateWindowsName);
}
export function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export async function resolveSafePath(root: string, relative: unknown, allowMissingLeaf = false): Promise<string> {
  const parts = relativeSegments(relative);
  let current = root;
  const canonicalRoot = await fs.realpath(root);
  // Корень тоже проверяется заново: его могли заменить junction после подключения.
  if (canonicalRoot !== root || (await fs.lstat(root)).isSymbolicLink()) {
    throw new WindowsFilesError('ROOT_CHANGED', 'Подключённая папка перенесена или заменена ссылкой. Подключите её заново.');
  }
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error: any) {
      if (error.code === 'ENOENT' && allowMissingLeaf && i === parts.length - 1) return current;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new WindowsFilesError('LINK_BLOCKED', 'Переход по ссылке или junction требует отдельного подключения папки.');
    const actual = await fs.realpath(current);
    if (!isContained(root, actual)) throw new WindowsFilesError('OUTSIDE_ROOT', 'Путь выходит за пределы подключённой папки.');
    if (i < parts.length - 1 && !stat.isDirectory()) throw new WindowsFilesError('NOT_DIRECTORY', 'Родитель пути не является папкой.');
  }
  return current;
}
export function joinRelative(parent: string, name: string): string {
  relativeSegments(parent); validateWindowsName(name); return parent ? `${parent}/${name}` : name;
}
