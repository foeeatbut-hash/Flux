// Автоматическая миграция общей базы (PostgreSQL / MariaDB) под схему программы.
//
// Зачем: локальная база (SQLite) при каждом старте догоняет схему в
// ensureSchemaColumns(). Для общей базы этого не было — новая колонка/таблица в
// новой версии программы не появлялась сама, и базу пришлось бы править вручную.
//
// Этот модуль на каждом старте в совместном режиме приводит живую базу к схеме
// программы: добавляет недостающие таблицы и колонки и РАСШИРЯЕТ узкие
// текстовые. Ничего не удаляет и не сужает, поэтому данные в безопасности.
// Источник истины — файл prisma/schema.<движок>.prisma, который едет внутри
// обновления программы.

import { withSchemaConnection } from './schemaRuntime.js';
import { createIndexSql, isDuplicateIndex } from './ddl.js';
import { inspectSchema } from './schemaInspection.js';

type Dialect = 'postgresql' | 'mysql' | 'sqlite';

interface Column {
  name: string;
  sqlType: string;
  nullable: boolean;
  isId: boolean;
  unique: boolean;
  defaultSql: string | null; // готовый фрагмент DEFAULT ... или null
}

/** Составной уникальный ключ @@unique([a, b]) — имя индекса и его колонки */
interface UniqueKey {
  name: string;
  columns: string[];
}

interface Model {
  name: string;
  columns: Column[];
  uniques: UniqueKey[];
  indexes?: UniqueKey[];
  foreignKeys?: Array<{ column: string; table: string; reference: string }>;
}

/**
 * Типы, которые становятся колонками. Всё остальное в схеме — связи.
 *
 * `Bytes` сюда не входил, и это стоило отделу двух выпусков без обновлений.
 * Двоичное поле в схеме одно — файл обновления (`AppUpdateChunk.data`), и из-за
 * пропуска таблица в общей базе создавалась БЕЗ НЕГО: id, version, idx — и всё.
 * Дальше по цепочке всё выглядело исправным: таблица есть, значит подстраховка
 * с созданием не срабатывает; вставка куска падает на «нет такой колонки»,
 * ошибка ловится и превращается в предупреждение, которое легко не заметить.
 * Итог — запись о релизе у всех, файла в общей базе нет ни у кого.
 */
const SCALARS = new Set(['String', 'Int', 'Boolean', 'DateTime', 'Float', 'BigInt', 'Decimal', 'Json', 'Bytes']);

function quoteId(dialect: Dialect, id: string): string {
  return dialect === 'mysql' ? `\`${id}\`` : `"${id}"`;
}

// SQLite хранит всё в пяти типах и не поддерживает information_schema —
// поэтому у него свои ветки в типах, дефолтах и чтении текущей структуры.
function sqliteType(base: string): string {
  switch (base) {
    case 'Int': case 'BigInt': case 'Boolean': return 'INTEGER';
    case 'Float': case 'Decimal': return 'REAL';
    case 'DateTime': return 'DATETIME';
    case 'Bytes': return 'BLOB';
    default: return 'TEXT';
  }
}

function quoteStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// Тип колонки в SQL для конкретного движка
/**
 * Тип колонки в SQL.
 *
 * `indexed` — участвует ли строка в индексе (@id, @unique, @@index, @@unique).
 * Это не украшение, а причина, по которой у MySQL строки вообще стали
 * VARCHAR(191): TEXT там нельзя проиндексировать без длины префикса, а 191 —
 * предел ключа для utf8mb4.
 *
 * Всё остальное VARCHAR(191) быть не должно, и это стоило владельцу рабочего
 * дня: права роли — JSON со списком доступов — в 191 символ не влезали, и
 * общая база отвечала «Data too long». Наружу это выходило как «роль не
 * создаётся» без единого понятного слова. Не индексируемая строка теперь TEXT.
 */
