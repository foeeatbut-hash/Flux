import { withDefaults, type CatalogRef, type Component, type Family, type ValveValues } from '../catalog/model';
import { parseDesignation } from '../catalog/designation';
import { evalCond } from '../catalog/rules';

export interface SourceParam { key: string; value: string; unit?: string }
export interface SourceGroup { title: string; params: SourceParam[] }
export type SourceMode = 'xml' | 'catalog' | 'hybrid';
export interface CatalogBinding {
  mode: SourceMode; modelId?: string; code?: string; manufacturer?: string;
  revision: string; catalogRevision?: string; sourceRevision?: string; sourceType?: 'component' | 'family';
  values?: ValveValues; at: string; snapshot?: Component | Family;
}
export interface EffectiveParam extends SourceParam {
  group: string;
  source: 'xml' | 'catalog' | 'manual';
  /** Published catalogue revision for catalogue-derived values. */
  revision?: string;
  sourceRef?: CatalogRef;
}

export interface FamilyMatch { family: Family; values: ValveValues }

export function catalogSnapshotIsStale(binding: CatalogBinding | undefined, currentRevision?: string): boolean {
  if (!binding?.snapshot || !currentRevision) return false;
  return currentRevision !== (binding.sourceRevision || binding.catalogRevision || binding.revision);
}

/** Project reads keep the saved snapshot until a deliberate refresh/apply. */
export function snapshotForBinding<T>(previous: T | undefined, latest: T, applyUpdate: boolean): T {
  return previous && !applyUpdate ? previous : latest;
}

/** Select a family only when a complete designation parse identifies one row. */
export function matchPublishedFamily(families: Family[], designation: string, manufacturerId?: string): FamilyMatch[] {
  const candidates = manufacturerId ? families.filter(f => f.manufacturerId === manufacturerId) : families;
  return parseDesignation(candidates, designation).filter(r => r.complete)
    .map(r => ({ family: candidates.find(f => f.id === r.familyId)!, values: r.values }))
    .filter(x => !!x.family);
}

/** Resolve family defaults and exact, verified table rows for one parsed variant. */
export function familySpecs(family: Family, values: ValveValues): Array<{ label: { ru: string; en?: string }; value: string; unit?: string; sourceRef?: CatalogRef }> {
  const config = withDefaults(family, values);
  const specs: Array<{ label: { ru: string; en?: string }; value: string; unit?: string; sourceRef?: CatalogRef }> = (family.specs || []).map(spec => {
    const conditional = (spec.cases || []).find(item => evalCond(family, item.when, config));
    const value = conditional?.value || spec.value;
    return { label: spec.label, value: String(value?.ru ?? ''), unit: spec.unit, sourceRef: family.catalog };
  }).filter(spec => spec.value.trim() !== '');
  for (const table of family.tables || []) {
    const inputs = table.columns.filter(c => c.role === 'input');
    const outputs = table.columns.filter(c => c.role === 'output');
    if (!inputs.length || !outputs.length || inputs.some(c => config[c.key] === undefined || config[c.key] === null || config[c.key] === '')) continue;
    const rows = table.rows.filter(row => row.verified && inputs.every(c => String(row.values[c.key] ?? '') === String(config[c.key])));
    // Duplicate exact rows are ambiguous; no table value is selected.
    if (rows.length !== 1) continue;
    for (const column of outputs) {
      const value = rows[0].values[column.key];
      if (value === null || value === undefined || String(value).trim() === '') continue;
      specs.push({ label: { ru: column.label }, value: String(value), unit: column.unit, sourceRef: rows[0].source || table.source || family.catalog });
    }
  }
  return specs;
}

export function sourceGroups(raw: unknown): SourceGroup[] {
  let p: any = raw;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return []; } }
  if (Array.isArray(p?.groups)) return p.groups.map((g: any) => ({ title: g.title || 'Параметры', params: g.params || [] }));
  if (Array.isArray(p)) return p.map((g: any) => ({ title: g.title || 'Параметры', params: g.params || [] }));
  if (!p || typeof p !== 'object') return [];
  return [{ title: 'Параметры', params: Object.entries(p).map(([key, v]: any) => ({ key, value: String(v?.value ?? v ?? ''), unit: String(v?.unit ?? '') })) }];
}
const label = (v: string) => v.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
// Только проверенные синонимы; «мощность двигателя» и «расчётная мощность» различны.
const aliases: Record<string, string> = {
  'номинальное напряжение': 'напряжение питания', 'напряжение': 'напряжение питания',
  'степень защиты корпуса': 'степень защиты', 'степень защиты ip': 'степень защиты',
  'температура окружающей среды': 'температура работы', 'крутящий момент привода': 'крутящий момент',
};
const canonical = (v: string) => aliases[label(v)] || label(v);
const present = (v: unknown) => String(v ?? '').trim() !== '' && String(v).trim() !== '—';

