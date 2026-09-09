/**
 * Схема Prisma и страховка DDL описывают одно и то же.
 *
 * Списков два, и это вынужденно: автомиграция читает схему, но индексов не
 * создаёт, поэтому таблицы обращений дополнительно описаны в
 * `server/feedback/tables.ts`. Два списка без проверки разъезжаются за пару
 * выпусков — и разъезжаются молча: программа работает, а на общей базе нет
 * того самого уникального индекса, на котором держится «повтор не плодит
 * карточек».
 *
 * Заодно сверяются три схемы между собой: они правятся руками, и поле,
 * добавленное только в sqlite, у заказчика на MariaDB просто не появится.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { FEEDBACK_TABLES } from '../server/feedback/tables';

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
  const re = /model\s+(Feedback[A-Za-z]*)\s*\{([\s\S]*?)\n\}/g;
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
      if (field[3] || /^Feedback[A-Z]/.test(field[2])) continue;
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
  ok(`моделей обращений заведено (${base.size})`, base.size >= 13, base.size);
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
  const specs = new Map(FEEDBACK_TABLES.map((t) => [t.table, t]));
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
  const specs = new Map(FEEDBACK_TABLES.map((t) => [t.table, t]));
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
  for (const spec of FEEDBACK_TABLES) {
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
  for (const spec of FEEDBACK_TABLES) {
    const inIndex = new Set((spec.indexes || []).flatMap((i) => i.cols));
    for (const col of spec.cols) {
      if (!inIndex.has(col.name)) continue;
      if (col.kind === 'longtext') bad.push(`${spec.table}.${col.name} — длинный текст в индексе`);
      else if (col.kind === 'text' && !col.indexed) bad.push(`${spec.table}.${col.name} — без пометки indexed`);
    }
  }
  ok('в индексах нет неразмеченных текстовых колонок', bad.length === 0, bad);
}

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