function sqlType(dialect: Dialect, base: string, dbAttr: string | null, indexed = false): string {
  if (dialect === 'sqlite') return sqliteType(base);
  if (dbAttr) {
    const m = dbAttr.match(/^(\w+)(\([^)]*\))?$/);
    const t = (m?.[1] || '').toLowerCase();
    const arg = m?.[2] || '';
    if (t === 'text') return 'TEXT';
    if (t === 'longtext') return dialect === 'mysql' ? 'LONGTEXT' : 'TEXT';
    if (t === 'mediumtext') return dialect === 'mysql' ? 'MEDIUMTEXT' : 'TEXT';
    if (t === 'varchar') return `VARCHAR${arg || '(191)'}`;
    if (t === 'char') return `CHAR${arg || '(1)'}`;
    // Двоичное поле: у каждого движка своё имя, «почти правильное» не подходит
    if (t === 'longblob') return dialect === 'mysql' ? 'LONGBLOB' : 'BYTEA';
    if (t === 'blob' || t === 'mediumblob') return dialect === 'mysql' ? t.toUpperCase() : 'BYTEA';
  }
  switch (base) {
    case 'String': return dialect === 'mysql' ? (indexed ? 'VARCHAR(191)' : 'TEXT') : 'TEXT';
    // Без указания размера двоичное поле берётся самым вместительным: в нём
    // едет файл обновления, а BLOB на 64 КБ для него бесполезен
    case 'Bytes': return dialect === 'mysql' ? 'LONGBLOB' : 'BYTEA';
    case 'Int': return 'INTEGER';
    case 'Boolean': return dialect === 'mysql' ? 'TINYINT(1)' : 'BOOLEAN';
    case 'DateTime': return dialect === 'mysql' ? 'DATETIME(3)' : 'TIMESTAMP(3)';
    case 'Float': return dialect === 'mysql' ? 'DOUBLE' : 'DOUBLE PRECISION';
    case 'BigInt': return 'BIGINT';
    case 'Decimal': return 'DECIMAL(65,30)';
    case 'Json': return dialect === 'mysql' ? 'JSON' : 'JSONB';
    default: return dialect === 'mysql' ? (indexed ? 'VARCHAR(191)' : 'TEXT') : 'TEXT';
  }
}

// DEFAULT из @default(...) Prisma; null = функция-генератор (id) → без SQL-дефолта
function defaultSql(dialect: Dialect, base: string, raw: string | null): string | null {
  if (raw == null) return null;
  const v = raw.trim();
  if (/^(uuid|cuid|autoincrement|dbgenerated)\s*\(/.test(v)) return null;
  if (/^now\s*\(/.test(v)) return dialect === 'sqlite' ? "(datetime('now'))" : 'CURRENT_TIMESTAMP(3)';
  if (v === 'true') return dialect === 'postgresql' ? 'true' : '1';
  if (v === 'false') return dialect === 'postgresql' ? 'false' : '0';
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  const str = v.match(/^"([\s\S]*)"$/);
  if (str) return quoteStr(str[1]);
  return null;
}

// Синтетический дефолт для NOT NULL колонки без @default — чтобы ADD COLUMN не
// падал на таблице с существующими строками
function fallbackDefault(dialect: Dialect, base: string): string | null {
  switch (base) {
    case 'Int': case 'Float': case 'BigInt': case 'Decimal': return '0';
    case 'Boolean': return dialect === 'postgresql' ? 'false' : '0';
    case 'DateTime': return dialect === 'sqlite' ? "(datetime('now'))" : 'CURRENT_TIMESTAMP(3)';
    // У двоичного поля значения по умолчанию нет и быть не должно: MySQL на
    // DEFAULT для BLOB отвечает отказом, и вся правка схемы встала бы из-за него
    case 'Bytes': return null;
    default: return quoteStr('');
  }
}

// Разбор schema.prisma → модели с колонками (связи и списки пропускаются)
export function parsePrismaSchema(dialect: Dialect, text: string): Model[] {
  const models: Model[] = [];
  const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let mm: RegExpExecArray | null;
  while ((mm = modelRe.exec(text))) {
    const name = mm[1];
    const body = mm[2];
    const columns: Column[] = [];
    // Поля, попавшие в индексы таблицы: @@index([a, b]) и @@unique([a, b]).
    // Их тип обязан оставаться индексируемым — у MySQL это VARCHAR, а не TEXT
    const indexed = new Set<string>();
    for (const im of body.matchAll(/@@(?:index|unique)\s*\(\s*\[([^\]]*)\]/g)) {
      for (const f of im[1].split(',')) {
        const clean = f.trim().replace(/\(.*$/, '');
        if (clean) indexed.add(clean);
      }
    }
    // Поля связей — те же ключи: по ним ищут («файлы этой папки», «теги этого
    // проекта»), и TEXT здесь означал бы перебор всей таблицы на каждый запрос
    for (const rm of body.matchAll(/@relation\([^)]*fields:\s*\[([^\]]*)\]/g)) {
      for (const f of rm[1].split(',')) {
        const clean = f.trim();
        if (clean) indexed.add(clean);
      }
    }
    // Составные ключи. Имя — как у Prisma по умолчанию (Модель_а_б_key) или
    // заданное map: — чтобы индекс, созданный prisma db push, узнавался своим
    const uniques: UniqueKey[] = [];
    for (const um of body.matchAll(/@@unique\s*\(\s*(?:fields:\s*)?\[([^\]]*)\]([^)]*)\)/g)) {
      const cols = um[1].split(',').map((f) => f.trim().replace(/\(.*$/, '')).filter(Boolean);
      const map = (um[2].match(/map:\s*"([^"]+)"/) || [])[1];
      if (cols.length) uniques.push({ name: map || `${name}_${cols.join('_')}_key`, columns: cols });
    }
    for (const lineRaw of body.split('\n')) {
      const line = lineRaw.replace(/\/\/.*$/, '').trim();
      if (!line || line.startsWith('@@')) continue;
      const fm = line.match(/^(\w+)\s+(\w+)(\?|\[\])?(.*)$/);
      if (!fm) continue;
      const [, fname, base, suffix, attrsRaw] = fm;
      if (suffix === '[]') continue;            // список — это связь
      if (!SCALARS.has(base)) continue;         // тип-модель — это связь
      const attrs = attrsRaw || '';
      const nullable = suffix === '?';
      const isId = /@id\b/.test(attrs);
      const unique = /@unique\b/.test(attrs);
      const dbAttr = (attrs.match(/@db\.(\w+(?:\([^)]*\))?)/) || [])[1] || null;
      const defRaw = (attrs.match(/@default\(([\s\S]*?)\)\s*(?:@|$)/) || [])[1]
        ?? (attrs.match(/@default\(([\s\S]*)\)/) || [])[1] ?? null;
      columns.push({
        name: fname,
        sqlType: sqlType(dialect, base, dbAttr, isId || unique || indexed.has(fname)),
        nullable,
        isId,
        unique,
        defaultSql: defaultSql(dialect, base, defRaw),
      });
      // запоминаем базовый тип для fallback-дефолта
      (columns[columns.length - 1] as any)._base = base;
    }
    if (columns.length) models.push({ name, columns, uniques });
  }
  return [...models, ...implicitRelationModels(dialect, text, models)];
}

