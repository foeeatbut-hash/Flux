import { createHash } from 'node:crypto';
import { readSettings } from './docflowSettings.js';
import { DocflowPlanError, saveDocflowPlan, loadDocflowPlan, parsedPlan, finishDocflowPlan } from './docflowPlans.js';

const KIND = 'equipment-classes';
export interface ClassSelection { tagIds?: string[]; overrides?: Array<{ tagId: string; classId: string; type?: string }> }
const json = (value: unknown) => JSON.stringify(value);
const parse = (value: string | null) => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const stamp = (date: any) => date ? new Date(date).toISOString() : null;

function selectionOf(raw: any): ClassSelection {
  const tagIds = raw?.tagIds;
  const overrides = raw?.overrides;
  if (tagIds !== undefined && (!Array.isArray(tagIds) || !tagIds.length || tagIds.length > 500 || tagIds.some(id => typeof id !== 'string' || !id || id.length > 100))) {
    throw new DocflowPlanError('Выберите от 1 до 500 тегов', 400);
  }
  if (overrides !== undefined && (!Array.isArray(overrides) || overrides.length > 500 || overrides.some(row =>
    !row || typeof row.tagId !== 'string' || typeof row.classId !== 'string' || !row.classId || row.classId.length > 100
    || (row.type !== undefined && (typeof row.type !== 'string' || row.type.length > 100))))) {
    throw new DocflowPlanError('Неверный выбор класса', 400);
  }
  if (new Set((overrides || []).map((r: any) => r.tagId)).size !== (overrides || []).length) throw new DocflowPlanError('Тег повторяется в плане', 400);
  return { tagIds: tagIds ? [...new Set<string>(tagIds)] : undefined, overrides: overrides || [] };
}

/** Предпросмотр не меняет оборудование. Старые общие Equipment остаются нетронутыми. */
async function preview(prisma: any, projectId: string, selection: ClassSelection) {
  const settings = await readSettings(prisma, projectId);
  const tags: any[] = await prisma.tag.findMany({
    where: { projectId, ...(selection.tagIds ? { id: { in: selection.tagIds } } : {}) },
    take: 501, orderBy: { id: 'asc' },
    include: { equipment: true, componentElements: { include: { monoblock: { include: { system: true } } } } },
  });
  if (tags.length > 500) throw new DocflowPlanError('В проекте больше 500 тегов. Выберите часть тегов.', 400);
  if (selection.tagIds?.some(id => !tags.some(tag => tag.id === id)) || selection.overrides?.some(row => !tags.some(tag => tag.id === row.tagId))) {
    throw new DocflowPlanError('Тег не найден в этом проекте', 403);
  }
  const classes: any[] = await prisma.catalogClass.findMany({ select: { id: true, code: true } });
  const available = new Map(classes.map(row => [row.id, row.code]));
  const mapping = new Map(settings.config.equipmentClasses.map(row => [row.type, row.classId]));
  const rows = [];
  for (const tag of tags) {
    const elements = tag.componentElements.filter((el: any) => el.status !== 'REMOVED');
    if (elements.some((el: any) => el.monoblock?.system?.projectId !== projectId)) throw new DocflowPlanError('Связь оборудования ведёт в другой проект', 403);
    const sourceBindings = [];
    for (const el of elements) {
      const entry = await prisma.appSetting.findFirst({ where: { key: `equipment_catalog_binding:${el.id}`, userId: null } });
      const binding = parse(entry?.value);
      sourceBindings.push({ elementId: el.id, version: el.version, value: entry?.value || '',
        classId: binding.mode !== 'xml' && binding.sourceType === 'family' ? binding.snapshot?.classId || '' : '' });
    }
    const selected = selection.overrides?.find(row => row.tagId === tag.id);
    const types = [...new Set<string>(elements.map((el: any) => String(el.equipType || '').trim()).filter(Boolean))];
    const type = selected?.type?.trim() || tag.equipment?.type || (types.length === 1 ? types[0] : '');
    const classIds = [...new Set<string>(sourceBindings.map(row => row.classId).filter(Boolean))];
    const previous = tag.equipment?.catalogClassId || '';
    const classId = selected?.classId || previous || (classIds.length === 1 ? classIds[0] : classIds.length ? '' : mapping.get(type.toUpperCase()) || '');
    if (selected && !available.has(selected.classId)) throw new DocflowPlanError('Выбранный класс каталога не существует', 400);
    const problem = !type ? 'Выберите тип оборудования' : !classId ? (classIds.length > 1 ? 'У связанных позиций разные классы — выберите вручную' : 'Класс не задан: выберите вручную или добавьте соответствие типа') : !available.has(classId) ? 'Класс удалён из Каталога: выберите другой' : '';
    rows.push({ tagId: tag.id, tag: tag.identifier, type, before: previous, classId,
      classCode: available.get(classId) || '', action: problem ? 'skip' : previous === classId && tag.equipment?.type === type ? 'keep' : 'set', problem,
      source: selected ? 'Вручную' : previous ? 'Уже назначен' : classIds.length === 1 ? 'Модель Каталога' : 'Соответствие типа',
      expected: { equipmentId: tag.equipmentId, updatedAt: stamp(tag.updatedAt), equipment: tag.equipment, sourceBindings },
    });
  }
  return { settingsVersion: settings.updatedAt, rows };
}

