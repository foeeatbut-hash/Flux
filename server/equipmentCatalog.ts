import { displayParentLinks } from '../equipment/displayHierarchy.js';
import { createHash, randomUUID } from 'node:crypto';
import { getPrisma } from './context.js';
import { modelOf } from '../equipment/classes.js';
import { manufacturerKey, matchComponent } from '../catalog/componentCatalog.js';
import type { Catalog, Component, Family, FamilyStatus, ValveValues } from '../catalog/model.js';
import { catalogSnapshotIsStale, familySpecs, matchPublishedFamily, sourceGroups, resolveCatalogSpecs, type CatalogBinding } from '../equipment/catalogSpecs.js';
import { ensureCatalog, readCatalog } from './routes/catalog.js';

export const bindingKey = (id: string) => `equipment_catalog_binding:${id}`;
export const catalogRevision = (c: Component | Family) => createHash('sha256').update(JSON.stringify(c)).digest('hex');
export const publishedRevision = (value: unknown, fallback: string) => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
  }
  return fallback;
};
export interface EquipmentCatalog extends Catalog { meta?: Record<string, { updatedAt?: string }> }
export async function equipmentCatalog(p = getPrisma()): Promise<EquipmentCatalog> {
  await ensureCatalog(p);
  return readCatalog(p) as Promise<EquipmentCatalog>;
}
/** Kept for the component binding route's existing selector contract. */
export async function catalogModels(p = getPrisma()): Promise<Component[]> {
  return (await equipmentCatalog(p)).components;
}
export interface EquipmentCatalogChoice extends Component {
  sourceType: 'component' | 'family';
  sourceRevision?: string;
  parsedValues?: ValveValues;
  status?: FamilyStatus;
}
export function matchesFor(el: any, catalog: EquipmentCatalog | Component[]): EquipmentCatalogChoice[] {
  const params = sourceGroups(el.specs).flatMap(g => g.params);
  const code = modelOf(el.specs) || params.find(p => /^(марка|модель|тип привода)$/i.test(p.key))?.value || '';
  const maker = params.find(p => /^(изготовитель|производитель)( привода)?$/i.test(p.key))?.value;
  const kind = /ПРИВОД/.test(`${el.role} ${el.equipType}`) ? 'actuator' : undefined;
  if (!code) return [];
  const components = Array.isArray(catalog) ? catalog : catalog.components;
  const componentChoices = matchComponent(components, code, maker, kind).map(c => ({ ...c, sourceType: 'component' as const,
    sourceRevision: !Array.isArray(catalog) ? publishedRevision(catalog.meta?.[c.id]?.updatedAt, catalogRevision(c)) : catalogRevision(c) }));
  if (Array.isArray(catalog)) return componentChoices;
  const makerRecord = maker ? catalog.manufacturers.find(m => [m.name, m.shortName].some(n => manufacturerKey(n) === manufacturerKey(maker))) : undefined;
  const familyMatches = maker && !makerRecord ? [] : matchPublishedFamily(catalog.families, code, makerRecord?.id);
  const familyChoices = familyMatches.map(({ family, values }) => ({
    ...family, kind: 'other' as const, title: family.title, manufacturer: catalog.manufacturers.find(m => m.id === family.manufacturerId)?.name || '',
    specs: familySpecs(family, values), sourceType: 'family' as const, parsedValues: values,
    sourceRevision: publishedRevision(catalog.meta?.[family.id]?.updatedAt, catalogRevision(family)), status: family.status,
  } as EquipmentCatalogChoice));
  return [...componentChoices, ...familyChoices];
}
function parseBinding(record: any): CatalogBinding | undefined {
  try { return record ? JSON.parse(record.value) as CatalogBinding : undefined; } catch { return undefined; }
}

