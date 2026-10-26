/**
 * Чистая модель читателя Каталога: одна запись списка на модель или
 * комплектующее, фильтры, счётчики для навигации и главные характеристики
 * для карточки. Без React — чтобы фильтры и счётчики проверялись скриптом.
 */
import type { Catalog, Component, Family, FactDef, ParamDef } from '../../../../catalog/model';
import { textOf } from '../../../../catalog/model';

export type Scope = 'all' | 'models' | 'components';
export type SortKey = 'code' | 'maker' | 'data';

export interface Entry {
  family: Family;
  component?: Component;
  isComponent: boolean;
  maker: string;
  /** Ключ изготовителя для фильтра: id или `name:<название>` у комплектующих без справочника */
  makerKey: string;
  classIds: string[];
  /** Подтип внутри типа оборудования: «пожарный», «осевой» */
  kindLabel: string;
  hay?: string;
}

export interface Filters {
  query: string;
  classId: string;
  kindId: string;
  makerKey: string;
  scope: Scope;
}

/** Каталог открывается моделями: комплектующих в разы больше, и они вытесняли бы главное */
export const EMPTY_FILTERS: Filters = { query: '', classId: '', kindId: '', makerKey: '', scope: 'models' };

const COMPONENT_KIND: Record<string, string> = { actuator: 'Привод', box: 'Коробка', gland: 'Кабельный ввод', heater: 'Обогрев', frame: 'Рама', other: 'Прочее' };

