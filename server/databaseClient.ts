import { dialectOf, type Dialect } from './ddl';
import { validateDatabaseUri } from '../shared/databaseUri';

interface ClientDependencies {
  load: (name: string) => any;
  sqliteAdapter: (url: string) => any;
  selectDialect: (dialect: Dialect) => void;
}

/** Ошибка общей БД не должна создавать независимую локальную базу под видом подключения к компании. */
export function buildDatabaseClient(mode: string, url: string, deps: ClientDependencies): any {
  if (mode !== 'LOCAL' && mode !== 'REMOTE') throw new Error('Неизвестный режим базы данных.');
  if (mode === 'REMOTE' && !validateDatabaseUri(url))
    throw new Error('Проверьте строку подключения к общей базе данных: mysql://… или postgresql://…');
  const dialect = dialectOf(mode, url);
  deps.selectDialect(dialect);
  if (mode === 'REMOTE') {
    if (dialect === 'mysql') {
      const { PrismaClient } = deps.load('@prisma/client-mysql');
      const { PrismaMariaDb } = deps.load('@prisma/adapter-mariadb');
      return new PrismaClient({ adapter: new PrismaMariaDb(url.replace(/^mariadb:\/\//i, 'mysql://')) });
    }
    const { PrismaClient } = deps.load('@prisma/client-pg');
    const { PrismaPg } = deps.load('@prisma/adapter-pg');
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  }
  const { PrismaClient } = deps.load('@prisma/client-sqlite');
  return new PrismaClient({ adapter: deps.sqliteAdapter(url) });
}
