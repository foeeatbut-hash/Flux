/** Разница проекта хранится отдельно от закреплённой общей редакции. */
export interface CatalogDifference { path: string[]; before?: unknown; after?: unknown; remove?: boolean }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export function catalogDifferences(before: any, after: any, path: string[] = []): CatalogDifference[] {
  if (same(before, after)) return [];
  if (object(before) && object(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => {
      if (!Object.prototype.hasOwnProperty.call(after, key)) return [{ path: [...path, key], before: before[key], remove: true }];
      return catalogDifferences(before[key], after[key], [...path, key]);
    });
  }
  return [{ path, before, after }];
}

/** Массив заменяется целиком: удаление элемента не сдвигает чужие индексы. */
export function applyCatalogDifferences(base: any, changes: CatalogDifference[]): any {
  let result = JSON.parse(JSON.stringify(base));
  for (const change of changes) {
    if (change.path.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('Недопустимое поле каталога');
    if (!change.path.length) { result = change.remove ? {} : structuredClone(change.after); continue; }
    let parent = result;
    for (const key of change.path.slice(0, -1)) {
      if (!object(parent[key])) parent[key] = {};
      parent = parent[key];
    }
    const key = change.path[change.path.length - 1];
    if (change.remove) delete parent[key]; else parent[key] = structuredClone(change.after);
  }
  return result;
}
