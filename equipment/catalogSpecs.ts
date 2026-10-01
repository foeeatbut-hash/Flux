import type { Component } from '../catalog/model';

export interface SourceParam { key: string; value: string; unit?: string }
export interface SourceGroup { title: string; params: SourceParam[] }
export type SourceMode = 'xml' | 'catalog' | 'hybrid';
export interface CatalogBinding {
  mode: SourceMode; modelId?: string; code?: string; manufacturer?: string;
  revision: string; catalogRevision?: string; at: string; snapshot?: Component;
}
export interface EffectiveParam extends SourceParam { group: string; source: 'xml' | 'catalog' | 'manual' }

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
export function resolveCatalogSpecs(raw: unknown, overridesRaw: unknown, mode: SourceMode, model?: Component): { groups: SourceGroup[]; effective: EffectiveParam[]; warnings: string[] } {
  const groups = sourceGroups(raw).map(g => ({ ...g, params: g.params.map(p => ({ ...p, value: String(p.value ?? '') })) }));
  const warnings: string[] = [];
  const origins = new Map<SourceParam, EffectiveParam['source']>();
  for (const g of groups) for (const p of g.params) origins.set(p, 'xml');
  if (mode !== 'xml' && model) {
    let extra = groups.find(g => g.title === 'Характеристики из каталога');
    for (const spec of model.specs || []) {
      const matches = groups.flatMap(g => g.params.map(p => ({ g, p }))).filter(x => canonical(x.p.key) === canonical(spec.label.ru));
      const compatible = matches.filter(x => !x.p.unit || !spec.unit || label(x.p.unit) === label(spec.unit));
      if (compatible.length === 1) {
        const { p } = compatible[0];
        if (mode === 'catalog' || !present(p.value)) { p.value = spec.value; p.unit = spec.unit || p.unit; origins.set(p, 'catalog'); }
      } else if (!matches.length) {
        if (!extra) { extra = { title: 'Характеристики из каталога', params: [] }; groups.push(extra); }
        const p = { key: spec.label.ru, value: spec.value, unit: spec.unit }; extra.params.push(p); origins.set(p, 'catalog');
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
    effective.push({ ...p, group: g.title, source: origins.get(p) || 'xml' });
  }
  return { groups, effective, warnings };
}
