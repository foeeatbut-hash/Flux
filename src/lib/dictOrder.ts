// Порядок записей справочника. Чистые функции, состояния экрана не касаются.

// Helper function for formatted order codes
export const getOrderNumber = (index: number) => {
  return String(index + 1).padStart(3, '0');
};

export const getOrderedItems = (items: any[]) => {
  if (!items) return [];
  const map: Record<string, any[]> = {};
  const rootItems: any[] = [];

  items.forEach((item) => {
    if (item.parentId) {
      if (!map[item.parentId]) map[item.parentId] = [];
      map[item.parentId].push(item);
    } else {
      rootItems.push(item);
    }
  });

  const ordered: { item: any; depth: number }[] = [];

  const traverse = (item: any, depth: number) => {
    ordered.push({ item, depth });
    const children = map[item.id] || [];
    const sortedChildren = [...children].sort((a, b) =>
      a.code.localeCompare(b.code),
    );
    sortedChildren.forEach((child) => traverse(child, depth + 1));
  };

  const sortedRoots = [...rootItems].sort((a, b) =>
    a.code.localeCompare(b.code),
  );
  sortedRoots.forEach((root) => traverse(root, 0));

  items.forEach((item) => {
    if (!ordered.some((o) => o.item.id === item.id)) {
      ordered.push({ item, depth: 0 });
    }
  });

  return ordered;
};