/** Источники накладываются на чтении; исходный XML не меняется. */
export function resolveCatalogSpecs(raw: unknown, overridesRaw: unknown, mode: SourceMode, model?: Component | Family, options: { values?: ValveValues; revision?: string; sourceRef?: CatalogRef } = {}): { groups: SourceGroup[]; effective: EffectiveParam[]; warnings: string[] } {
  const groups = sourceGroups(raw).map(g => ({ ...g, params: g.params.map(p => ({ ...p, value: String(p.value ?? '') })) }));
  const warnings: string[] = [];
  const origins = new Map<SourceParam, EffectiveParam['source']>();
  const sourceRefs = new Map<SourceParam, CatalogRef | undefined>();
  for (const g of groups) for (const p of g.params) origins.set(p, 'xml');
  if (mode !== 'xml' && model) {
    let extra = groups.find(g => g.title === 'Характеристики из каталога');
    const specs = 'positions' in model ? familySpecs(model, options.values || {}) : model.specs || [];
    for (const spec of specs) {
      const matches = groups.flatMap(g => g.params.map(p => ({ g, p }))).filter(x => canonical(x.p.key) === canonical(spec.label.ru));
      const compatible = matches.filter(x => !x.p.unit || !spec.unit || label(x.p.unit) === label(spec.unit));
      if (compatible.length === 1) {
        const { p } = compatible[0];
        if (mode === 'catalog' || !present(p.value)) { p.value = spec.value; p.unit = spec.unit || p.unit; origins.set(p, 'catalog'); sourceRefs.set(p, spec.sourceRef || options.sourceRef); }
      } else if (!matches.length) {
        if (!extra) { extra = { title: 'Характеристики из каталога', params: [] }; groups.push(extra); }
        const p = { key: spec.label.ru, value: spec.value, unit: spec.unit }; extra.params.push(p); origins.set(p, 'catalog'); sourceRefs.set(p, spec.sourceRef || options.sourceRef);
      } else if (!compatible.length) {
        warnings.push(`«${spec.label.ru}»: единица каталога ${spec.unit || 'не указана'} отличается от XML. Значение не подменено.`);
      } else {
        warnings.push(`«${spec.label.ru}»: несколько параметров XML. Автоматическая подстановка пропущена.`);
      }
    }
  }
  let overrides: any = overridesRaw;
  if (typeof overrides === 'string') { try { overrides = JSON.parse(overrides); } catch { overrides = {}; } }
  // Переимпорт мог убрать или переименовать группу. Сохраняем ручное поле
  // с исходным адресом, чтобы его значение было видно и можно было исправить.
  for (const [address, value] of Object.entries(overrides || {})) {
    const at = address.indexOf('||'); if (at < 0) continue;
    const title = address.slice(0, at); const key = address.slice(at + 2);
    let g = groups.find(g => g.title === title);
    if (g?.params.some(p => p.key === key)) continue;
    if (!g) { g = { title, params: [] }; groups.push(g); }
    g.params.push({ key, value: String(value ?? '') });
    warnings.push(`Ручное поле «${title} / ${key}» больше не найдено в XML; значение сохранено.`);
  }
  const effective: EffectiveParam[] = [];
  for (const g of groups) for (const p of g.params) {
    const key = `${g.title}||${p.key}`;
    if (overrides && Object.hasOwn(overrides, key)) { p.value = String(overrides[key] ?? ''); origins.set(p, 'manual'); }
    const source = origins.get(p) || 'xml';
    const sourceRef = sourceRefs.get(p) || options.sourceRef;
    effective.push({ ...p, group: g.title, source, ...(source === 'catalog' && options.revision ? { revision: options.revision } : {}), ...(source === 'catalog' && sourceRef ? { sourceRef } : {}) });
  }
  return { groups, effective, warnings };
}
