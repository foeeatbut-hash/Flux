/** Проверки выбора драйвера и метаданных /api/health без подключения к БД.
 * Запуск: node --import tsx scripts/test-database-client.ts
 */
import { buildDatabaseClient } from '../server/databaseClient';
import { registerSystemRoutes } from '../server/routes/system';
import { getDialect, setDialect, type Dialect } from '../server/ddl';
import { setPrisma } from '../server/context';

let passed = 0, failed = 0;
const eq = (name: string, got: any, want: any) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { passed++; return; }
  failed++;
  console.error(`  ✗ ${name}\n      получено: ${JSON.stringify(got)}\n      ожидалось: ${JSON.stringify(want)}`);
};
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получено: ${String(got)}`}`);
};
const throws = (name: string, fn: () => unknown, includes?: string) => {
  try { fn(); check(name, false, 'ошибка не возникла'); }
  catch (err: any) { check(name, includes ? String(err?.message).includes(includes) : true, err?.message); }
};

console.log('Выбор и создание драйвера');
{
  const calls: string[] = [];
  const dialects: Dialect[] = [];
  const uri = 'mysql://demo:p%40ss%5E%24@db.example.test:3306/flux';
  const deps = {
    load(name: string) {
      calls.push(name);
      if (name === '@prisma/client-mysql') return { PrismaClient: class { constructor(public options: any) { (this as any).kind = 'mysql'; } } };
      if (name === '@prisma/adapter-mariadb') return { PrismaMariaDb: class { constructor(public url: string) {} } };
      throw new Error(`unexpected load: ${name}`);
    },
    sqliteAdapter: (url: string) => ({ url }),
    selectDialect: (d: Dialect) => dialects.push(d),
  };
  const result = buildDatabaseClient('REMOTE', uri, deps);
  eq('REMOTE mysql возвращает свой PrismaClient', (result as any).kind, 'mysql');
  eq('URI с encoded @ ^ и $ разобран без изменения пароля', result.options.adapter.url.password, 'p@ss^$');
  eq('адаптер запрещает чтение локальных файлов через LOAD DATA', result.options.adapter.url.permitLocalInfile, false);
  eq('адаптер запрещает перенаправление соединения', result.options.adapter.url.permitRedirect, false);
  eq('mysql модуль выбран', calls, ['@prisma/client-mysql', '@prisma/adapter-mariadb']);
  eq('запрошенный mysql диалект установлен', dialects, ['mysql']);

  const pgCalls: string[] = [];
  const pgDeps = {
    load(name: string) {
      pgCalls.push(name);
      if (name === '@prisma/client-pg') return { PrismaClient: class { constructor(public options: any) {} } };
      if (name === '@prisma/adapter-pg') return { PrismaPg: class { constructor(public options: any) {} } };
      throw new Error(`unexpected load: ${name}`);
    }, sqliteAdapter: (_url: string) => { throw new Error('sqlite must not load'); },
    selectDialect: (d: Dialect) => dialects.push(d),
  };
  const pgUri = 'postgresql://demo:p%40ss%5E%24@db.example.test:5432/flux';
  const pg = buildDatabaseClient('REMOTE', pgUri, pgDeps);
  eq('REMOTE PostgreSQL получает connectionString целиком', pg.options.adapter.options, { connectionString: pgUri });
  eq('PostgreSQL модули выбраны', pgCalls, ['@prisma/client-pg', '@prisma/adapter-pg']);
  eq('запрошенный PostgreSQL диалект установлен', dialects[1], 'postgresql');

  const localCalls: string[] = [];
  const localDeps = {
    load(name: string) {
      localCalls.push(name);
      if (name === '@prisma/client-sqlite') return { PrismaClient: class { constructor(public options: any) {} } };
      throw new Error(`unexpected load: ${name}`);
    }, sqliteAdapter: (url: string) => ({ sqliteUrl: url }),
    selectDialect: (d: Dialect) => dialects.push(d),
  };
  const local = buildDatabaseClient('LOCAL', 'file:/tmp/flux-test.sqlite', localDeps);
  eq('LOCAL выбирает SQLite', localCalls, ['@prisma/client-sqlite']);
  eq('SQLite адаптер получает URL', local.options.adapter, { sqliteUrl: 'file:/tmp/flux-test.sqlite' });
  eq('запрошенный SQLite диалект установлен', dialects[2], 'sqlite');
}

