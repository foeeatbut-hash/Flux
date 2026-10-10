import { displayParentLinks } from '../equipment/displayHierarchy.js';
import { sourceValuesEqual } from '../equipment/sourceValueComparison.js';
import { createHash, randomUUID } from 'node:crypto';
import { getPrisma } from './context.js';
import { modelOf } from '../equipment/classes.js';
import { manufacturerKey, matchComponent } from '../catalog/componentCatalog.js';
import { withDefaults, type Catalog, type Component, type Family, type FamilyStatus, type ValveValues } from '../catalog/model.js';
import { checkConfig } from '../catalog/rules.js';
import { parseDesignation } from '../catalog/designation.js';
import { catalogCodesForEquipment, catalogSnapshotIsStale, catalogValuesByAddress, familySpecs, matchPublishedFamily, sourceGroups, resolveCatalogSpecs, type CatalogBinding } from '../equipment/catalogSpecs.js';
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
  const allowedCodes = catalogCodesForEquipment(el.equipClass || el.equipType || el.role);
  const classCode = (classId: string) => !Array.isArray(catalog) ? catalog.classes.find(item => item.id === classId)?.code || '' : '';
  if (!code) return [];
  const components = Array.isArray(catalog) ? catalog : catalog.components;
  const componentChoices = matchComponent(components, code, maker, kind).filter(c => !allowedCodes.length || (Array.isArray(catalog) ? true : allowedCodes.includes(classCode(c.classId)))).map(c => ({ ...c, sourceType: 'component' as const,
    sourceRevision: !Array.isArray(catalog) ? publishedRevision(catalog.meta?.[c.id]?.updatedAt, catalogRevision(c)) : catalogRevision(c) }));
  if (Array.isArray(catalog)) return componentChoices;
  const makerRecord = maker ? catalog.manufacturers.find(m => [m.name, m.shortName].some(n => manufacturerKey(n) === manufacturerKey(maker))) : undefined;
  const familyMatches = maker && !makerRecord ? [] : matchPublishedFamily(catalog.families, code, makerRecord?.id).filter(item => familyMatchesEquipment(el, item.family, catalog));
  const familyChoices = familyMatches.map(({ family, values }) => ({
    ...family, kind: 'other' as const, title: family.title, manufacturer: catalog.manufacturers.find(m => m.id === family.manufacturerId)?.name || '',
    specs: familySpecs(family, values), sourceType: 'family' as const, parsedValues: values,
    sourceRevision: publishedRevision(catalog.meta?.[family.id]?.updatedAt, catalogRevision(family)), status: family.status,
  } as EquipmentCatalogChoice));
  return [...componentChoices, ...familyChoices];
}

export interface CatalogPreviewChange {
  group: string; key: string; before: string; after: string; unit?: string;
  beforeSource?: 'xml' | 'catalog' | 'manual'; sourceRef?: { file: string; pages?: string; edition?: string };
}
function knownFamilyParamValues(family: Family, key: string, recognized: ValveValues[]): Set<string> {
  const values = new Set<string>();
  const param = family.params.find(item => item.key === key);
  if (param?.default !== undefined) values.add(String(param.default));
  for (const table of family.tables || []) for (const row of table.rows || []) {
    const value = row.verified ? row.values?.[key] : null;
    if (value !== null && value !== undefined) values.add(String(value));
  }
  for (const example of family.examples || []) for (const parsed of parseDesignation([family], example)) {
    if (parsed.complete && parsed.values[key] !== undefined) values.add(String(parsed.values[key]));
  }
  for (const config of recognized) if (config[key] !== undefined) values.add(String(config[key]));
  return values;
}

export function validateFamilyValues(family: Family, raw: unknown, recognized: ValveValues[] = []): ValveValues {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Object.assign(new Error('Параметры варианта указаны неверно'), { status: 400 });
  const values: ValveValues = {};
  for (const [key, input] of Object.entries(raw as Record<string, unknown>)) {
    const param = family.params.find(item => item.key === key);
    if (!param) {
      const posKey = key.startsWith('~') ? key.slice(1) : '';
      const position = family.positions.find(item => item.key === posKey);
      const index = Number(input);
      if (position?.rememberFormat && Number.isInteger(index) && index >= 0 && index < position.formats.length) { values[key] = index; continue; }
      if ((key === 'article' && ['article', 'free'].includes(family.designationMode || '')) && typeof input === 'string' && input.length <= 200) { values[key] = input; continue; }
      throw Object.assign(new Error(`Неизвестный параметр варианта: ${key}`), { status: 400 });
    }
    if (param.kind === 'choice') {
      const code = String(input ?? '');
      if (!(param.values || []).some(item => item.code === code)) throw Object.assign(new Error(`Недопустимый вариант «${String(param.label?.ru || param.key)}»`), { status: 400 });
      values[key] = code;
    } else if (param.kind === 'number' || param.size) {
      if (input === '' || input === null || input === undefined) { values[key] = ''; continue; }
      const number = Number(String(input).replace(',', '.'));
      if (!Number.isFinite(number) || (param.min !== undefined && number < param.min) || (param.max !== undefined && number > param.max) || (param.size && number <= 0)) {
        throw Object.assign(new Error(`Число для «${String(param.label?.ru || param.key)}» вне допустимого диапазона`), { status: 400 });
      }
      if (![...knownFamilyParamValues(family, key, recognized)].some(candidate => Number(candidate) === number)) throw Object.assign(new Error(`Выберите существующий вариант каталога для «${String(param.label?.ru || param.key)}»`), { status: 400 });
      values[key] = number;
    } else {
      if (typeof input !== 'string' || input.length > 500) throw Object.assign(new Error(`Значение «${String(param.label?.ru || param.key)}» указано неверно`), { status: 400 });
      if (input && !knownFamilyParamValues(family, key, recognized).has(input)) throw Object.assign(new Error(`Выберите существующий вариант каталога для «${String(param.label?.ru || param.key)}»`), { status: 400 });
      values[key] = input;
    }
  }
  const completed = withDefaults(family, values);
  const errors = checkConfig(family, completed).filter(item => item.level === 'error');
  if (errors.length) throw Object.assign(new Error(errors[0].message), { status: 400 });
  return completed;
}

