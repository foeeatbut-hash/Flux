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
import { compositionOf } from '../../equipment/composition';
import { modelOf } from '../../equipment/classes';

export interface RowComponent {
  id: string; itemCode: string; name: string; equipType: string;
  specs?: string; overrides?: string;
  tags?: { id?: string; identifier: string }[];
  role?: string;
  parentElementId?: string | null;
  instanceNo?: number | null;
  manual?: boolean;
  sourceOrder?: number | null;
  sourceKind?: string | null;
}
export interface RowMonoblock { name: string; components: RowComponent[] }
export interface RowSystem { name: string; monoblocks: RowMonoblock[] }

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
  const all = (sys.monoblocks || []).flatMap((mb) => mb.components || []);
  const { unitTag, parentTagOf } = compositionOf(all as any, sys.name);

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
      parentTag: parentTagOf(c as any),
      unitTag,
      instanceNo: c.instanceNo ?? null,
      manual: !!c.manual,
      sourceOrder: c.sourceOrder ?? null,
      sourceKind: c.sourceKind ?? null,
      model: modelOf(c.specs),
    })));
}

/** Строки всего проекта. */
export const rowsOfProject = (
  systems: RowSystem[],
  normalizeSpecs: (raw?: string) => { groups: any[] },
): ExchangeComponent[] => (systems || []).flatMap((s) => rowsOfSystem(s, normalizeSpecs));
