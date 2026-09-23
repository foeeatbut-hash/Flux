/**
 * Создание недостающих таблиц с учётом движка базы.
 *
 * Почему это отдельный слой. Программа работает с тремя базами: SQLite на
 * машине, PostgreSQL и MariaDB в общей сети. Основную работу делает автомиграция
 * по схеме Prisma (server/schema-sync.ts), но у каждого вынесенного маршрута
 * была ещё и своя подстраховка: «таблицы нет — создам сам». Написана она была
 * синтаксисом PostgreSQL, а ошибку глотала молча:
 *
 *     try { ...CREATE TABLE "CalEvent" (... TIMESTAMP(3) ...) } catch (_) {}
 *
 * На MariaDB двойные кавычки — это не имя таблицы, а строка, и такой запрос
 * падает всегда. Падение проглатывалось, таблица не появлялась, и КАЖДЫЙ заход
 * в календарь отвечал 500 — без единой строчки в журнале о причине. Именно так
 * у владельца календарь и «выкидывал из программы».
 *
 * Отсюда два правила этого модуля:
 *
 *   1. SQL собирается под конкретный движок — кавычки, типы, значения по
 *      умолчанию у всех трёх разные, и «почти правильный» SQL здесь бесполезен;
 *   2. ошибка не глотается. Не удалось создать таблицу — это записывается и
 *      возвращается наверх, чтобы человек увидел причину, а не пустой экран.
 *
 * Правила проверяются скриптом (scripts/test-ddl.ts): живой MariaDB в
 * контейнере нет, а ошибиться в диалекте очень легко.
 */

export type Dialect = 'sqlite' | 'postgresql' | 'mysql';

/** Из адреса базы понятно, какой это движок */
export function dialectOf(dbType: string, dbUrl: string): Dialect {
  if (String(dbType || '').toUpperCase() !== 'REMOTE') return 'sqlite';
  return /^(mysql|mariadb):\/\//i.test(String(dbUrl || '').trim()) ? 'mysql' : 'postgresql';
}

let current: Dialect = 'sqlite';
export function setDialect(d: Dialect): void { current = d; }
export function getDialect(): Dialect { return current; }

export type ColKind = 'text' | 'longtext' | 'int' | 'bool' | 'time' | 'blob';

export interface Col {
  name: string;
  kind: ColKind;
  /** Первичный ключ. Всегда NOT NULL и без значения по умолчанию */
  pk?: boolean;
  notNull?: boolean;
  /** Значение по умолчанию: строка, число, true/false или 'now' */
  def?: string | number | boolean | 'now' | null;
  /** Колонка участвует в индексе — у MySQL это меняет тип на VARCHAR */
  indexed?: boolean;
}

const q = (d: Dialect, id: string): string => (d === 'mysql' ? `\`${id}\`` : `"${id}"`);
const str = (s: string): string => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Тип колонки.
 *
 * У MySQL три отдельные засады, и каждая когда-нибудь стоила бы вечера:
 * TEXT нельзя сделать первичным ключом без длины префикса, по TEXT нельзя
 * строить индекс без длины, и у TEXT нет значения по умолчанию в старых
 * версиях. Поэтому всё, что участвует в ключе, индексе или имеет умолчание,
 * объявляется VARCHAR.
 */
function typeOf(d: Dialect, c: Col): string {
  if (c.kind === 'int') return d === 'sqlite' ? 'INTEGER' : 'INTEGER';
  if (c.kind === 'bool') return d === 'mysql' ? 'TINYINT(1)' : 'BOOLEAN';
  if (c.kind === 'time') {
    if (d === 'sqlite') return 'DATETIME';
    return d === 'mysql' ? 'DATETIME(3)' : 'TIMESTAMP(3)';
  }
  if (c.kind === 'longtext') return d === 'mysql' ? 'LONGTEXT' : 'TEXT';
  // Двоичные данные: у каждого движка своё имя, и «почти правильное» не подходит
  if (c.kind === 'blob') return d === 'mysql' ? 'LONGBLOB' : d === 'postgresql' ? 'BYTEA' : 'BLOB';
  // Обычный текст
  if (d === 'mysql' && (c.pk || c.indexed || c.def !== undefined)) return 'VARCHAR(191)';
  return 'TEXT';
}

