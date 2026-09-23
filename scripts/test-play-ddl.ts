/**
 * Схема Prisma и страховка DDL описывают одно и то же — для платформы.
 *
 * Списков два, и это вынужденно: автомиграция читает схему, но индексов не
 * создаёт, а у платформы на индексах держится не скорость, а правильность —
 * «одна активная группа на человека», «один незавершённый матч на лобби».
 * Два списка без проверки разъезжаются за пару выпусков, и разъезжаются
 * молча: программа работает, а в общей базе нет того самого индекса.
 *
 * Отдельно проверяются частичные индексы: у них есть условие, и потерять его
 * страшнее, чем потерять индекс целиком. Индекс без условия не «почти то же
 * самое» — он запрещает больше, чем надо, и ломает работу вместо того, чтобы
 * её уберечь.
 *
 * Заодно сверяются три схемы между собой: они правятся руками, и поле,
 * добавленное только в sqlite, у заказчика на MariaDB просто не появится.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { PLAY_TABLES } from '../server/play/tables';
import { createConditionalColumnSql, createIndexSql } from '../server/ddl';

const ROOT = join(__dirname, '..');
let f = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (f++, console.error('  ✗', name, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ''));

interface Model { fields: string[]; uniques: string[][]; indexes: string[][] }

/** Разбор блоков `model FeedbackX { … }`: только скалярные поля и индексы. */
function parse(text: string): Map<string, Model> {
  const out = new Map<string, Model>();
  const re = /model\s+(Play[A-Za-z]*)\s*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [, name, body] = m;
    const fields: string[] = [];
    const uniques: string[][] = [];
    const indexes: string[][] = [];
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('//') || line.startsWith('///')) continue;
      const at = line.match(/^@@(unique|index)\(\[([^\]]+)\]\)/);
      if (at) {
        const cols = at[2].split(',').map((c) => c.trim());
        (at[1] === 'unique' ? uniques : indexes).push(cols);
        continue;
      }
      if (line.startsWith('@@')) continue;
      const field = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s+([A-Za-z][A-Za-z0-9_]*)(\[\])?(\?)?/);
      if (!field) continue;
      // Связи — не колонки: у них нет своего столбца в таблице
      if (field[3] || /^Play[A-Z]/.test(field[2])) continue;
      fields.push(field[1]);
      // Поле с @unique — тоже уникальный индекс, просто на одну колонку
      if (/@unique/.test(line)) uniques.push([field[1]]);
    }
    out.set(name, { fields, uniques, indexes });
  }
  return out;
}

