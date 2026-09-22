/**
 * Проверки создания таблиц под три движка базы.
 *
 * Живой MariaDB в контейнере нет, а ошибка в диалекте не видна ничем: запрос
 * падает, ошибку глотают, таблицы нет — и раздел отвечает 500 у того
 * единственного заказчика, у кого общая база на MariaDB. Ровно так и вышло с
 * календарём. Поэтому SQL проверяется здесь, до того как его увидит база.
 *
 * Запуск: npx tsx scripts/test-ddl.ts
 */
import {
  createTableSql, createIndexSql, columnSql, dialectOf, isDuplicateIndex,
  addColumnSql, isDuplicateColumn, supportsPartialIndex, type Col,
} from '../server/ddl';
// Автомиграция общей базы: она создаёт таблицы по схеме Prisma, и именно она
// однажды пропустила колонку с файлом обновления
import { parsePrismaSchema, needsWidening, isTextDefaultRefusal } from '../server/schema-sync';
import { readFileSync } from 'fs';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const cols: Col[] = [
  { name: 'id', kind: 'text', pk: true },
  { name: 'projectId', kind: 'text', notNull: true, def: '', indexed: true },
  { name: 'title', kind: 'text', notNull: true, def: '' },
  { name: 'body', kind: 'longtext', notNull: true },
  { name: 'allDay', kind: 'bool', notNull: true, def: false },
  { name: 'remindMin', kind: 'int', notNull: true, def: 0 },
  { name: 'createdAt', kind: 'time', notNull: true, def: 'now' },
];

console.log('Определение движка по адресу');
{
  check('локальная база — SQLite', dialectOf('LOCAL', 'file:x.sqlite') === 'sqlite');
  check('mysql:// — MariaDB', dialectOf('REMOTE', 'mysql://u:p@h:3306/db') === 'mysql');
  check('mariadb:// — тоже MariaDB', dialectOf('REMOTE', 'mariadb://u:p@h:3306/db') === 'mysql');
  check('postgresql:// — PostgreSQL', dialectOf('REMOTE', 'postgresql://u:p@h/db') === 'postgresql');
  check('общий режим без адреса считается PostgreSQL', dialectOf('REMOTE', '') === 'postgresql');
}

console.log('Кавычки вокруг имён');
{
  const my = createTableSql('mysql', 'CalEvent', cols);
  const pg = createTableSql('postgresql', 'CalEvent', cols);
  check('у MySQL имена в обратных кавычках', my.includes('`CalEvent`'), my.slice(0, 60));
  check('у MySQL двойных кавычек нет вовсе', !my.includes('"'), my.slice(0, 120));
  check('у PostgreSQL имена в двойных кавычках', pg.includes('"CalEvent"'), pg.slice(0, 60));
}

console.log('Типы под движок');
{
  const my = createTableSql('mysql', 'T', cols);
  const pg = createTableSql('postgresql', 'T', cols);
  const lite = createTableSql('sqlite', 'T', cols);

  check('время у MySQL — DATETIME(3)', my.includes('DATETIME(3)'), my);
  check('время у PostgreSQL — TIMESTAMP(3)', pg.includes('TIMESTAMP(3)'), pg);
  // Смотрим объявление колонки, а не всю строку: CURRENT_TIMESTAMP в умолчании
  // содержит слово TIMESTAMP и делает поиск по подстроке бессмысленным
  check('время у SQLite — DATETIME',
    columnSql('sqlite', { name: 'a', kind: 'time' }) === '"a" DATETIME',
    columnSql('sqlite', { name: 'a', kind: 'time' }));

  check('да/нет у MySQL — TINYINT(1)', my.includes('TINYINT(1)'), my);
  check('да/нет у PostgreSQL — BOOLEAN', pg.includes('BOOLEAN'), pg);
  check('умолчание false у MySQL числом', my.includes('DEFAULT 0'), my);
  check('умолчание false у PostgreSQL словом', pg.includes('DEFAULT false'), pg);
}