console.log('Ошибки и запрет тихого перехода на SQLite');
{
  let loads = 0, sqliteCalls = 0, selections = 0;
  const deps = {
    load: (_name: string) => { loads++; return {}; },
    sqliteAdapter: (_url: string) => { sqliteCalls++; return {}; },
    selectDialect: (_d: Dialect) => { selections++; },
  };
  throws('пустой REMOTE URL отклонён', () => buildDatabaseClient('REMOTE', '', deps));
  throws('схема file отклонена для REMOTE', () => buildDatabaseClient('REMOTE', 'file:/tmp/flux.sqlite', deps));
  throws('битый процент отклонён', () => buildDatabaseClient('REMOTE', 'mysql://u:p%@host/db', deps));
  eq('невалидный URL отклонён до загрузки драйвера', loads, 0);
  eq('невалидный URL отклонён до выбора диалекта', selections, 0);
  throws('неизвестный режим отклонён', () => buildDatabaseClient('OTHER', 'file:/tmp/a', deps));
  eq('REMOTE ошибка не запускает SQLite драйвер', sqliteCalls, 0);

  const sentinel = new Error('constructor failed');
  const errorDeps = {
    load(name: string) {
      if (name === '@prisma/client-pg') return { PrismaClient: class { constructor() { throw sentinel; } } };
      if (name === '@prisma/adapter-pg') return { PrismaPg: class { constructor(_options: any) {} } };
      throw new Error(`unexpected load: ${name}`);
    }, sqliteAdapter: (_url: string) => ({}), selectDialect: (_d: Dialect) => {},
  };
  try { buildDatabaseClient('REMOTE', 'postgresql://user:pass@db.example.test/flux', errorDeps); check('ошибка конструктора не проглочена', false); }
  catch (err) { eq('исходная ошибка конструктора проброшена', err, sentinel); }
}

async function testHealth() {
console.log('Метаданные health');
{
  const handlers = new Map<string, Function>();
  const app: any = {
    use: () => {}, post: () => {},
    get: (route: string, handler: Function) => handlers.set(route, handler),
  };
  let mode: 'LOCAL' | 'REMOTE' = 'REMOTE';
  const passwordUri = 'mysql://demo:health-secret%40%5E%24@db.example.test:3306/flux';
  const deps: any = {
    appVersion: 'test-version', appDataPath: '/tmp/flux-test',
    loadAppConfig: () => ({ current_db_type: mode, database_url: passwordUri }), saveAppConfig: () => {},
    resolveLocalDbPath: () => '/tmp/flux-test.sqlite', createPrismaClient: () => ({}),
    ensureHealthyLocalDb: () => {}, ensureSchemaColumns: () => {}, syncRemoteSchema: async () => [],
    hashPassword: (s: string) => s, replaceClient: () => {},
  };
  registerSystemRoutes(app, deps);
  const health = handlers.get('/api/health')!;
  const invoke = async () => {
    let statusCode = 200, body: any;
    const res: any = {
      json(value: any) { body = value; return this; },
      status(code: number) { statusCode = code; return this; },
    };
    await health({}, res);
    return { statusCode, body };
  };
  try {
    setDialect('mysql');
    setPrisma({ user: { count: async () => 2 } });
    const remote = await invoke();
    eq('REMOTE/mysql health статус', remote.statusCode, 200);
    eq('REMOTE/mysql метаданные', { databaseMode: remote.body.databaseMode, dialect: remote.body.dialect }, { databaseMode: 'REMOTE', dialect: 'mysql' });
    check('успешный health не содержит секрет URL', !JSON.stringify(remote.body).includes('health-secret'), remote.body);

    setDialect('sqlite');
    setPrisma({ user: { count: async () => { throw new Error(`could not connect: ${passwordUri}`); } } });
    const broken = await invoke();
    eq('ошибка БД даёт 503', broken.statusCode, 503);
    eq('ошибка БД даёт общую причину', broken.body.error, 'База временно недоступна');
    eq('ошибка сохраняет REMOTE/mysql метаданные из config и dialect', { databaseMode: broken.body.databaseMode, dialect: broken.body.dialect }, { databaseMode: 'REMOTE', dialect: 'sqlite' });
    check('ошибка health не раскрывает URL, пароль или текст исключения', !JSON.stringify(broken.body).includes('health-secret') && !JSON.stringify(broken.body).includes('could not connect'), broken.body);

    mode = 'LOCAL';
    setDialect('sqlite');
    setPrisma({ user: { count: async () => 0 } });
    const local = await invoke();
    eq('LOCAL/sqlite health статус', local.statusCode, 200);
    eq('LOCAL/sqlite метаданные', { databaseMode: local.body.databaseMode, dialect: local.body.dialect }, { databaseMode: 'LOCAL', dialect: 'sqlite' });
  } finally {
    setPrisma(null);
    setDialect('sqlite');
  }
}
}

testHealth().then(() => {
  console.log(`\n${passed} проверок пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