function defaultOf(d: Dialect, c: Col): string {
  if (c.def === undefined || c.def === null) return '';
  if (c.def === 'now') return d === 'mysql' ? ' DEFAULT CURRENT_TIMESTAMP(3)' : ' DEFAULT CURRENT_TIMESTAMP';
  if (typeof c.def === 'boolean') {
    if (d === 'mysql') return ` DEFAULT ${c.def ? 1 : 0}`;
    if (d === 'sqlite') return ` DEFAULT ${c.def ? 1 : 0}`;
    return ` DEFAULT ${c.def ? 'true' : 'false'}`;
  }
  if (typeof c.def === 'number') return ` DEFAULT ${c.def}`;
  // У MySQL по длинному тексту умолчания нет — и оно там не нужно
  if (d === 'mysql' && c.kind === 'longtext') return '';
  return ` DEFAULT ${str(c.def)}`;
}

export function columnSql(d: Dialect, c: Col): string {
  const notNull = c.pk || c.notNull ? ' NOT NULL' : '';
  return `${q(d, c.name)} ${typeOf(d, c)}${notNull}${defaultOf(d, c)}`;
}

export function createTableSql(d: Dialect, table: string, cols: Col[]): string {
  const defs = cols.map((c) => columnSql(d, c));
  const pk = cols.find((c) => c.pk);
  if (pk) defs.push(`PRIMARY KEY (${q(d, pk.name)})`);
  const tail = d === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' : '';
  return `CREATE TABLE IF NOT EXISTS ${q(d, table)} (${defs.join(', ')})${tail}`;
}

/**
 * Индекс.
 *
 * У MySQL нет «CREATE INDEX IF NOT EXISTS»: повторный запуск отвечает ошибкой
 * «дубликат имени ключа». Это не беда — она ловится там, где индекс создаётся,
 * и считается успехом: индекс уже есть, значит цель достигнута.
 *
 * `where` — частичный индекс: уникальность держится не по всей таблице, а по
 * той её части, где условие истинно. На нём стоят правила вида «одна активная
 * группа на человека»: закрытых групп у человека сотни, активная одна, и
 * обычный UNIQUE тут запретил бы вторую игру навсегда. PostgreSQL и SQLite
 * частичные индексы умеют. В MariaDB то же ограничение создаётся через
 * индексируемые вычисляемые колонки: у неактивных строк они равны NULL,
 * поэтому уникальность касается только активных строк.
 */
export function conditionalColumnName(index: string, column: string): string {
  const name = `__${index}_${column}`;
  if (!/^[A-Za-z0-9_]+$/.test(name) || name.length > 64) throw Error(`Недопустимое имя колонки индекса: ${name}`);
  return name;
}

export function createConditionalColumnSql(table: string, index: string, column: string, where: string): string {
  const condition = where.replace(/"([A-Za-z][A-Za-z0-9_]*)"/g, '`$1`');
  return `ALTER TABLE ${q('mysql', table)} ADD COLUMN ${q('mysql', conditionalColumnName(index, column))} `
    + `VARCHAR(191) AS (CASE WHEN (${condition}) THEN ${q('mysql', column)} ELSE NULL END) STORED`;
}

export function createIndexSql(
  d: Dialect, table: string, name: string, cols: string[], unique = false, where?: string,
): string {
  const kind = unique ? 'UNIQUE INDEX' : 'INDEX';
  const indexed = d === 'mysql' && where ? cols.map(c => conditionalColumnName(name, c)) : cols;
  const list = indexed.map((c) => q(d, c)).join(', ');
  if (d === 'mysql') return `CREATE ${kind} ${q(d, name)} ON ${q(d, table)} (${list})`;
  const tail = where ? ` WHERE ${where}` : '';
  return `CREATE ${kind} IF NOT EXISTS ${q(d, name)} ON ${q(d, table)} (${list})${tail}`;
}

/** Движок умеет настоящие частичные индексы. */
export const supportsPartialIndex = (d: Dialect): boolean => d !== 'mysql';

