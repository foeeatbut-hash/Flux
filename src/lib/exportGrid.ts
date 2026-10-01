import { exportTable, selectItems, orderItems, type ExportSpec } from './exportSpec';
import type { ExchangeComponent, ParamColumn } from './equipmentExchange';

export interface ExportGrid { headers: string[]; rows: string[][]; rowKeys: string[]; columnKeys: string[]; formulas: number[]; formulaTemplates?: Record<number, string>; warnings: string[] }
export interface GridOptions { deduplicate?: boolean; groupBy?: string[]; sums?: string[]; blankRepeats?: string[] }
export const exportName = (row: string, col: string): string => {
  const text = `${row}\u0000${col}`;
  let a = 2166136261; let b = 5381;
  for (const c of text) { a = Math.imul(a ^ c.codePointAt(0)!, 16777619); b = Math.imul(b, 33) ^ c.codePointAt(0)!; }
  return `FXE_${(a >>> 0).toString(16)}_${(b >>> 0).toString(16)}`;
};
const numberOf = (s: string): number | null => /^[-+]?\d+(?:[.,]\d+)?$/.test(s.trim().replace(/\s/g, '')) ? Number(s.replace(/\s/g, '').replace(',', '.')) : null;

/** Группировка требует явных ключей; разные изделия не исчезают по сходству названий. */
export function exportGrid(items: ExchangeComponent[], spec: ExportSpec, known: ParamColumn[] = [], options: GridOptions = {}): ExportGrid {
  const dataColumns = spec.columns.filter(c => !c.key.startsWith('formula:'));
  const baseSpec = { ...spec, columns: dataColumns, groupHeaders: false };
  const base = exportTable(items, baseSpec, known);
  const picked = orderItems(selectItems(items, baseSpec), baseSpec.order);
  const columnKeys = dataColumns.map(c => `${c.key}::unit:${c.unit || known.find(p => p.key === c.key)?.unit || ''}`);
  const colIndex = (key: string) => dataColumns.findIndex(c => c.key === key);
  if (new Set(columnKeys).size !== columnKeys.length) throw new Error('Один столбец с той же единицей выбран несколько раз');
  let rows = base.rows.map(r => [...r]);
  let rowKeys = picked.map(it => `${it.id}:${it.tags?.[0]?.identifier || ''}`);
  const warnings = base.problems.map(p => `${p.tag}: ${p.column} — ${p.why}`);
  if (options.deduplicate) {
    const seen = new Set<string>(); const keep: number[] = [];
    rows.forEach((r, i) => { const key = JSON.stringify(r); if (!seen.has(key)) { seen.add(key); keep.push(i); } });
    rows = keep.map(i => rows[i]); rowKeys = keep.map(i => rowKeys[i]);
  }
  const groupCols = (options.groupBy || []).map(k => colIndex(k)).filter(i => i >= 0);
  if (groupCols.length) {
    const groups = new Map<string, { row: string[]; id: string; n: number }>();
    const sumCols = new Set((options.sums || []).map(k => colIndex(k)).filter(i => i >= 0 && !groupCols.includes(i)));
    rows.forEach((r, at) => {
      const key = JSON.stringify(groupCols.map(i => r[i])); const old = groups.get(key);
      if (!old) { groups.set(key, { row: [...r], id: `group:${key}`, n: 1 }); return; }
      old.n++;
      old.row = old.row.map((v, i) => {
        if (sumCols.has(i)) {
          const x = numberOf(v || '0'); const y = numberOf(r[i] || '0');
          if (x !== null && y !== null) return String(Math.round((x + y) * 1e10) / 1e10);
          warnings.push(`«${base.headers[i]}»: нечисловые значения объединены списком, не сложены`);
        }
        const values = [...new Set([v, r[i]].flatMap(s => s.split(' · ')).filter(Boolean))];
        return values.join(' · ');
      });
      // source id не является ключом группировки, но остаётся для диагностики.
      void rowKeys[at];
    });
    rows = [...groups.values()].map(g => g.row); rowKeys = [...groups.values()].map(g => g.id);
  }
  for (const key of options.blankRepeats || []) {
    const col = colIndex(key); if (col < 0) continue;
    let last = '';
    for (const row of rows) { const value = row[col]; if (value && value === last) row[col] = ''; else last = value; }
  }
  const headers = [...base.headers]; const formulas: number[] = []; const formulaTemplates: Record<number, string> = {};
  for (const column of spec.columns.filter(c => c.key.startsWith('formula:'))) {
    formulaTemplates[headers.length] = column.formula || '';
    formulas.push(headers.length); columnKeys.push(column.key); headers.push(column.label);
    rows.forEach((row, i) => row.push((column.formula || '').replace(/\{row\}/g, String(i + 2))));
  }
  return { headers, rows, rowKeys, columnKeys, formulas, formulaTemplates, warnings: [...new Set(warnings)] };
}
