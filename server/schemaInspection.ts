import type { Dialect, TableSpec } from './ddl.js';
import type { SchemaConnection } from './schemaRuntime.js';

const quote = (d: Dialect, value: string) => d === 'mysql' ? `\`${value.replace(/`/g, '``')}\`` : `"${value.replace(/"/g, '""')}"`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
export interface SchemaIndex { columns: string[]; unique: boolean; partial: boolean; valid: boolean; }
export interface SchemaTable { columns: Set<string>; indexes: Map<string, SchemaIndex>; }

/** Снимок метаданных вместо пробного ALTER каждой существующей колонки. */
export async function inspectSchema(connection: SchemaConnection, dialect: Dialect, specs: TableSpec[]): Promise<Map<string, SchemaTable>> {
  const tables = new Map<string, SchemaTable>();
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, { columns: new Set(), indexes: new Map() });
    return tables.get(name)!;
  };
  if (!specs.length) return tables;
  if (dialect === 'sqlite') {
    for (const spec of specs) {
      const columns = await connection.$queryRawUnsafe(`PRAGMA table_info(${quote(dialect, spec.table)})`);
      if (!columns.length) continue;
      const current = table(spec.table);
      columns.forEach(row => current.columns.add(String(row.name)));
      const indexes = await connection.$queryRawUnsafe(`PRAGMA index_list(${quote(dialect, spec.table)})`);
      for (const row of indexes) {
        const columns = await connection.$queryRawUnsafe(`PRAGMA index_info(${quote(dialect, String(row.name))})`);
        current.indexes.set(String(row.name), { columns: columns.map(col => String(col.name)), unique: !!Number(row.unique), partial: !!Number(row.partial), valid: true });
      }
    }
    return tables;
  }
  const names = specs.map(spec => literal(spec.table)).join(', ');
  const schema = dialect === 'mysql' ? 'DATABASE()' : 'current_schema()';
  const columns = await connection.$queryRawUnsafe(`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = ${schema} AND table_name IN (${names})`);
  columns.forEach(row => table(String(row.t ?? row.T)).columns.add(String(row.c ?? row.C)));
  const indexes = await connection.$queryRawUnsafe(dialect === 'mysql'
    ? `SELECT table_name AS t, index_name AS n, column_name AS c, non_unique AS nu FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name IN (${names}) ORDER BY table_name, index_name, seq_in_index`
    : `SELECT t.relname AS t, i.relname AS n, a.attname AS c, x.indisunique AS u, x.indpred IS NOT NULL AS p, x.indisvalid AS v
       FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace s ON s.oid = t.relnamespace
       JOIN pg_class i ON i.oid = x.indexrelid JOIN LATERAL unnest(x.indkey) WITH ORDINALITY k(attnum, ord) ON k.ord <= x.indnkeyatts
       LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       WHERE s.nspname = current_schema() AND t.relname IN (${names}) ORDER BY t.relname, i.relname, k.ord`);
  for (const row of indexes) {
    const current = table(String(row.t ?? row.T));
    const name = String(row.n ?? row.N);
    if (!current.indexes.has(name)) current.indexes.set(name, {
      columns: [], unique: dialect === 'mysql' ? Number(row.nu ?? row.NU) === 0 : !!row.u,
      partial: dialect === 'mysql' ? false : !!row.p, valid: dialect === 'mysql' ? true : !!row.v,
    });
    current.indexes.get(name)!.columns.push(String(row.c ?? row.C));
  }
  return tables;
}
