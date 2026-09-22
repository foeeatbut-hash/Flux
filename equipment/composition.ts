/**
 * Состав установки: кто чей владелец и какой у позиции родительский тег.
 *
 * Правило одно на всю программу: родитель — тег БЛИЖАЙШЕГО ТЕГИРОВАННОГО
 * ВЛАДЕЛЬЦА позиции, а если такого нет, тег установки. Оно же лежит в основе
 * родства тегов при импорте (`server/equipmentHierarchy.ts`).
 *
 * Считается это здесь, а не по месту, потому что мест три: выгрузка в Excel,
 * сборка таблицы и карточка позиции. Разойдись они, в таблице стояли бы одни
 * родители, в выгрузке другие, а в разделе «Теги» третьи — и разбираться, кто
 * из них прав, пришлось бы на объекте.
 */

export interface CompositionNode {
  id: string;
  itemCode?: string;
  name?: string;
  parentElementId?: string | null;
  tags?: { identifier: string }[];
}

export interface Composition {
  /** Главный тег: тег установки. Пусто — установку не тегировали */
  unitTag: string;
  /** Тег ближайшего тегированного владельца; нет такого — тег установки */
  parentTagOf: (node: CompositionNode) => string;
  /** Название непосредственного владельца — для колонки «Владелец» */
  parentNameOf: (node: CompositionNode) => string;
}

const tagOf = (node?: CompositionNode): string => String((node?.tags || [])[0]?.identifier || '');

/**
 * Разобрать состав одной установки.
 *
 * `unitName` — обозначение установки: по нему тег установки находится и тогда,
 * когда служебной строки `__unit__` в списке нет (её отбрасывают выгрузки).
 */
export function compositionOf(nodes: CompositionNode[], unitName = ''): Composition {
  const byId = new Map<string, CompositionNode>();
  for (const n of nodes || []) byId.set(n.id, n);

  const unitTag = tagOf([...byId.values()].find((n) => n.itemCode === '__unit__'))
    || (unitName ? [...byId.values()].map(tagOf).find((t) => t === unitName) || '' : '');

  const parentTagOf = (node: CompositionNode): string => {
    const seen = new Set<string>([node.id]);
    let at = node.parentElementId ? byId.get(node.parentElementId) : undefined;
    while (at && !seen.has(at.id)) {
      seen.add(at.id);          // кольцо в данных не должно вешать обход
      const t = tagOf(at);
      if (t) return t;
      at = at.parentElementId ? byId.get(at.parentElementId) : undefined;
    }
    return unitTag;
  };

  const parentNameOf = (node: CompositionNode): string =>
    String(byId.get(node.parentElementId || '')?.name || '');

  return { unitTag, parentTagOf, parentNameOf };
}
