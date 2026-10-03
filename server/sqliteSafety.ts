import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');

/** Fast format check before passing an untrusted file to the native SQLite parser. */
export function sqliteSignatureMatches(dbPath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dbPath, 'r');
    const header = Buffer.alloc(SQLITE_HEADER.length);
    return fs.readSync(fd, header, 0, header.length, 0) === header.length
      && header.equals(SQLITE_HEADER);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Ошибка чтения не доказывает порчу: база может быть занята или недоступна. */
export function assertHealthySqlite(dbPath: string): void {
  if (!sqliteSignatureMatches(dbPath)) {
    throw new Error(`Не удалось проверить базу «${dbPath}»: неверная сигнатура SQLite. Исходная база сохранена.`);
  }
  const Database = require('better-sqlite3');
  let db: any;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.pragma('quick_check');
    if (!Array.isArray(rows) || rows.length === 0 ||
        rows.some((row: any) => row.quick_check !== 'ok')) {
      throw new Error('Проверка целостности не пройдена');
    }
    const tables = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get();
    if (!tables?.c) throw new Error('В существующей базе отсутствуют таблицы');
  } catch (error: any) {
    throw new Error(`Не удалось проверить базу «${dbPath}»: ${error.message}. `
      + 'Исходная база сохранена. Проверьте доступ к файлу; при повреждении восстановите проверенную резервную копию в отдельный файл.');
  } finally {
    db?.close();
  }
}

/** SQLite backup учитывает журнал WAL, обычное копирование файла его теряет. */
export async function snapshotSqlite(source: string, destination: string): Promise<void> {
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const pending = `${destination}.${crypto.randomUUID()}.pending`;
  let db: any;
  try {
    db = new Database(source, { readonly: true, fileMustExist: true });
    await db.backup(pending);
    assertHealthySqlite(pending);
    // Не затираем прежнюю копию даже при совпадении имени назначения.
    fs.copyFileSync(pending, destination, fs.constants.COPYFILE_EXCL);
  } finally {
    db?.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(pending + suffix); } catch (_) { /* временный файл мог не создаться */ }
    }
  }
}