/** Freeze a uniquely resolved first-use choice without replacing a concurrent/manual binding. */
async function freezeFirstMatch(el: any, choice: EquipmentCatalogChoice, all: EquipmentCatalog | Component[], record: any): Promise<CatalogBinding | undefined> {
  if (record) return parseBinding(record);
  const snapshot = Array.isArray(all)
    ? all.find(model => model.id === choice.id)
    : choice.sourceType === 'family' ? all.families.find(model => model.id === choice.id) : all.components.find(model => model.id === choice.id);
  if (!snapshot) return undefined;
  const sourceRevision = choice.sourceRevision || catalogRevision(snapshot);
  const manufacturer = choice.sourceType === 'family' && !Array.isArray(all)
    ? all.manufacturers.find(item => item.id === (snapshot as Family).manufacturerId)?.name || ''
    : (snapshot as Component).manufacturer || '';
  const binding: CatalogBinding = {
    mode: 'hybrid', modelId: snapshot.id, code: snapshot.code, manufacturer,
    sourceType: choice.sourceType, values: choice.sourceType === 'family' ? choice.parsedValues : undefined,
    revision: randomUUID(), catalogRevision: catalogRevision(snapshot), sourceRevision,
    at: new Date().toISOString(), snapshot,
  };
  const prisma = getPrisma();
  const key = bindingKey(el.id);
  const id = `ecb-${el.id}`;
  try {
    await prisma.appSetting.upsert({
      where: { id },
      create: { id, key, userId: null, value: JSON.stringify(binding) },
      update: {},
    });
  } catch (err: any) {
    // A pre-existing row can have a different ID but the same unique key.
    if (err?.code !== 'P2002') throw err;
  }
  const winner = await prisma.appSetting.findFirst({ where: { key, userId: null } });
  return parseBinding(winner);
}
export async function sourceInfo(el: any, models?: EquipmentCatalog | Component[], stored?: any) {
  const all = models || await equipmentCatalog();
  let record = stored === undefined ? await getPrisma().appSetting.findFirst({ where: { key: bindingKey(el.id), userId: null } }) : stored;
  let binding = parseBinding(record);
  const matches = matchesFor(el, all);
  let selectedChoice = !record && !binding && matches.length === 1 ? matches[0] : undefined;
  if (selectedChoice) {
    binding = await freezeFirstMatch(el, selectedChoice, all, record);
    record = binding ? { value: JSON.stringify(binding) } : record;
    // A racing request may have written a different explicit choice. Always
    // resolve from the persisted winner's actual family/component snapshot.
    selectedChoice = undefined;
  }
  const selected = binding?.snapshot || selectedChoice;
  const mode = binding?.mode || 'hybrid';
  const values = binding?.values || selectedChoice?.parsedValues;
  const sourceRevision = binding?.sourceRevision || selectedChoice?.sourceRevision;
  const sourceRef = selected && 'positions' in selected ? selected.catalog : selected?.catalog;
  const resolved = resolveCatalogSpecs(el.specs, el.overrides, mode, selected, { values, revision: sourceRevision, sourceRef });
  const warnings: string[] = [...resolved.warnings];
  let updateAvailable: EquipmentCatalogChoice | undefined;
  if (!selected && mode !== 'xml') warnings.push(matches.length > 1 ? 'Несколько изготовителей или моделей. Выберите точную модель.' : matches.length === 1 ? 'Не удалось сохранить снимок каталога; XML и ручные значения сохранены.' : 'Модель не найдена в каталоге. XML и ручные значения сохранены.');
  if (selected?.status === 'partial') warnings.push('Карточка каталога заполнена частично; проверьте источник перед выпуском.');
  if (binding?.snapshot) {
    const current = Array.isArray(all) ? all.find(c => c.id === binding.modelId) : binding.sourceType === 'family'
      ? all.families.find(c => c.id === binding.modelId) : all.components.find(c => c.id === binding.modelId);
    if (!current) warnings.push('Модель удалена из каталога. Используется сохранённый снимок.');
    else {
      const currentPublishedRevision = Array.isArray(all) ? catalogRevision(current) : publishedRevision(all.meta?.[current.id]?.updatedAt, catalogRevision(current));
      const currentRevision = binding.sourceRevision ? currentPublishedRevision : catalogRevision(current);
      if (catalogSnapshotIsStale(binding, currentRevision)) {
        warnings.push('Каталог обновлён. Снимок проекта сохраняется до вашего обновления.');
        if ('positions' in current) {
          const family = current as Family;
          updateAvailable = { ...family, kind: 'other', title: family.title, manufacturer: !Array.isArray(all) ? all.manufacturers.find(m => m.id === family.manufacturerId)?.name || '' : '',
            specs: familySpecs(family, binding.values || {}), sourceType: 'family', parsedValues: binding.values || {}, sourceRevision: currentPublishedRevision, status: family.status } as EquipmentCatalogChoice;
        } else updateAvailable = { ...current as Component, sourceType: 'component', sourceRevision: currentPublishedRevision };
      }
    }
  }
  const snapshotSpecs = binding?.snapshot && 'positions' in binding.snapshot
    ? familySpecs(binding.snapshot, binding.values || {}) : binding?.snapshot?.specs || [];
  const bindingView = binding ? { ...binding, snapshot: { ...binding.snapshot, effectiveSpecs: snapshotSpecs } } : undefined;
  return { mode, binding: bindingView, matches, updateAvailable, ...resolved, warnings, originalSpecs: el.specs };
}

/** Одна загрузка справочника и привязок на весь срез, без N запросов на позицию. */
export async function enrichEquipment(systems: any[]): Promise<void> {
  const prisma = getPrisma();
  const models = await equipmentCatalog(prisma);
  const elements = systems.flatMap(s => s.monoblocks.flatMap((m: any) => m.components));
  const keys = elements.map(e => bindingKey(e.id));
  const saved = keys.length ? await prisma.appSetting.findMany({ where: { key: { in: keys }, userId: null } }) : [];
  const byKey = new Map(saved.map((r: any) => [r.key, r]));
  for (const el of elements) {
    const info = await sourceInfo(el, models, byKey.get(bindingKey(el.id)) || null);
    el.originalSpecs = el.specs; el.specs = JSON.stringify({ groups: info.groups });
    el.catalogSource = { mode: info.mode, binding: info.binding, effective: info.effective, warnings: info.warnings };
  }
  for (const sys of systems) {
    const parents = new Map(displayParentLinks(sys.monoblocks.flatMap((m: any) => m.components) as any[]).map(e => [e.id, e.parentElementId]));
    for (const mono of sys.monoblocks) for (const el of mono.components) el.parentElementId = parents.get(el.id) || el.parentElementId;
  }

}
