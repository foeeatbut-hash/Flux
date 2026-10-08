/**
 * Характеристики позиций программы «Оборудование» по типу Flux — список, из
 * которого в справочнике атрибутов E3 выбирают источник «характеристика» для
 * типа (решение владельца: только данные, которые есть в «Оборудовании»).
 *
 * Читаются позиции всех проектов, кроме снятых; проект за проектом и только
 * нужные столбцы, чтобы не держать в памяти весь парк. Тип позиции — тот же,
 * что видит человек (classifyAll: ручная поправка, тег, родство), поэтому
 * тип нельзя взять из столбца equipType.
 */
import { classifyAll } from '../equipment/classes.js';

export interface ClassParam {
  /** «Группа|Название» — так хранится источник характеристики, он указывает её точно */
  key: string;
  group: string;
  name: string;
  /** Единицы, встречающиеся у позиций, с числом позиций */
  units: { unit: string; count: number }[];
  /** У скольких позиций значение заполнено */
  count: number;
}

export async function classParams(db: any, cls: string): Promise<{ params: ClassParam[]; positions: number }> {
  const acc = new Map<string, { group: string; name: string; units: Map<string, number>; count: number }>();
  let positions = 0;
  const systems: { id: string }[] = await db.equipmentSystem.findMany({ select: { id: true } });
  for (const sys of systems) {
    const list: any[] = await db.componentElement.findMany({
      where: { status: { not: 'REMOVED' }, monoblock: { systemId: sys.id } },
      select: { id: true, itemCode: true, name: true, equipType: true, role: true, sourceKind: true, specs: true, parentElementId: true, equipClass: true, equipKind: true, tags: { select: { identifier: true } } },
    });
    const types = classifyAll(list);
    for (const c of list) {
      if (types.get(c.id)?.cls !== cls) continue;
      positions++;
      let groups: any[] = [];
      try { const s = typeof c.specs === 'string' ? JSON.parse(c.specs) : c.specs; groups = Array.isArray(s?.groups) ? s.groups : []; } catch (_) { /* битые specs — позиция без характеристик */ }
      const seen = new Set<string>();
      for (const g of groups) {
        const group = String(g?.title ?? '').trim();
        // Группа «КИП» тоже в списке: решение владельца — источником может быть и она
        if (!group) continue;
        for (const p of Array.isArray(g.params) ? g.params : []) {
          const name = String(p?.key ?? '').trim();
          if (!name || !String(p?.value ?? '').trim()) continue;
          const key = `${group}|${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const e = acc.get(key) || { group, name, units: new Map<string, number>(), count: 0 };
          e.count++;
          const unit = String(p.unit ?? '').trim();
          e.units.set(unit, (e.units.get(unit) || 0) + 1);
          acc.set(key, e);
        }
      }
    }
  }
  const params = [...acc.entries()].map(([key, e]) => ({
    key, group: e.group, name: e.name, count: e.count,
    units: [...e.units.entries()].map(([unit, count]) => ({ unit, count })).sort((a, b) => b.count - a.count),
  })).sort((a, b) => a.group.localeCompare(b.group, 'ru') || a.name.localeCompare(b.name, 'ru'));
  return { params, positions };
}
