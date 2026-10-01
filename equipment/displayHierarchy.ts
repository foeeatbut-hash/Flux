function parentTagId(metadata: unknown): string {
  let value = metadata;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return ''; }
  }
  return String((value as { parentId?: unknown } | null)?.parentId || '');
}

/**
 * В старых связях состава родитель позиции записан в metadata родительского
 * тега, а не в parentElementId. Экран восстанавливает эту связь для показа,
 * не переписывая полученные от сервера строки.
 */
export function displayParentLinks<T extends { id: string; parentElementId?: string | null; tags?: { id: string; metadata?: unknown }[] }>(items: T[]): T[] {
  const ownerOfTag = new Map<string, string>();
  for (const item of items || []) for (const tag of item.tags || []) {
    if (tag.id && !ownerOfTag.has(tag.id)) ownerOfTag.set(tag.id, item.id);
  }

  return (items || []).map((item) => {
    if (item.parentElementId) return { ...item };
    const inferred = new Set<string>();
    for (const tag of item.tags || []) {
      const parentTag = parentTagId(tag.metadata);
      if (!parentTag) continue;
      const owner = ownerOfTag.get(parentTag);
      if (owner === item.id) continue;
      inferred.add(owner || `tag-parent:${parentTag}`);
    }
    if (inferred.size > 1) return { ...item, parentElementId: `tag-ambiguous:${item.id}` };
    const parent = [...inferred][0];
    if (parent) return { ...item, parentElementId: parent };
    return { ...item };
  });
}
