/**
 * Позиции проекта для раздела «Нет данных»: те же, что видят «Подбор по проекту»
 * (соседи — позиции одной установки) и «Атрибуты проекта» (пустая ячейка с
 * «Да» считается той же `isMissingCell`), чтобы три экрана не спорили о том,
 * чего не хватает.
 */
import { e3Columns, type E3Attribute } from '../../e3/attributes';
import { isMissingCell } from '../../e3/attributeWorkbook';
import type { GapPosition } from '../../e3/gaps';
import { buildExportSources, type ExportSystem } from './exportWorkspace';
import { e3Rows } from './e3Table';
import { toPositions } from './e3Positions';

export function buildGapPositions(systems: ExportSystem[], attributes: E3Attribute[]): GapPosition[] {
  const items = buildExportSources(systems, []).rows('all');
  const live = attributes.filter((a) => !a.removed);
  const classes = [...new Set(items.map((it) => String(it.cls || 'ПРОЧЕЕ')))];
  const columns = e3Columns(live, classes, { header: 'name' });
  const missing = new Map<string, string[]>();
  for (const r of e3Rows(items, live, columns, { classes: [], taggedOnly: false }).rows) {
    const names = columns.filter((c, j) => isMissingCell(c, r.cells[j], r.na[j])).map((c) => c.key.slice(3));
    if (names.length) missing.set(r.id, names);
  }
  const bySystem = new Map<string, typeof items>();
  for (const it of items) bySystem.set(it.systemName, [...(bySystem.get(it.systemName) || []), it]);
  const out: GapPosition[] = [];
  for (const group of bySystem.values()) {
    const positions = toPositions(group);
    group.forEach((it, i) => {
      out.push({
        id: positions[i].id, label: (it.tags || [])[0]?.identifier || String(it.name || ''), position: positions[i], siblings: positions,
        missingAttrs: missing.get(positions[i].id) || [],
      });
    });
  }
  return out;
}