/** То же ограничение на MariaDB обеспечивают уникальные вычисляемые колонки. */
export const supportsConditionalUniqueIndex = (d: Dialect): boolean =>
  d === 'mysql' || d === 'postgresql' || d === 'sqlite';

/** «Индекс уже есть» — это не ошибка, а достигнутая цель */
export const isDuplicateIndex = (message: string): boolean =>
  /duplicate key name|already exists|ER_DUP_KEYNAME/i.test(String(message || ''));

/**
 * Добавить недостающую колонку в уже существующую таблицу.
 *
 * Понадобилось после случая, когда таблица в общей базе была создана НЕ ПОЛНОЙ:
 * автомиграция не знала двоичного типа и молча пропустила колонку с файлом
 * обновления. Дальше всё выглядело исправным — таблица есть, значит создавать
 * нечего, — а вставка падала на «нет такой колонки». Поэтому «таблица есть»
 * больше не значит «таблица правильная».
 */
export function addColumnSql(d: Dialect, table: string, c: Col): string {
  return `ALTER TABLE ${q(d, table)} ADD COLUMN ${columnSql(d, c)}`;
}

/** «Колонка уже есть» — тоже достигнутая цель, а не беда */
export const isDuplicateColumn = (message: string): boolean =>
  /duplicate column|already exists|ER_DUP_FIELDNAME/i.test(String(message || ''));

export interface IndexSpec {
  name: string;
  cols: string[];
  unique?: boolean;
  /**
   * Условие частичного индекса. Пишется на SQL и одинаково читается
   * PostgreSQL и SQLite; на MySQL индекс с условием не создаётся вовсе.
   */
  where?: string;
}

export interface TableSpec {
  table: string;
  cols: Col[];
  indexes?: IndexSpec[];
}

/**
 * Создать таблицы, которых не хватает. Возвращает текст беды или пустую
 * строку. Молчаливого проглатывания здесь нет и быть не может: отсутствие
 * таблицы выглядит для человека как «раздел сломался», и он должен прочитать,
 * почему, а не гадать.
 */
export async function ensureTables(prisma: any, specs: TableSpec[], log?: (m: string) => void, strict = false): Promise<string> {
  const d = getDialect();
  for (const spec of specs) {
    try {
      await prisma.$executeRawUnsafe(createTableSql(d, spec.table, spec.cols));
    } catch (e: any) {
      const msg = `Не удалось создать таблицу ${spec.table} (${d}): ${e?.message || e}`;
      log?.(msg);
      return msg;
    }
    // Таблица могла остаться с прошлой версии программы неполной — тогда её
    // надо не создать, а дополнить. Первичный ключ пропускаем: он есть всегда,
    // и добавить его второй раз нельзя
    for (const col of spec.cols) {
      if (col.pk) continue;
      try {
        await prisma.$executeRawUnsafe(addColumnSql(d, spec.table, col));
        log?.(`В таблицу ${spec.table} добавлена недостающая колонка ${col.name}`);
      } catch (e: any) {
        if (!isDuplicateColumn(e?.message)) {
          const msg = `Колонка ${spec.table}.${col.name} не добавлена: ${e?.message || e}`;
          log?.(msg); if (strict) return msg;
        }
      }
    }
    for (const idx of spec.indexes || []) {
      if (d === 'mysql' && idx.where) {
        if (!idx.unique) return `Условный индекс ${idx.name} должен быть уникальным`;
        for (const col of idx.cols) {
          try {
            await prisma.$executeRawUnsafe(createConditionalColumnSql(spec.table, idx.name, col, idx.where));
          } catch (e: any) {
            if (!isDuplicateColumn(e?.message)) {
              const msg = `Вычисляемая колонка для ${idx.name} не создана: ${e?.message || e}`;
              log?.(msg); return msg;
            }
          }
        }
      }
      try {
        await prisma.$executeRawUnsafe(createIndexSql(d, spec.table, idx.name, idx.cols, idx.unique, idx.where));
      } catch (e: any) {
        if (!isDuplicateIndex(e?.message)) {
          const msg = `Индекс ${idx.name} не создан: ${e?.message || e}`;
          log?.(msg); if (strict) return msg;
        }
      }
    }
  }
  return '';
}
