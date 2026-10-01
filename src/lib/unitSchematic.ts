import { displayParentLinks } from '../../equipment/displayHierarchy';
export { displayParentLinks } from '../../equipment/displayHierarchy';
/** Узел состава, который можно показать на схеме физического изделия. */
export interface UnitSchematicItem {
  id: string;
  itemCode: string;
  parentElementId?: string | null;
  equipType: string;
  tags?: { id: string; metadata?: unknown }[];
}

export interface UnitSchematicNode<T extends UnitSchematicItem = UnitSchematicItem> {
  item: T;
  children: UnitSchematicNode<T>[];
}

export interface UnitSchematicTree<T extends UnitSchematicItem = UnitSchematicItem> {
  /** Физические позиции без родителя; только они участвуют в порядке потока. */
  roots: UnitSchematicNode<T>[];
  /** Позиции с потерянной связью или в цикле вместе с их поддеревьями. */
  unassigned: { node: UnitSchematicNode<T>; reason: 'missing-parent' | 'cycle' }[];
  /** Служебные строки не являются физическими изделиями и не рисуются. */
  physicalCount: number;
}

const isPhysical = (item: UnitSchematicItem) =>
  item.itemCode !== '__unit__' && !item.itemCode.endsWith('_общие');

/**
 * Собирает позиции по parentElementId, разрывая циклы без потери узлов.
 * Порядок исходных элементов сохраняется у детей, а корни схемы сортируются
 * по ходу воздуха; поэтому привод или двигатель не вклиниваются в поток.
 */
export function buildUnitSchematic<T extends UnitSchematicItem>(
  items: T[],
  sectionOrder: Record<string, number>,
): UnitSchematicTree<T> {
  const physical = displayParentLinks(items || []).filter(isPhysical);
  const byId = new Map<string, T>();
  const index = new Map<string, number>();
  physical.forEach((item, i) => {
    if (!byId.has(item.id)) index.set(item.id, i);
    byId.set(item.id, item);
  });

  const children = new Map<string, T[]>();
  const roots: T[] = [];
  const missing: T[] = [];
  for (const item of physical) {
    const parentId = item.parentElementId || '';
    if (!parentId) roots.push(item);
    else if (byId.has(parentId)) {
      const list = children.get(parentId) || [];
      list.push(item);
      children.set(parentId, list);
    } else missing.push(item);
  }

  const seen = new Set<string>();
  const toNode = (item: T): UnitSchematicNode<T> => {
    seen.add(item.id);
    const nested = (children.get(item.id) || []).filter((child) => !seen.has(child.id));
    return { item, children: nested.map(toNode) };
  };
  const rootNodes = roots
    .map((item, order) => ({ item, order }))
    .sort((a, b) => (sectionOrder[a.item.equipType] ?? 500) - (sectionOrder[b.item.equipType] ?? 500)
      || a.order - b.order)
    .map(({ item }) => toNode(item));

  const unassigned: UnitSchematicTree<T>['unassigned'] = [];
  for (const item of missing) {
    if (!seen.has(item.id)) unassigned.push({ node: toNode(item), reason: 'missing-parent' });
  }

  // В компоненте цикла нет корня. Находим участника самого цикла и открываем
  // от него ветвь в отдельной группе; обход с общей защитой от дублей завершит её.
  for (const item of physical) {
    if (seen.has(item.id)) continue;
    const path: T[] = [];
    const at = new Map<string, number>();
    let cursor: T | undefined = item;
    while (cursor && !seen.has(cursor.id) && !at.has(cursor.id)) {
      at.set(cursor.id, path.length);
      path.push(cursor);
      cursor = cursor.parentElementId ? byId.get(cursor.parentElementId) : undefined;
    }
    const cycle = cursor ? path.slice(at.get(cursor.id) ?? 0) : [];
    const anchor = cycle.length
      ? cycle.reduce((first, candidate) => index.get(candidate.id)! < index.get(first.id)! ? candidate : first)
      : item;
    unassigned.push({ node: toNode(anchor), reason: 'cycle' });
  }

  return { roots: rootNodes, unassigned, physicalCount: physical.length };
}