console.log('Засады MySQL');
{
  const my = createTableSql('mysql', 'T', cols);
  check('первичный ключ не TEXT, а VARCHAR', /`id` VARCHAR\(191\) NOT NULL/.test(my), my);
  check('колонка под индексом — VARCHAR', /`projectId` VARCHAR\(191\)/.test(my), my);
  check('колонка с умолчанием — VARCHAR', /`title` VARCHAR\(191\)/.test(my), my);
  check('длинный текст остаётся LONGTEXT', my.includes('`body` LONGTEXT'), my);
  // Тоже по колонке, а не по всей таблице: в хвосте стоит DEFAULT CHARSET
  check('у длинного текста нет умолчания',
    columnSql('mysql', { name: 'body', kind: 'longtext', notNull: true, def: '' }) === '`body` LONGTEXT NOT NULL',
    columnSql('mysql', { name: 'body', kind: 'longtext', notNull: true, def: '' }));
  check('движок и кодировка заданы', my.includes('ENGINE=InnoDB') && my.includes('utf8mb4'), my.slice(-90));
  check('у PostgreSQL ничего про движок не пишется', !createTableSql('postgresql', 'T', cols).includes('ENGINE'));
}

console.log('Первичный ключ и NOT NULL');
{
  const pg = createTableSql('postgresql', 'T', cols);
  check('первичный ключ объявлен', pg.includes('PRIMARY KEY ("id")'), pg);
  check('ключ — NOT NULL', /"id" TEXT NOT NULL/.test(pg), pg);
  check('необязательная колонка без NOT NULL',
    columnSql('postgresql', { name: 'x', kind: 'text' }) === '"x" TEXT');
}

console.log('Значения по умолчанию с кавычками');
{
  const c: Col = { name: 'kind', kind: 'text', notNull: true, def: "мет'ка" };
  check('одинарная кавычка в умолчании экранируется',
    columnSql('postgresql', c).includes("'мет''ка'"), columnSql('postgresql', c));
  check('время по умолчанию у MySQL с долями секунды',
    columnSql('mysql', { name: 'a', kind: 'time', notNull: true, def: 'now' }).includes('CURRENT_TIMESTAMP(3)'));
}

console.log('Индексы');
{
  check('у PostgreSQL индекс создаётся мягко',
    createIndexSql('postgresql', 'T', 'T_idx', ['a', 'b']).includes('IF NOT EXISTS'));
  check('у MySQL мягкого создания нет',
    !createIndexSql('mysql', 'T', 'T_idx', ['a']).includes('IF NOT EXISTS'),
    createIndexSql('mysql', 'T', 'T_idx', ['a']));
  check('уникальный индекс назван уникальным',
    createIndexSql('sqlite', 'T', 'T_key', ['a'], true).includes('UNIQUE INDEX'));
  check('повтор индекса у MySQL считается успехом',
    isDuplicateIndex("Duplicate key name 'T_idx'"));
  check('чужая ошибка успехом не считается', !isDuplicateIndex('Table does not exist'));
}

// Проверка написана по поломке, из-за которой обновления не работали вовсе.
// Автомиграция общей базы не знала двоичного типа и молча пропускала колонку с
// файлом обновления: таблица в MariaDB создавалась без неё. Дальше всё выглядело
// исправным — таблица есть, — а вставка падала на «нет такой колонки», и файл
// не попадал в общую базу никогда
console.log('Двоичное поле доезжает до общей базы');
{
  const schema = `
model AppUpdateChunk {
  id      String @id @default(uuid())
  version String
  idx     Int
  data    Bytes  @db.LongBlob

  @@unique([version, idx])
}
`;
  const my = parsePrismaSchema('mysql', schema)[0];
  check('модель разобрана', !!my, my);
  check('колонка с файлом не потерялась', my.columns.some((c) => c.name === 'data'), my.columns.map((c) => c.name));
  const data = my.columns.find((c) => c.name === 'data')!;
  check('у MariaDB это LONGBLOB, а не текст', data.sqlType === 'LONGBLOB', data.sqlType);
  // У MySQL двоичное поле не имеет значения по умолчанию — с DEFAULT запрос
  // отказал бы целиком, и таблица снова осталась бы без колонки
  check('значения по умолчанию у него нет', data.defaultSql === null, data.defaultSql);

  const pg = parsePrismaSchema('postgresql', schema)[0].columns.find((c) => c.name === 'data')!;
  check('у PostgreSQL это BYTEA', pg.sqlType === 'BYTEA', pg.sqlType);
  const lite = parsePrismaSchema('sqlite', schema)[0].columns.find((c) => c.name === 'data')!;
  check('у SQLite это BLOB', lite.sqlType === 'BLOB', lite.sqlType);
}