/** Prisma хранит связи список↔список в отдельных _Relation(A,B) таблицах. */
function implicitRelationModels(dialect: Dialect, text: string, models: Model[]): Model[] {
  const lists: Array<{ model: string; field: string; target: string; relation: string }> = [];
  for (const match of text.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    for (const raw of match[2].split('\n')) {
      const field = raw.replace(/\/\/.*$/, '').trim().match(/^(\w+)\s+(\w+)\[\](.*)$/);
      if (!field || SCALARS.has(field[2])) continue;
      const relation = field[3].match(/@relation\(\s*"([^"]+)"/)?.[1]
        || [match[1], field[2]].sort().join('To');
      lists.push({ model: match[1], field: field[1], target: field[2], relation });
    }
  }
  const result = new Map<string, Model>();
  for (const list of lists) {
    const other = lists.find(candidate => candidate !== list && candidate.model === list.target
      && candidate.target === list.model && candidate.relation === list.relation);
    if (!other) continue; // список↔одна запись — обычный внешний ключ
    const name = `_${list.relation}`;
    if (result.has(name)) continue;
    const owners = [list.model, list.target].sort();
    const ids = owners.map(owner => models.find(model => model.name === owner)?.columns.find(column => column.isId));
    if (ids.some(id => !id)) throw Error(`Не найден первичный ключ связи ${name}`);
    const columns = ids.map((id, index): Column => ({
      name: index === 0 ? 'A' : 'B', sqlType: id!.sqlType, nullable: false, isId: false, unique: false, defaultSql: null,
    }));
    result.set(name, {
      name, columns,
      uniques: [{ name: `${name}_AB_unique`, columns: ['A', 'B'] }],
      indexes: [{ name: `${name}_B_index`, columns: ['B'] }],
      foreignKeys: owners.map((owner, index) => ({ column: index === 0 ? 'A' : 'B', table: owner, reference: ids[index]!.name })),
    });
  }
  return [...result.values()];
}

