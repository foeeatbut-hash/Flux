import { validateDatabaseUri } from './databaseUri';

/** Настройка приложения допускает только корпоративную MariaDB/MySQL. */
export function companyDatabaseUri(raw: unknown): string | null {
  const uri = validateDatabaseUri(raw);
  if (!uri) return null;
  try {
    const url = new URL(uri);
    if (!['mysql:', 'mariadb:'].includes(url.protocol) || !url.username || !url.password) return null;
    if (/[\u0000-\u0020\u007f]/.test(uri) || /[\u0000-\u001f\u007f]/.test(decodeURIComponent(url.username + url.password + url.pathname))) return null;
    // URI не может задавать initSql, чтение файлов, socketPath или обход TLS.
    for (const [key, value] of url.searchParams) if (key !== 'ssl' || !['true', 'false'].includes(value)) return null;
    return uri;
  } catch { return null; }
}

/** Только явно разрешённые параметры драйвера; URI не задаёт чтение файлов или SQL. */
export function mariaDatabaseOptions(raw: unknown) {
  const uri = companyDatabaseUri(raw);
  if (!uri) throw new Error('Введите корректное подключение MariaDB/MySQL.');
  const url = new URL(uri);
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 3306),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: url.searchParams.get('ssl') === 'true' ? { rejectUnauthorized: true } : false,
    connectTimeout: 8000, permitLocalInfile: false, permitRedirect: false, allowPublicKeyRetrieval: false,
  };
}
