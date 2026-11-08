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
  hasKey(key: string): boolean { return this.keys.has(key); }
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

/**
 * Атрибут «только чтение»: ставится или снимается; возвращает, был ли файл только для чтения ДО этого вызова.
 * Сбой (нет файла, сетевой диск без прав) блокировку не отменяет: она держится в мосте.
 */
export async function setReadOnly(filename: string, on: boolean): Promise<{ ok: boolean; before: boolean }> {
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile()) return { ok: false, before: false };
    const before = (stat.mode & 0o222) === 0;
    await fs.chmod(filename, on ? stat.mode & ~0o222 : stat.mode | 0o200);
    return { ok: true, before };
  } catch { return { ok: false, before: false }; }
}

/** Что поставили мы: путь и был ли у файла «только чтение» до блокировки — такой атрибут при снятии замка не трогается. */
export type ProtectedFiles = Record<string, { path: string; readOnlyBefore: boolean }>;

export async function loadProtected(file: string): Promise<ProtectedFiles> {
  try { const v = JSON.parse(await fs.readFile(file, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
export async function saveProtected(file: string, value: ProtectedFiles): Promise<void> {
  try { await fs.writeFile(file, JSON.stringify(value)); } catch { /* память атрибутов — удобство, не условие блокировки */ }
}