// Та же проверка, но на настоящих схемах: правило должно держаться и тогда,
// когда двоичных полей станет больше одного
{
  const files: [string, 'sqlite' | 'postgresql' | 'mysql'][] = [
    ['prisma/schema.prisma', 'sqlite'],
    ['prisma/schema.postgresql.prisma', 'postgresql'],
    ['prisma/schema.mariadb.prisma', 'mysql'],
  ];
  for (const [file, dialect] of files) {
    const text = readFileSync(file, 'utf-8');
    const declared = [...text.matchAll(/^\s*(\w+)\s+Bytes\b/gm)].map((m) => m[1]);
    const parsed = parsePrismaSchema(dialect, text).flatMap((m) => m.columns.map((c) => c.name));
    check(`${file}: ни одно двоичное поле не потерялось`,
      declared.every((n) => parsed.includes(n)), { declared, дошли: declared.filter((n) => parsed.includes(n)) });
  }
}

console.log('Неполная таблица дополняется, а не остаётся неполной');
{
  const blob: Col = { name: 'data', kind: 'blob', notNull: true };
  const sql = addColumnSql('mysql', 'AppUpdateChunk', blob);
  check('колонка добавляется в существующую таблицу', sql.startsWith('ALTER TABLE'), sql);
  check('имена в обратных кавычках, как любит MySQL', sql.includes('`AppUpdateChunk`') && sql.includes('`data`'), sql);
  check('тип двоичный и вместительный', sql.includes('LONGBLOB'), sql);
  check('у PostgreSQL — BYTEA в двойных кавычках',
    addColumnSql('postgresql', 'T', blob).includes('"data" BYTEA'), addColumnSql('postgresql', 'T', blob));
  check('«колонка уже есть» — это успех', isDuplicateColumn("Duplicate column name 'data'"));
  check('чужая ошибка успехом не считается', !isDuplicateColumn('Table does not exist'));
}

// Проверка написана по поломке, из-за которой в настройках не заводились роли.
// В общей базе каждая строка была VARCHAR(191). Права роли — это JSON со списком
// доступов, он длиннее; MariaDB отвечала «Data too long», а до человека доходило
// «роль не создаётся» без причины. Строка под индексом обязана остаться VARCHAR
// (TEXT в MySQL нельзя индексировать без длины префикса), всё остальное — TEXT.
console.log('Длинная строка помещается в общую базу');
{
  const schema = `
model Role {
  id          String @id @default(uuid())
  code        String @unique
  name        String
  permissions String @default("[]")
  sortOrder   Int    @default(0)
}

model Tag {
  id        String  @id @default(uuid())
  projectId String
  note      String?
  project   Project @relation(fields: [projectId], references: [id])

  @@index([projectId])
}
`;
  const my = parsePrismaSchema('mysql', schema);
  const role = my.find((m) => m.name === 'Role')!;
  const col = (m: any, n: string) => m.columns.find((c: any) => c.name === n)!;

  check('права роли не влезали в 191 символ — теперь TEXT', col(role, 'permissions').sqlType === 'TEXT',
    col(role, 'permissions').sqlType);
  check('название роли тоже TEXT', col(role, 'name').sqlType === 'TEXT', col(role, 'name').sqlType);
  check('ключ остаётся VARCHAR — по нему первичный индекс',
    col(role, 'id').sqlType === 'VARCHAR(191)', col(role, 'id').sqlType);
  check('уникальный код остаётся VARCHAR — по нему уникальный индекс',
    col(role, 'code').sqlType === 'VARCHAR(191)', col(role, 'code').sqlType);
  check('число типом не тронуто', col(role, 'sortOrder').sqlType === 'INTEGER', col(role, 'sortOrder').sqlType);

  const tag = my.find((m) => m.name === 'Tag')!;
  check('поле связи остаётся VARCHAR — по нему ищут теги проекта',
    col(tag, 'projectId').sqlType === 'VARCHAR(191)', col(tag, 'projectId').sqlType);
  check('обычная заметка — TEXT', col(tag, 'note').sqlType === 'TEXT', col(tag, 'note').sqlType);

  // У PostgreSQL строка и так TEXT, и разбор не должен туда ничего приносить
  const pg = parsePrismaSchema('postgresql', schema).find((m) => m.name === 'Role')!;
  check('у PostgreSQL VARCHAR не появляется',
    pg.columns.every((c) => !/VARCHAR/.test(c.sqlType)), pg.columns.map((c) => c.sqlType));
}