export async function planEquipmentClasses(prisma: any, projectId: string, actorId: string, raw: unknown) {
  const selection = selectionOf(raw);
  const data = await preview(prisma, projectId, selection);
  const plan = await saveDocflowPlan(prisma, { projectId, actorId, kind: KIND, payload: { selection, ...data } });
  return { id: plan.id, expiresAt: stamp(plan.expiresAt), rows: data.rows };
}

/** Классификация принадлежит проектным тегам: общая запись не меняется за другие проекты. */
function classifiedId(projectId: string, type: string, description: string | null, classId: string) {
  return `dc-${createHash('sha256').update(json([projectId, type, description, classId])).digest('hex').slice(0, 48)}`;
}

export async function applyEquipmentClasses(prisma: any, projectId: string, actorId: string, id: string) {
  return prisma.$transaction(async (tx: any) => {
    const row = await loadDocflowPlan(tx, id, { projectId, actorId, kind: KIND });
    if (row.state === 'applied') return { id, ...JSON.parse(row.result) };
    if (row.state !== 'preview') throw new DocflowPlanError('Этот план уже отменён');
    const saved = parsedPlan<any>(row);
    const current = await preview(tx, projectId, saved.selection);
    if (json(current) !== json({ settingsVersion: saved.settingsVersion, rows: saved.rows })) throw new DocflowPlanError('Теги, Каталог или настройки изменились. Постройте новый предпросмотр.');
    const changes = [];
    for (const item of saved.rows.filter((r: any) => r.action === 'set')) {
      const equipmentId = classifiedId(projectId, item.type, item.expected.equipment?.description || null, item.classId);
      const existing = await tx.equipment.findUnique({ where: { id: equipmentId } });
      if (existing && (existing.type !== item.type || existing.catalogClassId !== item.classId)) throw new DocflowPlanError('Классификация оборудования уже изменена');
      if (!existing) await tx.equipment.create({ data: { id: equipmentId, type: item.type, description: item.expected.equipment?.description || null, catalogClassId: item.classId } });
      const now = new Date(Math.max(Date.now(), item.expected.updatedAt ? Date.parse(item.expected.updatedAt) + 1 : 0));
      const done = await tx.tag.updateMany({ where: { id: item.tagId, projectId, equipmentId: item.expected.equipmentId, updatedAt: item.expected.updatedAt ? new Date(item.expected.updatedAt) : null }, data: { equipmentId, updatedAt: now } });
      if (done.count !== 1) throw new DocflowPlanError('Тег изменён коллегой. Постройте новый план.');
      changes.push({ tagId: item.tagId, before: item.expected.equipmentId, equipmentId, updatedAt: stamp(now), created: !existing });
    }
    const result = { changes, count: changes.length };
    await finishDocflowPlan(tx, row, 'applied', result);
    return { id, ...result };
  }, { isolationLevel: 'Serializable', timeout: 30_000 });
}

export async function undoEquipmentClasses(prisma: any, projectId: string, actorId: string, id: string) {
  return prisma.$transaction(async (tx: any) => {
    const row = await loadDocflowPlan(tx, id, { projectId, actorId, kind: KIND });
    if (row.state === 'undone') return { ok: true };
    if (row.state !== 'applied') throw new DocflowPlanError('План ещё не применён');
    const result = JSON.parse(row.result);
    for (const item of result.changes) {
      if (item.before && !(await tx.equipment.findUnique({ where: { id: item.before } }))) throw new DocflowPlanError('Исходное оборудование удалено. Отмена недоступна.');
      const done = await tx.tag.updateMany({ where: { id: item.tagId, projectId, equipmentId: item.equipmentId, updatedAt: new Date(item.updatedAt) }, data: { equipmentId: item.before } });
      if (done.count !== 1) throw new DocflowPlanError('После заполнения тег изменили. Отмена не затронула новые правки.');
    }
    for (const equipmentId of new Set<string>(result.changes.filter((item: any) => item.created).map((item: any) => item.equipmentId))) {
      await tx.equipment.deleteMany({ where: { id: equipmentId, tags: { none: {} } } });
    }
    await finishDocflowPlan(tx, row, 'undone', result);
    return { ok: true };
  }, { isolationLevel: 'Serializable', timeout: 30_000 });
}

export async function lastEquipmentClassPlan(prisma: any, projectId: string, actorId: string) {
  const row = await prisma.docflowPlan.findFirst({ where: { projectId, actorId, kind: KIND, state: 'applied', expiresAt: { gt: new Date() } }, orderBy: { updatedAt: 'desc' } });
  return { id: row?.id || null, count: row ? JSON.parse(row.result).count : 0 };
}