export function valueText(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function makerOf(catalog: Catalog, family: Family, component?: Component): string {
  const maker = catalog.manufacturers.find((item) => item.id === family.manufacturerId);
  return maker?.shortName || maker?.name || component?.manufacturer || '';
}

/** Комплектующее показывается так же, как модель: одна идентичность на оба вида записей */
export function familyOfComponent(component: Component, catalog: Catalog): Family {
  const maker = catalog.manufacturers.find((item) => item.id === component.manufacturerId)
    || catalog.manufacturers.find((item) => item.name === component.manufacturer || item.shortName === component.manufacturer);
  return {
    id: `component:${component.id}`, classId: component.classId, manufacturerId: maker?.id || '', code: component.code,
    title: component.title, typeLabel: { ru: component.equipmentType || component.kind }, kind: component.kind,
    shapes: [], positions: [], designationMode: 'article', article: component.code, rules: [], match: { kinds: [] },
    params: (component.specs || []).map((spec, index) => ({
      key: `spec_${index}`, label: spec.label, kind: 'text' as const, unit: spec.unit,
      values: [{ code: spec.value, label: { ru: spec.value } }],
    })),
    specs: [], facts: component.facts,
    catalog: component.catalog || (component.sourcePdfPage ? { file: '', pages: String(component.sourcePdfPage) } : undefined),
    documents: component.documents, sections: component.sections, tables: component.tables,
    status: component.status || 'partial', todo: component.todo,
  };
}

export function buildEntries(catalog: Catalog): Entry[] {
  const kindLabelOf = (classId: string, kind: string) => {
    const def = catalog.classes.find((c) => c.id === classId)?.facts.find((f) => f.key === 'kind');
    return textOf(def?.values?.find((v) => v.code === kind)?.label) || '';
  };
  const models: Entry[] = catalog.families.map((family) => ({
    family, isComponent: false, maker: makerOf(catalog, family), makerKey: family.manufacturerId,
    classIds: [family.classId], kindLabel: kindLabelOf(family.classId, family.kind),
  }));
  const parts: Entry[] = catalog.components.map((component) => {
    const family = familyOfComponent(component, catalog);
    return {
      family, component, isComponent: true, maker: makerOf(catalog, family, component),
      makerKey: family.manufacturerId || (component.manufacturer ? `name:${component.manufacturer}` : ''),
      classIds: component.classIds?.length ? component.classIds : [component.classId],
      kindLabel: component.equipmentType || COMPONENT_KIND[component.kind] || component.kind,
    };
  });
  return [...models, ...parts];
}

function haystack(entry: Entry): string {
  if (entry.hay === undefined) {
    const f = entry.family;
    entry.hay = [
      f.code, textOf(f.title), textOf(f.description), textOf(f.typeLabel), ...(f.aliases || []), entry.maker, entry.kindLabel,
      ...(f.sections || []).map((s) => `${s.title} ${s.text}`),
      ...(f.tables || []).flatMap((t) => [t.title, ...t.rows.map((r) => Object.values(r.values).join(' '))]),
    ].join('\n').toLocaleLowerCase('ru');
  }
  return entry.hay;
}

/** Пропускает по всем фильтрам, кроме названных в `skip` — так считаются счётчики соседних фильтров */
export function matches(entry: Entry, f: Filters, skip?: keyof Filters): boolean {
  if (skip !== 'scope' && f.scope !== 'all' && (f.scope === 'components') !== entry.isComponent) return false;
  if (skip !== 'classId' && f.classId && !entry.classIds.includes(f.classId)) return false;
  if (skip !== 'kindId' && f.kindId && entry.family.kind !== f.kindId) return false;
  if (skip !== 'makerKey' && f.makerKey && entry.makerKey !== f.makerKey) return false;
  const q = f.query.trim().toLocaleLowerCase('ru');
  return skip === 'query' || !q || haystack(entry).includes(q);
}

export function sortEntries(list: Entry[], key: SortKey): Entry[] {
  const rank = (e: Entry) => ({ full: 0, partial: 1, draft: 2 }[e.family.status] ?? 3);
  const byCode = (a: Entry, b: Entry) => (a.family.sort ?? 0) - (b.family.sort ?? 0) || a.family.code.localeCompare(b.family.code, 'ru');
  const cmp = key === 'maker' ? (a: Entry, b: Entry) => a.maker.localeCompare(b.maker, 'ru') || byCode(a, b)
    : key === 'data' ? (a: Entry, b: Entry) => rank(a) - rank(b) || byCode(a, b) : byCode;
  return [...list].sort(cmp);
}

export interface NavCounts {
  classes: Map<string, number>;
  kinds: Map<string, number>;
  makers: Map<string, { title: string; count: number }>;
  scope: Record<Scope, number>;
}

/** Каждый фильтр считается при остальных включённых: число рядом с пунктом — то, что получится после нажатия */
export function navCounts(entries: Entry[], f: Filters): NavCounts {
  const classes = new Map<string, number>(); const kinds = new Map<string, number>();
  const makers = new Map<string, { title: string; count: number }>();
  const scope: Record<Scope, number> = { all: 0, models: 0, components: 0 };
  for (const e of entries) {
    if (matches(e, f, 'classId')) for (const id of e.classIds) classes.set(id, (classes.get(id) || 0) + 1);
    if (matches(e, f, 'kindId') && e.family.kind) kinds.set(e.family.kind, (kinds.get(e.family.kind) || 0) + 1);
    if (matches(e, f, 'makerKey') && e.makerKey) { const m = makers.get(e.makerKey) || { title: e.maker, count: 0 }; m.count++; makers.set(e.makerKey, m); }
    if (matches(e, f, 'scope')) { scope.all++; scope[e.isComponent ? 'components' : 'models']++; }
  }
  return { classes, kinds, makers, scope };
}

export interface KeyFact { label: string; value: string }

/** Главные характеристики для карточки: признаки класса, затем характеристики комплектующего */
export function keyFacts(entry: Entry, catalog: Catalog, limit = 4): KeyFact[] {
  const out: KeyFact[] = [];
  const defs: FactDef[] = catalog.classes.find((c) => c.id === entry.family.classId)?.facts || [];
  for (const [key, raw] of Object.entries(entry.family.facts || {})) {
    if (key === 'kind' || raw === undefined || raw === null || raw === '') continue;
    const def = defs.find((d) => d.key === key);
    const choice = def?.values?.find((v) => v.code === String(raw));
    const value = choice ? textOf(choice.label) : `${valueText(raw)}${def?.unit ? ` ${def.unit}` : ''}`;
    out.push({ label: def ? textOf(def.label) : key, value });
  }
  if (entry.component) {
    for (const spec of entry.component.specs || []) out.push({ label: textOf(spec.label), value: `${spec.value}${spec.unit ? ` ${spec.unit}` : ''}` });
  }
  return out.filter((x) => x.label && x.value).slice(0, limit);
}

/** Значения параметра словами: для таблицы исполнений и сравнения */
export function paramOptions(param: ParamDef | undefined): string[] {
  return param?.values?.map((item) => textOf(item.label)).filter(Boolean) || [];
}

export function documentCount(f: Family): number {
  const files = new Set<string>();
  for (const d of f.documents || []) files.add(d.assetId || d.file || d.id);
  for (const s of f.sections || []) if (s.source.file) files.add(s.source.assetId || s.source.file);
  if (f.catalog?.assetId || f.catalog?.file) files.add(f.catalog.assetId || f.catalog.file);
  return files.size;
}