// Та же проверка на настоящей схеме: правило должно держаться после любой правки
{
  const text = readFileSync('prisma/schema.mariadb.prisma', 'utf-8');
  const models = parsePrismaSchema('mysql', text);
  const role = models.find((m) => m.name === 'Role');
  check('в рабочей схеме роль есть', !!role);
  const perms = role?.columns.find((c) => c.name === 'permissions');
  check('и её доступы записываются целиком', perms?.sqlType === 'TEXT', perms?.sqlType);
  // Ключи при этом никуда не делись: без них база откажется строить индекс
  const withIndex = models.filter((m) => m.columns.some((c) => c.isId && c.sqlType !== 'VARCHAR(191)'));
  check('ни один первичный ключ не стал TEXT', withIndex.length === 0, withIndex.map((m) => m.name));
}

console.log('Узкую колонку в живой базе расширяют, а не оставляют узкой');
{
  check('varchar → text расширяется', needsWidening('mysql', 'varchar', 'TEXT'));
  check('varchar → longtext расширяется', needsWidening('mysql', 'varchar', 'LONGTEXT'));
  check('text → longtext расширяется', needsWidening('mysql', 'text', 'LONGTEXT'));
  // Сужение обрезало бы чужие данные — этого автомиграция не делает никогда
  check('longtext → text не сужается', !needsWidening('mysql', 'longtext', 'TEXT'));
  check('text → varchar не сужается', !needsWidening('mysql', 'text', 'VARCHAR(191)'));
  check('одинаковый тип не трогается', !needsWidening('mysql', 'text', 'TEXT'));
  check('нетекстовые типы не расширяются', !needsWidening('mysql', 'int', 'INTEGER'));
  check('у PostgreSQL расширять нечего', !needsWidening('postgresql', 'varchar', 'TEXT'));
  check('у SQLite тоже', !needsWidening('sqlite', 'varchar', 'TEXT'));

  // Старая MariaDB запрещает DEFAULT у TEXT. Отказ надо узнать в лицо, иначе
  // правка схемы встанет целиком из-за одной колонки
  check('отказ старого движка распознан',
    isTextDefaultRefusal("BLOB/TEXT column 'permissions' can't have a default value"));
  check('чужая ошибка за него не принимается', !isTextDefaultRefusal('Table does not exist'));
}

console.log('Частичные индексы: там, где они есть');
{
  // На них держатся правила вида «одна активная группа на человека»: обычный
  // UNIQUE запретил бы вторую игру навсегда, а не вторую ОДНОВРЕМЕННУЮ
  const cond = `"state" = 'ACTIVE'`;
  const pg = createIndexSql('postgresql', 'PlayParty', 'PlayParty_active_key', ['leaderId'], true, cond);
  check('PostgreSQL получает условие', pg.includes('WHERE "state"'), pg);
  check('и остаётся уникальным', pg.includes('UNIQUE INDEX'), pg);

  const lite = createIndexSql('sqlite', 'PlayParty', 'PlayParty_active_key', ['leaderId'], true, cond);
  check('SQLite получает то же условие', lite.includes('WHERE "state"'), lite);

  // У MySQL частичных индексов нет. Полный вместо частичного был бы не
  // «почти то же самое», а другое правило: он запретил бы человеку вторую
  // группу вообще, и раздел сломался бы после первой же игры
  check('MySQL частичных индексов не умеет', !supportsPartialIndex('mysql'));
  check('PostgreSQL умеет', supportsPartialIndex('postgresql'));
  check('SQLite умеет', supportsPartialIndex('sqlite'));

  const plain = createIndexSql('postgresql', 'T', 'i', ['a']);
  check('без условия ничего не дописывается', !plain.includes('WHERE'), plain);
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки создания таблиц пройдены');
