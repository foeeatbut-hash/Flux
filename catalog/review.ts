/** Сравнение предметных данных для публикации; технические метки в разницу не входят. */
export interface CatalogDifference { path: string; before: string; after: string }
const show = (v: any): string => v === undefined ? 'Не указано' : v === null ? 'Пусто' : typeof v === 'object' ? JSON.stringify(v) : String(v);
export function catalogDifferences(before: any, after: any, limit = 200): CatalogDifference[] {
  const out: CatalogDifference[] = [];
  const walk = (a: any, b: any, path: string, depth: number) => {
    if (out.length >= limit || JSON.stringify(a) === JSON.stringify(b)) return;
    if (depth < 12 && a && b && typeof a === 'object' && typeof b === 'object') {
      if (Array.isArray(a) && Array.isArray(b) && [...a, ...b].every(v => v && typeof v === 'object' && (v.id || v.key))) {
        const aa = new Map(a.map(v => [v.id || v.key, v])); const bb = new Map(b.map(v => [v.id || v.key, v]));
        // Порядок позиций влияет на маркировку: сравнение по ID не должно скрывать перестановку.
        if (JSON.stringify([...aa.keys()]) !== JSON.stringify([...bb.keys()])) walk([...aa.keys()], [...bb.keys()], `${path}.Порядок`, 12);
        for (const id of new Set([...aa.keys(), ...bb.keys()])) walk(aa.get(id), bb.get(id), `${path}[${id}]`, depth + 1);
      } else for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!key.startsWith('_')) walk(a[key], b[key], path ? `${path}.${key}` : key, depth + 1);
      return;
    }
    out.push({ path: path || 'Запись', before: show(a).slice(0, 800), after: show(b).slice(0, 800) });
  };
  walk(before, after, '', 0); return out;
}
