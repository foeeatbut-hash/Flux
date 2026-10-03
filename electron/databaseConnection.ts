import { createConnection } from 'mariadb';
import { companyDatabaseUri, mariaDatabaseOptions } from '../shared/companyDatabase';
export { companyDatabaseUri } from '../shared/companyDatabase';

export function databaseSummary(raw: unknown) {
  const uri = companyDatabaseUri(raw);
  if (!uri) return { configured: false, provider: raw ? 'unsupported' : null, host: '', database: '' };
  const url = new URL(uri);
  return { configured: true, provider: 'mysql', host: `${url.hostname}:${url.port || '3306'}`, database: decodeURIComponent(url.pathname.slice(1)) };
}

export interface DatabaseProbeConnection {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}
type ProbeOptions = Exclude<Parameters<typeof createConnection>[0], string> & { permitRedirect: boolean };
type Connector = (options: ProbeOptions) => Promise<DatabaseProbeConnection>;

/** Проба читает только текущую БД; никаких миграций или переключения конфигурации. */
export async function probeCompanyDatabase(raw: unknown, connect: Connector = createConnection) {
  const uri = companyDatabaseUri(raw);
  if (!uri) return { success: false, error: 'Введите URI MariaDB/MySQL с пользователем, паролем и именем базы.' };
  const url = new URL(uri);
  let connection: DatabaseProbeConnection | undefined;
  try {
    connection = await connect({ ...mariaDatabaseOptions(uri), socketTimeout: 8000, queryTimeout: 8000 });
    await connection.query('SELECT DATABASE() AS databaseName');
    return { success: true, provider: 'mysql', database: decodeURIComponent(url.pathname.slice(1)) };
  } catch (error: any) {
    const messages: Record<string, string> = {
      ER_ACCESS_DENIED_ERROR: 'База отклонила вход. Проверьте пользователя, пароль и разрешение на подключение с этого компьютера.',
      ER_BAD_DB_ERROR: 'Указанная база не найдена. Проверьте её имя.',
      ECONNREFUSED: 'База не принимает подключение на указанном порту.',
      ENOTFOUND: 'Не удалось найти компьютер базы. Проверьте имя или IP.',
      ETIMEDOUT: 'База не ответила вовремя. Проверьте сеть и доступ к порту базы.',
    };
    return { success: false, error: messages[error?.code] || 'Не удалось подключиться к базе. Проверьте URI, доступность сети и права пользователя.' };
  } finally { if (connection) { try { await connection.end(); } catch {} } }
}