/** Текстовые типы MySQL, которым старые версии запрещают DEFAULT */
const TEXTY = /^(tinytext|text|mediumtext|longtext|blob|mediumblob|longblob)$/i;

/**
 * Описание колонки для DDL.
 *
 * `noTextDefault` — запасной вариант для старых MySQL и MariaDB до 10.2: там
 * `DEFAULT` у TEXT и BLOB запрещён, и вся правка схемы падала бы из-за одной
 * колонки. Сначала пробуем как надо, а на отказ повторяем без умолчания:
 * пустая строка у TEXT и так подставляется движком.
 */
function columnDdl(dialect: Dialect, c: Column, noTextDefault = false): string {
  const base = (c as any)._base as string;
  let def = c.defaultSql;
  if (!c.nullable && !c.isId && def == null) def = fallbackDefault(dialect, base);
  if (noTextDefault && dialect === 'mysql' && TEXTY.test(c.sqlType.replace(/\(.*$/, ''))) def = null;
  const parts = [quoteId(dialect, c.name), c.sqlType];
  if (!c.nullable) parts.push('NOT NULL');
  if (def != null) parts.push(`DEFAULT ${def}`);
  return parts.join(' ');
}

/** «У этого типа не может быть значения по умолчанию» — отказ старого движка */
export const isTextDefaultRefusal = (message: string): boolean =>
  /BLOB|TEXT.*can't have a default|default value|1101/i.test(String(message || ''));

async function existingTables(prisma: any, dialect: Dialect): Promise<Set<string>> {
  if (dialect === 'sqlite') {
    const rows: any[] = await prisma.$queryRawUnsafe(
      "SELECT name AS t FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    );
    return new Set(rows.map(r => String(r.t)));
  }
  const where = dialect === 'mysql'
    ? "table_schema = DATABASE()"
    : "table_schema = current_schema()";
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT table_name AS t FROM information_schema.tables WHERE ${where}`
  );
  return new Set(rows.map(r => String(r.t ?? r.T)));
}

/** Колонки таблицы и их нынешние типы: имя → тип строчными («varchar», «text») */
async function existingColumns(prisma: any, dialect: Dialect, table: string): Promise<Map<string, string>> {
  if (dialect === 'sqlite') {
    const rows: any[] = await prisma.$queryRawUnsafe(`PRAGMA table_info(${quoteId(dialect, table)})`);
    return new Map(rows.map((r: any) => [String(r.name), String(r.type || '').toLowerCase()]));
  }
  const where = dialect === 'mysql'
    ? "table_schema = DATABASE()"
    : "table_schema = current_schema()";
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT column_name AS c, data_type AS t FROM information_schema.columns WHERE ${where} AND table_name = ${quoteStr(table)}`
  );
  return new Map(rows.map(r => [String(r.c ?? r.C), String(r.t ?? r.T ?? '').toLowerCase()]));
}

/**
 * Уникальные индексы таблицы — как наборы колонок («fileId,idx», по алфавиту).
 *
 * Сверяем по колонкам, а не по имени: часть ключей старые версии создавали
 * вручную под своими именами (CalGuest_event_user_key), и второй такой же
 * индекс рядом ничего бы не дал, кроме лишней записи на каждую вставку.
 */
async function existingUniqueSets(prisma: any, dialect: Dialect, table: string): Promise<Set<string>> {
  const byIndex = new Map<string, string[]>();
  const add = (index: string, col: string) => {
    if (!byIndex.has(index)) byIndex.set(index, []);
    byIndex.get(index)!.push(col);
  };
  if (dialect === 'sqlite') {
    const list: any[] = await prisma.$queryRawUnsafe(`PRAGMA index_list(${quoteId(dialect, table)})`);
    for (const ix of list.filter((r: any) => Number(r.unique) === 1)) {
      const info: any[] = await prisma.$queryRawUnsafe(`PRAGMA index_info(${quoteId(dialect, String(ix.name))})`);
      for (const c of info) add(String(ix.name), String(c.name));
    }
  } else if (dialect === 'mysql') {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT index_name AS n, column_name AS c FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ${quoteStr(table)} AND non_unique = 0`
    );
    for (const r of rows) add(String(r.n ?? r.N), String(r.c ?? r.C));
  } else {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT i.relname AS n, a.attname AS c
       FROM pg_index x
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace s ON s.oid = t.relnamespace
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(x.indkey)
       WHERE x.indisunique AND s.nspname = current_schema() AND t.relname = ${quoteStr(table)}`
    );
    for (const r of rows) add(String(r.n), String(r.c));
  }
  return new Set([...byIndex.values()].map((cols) => [...cols].sort().join(',')));
}

