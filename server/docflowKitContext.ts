import { resolveCatalogSpecs } from '../equipment/catalogSpecs.js';
import { DocflowPlanError } from './docflowPlans.js';
import { readSettings, rawSettingsConfig } from './docflowSettings.js';
import { validateDocflowReferences } from './docflowConfigRefs.js';
import type { DocflowKitItem } from '../shared/docflow/kits.js';
import { codesOfItem, isGenericTagCode } from './vdrTags.js';
import { readInBatches } from './batchRead.js';

export const parse = (raw: any, fallback: any = {}) => { try { return typeof raw === 'string' ? JSON.parse(raw) : raw ?? fallback; } catch { return fallback; } };
export const iso = (value: any) => value ? new Date(value).toISOString() : null;
export const keyOf = (unit: string, scopeId: string, docType: string) => JSON.stringify([unit, scopeId, docType]);

/** Параметры читаем без sourceInfo: тот может закрепить модель при первом чтении. */
export async function loadKitContext(prisma: any, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new DocflowPlanError('Проект не найден', 404);
  await validateDocflowReferences(prisma, await rawSettingsConfig(prisma, projectId));
  const settings = await readSettings(prisma, projectId);
  await validateDocflowReferences(prisma, settings.config);
  const tags: any[] = await prisma.tag.findMany({ where: { projectId }, orderBy: { id: 'asc' }, include: {
    equipment: true, componentElements: { orderBy: { id: 'asc' }, include: { monoblock: { include: { system: true } } } },
  } });
  const ids = tags.flatMap(tag => tag.componentElements.map((el: any) => `equipment_catalog_binding:${el.id}`));
  const bindings = await readInBatches<any>(ids, part => prisma.appSetting.findMany({ where: { key: { in: part }, userId: null } }));
  const mapping = new Map(settings.config.equipmentClasses.map(row => [row.type, row.classId]));
  for (const tag of tags) {
    tag.active = tag.componentElements.filter((el: any) => el.status !== 'REMOVED');
    if (tag.active.some((el: any) => el.monoblock.system.projectId !== projectId)) throw new DocflowPlanError('Позиция оборудования связана с чужим проектом', 403);
    const classes: string[] = [];
    tag.parameters = new Map<string, Set<string>>();
    tag.sourceVersions = [];
    for (const el of tag.active) {
      const stored = bindings.find(row => row.key === `equipment_catalog_binding:${el.id}`)?.value || '';
      const binding = parse(stored);
      if (binding.mode !== 'xml' && binding.sourceType === 'family' && binding.snapshot?.classId) classes.push(binding.snapshot.classId);
      const effective = resolveCatalogSpecs(el.specs, el.overrides, binding.mode || 'xml', binding.snapshot, { values: binding.values, revision: binding.sourceRevision, acceptedCatalogParams: binding.acceptedCatalogParams }).effective;
      for (const p of effective) {
        const key = `${p.group}||${p.key}`;
        const values: Set<string> = tag.parameters.get(key) || new Set();
        values.add(String(p.value).trim()); tag.parameters.set(key, values);
      }
      tag.sourceVersions.push([el.id, el.version, stored]);
    }
    const types = [...new Set<string>(tag.active.map((el: any) => el.equipType).filter(Boolean))];
    const type = String(tag.equipment?.type || (types.length === 1 ? types[0] : '')).trim().toUpperCase();
    const distinctClasses = [...new Set(classes)];
    tag.classId = tag.equipment?.catalogClassId || (distinctClasses.length === 1 ? distinctClasses[0] : distinctClasses.length ? '' : mapping.get(type) || '');
    const systems = [...new Map<string, any>(tag.active.map((el: any) => [el.monoblock.system.id, el.monoblock.system])).values()];
    tag.group = systems.length === 1 ? systems[0] : null;
    tag.removed = !!tag.componentElements.length && !tag.active.length;
  }
  const items: any[] = await prisma.docRegisterItem.findMany({ where: { projectId }, orderBy: { id: 'asc' } });
  const itemIds = items.map(item => item.id);
  const links = await readInBatches<any>(itemIds, part => prisma.docRegisterItemTag.findMany({ where: { itemId: { in: part } }, orderBy: [{ itemId: 'asc' }, { tagId: 'asc' }] }));
  const unknownLinks = links.filter(l => !tags.some(tag => tag.id === l.tagId));
  if (unknownLinks.length) {
    const others = await readInBatches<any>(unknownLinks.map(l => l.tagId), part => prisma.tag.findMany({ where: { id: { in: part } }, select: { projectId: true } }));
    if (others.some((tag: any) => tag.projectId !== projectId)) throw new DocflowPlanError('Строка содержит тег другого проекта', 403);
  }
  const reservations: any[] = await prisma.docflowKitRow.findMany({ where: { projectId }, orderBy: { id: 'asc' } });
  const files = await readInBatches<any>(itemIds, part => prisma.docFileLink.findMany({ where: { projectId, itemId: { in: part }, role: 'file', unlinkedAt: null }, orderBy: { id: 'asc' } }));
  const registers: any[] = await prisma.docRegister.findMany({ where: { projectId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return { project, settings, tags, items, links, reservations, files, registers };
}

export type KitContext = Awaited<ReturnType<typeof loadKitContext>>;
/** «Все позиции» — прежняя общепроектная отметка; чтение не создаёт связей. */
export const unitOfItem = (item: any): string => parse(item.meta).docflowUnit || (codesOfItem(item.equipmentTags).some(isGenericTagCode) ? 'project' : 'tag');
export function itemAppliesToTag(context: KitContext, item: any, tagId: string) {
  return context.links.some(link => link.itemId === item.id && link.tagId === tagId) || codesOfItem(item.equipmentTags).some(isGenericTagCode);
}
export function requirementFor(context: KitContext, tag: any, spec: DocflowKitItem) {
  const { config } = context.settings;
  const scopeId = spec.unit === 'tag' ? tag.id : spec.unit === 'project' ? context.project.id : tag.group?.id || '';
  const key = keyOf(spec.unit, scopeId || `unresolved:${tag.id}`, spec.docType);
  const values: Set<string> | undefined = spec.condition ? tag.parameters.get(spec.condition.parameter) : undefined;
  const matches = !spec.condition || (spec.condition.operator === 'exists' ? !!values?.size && [...values].some(Boolean)
    : spec.condition.operator === 'equals' ? !!values?.has(spec.condition.value.trim()) : !!values?.size && [...values].every(v => v !== spec.condition!.value.trim()));
  const needed = matches && !tag.removed;
  const problem = !scopeId ? 'У тега нет однозначной установки. Проверьте связь оборудования.' : '';
  const reservation = context.reservations.find(r => r.unit === spec.unit && r.scopeId === scopeId && r.docType === spec.docType);
  const scopeTags = spec.unit === 'tag' || !scopeId ? [tag] : spec.unit === 'project' ? context.tags : context.tags.filter(t => t.group?.id === scopeId);
  const item = reservation ? context.items.find(i => i.id === reservation.itemId) : context.items.find(i => i.vdrCode === spec.docType && scopeTags.some(t => itemAppliesToTag(context, i, t.id)) && unitOfItem(i) === spec.unit);
  const hasFile = !!item && context.files.some(file => file.itemId === item.id && file.revision === item.revision && !file.lostAt);
  return { key, docType: spec.docType, title: config.vdrTypes.find(type => type.code === spec.docType)?.titleRu || spec.docType,
    unit: spec.unit, scopeId, needed, problem, spec, tagIds: scopeTags.map(t => t.id), item: item || null, hasFile,
    state: tag.removed ? 'Тег снят' : !needed ? 'Не нужен в проекте' : !item ? 'Нет строки' : !hasFile ? 'Строка без файла' : config.statuses.find(s => s.code === item.status)?.label || item.status,
  };
}