const schemas = {
  sqlite: parse(readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8')),
  postgres: parse(readFileSync(join(ROOT, 'prisma/schema.postgresql.prisma'), 'utf8')),
  mariadb: parse(readFileSync(join(ROOT, 'prisma/schema.mariadb.prisma'), 'utf8')),
};

console.log('1. Три схемы описывают одно и то же');
{
  const base = schemas.sqlite;
  ok(`моделей платформы заведено (${base.size})`, base.size >= 13, base.size);
  for (const [dialect, models] of Object.entries(schemas)) {
    if (dialect === 'sqlite') continue;
    const missing = [...base.keys()].filter((n) => !models.has(n));
    ok(`в ${dialect} есть все модели`, missing.length === 0, missing);
    const drift: string[] = [];
    for (const [name, model] of base) {
      const other = models.get(name);
      if (!other) continue;
      for (const field of model.fields) if (!other.fields.includes(field)) drift.push(`${name}.${field}`);
      for (const field of other.fields) if (!model.fields.includes(field)) drift.push(`${dialect}:${name}.${field}`);
    }
    ok(`в ${dialect} те же поля`, drift.length === 0, drift);
  }
}

console.log('\n2. Страховка DDL описывает все модели схемы');
{
  const specs = new Map(PLAY_TABLES.map((t) => [t.table, t]));
  const missing = [...schemas.sqlite.keys()].filter((n) => !specs.has(n));
  ok('для каждой модели есть описание таблицы', missing.length === 0, missing);
  const extra = [...specs.keys()].filter((n) => !schemas.sqlite.has(n));
  ok('лишних таблиц в описании нет', extra.length === 0, extra);

  const drift: string[] = [];
  for (const [name, model] of schemas.sqlite) {
    const spec = specs.get(name);
    if (!spec) continue;
    const cols = spec.cols.map((c) => c.name);
    for (const field of model.fields) if (!cols.includes(field)) drift.push(`нет колонки ${name}.${field}`);
    for (const col of cols) if (!model.fields.includes(col)) drift.push(`лишняя колонка ${name}.${col}`);
  }
  ok('колонки совпадают с полями схемы', drift.length === 0, drift);
}

console.log('\n3. Каждый индекс схемы создаётся страховкой');
{
  const specs = new Map(PLAY_TABLES.map((t) => [t.table, t]));
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const lost: string[] = [];
  for (const [name, model] of schemas.sqlite) {
    const spec = specs.get(name);
    if (!spec) continue;
    const made = spec.indexes || [];
    for (const cols of model.uniques) {
      if (!made.some((i) => i.unique && same(i.cols, cols))) lost.push(`${name} @@unique[${cols.join(',')}]`);
    }
    for (const cols of model.indexes) {
      if (!made.some((i) => same(i.cols, cols))) lost.push(`${name} @@index[${cols.join(',')}]`);
    }
  }
  // Без этих индексов «повтор не плодит карточек» и «кусок не задваивается»
  // перестают быть правдой на общей базе — молча
  ok('ни один индекс не потерян', lost.length === 0, lost);

  const named = new Set<string>();
  const twice: string[] = [];
  for (const spec of PLAY_TABLES) {
    for (const i of spec.indexes || []) {
      if (named.has(i.name)) twice.push(i.name);
      named.add(i.name);
    }
  }
  ok('имена индексов не повторяются', twice.length === 0, twice);
}

console.log('\n4. Колонки в индексах размечены как индексируемые');
{
  // У MySQL это меняет тип на VARCHAR(191): без пометки индекс по TEXT-колонке
  // не создастся вовсе, и обнаружится это только у заказчика
  const bad: string[] = [];
  for (const spec of PLAY_TABLES) {
    const inIndex = new Set((spec.indexes || []).flatMap((i) => i.cols));
    for (const col of spec.cols) {
      if (!inIndex.has(col.name)) continue;
      if (col.kind === 'longtext') bad.push(`${spec.table}.${col.name} — длинный текст в индексе`);
      else if (col.kind === 'text' && !col.indexed) bad.push(`${spec.table}.${col.name} — без пометки indexed`);
    }
  }
  ok('в индексах нет неразмеченных текстовых колонок', bad.length === 0, bad);
}

console.log('\n5. Частичные индексы не потеряли условия');
{
  // Каждое из этих правил — инвариант ТЗ. Условие тут важнее самого индекса:
  // без него уникальность распространяется на всю таблицу и запрещает
  // человеку вторую группу НАВСЕГДА, а не вторую одновременную
  const need: Array<[table: string, index: string, must: RegExp]> = [
    ['PlayPartyMember', 'PlayPartyMember_one_active_key', /leftAt/],
    ['PlayPartyMember', 'PlayPartyMember_pair_key', /leftAt/],
    ['PlayInvite', 'PlayInvite_pending_key', /PENDING/],
    ['PlayLobby', 'PlayLobby_active_key', /FORMING/],
    ['PlaySession', 'PlaySession_active_key', /ALLOCATING/],
    ['PlaySessionMember', 'PlaySessionMember_one_active_key', /ACTIVE/],
  ];
  for (const [table, index, must] of need) {
    const spec = PLAY_TABLES.find((t) => t.table === table);
    const idx = (spec?.indexes || []).find((i) => i.name === index);
    ok(`${index} объявлен`, !!idx, table);
    ok(`${index} уникален`, !!idx?.unique);
    ok(`${index} ограничен условием`, !!idx?.where && must.test(idx.where), idx?.where);
    if (idx?.where) {
      const sql = createIndexSql('mysql', table, index, idx.cols, true, idx.where);
      ok(`${index} в MariaDB строится по вычисляемым колонкам`,
        idx.cols.every(c => sql.includes(`__${index}_${c}`)) && !sql.includes(' WHERE '), sql);
      for (const col of idx.cols) {
        const generated = createConditionalColumnSql(table, index, col, idx.where);
        ok(`${index}.${col} оставляет закрытые записи вне ограничения`,
          generated.includes('CASE WHEN') && generated.includes('ELSE NULL END')
          && generated.includes(`THEN \`${col}\``) && !generated.includes('"'), generated);
      }
    }
  }

  // Обратное тоже важно: обычный UNIQUE там, где нужен частичный, — это тихо
  // сломанная работа. Пары «человек и группа» без условия быть не должно
  const wrong = PLAY_TABLES.flatMap((t) => (t.indexes || [])
    .filter((i) => i.unique && !i.where && (i.cols.join(',') === 'userId' || i.cols.join(',') === 'partyId'))
    .map((i) => `${t.table}.${i.name}`));
  ok('нет полного UNIQUE там, где нужен частичный', wrong.length === 0, wrong);
}

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
