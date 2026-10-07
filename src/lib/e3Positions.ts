/**
 * Позиции проекта для подбора типового решения (e3/solutionSelect.ts).
 *
 * Модуль подбора чистый и данных не ищет: значения источников читаются тем же
 * правилом, что и ячейки атрибутов E3 (equipmentCell), иначе подбор и таблица
 * атрибутов видели бы у одной позиции разные числа.
 */
import type { E3Position, E3RuleSource } from '../../e3/solutionTypes';
import { equipmentCell, type ExchangeComponent } from './equipmentExchange';

export function toPositions(items: ExchangeComponent[]): E3Position[] {
  return items.map((it) => ({
    id: String(it.id || ''),
    cls: String(it.cls || 'ПРОЧЕЕ'),
    ...(it.role ? { role: it.role } : {}),
    ...((it.tags || [])[0]?.identifier ? { tag: it.tags![0].identifier } : {}),
    ...(it.parentTag ? { parentTag: it.parentTag } : {}),
    read: (s: E3RuleSource) => (s.kind === 'field' ? equipmentCell(it, 'e3:x', '', { kind: 'field', key: s.key })
      : s.kind === 'param' ? equipmentCell(it, 'e3:x', s.unit || '', { kind: 'param', name: s.name, ...(s.unit ? { unit: s.unit } : {}) }) : ''),
  }));
}
