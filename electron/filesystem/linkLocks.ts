/**
 * Блокировка файлов, связанных со строками документооборота (docs/docflow-program.md, 3.7).
 *
 * Состояние замков хранит сервер; страница присылает сюда список заблокированных путей, а
 * файловый мост отклоняет над ними всё, что меняет, переносит, переименовывает или удаляет
 * файл. Заодно блокировка ставит файлу атрибут «только чтение» (в Windows — обычный атрибут
 * файла, в других системах — запрет записи): это защита от случайной правки в чужой программе,
 * а не полная защита — атрибут может снять сам пользователь Windows, права NTFS не меняются.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Один ключ на путь: в Windows регистр не важен, разделители приведены к одному виду. */
export const lockKeyOf = (filename: string): string =>
  process.platform === 'win32' ? path.win32.normalize(filename).toLocaleLowerCase('en-US') : path.resolve(filename);

export const MAX_LOCKED_FILES = 50_000;

export class LinkLocks {
  private keys = new Set<string>();
  size(): number { return this.keys.size; }
  has(filename: string): boolean { return this.keys.has(lockKeyOf(filename)); }
  drop(filename: string): void { this.keys.delete(lockKeyOf(filename)); }
  /** Внутри папки есть заблокированный файл — саму папку переносить и удалять нельзя. */
  inside(directory: string): boolean {
    const prefix = lockKeyOf(directory).replace(/[\\/]+$/, '') + path.sep;
    for (const key of this.keys) if (key.startsWith(prefix)) return true;
    return false;
  }
  /**
   * Новый список заблокированных путей целиком. Возвращает, какие файлы стали заблокированными, а какие освободились
   * по сравнению с прежним списком: им меняется атрибут «только чтение».
   */
  replace(filenames: string[]): { added: string[]; removed: string[] } {
    const next = new Map<string, string>();
    for (const name of filenames.slice(0, MAX_LOCKED_FILES)) next.set(lockKeyOf(name), name);
    const added = [...next].filter(([key]) => !this.keys.has(key)).map(([, name]) => name);
    const removed = [...this.keys].filter((key) => !next.has(key));
    this.keys = new Set(next.keys());
    return { added, removed };
  }
}

/** Атрибут «только чтение» на заблокированном файле; сбой (нет файла, сетевой диск без прав) блокировку не отменяет. */
export async function protectFile(filename: string, locked: boolean): Promise<boolean> {
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile()) return false;
    await fs.chmod(filename, locked ? stat.mode & ~0o222 : stat.mode | 0o200);
    return true;
  } catch { return false; }
}