/**
 * Досоздать составные уникальные ключи модели.
 *
 * Без них таблица, созданная автомиграцией (у обновившихся со старой версии и
 * в общей базе), выглядела исправной, но любая запись через upsert по такому
 * ключу падала: SQLite и PostgreSQL отвечают «ON CONFLICT не совпадает ни с
 * одним ключом». Так не записывался ни один кусок файла (FileChunk), а в
 * MariaDB ключ просто не держал повторов.
 *
 * Если в таблице уже есть повторы, индекс не создастся — об этом пишем в лог
 * и идём дальше: удалять чужие строки автомиграция не вправе.
 */
async function ensureUniqueKeys(prisma: any, dialect: Dialect, model: Model, log: (msg: string) => void, applied: string[]) {
  if (!model.uniques.length) return;
  const have = await existingUniqueSets(prisma, dialect, model.name);
  for (const u of model.uniques) {
    if (have.has([...u.columns].sort().join(','))) continue;
    const cols = u.columns.map((c) => quoteId(dialect, c)).join(', ');
    try {
      await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX ${quoteId(dialect, u.name)} ON ${quoteId(dialect, model.name)} (${cols})`);
      applied.push(`ключ ${u.name}`);
    } catch (e: any) {
      log(`[Schema Sync] Не удалось создать ключ ${u.name} (${u.columns.join(', ')}): ${e.message}. Возможно, в таблице есть повторы — данные не тронуты.`);
    }
  }
}

/** Насколько тип вместителен: расширять можно только вверх */
const TEXT_RANK: Record<string, number> = {
  char: 1, varchar: 2, tinytext: 3, text: 4, mediumtext: 5, longtext: 6,
};

/**
 * Надо ли расширить колонку.
 *
 * Только текстовые и только вверх: сузить — значит обрезать чужие данные, а
 * этого автомиграция делать не должна никогда. У PostgreSQL строка и так TEXT,
 * поэтому расширять там нечего.
 */
export function needsWidening(dialect: Dialect, currentType: string, wantedSql: string): boolean {
  if (dialect !== 'mysql') return false;
  const cur = TEXT_RANK[String(currentType || '').toLowerCase()];
  const want = TEXT_RANK[String(wantedSql || '').toLowerCase().replace(/\(.*$/, '')];
  if (!cur || !want) return false;
  return want > cur;
}

/** Одна правка колонки с тем же отходом на старый движок, что и у создания */
async function alterColumn(
  prisma: any, dialect: Dialect, table: string, c: Column, what: 'ADD' | 'MODIFY',
): Promise<void> {
  const sql = (noTextDefault: boolean) =>
    `ALTER TABLE ${quoteId(dialect, table)} ${what} COLUMN ${columnDdl(dialect, c, noTextDefault)}`;
  try {
    await prisma.$executeRawUnsafe(sql(false));
  } catch (e: any) {
    if (!isTextDefaultRefusal(e.message)) throw e;
    await prisma.$executeRawUnsafe(sql(true));
  }
}

// Главная точка: привести общую базу к схеме программы (аддитивно).
// Возвращает список выполненных изменений (для лога).
export async function ensureRemoteSchema(
  prisma: any,
  dialect: Dialect,
  schemaText: string,
  log: (msg: string) => void
): Promise<string[]> {
  return withSchemaConnection(prisma, connection => syncSchema(connection, dialect, schemaText, log));
}

async function syncSchema(prisma: any, dialect: Dialect, schemaText: string, log: (msg: string) => void): Promise<string[]> {
  const applied: string[] = [];
  let models: Model[];
  try {
    models = parsePrismaSchema(dialect, schemaText);
  } catch (e: any) {
    log(`[Schema Sync] Не удалось разобрать схему: ${e.message}`);
    return applied;
  }
  if (!models.length) {
    log('[Schema Sync] В схеме не найдено моделей — пропуск.');
    return applied;
  }

  let tables: Set<string>;
  try {
    tables = await existingTables(prisma, dialect);
  } catch (e: any) {
    log(`[Schema Sync] Не удалось прочитать список таблиц: ${e.message}`);
    return applied;
  }

  for (const model of models) {
    try {
      if (!tables.has(model.name)) {
        // Новой таблицы нет — создаём с колонками и первичным ключом
        const create = (noTextDefault: boolean) => {
          const defs = model.columns.map(c => {
            let d = columnDdl(dialect, c, noTextDefault);
            if (c.unique && !c.isId) d += ' UNIQUE';
            return d;
          });
          const idCol = model.columns.find(c => c.isId);
          if (idCol) defs.push(`PRIMARY KEY (${quoteId(dialect, idCol.name)})`);
          for (const fk of model.foreignKeys || []) defs.push(
            `FOREIGN KEY (${quoteId(dialect, fk.column)}) REFERENCES ${quoteId(dialect, fk.table)} (${quoteId(dialect, fk.reference)}) ON DELETE CASCADE ON UPDATE CASCADE`,
          );
          const engine = dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' : '';
          return `CREATE TABLE IF NOT EXISTS ${quoteId(dialect, model.name)} (${defs.join(', ')})${engine}`;
        };
        try {
          await prisma.$executeRawUnsafe(create(false));
        } catch (e: any) {
          // Старый движок не разрешает умолчание у TEXT. Повторяем без него:
          // лучше таблица без DEFAULT, чем ни таблицы, ни объяснения
          if (!isTextDefaultRefusal(e.message)) throw e;
          await prisma.$executeRawUnsafe(create(true));
        }
        applied.push(`создана таблица ${model.name}`);
        await ensureUniqueKeys(prisma, dialect, model, log, applied);
        await ensureRelationIndexes(prisma, dialect, model, applied);
        continue;
      }
      // Таблица есть — добавляем недостающие колонки и расширяем узкие
      const cols = await existingColumns(prisma, dialect, model.name);
      for (const c of model.columns) {
        if (!cols.has(c.name)) {
          try {
            await alterColumn(prisma, dialect, model.name, c, 'ADD');
            applied.push(`${model.name}.${c.name}`);
          } catch (e: any) {
            log(`[Schema Sync] Пропуск ${model.name}.${c.name}: ${e.message}`);
          }
          continue;
        }
        // «Таблица есть» не значит «колонка годится»: узкая VARCHAR(191) в
        // общей базе резала права роли и подпись в письме — записать не
        // получалось, а причина в ответе выглядела дампом драйвера
        if (!needsWidening(dialect, cols.get(c.name) || '', c.sqlType)) continue;
        try {
          await alterColumn(prisma, dialect, model.name, c, 'MODIFY');
          applied.push(`${model.name}.${c.name} → ${c.sqlType}`);
        } catch (e: any) {
          log(`[Schema Sync] Не удалось расширить ${model.name}.${c.name}: ${e.message}`);
        }
      }
      await ensureUniqueKeys(prisma, dialect, model, log, applied);
      await ensureRelationIndexes(prisma, dialect, model, applied);
    } catch (e: any) {
      log(`[Schema Sync] Ошибка при обработке ${model.name}: ${e.message}`);
    }
  }

  if (applied.length) log(`[Schema Sync] База приведена к схеме: ${applied.join(', ')}`);
  else log('[Schema Sync] Общая база уже соответствует схеме — изменений нет.');
  return applied;
}

async function ensureRelationIndexes(prisma: any, dialect: Dialect, model: Model, applied: string[]): Promise<void> {
  if (!model.indexes?.length) return;
  const spec = { table: model.name, cols: [] };
  const existing = (await inspectSchema(prisma, dialect, [spec])).get(model.name)?.indexes;
  for (const index of model.indexes) {
    const current = existing?.get(index.name);
    if (current) {
      if (!current.valid || current.partial || current.columns.join(',') !== index.columns.join(',')) throw Error(`Индекс ${index.name} не соответствует схеме связи`);
      continue;
    }
    try {
      await prisma.$executeRawUnsafe(createIndexSql(dialect, model.name, index.name, index.columns));
      applied.push(`индекс ${index.name}`);
    } catch (error: any) {
      if (!isDuplicateIndex(error?.message)) throw error;
    }
  }
}
