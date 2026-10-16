import { displayParentLinks } from '../../equipment/displayHierarchy';
export { displayParentLinks } from '../../equipment/displayHierarchy';

export interface EquipmentOverviewItem {
  id: string;
  itemCode: string;
  parentElementId?: string | null;
  equipType?: string;
  tags?: { id: string; metadata?: unknown }[];
}
export interface EquipmentOverviewNode<T extends EquipmentOverviewItem = EquipmentOverviewItem> {
  item: T;
  children: EquipmentOverviewNode<T>[];
}
export interface EquipmentOverviewTree<T extends EquipmentOverviewItem = EquipmentOverviewItem> {
  roots: EquipmentOverviewNode<T>[];
  unassigned: { node: EquipmentOverviewNode<T>; reason: 'missing-parent' | 'cycle' | 'tag-parent' | 'tag-ambiguous' }[];
  generalItems: T[];
  physicalCount: number;
}
const isPhysical = (item: EquipmentOverviewItem) =>
  item.itemCode !== '__unit__' && !item.itemCode.endsWith('_общие');
const unresolvedReason = (parentId: string): 'missing-parent' | 'tag-parent' | 'tag-ambiguous' =>
  parentId.startsWith('tag-ambiguous:') ? 'tag-ambiguous'
    : parentId.startsWith('tag-parent:') ? 'tag-parent' : 'missing-parent';

/** Сохраняет все физические позиции, включая потерянные связи и циклы. */
export function buildEquipmentOverview<T extends EquipmentOverviewItem>(
  items: T[], sectionOrder: Record<string, number>,
): EquipmentOverviewTree<T> {
  const linkedItems = displayParentLinks(items || []);
  const generalItems = linkedItems.filter(item => item.itemCode !== '__unit__' && item.itemCode.endsWith('_общие'));
  const physical = linkedItems.filter(isPhysical);
  const byId = new Map<string, T>();
  const index = new Map<string, number>();
  physical.forEach((item, i) => {
    if (!byId.has(item.id)) index.set(item.id, i);
    byId.set(item.id, item);
  });
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  const missing: { item: T; reason: ReturnType<typeof unresolvedReason> }[] = [];
  for (const item of physical) {
    const parentId = item.parentElementId || '';
    if (!parentId) roots.push(item);
    else if (byId.has(parentId)) {
      const list = children.get(parentId) || [];
      list.push(item);
      children.set(parentId, list);
    } else missing.push({ item, reason: unresolvedReason(parentId) });
  }
  const seen = new Set<string>();
  const toNode = (item: T): EquipmentOverviewNode<T> => {
    seen.add(item.id);
    const nested = (children.get(item.id) || []).filter(child => !seen.has(child.id));
    return { item, children: nested.map(toNode) };
  };
  const rootNodes = roots.map((item, order) => ({ item, order }))
    .sort((a, b) => (sectionOrder[a.item.equipType || ''] ?? 500) - (sectionOrder[b.item.equipType || ''] ?? 500) || a.order - b.order)
    .map(({ item }) => toNode(item));
  const unassigned: EquipmentOverviewTree<T>['unassigned'] = [];
  for (const { item, reason } of missing) {
    if (!seen.has(item.id)) unassigned.push({ node: toNode(item), reason });
  }
  // У цикла нет корня: выбираем участника цикла и размыкаем обход общей защитой.
  for (const item of physical) {
    if (seen.has(item.id)) continue;
    const path: T[] = [], at = new Map<string, number>();
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
  return { roots: rootNodes, unassigned, generalItems, physicalCount: physical.length };
}