export function familyMatchesEquipment(el: any, family: Family, catalog: EquipmentCatalog): boolean {
  const allowed = catalogCodesForEquipment(el.equipClass || el.equipType || el.role);
  if (!allowed.length) return true;
  const code = catalog.classes.find(item => item.id === family.classId)?.code || '';
  if (code) return allowed.includes(code);
  // В старых записях каталога может сохраниться смысловой тип семейства без
  // обновлённого справочника классов. Допускаем только распознанный тип или
  // название; неизвестные типы по-прежнему не проходят проверку.
  const familyCodes = catalogCodesForEquipment(`${family.kind || ''} ${family.typeLabel?.ru || ''} ${family.title?.ru || ''}`);
  return familyCodes.length > 0 && familyCodes.some(familyCode => allowed.includes(familyCode));
}
export function componentMatchesEquipment(el: any, component: Component, catalog: EquipmentCatalog): boolean {
  const allowed = catalogCodesForEquipment(el.equipClass || el.equipType || el.role);
  if (!allowed.length) return true;
  const code = catalog.classes.find(item => item.id === component.classId)?.code || '';
  return allowed.includes(code);
}

/** Предпросмотр читает закреплённый снимок кандидата и не создаёт привязку. */
export async function previewCatalogSource(el: any, modelId: string, sourceType: 'component' | 'family', requestedValues?: unknown, models?: EquipmentCatalog) {
  const all = models || await equipmentCatalog();
  const stored = await getPrisma().appSetting.findFirst({ where: { key: bindingKey(el.id), userId: null } });
  const current = await sourceInfo(el, all, stored || null);
  let model: Component | Family | undefined;
  let values: ValveValues | undefined;
  if (sourceType === 'family') {
    model = all.families.find(item => item.id === modelId);
    if (!model || model.status === 'draft' || !familyMatchesEquipment(el, model, all)) throw Object.assign(new Error('Семейство не относится к типу этой позиции'), { status: 400 });
    const match = matchesFor(el, all).find(item => item.sourceType === 'family' && item.id === modelId);
    values = requestedValues === undefined ? match?.parsedValues || validateFamilyValues(model as Family, {}, match?.parsedValues ? [match.parsedValues] : []) : validateFamilyValues(model as Family, requestedValues, match?.parsedValues ? [match.parsedValues] : []);
  } else {
    model = all.components.find(item => item.id === modelId);
    if (model && !componentMatchesEquipment(el, model as Component, all)) throw Object.assign(new Error('Модель не относится к типу этой позиции'), { status: 400 });
  }
  if (!model) throw Object.assign(new Error('Модель каталога не найдена'), { status: 404 });
  const sourceRef = model.catalog;
  const catalogValues = catalogValuesByAddress(el.specs, model, { values, sourceRef });
  const oldValues = new Map(current.effective.map(param => [`${param.group}||${param.key}`, param]));
  const changes: CatalogPreviewChange[] = [];
  for (const [address, proposal] of Object.entries(catalogValues)) {
    const [group, key] = address.split('||');
    const before = oldValues.get(address);
    const beforeText = before ? `${before.value}${before.unit ? ` ${before.unit}` : ''}` : '';
    const afterText = `${proposal.value}${proposal.unit ? ` ${proposal.unit}` : ''}`;
    if (before && sourceValuesEqual({ value: before.value, unit: before.unit }, { value: proposal.value, unit: proposal.unit })) continue;
    changes.push({ group, key, before: beforeText, after: afterText, ...(proposal.unit ? { unit: proposal.unit } : {}), ...(before ? { beforeSource: before.source } : {}), ...(proposal.sourceRef ? { sourceRef: proposal.sourceRef } : {}) });
  }
  return { changes, sourceRevision: publishedRevision(all.meta?.[model.id]?.updatedAt, catalogRevision(model)), code: model.code, manufacturer: sourceType === 'family' ? all.manufacturers.find(item => item.id === model!.manufacturerId)?.name || '' : (model as Component).manufacturer || '' };
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
    // Существующая строка может иметь другой ID, но тот же уникальный ключ.
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
    // Параллельный запрос мог сохранить другой явный выбор. Всегда используем
    // фактический снимок семейства или модели из победившей строки.
    selectedChoice = undefined;
  }
  const selected = binding?.snapshot || selectedChoice;
  const mode = binding?.mode || 'hybrid';
  const values = binding?.values || selectedChoice?.parsedValues;
  const sourceRevision = binding?.sourceRevision || selectedChoice?.sourceRevision;
  const sourceRef = selected && 'positions' in selected ? selected.catalog : selected?.catalog;
  const resolved = resolveCatalogSpecs(el.specs, el.overrides, mode, selected, { values, revision: sourceRevision, sourceRef, acceptedCatalogParams: binding?.acceptedCatalogParams });
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
    el.catalogSource = { mode: info.mode, binding: info.binding, effective: info.effective, warnings: info.warnings, discrepancies: info.discrepancies };
  }
  for (const sys of systems) {
    const parents = new Map(displayParentLinks(sys.monoblocks.flatMap((m: any) => m.components) as any[]).map(e => [e.id, e.parentElementId]));
    for (const mono of sys.monoblocks) for (const el of mono.components) el.parentElementId = parents.get(el.id) || el.parentElementId;
  }

}
