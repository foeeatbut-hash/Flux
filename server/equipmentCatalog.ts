import { displayParentLinks } from '../equipment/displayHierarchy.js';
import { createHash } from 'node:crypto';
import { getPrisma } from './context.js';
import { modelOf } from '../equipment/classes.js';
import { matchComponent } from '../catalog/componentCatalog.js';
import type { Component } from '../catalog/model.js';
import { sourceGroups, resolveCatalogSpecs, type CatalogBinding } from '../equipment/catalogSpecs.js';
import { ensureCatalog, readCatalog } from './routes/catalog.js';

export const bindingKey = (id: string) => `equipment_catalog_binding:${id}`;
export const catalogRevision = (c: Component) => createHash('sha256').update(JSON.stringify(c)).digest('hex');
export async function catalogModels(): Promise<Component[]> {
  const p = getPrisma(); await ensureCatalog(p); return (await readCatalog(p)).components;
}
export function matchesFor(el: any, models: Component[]): Component[] {
  const params = sourceGroups(el.specs).flatMap(g => g.params);
  const code = modelOf(el.specs) || params.find(p => /^(марка|модель|тип привода)$/i.test(p.key))?.value || '';
  const maker = params.find(p => /^(изготовитель|производитель)( привода)?$/i.test(p.key))?.value;
  const kind = /ПРИВОД/.test(`${el.role} ${el.equipType}`) ? 'actuator' : undefined;
  return code ? matchComponent(models, code, maker, kind) : [];
}
export async function sourceInfo(el: any, models?: Component[], stored?: any) {
  const all = models || await catalogModels();
  const record = stored === undefined ? await getPrisma().appSetting.findFirst({ where: { key: bindingKey(el.id), userId: null } }) : stored;
  let binding: CatalogBinding | undefined;
  try { binding = record ? JSON.parse(record.value) : undefined; } catch { /* повреждённая привязка не используется */ }
  const matches = matchesFor(el, all);
  const selected = binding?.snapshot || (!binding && matches.length === 1 ? matches[0] : undefined);
  const mode = binding?.mode || 'hybrid';
  const resolved = resolveCatalogSpecs(el.specs, el.overrides, mode, selected);
  const warnings: string[] = [...resolved.warnings];
  if (!selected && mode !== 'xml') warnings.push(matches.length > 1 ? 'Несколько изготовителей или моделей. Выберите точную модель.' : 'Модель не найдена в каталоге. XML и ручные значения сохранены.');
  if (selected?.status === 'partial') warnings.push('Карточка каталога заполнена частично; проверьте источник перед выпуском.');
  if (binding?.snapshot) {
    const current = all.find(c => c.id === binding.modelId);
    if (!current) warnings.push('Модель удалена из каталога. Используется сохранённый снимок.');
    else if (catalogRevision(current) !== (binding.catalogRevision || binding.revision)) warnings.push('Каталог обновлён. Снимок проекта сохраняется до вашего обновления.');
  }
  return { mode, binding, matches, ...resolved, warnings, originalSpecs: el.specs };
}

/** Одна загрузка справочника и привязок на весь срез, без N запросов на позицию. */
export async function enrichEquipment(systems: any[]): Promise<void> {
  const models = await catalogModels();
  const elements = systems.flatMap(s => s.monoblocks.flatMap((m: any) => m.components));
  const keys = elements.map(e => bindingKey(e.id));
  const saved = keys.length ? await getPrisma().appSetting.findMany({ where: { key: { in: keys }, userId: null } }) : [];
  const byKey = new Map(saved.map((r: any) => [r.key, r]));
  for (const el of elements) {
    const info = await sourceInfo(el, models, byKey.get(bindingKey(el.id)) || null);
    el.originalSpecs = el.specs; el.specs = JSON.stringify({ groups: info.groups });
    el.catalogSource = { mode: info.mode, binding: info.binding, warnings: info.warnings };
  }
  for (const sys of systems) {
    const parents = new Map(displayParentLinks(sys.monoblocks.flatMap((m: any) => m.components) as any[]).map(e => [e.id, e.parentElementId]));
    for (const mono of sys.monoblocks) for (const el of mono.components) el.parentElementId = parents.get(el.id) || el.parentElementId;
  }

}
