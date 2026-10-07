/**
 * Строки таблицы E3Flux: позиции проекта × столбцы атрибутов.
 *
 * Отбор и порядок — те же, что у выгрузки оборудования (selectItems и
 * orderItems), а значения считает та же buildEquipmentExchange: одно правило на
 * выгрузку и на E3, иначе в Excel и в схеме стояли бы разные числа.
 */
import { attributesForClass, type E3Attribute } from '../../e3/attributes';
import type { E3Row } from '../../e3/attributeWorkbook';
import { buildEquipmentExchange, type ExchangeComponent, type ParamColumn } from './equipmentExchange';
import { defaultSpec, orderItems, selectItems, type ExportColumn } from './exportSpec';

export function e3Rows(
  items: ExchangeComponent[], attributes: E3Attribute[], columns: ExportColumn[], filter: { classes: string[]; taggedOnly: boolean },
): { rows: E3Row[]; problems: ReturnType<typeof buildEquipmentExchange>['problems'] } {
  const picked = orderItems(selectItems(items, { ...defaultSpec(), classes: filter.classes, taggedOnly: filter.taggedOnly, columns: [] }), 'class-tag');
  const cols: ParamColumn[] = columns.map((c) => ({ key: c.key, label: c.label, unit: c.unit || '', group: '', param: '', ...(c.source ? { source: c.source } : {}) }));
  const built = buildEquipmentExchange(picked, cols, { keepOrder: true });
  const byName = new Map<string, E3Attribute>();
  for (const a of attributes || []) if (!byName.has(a.name)) byName.set(a.name, a);
  const rows = picked.map((it, i): E3Row => {
    const cls = String(it.cls || 'ПРОЧЕЕ');
    // Столбец типа, к которому атрибут не относится, — не пропущенные данные, а пустое место
    const na = columns.map((c) => { const a = byName.get(c.key.slice(3)); return !!a && attributesForClass([a], cls).length === 0; });
    return { id: String(it.id || ''), cls, label: (it.tags || [])[0]?.identifier || String(it.name || ''), cells: built.rows[i].map((v, j) => (na[j] ? '' : v)), na };
  });
  return { rows, problems: built.problems };
}
