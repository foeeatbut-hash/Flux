/**
 * Позиции проекта плоским списком — для выгрузки и для таблицы.
 *
 * Реестр хранит состав деревом: блок, вентилятор внутри него, двигатель внутри
 * вентилятора. Выгрузка же плоская, и в ней у каждой строки должны стоять
 * рядом свой тег, тег владельца и тег установки — владелец просил именно так:
 * «первый столбец — теги двигателей, дальше их данные и тег родителя».
 *
 * Считается это здесь, а не в экране: правило «тег ближайшего тегированного
 * владельца, а если такого нет — тег установки» то же самое, что у родства
 * тегов при импорте, и разойтись эти два места не должны.
 */

import type { ExchangeComponent } from './equipmentExchange';

export interface RowComponent {
  id: string; itemCode: string; name: string; equipType: string;
  specs?: string; overrides?: string;
  tags?: { id?: string; identifier: string }[];
  role?: string;
  parentElementId?: string | null;
  instanceNo?: number | null;
  manual?: boolean;
  sourceOrder?: number | null;
}
export interface RowMonoblock { name: string; components: RowComponent[] }
export interface RowSystem { name: string; monoblocks: RowMonoblock[] }

const tagOf = (c?: RowComponent): string => (c?.tags || [])[0]?.identifier || '';

const parseJson = (raw?: string): any => {
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; }
};

/**
 * Строки одной установки.
 *
 * `normalizeSpecs` передаётся снаружи: разбор характеристик живёт в экране и
 * знает про ручные правки и старые форматы, а тащить его сюда значило бы
 * завести вторую копию этого знания.
 */
export function rowsOfSystem(
  sys: RowSystem,
  normalizeSpecs: (raw?: string) => { groups: any[] },
): ExchangeComponent[] {
  const byId = new Map<string, RowComponent>();
  for (const mb of sys.monoblocks || []) for (const c of mb.components || []) byId.set(c.id, c);

  const unitRow = [...byId.values()].find((c) => c.itemCode === '__unit__');
  const unitTag = tagOf(unitRow)
    || [...byId.values()].map(tagOf).find((t) => t === sys.name)
    || '';

  /** Тег ближайшего тегированного владельца; нет такого — тег установки */
  const parentTagOf = (c: RowComponent): string => {
    const seen = new Set<string>([c.id]);
    let at = c.parentElementId ? byId.get(c.parentElementId) : undefined;
    while (at && !seen.has(at.id)) {
      seen.add(at.id);
      const t = tagOf(at);
      if (t) return t;
      at = at.parentElementId ? byId.get(at.parentElementId) : undefined;
    }
    return unitTag;
  };

  return (sys.monoblocks || []).flatMap((mb) => (mb.components || [])
    // Служебный блок параметров установки в перечень изделий не входит
    .filter((c) => c.itemCode !== '__unit__')
    .map((c) => ({
      id: c.id, itemCode: c.itemCode, name: c.name, equipType: c.equipType,
      groups: normalizeSpecs(c.specs).groups,
      overrides: parseJson(c.overrides),
      tags: c.tags || [],
      systemName: sys.name,
      monoblockName: mb.name === '__unit__' ? '' : mb.name,
      role: c.role || 'БЛОК',
      parentTag: parentTagOf(c),
      unitTag,
      instanceNo: c.instanceNo ?? null,
      manual: !!c.manual,
      sourceOrder: c.sourceOrder ?? null,
    })));
}

/** Строки всего проекта. */
export const rowsOfProject = (
  systems: RowSystem[],
  normalizeSpecs: (raw?: string) => { groups: any[] },
): ExchangeComponent[] => (systems || []).flatMap((s) => rowsOfSystem(s, normalizeSpecs));
