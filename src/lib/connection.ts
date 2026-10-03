import { validateDatabaseUri } from '../../shared/databaseUri';

export type DatabaseConnection = { kind: 'database'; uri: string } | { kind: 'error'; error: string };

/** Проверяет формат общей MariaDB до передачи реквизитов через Electron IPC. */
export function readDatabaseConnection(raw: string): DatabaseConnection {
  const uri = validateDatabaseUri(raw);
  if (!uri) return { kind: 'error', error: 'Введите корректный URI MariaDB/MySQL: mysql://USER:PASSWORD@HOST:3306/БАЗА.' };
  if (!/^mysql:/i.test(uri) && !/^mariadb:/i.test(uri)) {
    return { kind: 'error', error: 'Для общей базы Flux укажите URI MariaDB/MySQL, начинающийся с mysql:// или mariadb://.' };
  }
  const credentials = new URL(uri);
  if (!credentials.username || !credentials.password) {
    return { kind: 'error', error: 'Укажите имя отдельной учётной записи MariaDB и её пароль в URI подключения.' };
  }
  return { kind: 'database', uri };
}
