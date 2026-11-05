import { ENV_CONFIG, getAuthToken, usesCookieTransport } from '../config/env';
import { normalizeSpecs } from '../lib/specs';
import type { EquipmentData, LaunchContext, ModuleReader, ReadData, Resource, TagData } from '../../modules/contract';

const str = (value: unknown) => String(value ?? '');
function tagData(tag: any): TagData {
  return { id: str(tag.id), identifier: str(tag.identifier), name: str(tag.mainName || tag.name), parentId: tag.parentId ? str(tag.parentId) : null };
}
async function get(path: string): Promise<any> {
  const token = getAuthToken();
  if (!token && !usesCookieTransport()) throw new Error('Нет сеанса Flux');
  const response = await fetch(`${ENV_CONFIG.apiUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  // Подставные офлайн-данные dataService здесь недопустимы: отказ чтения остаётся отказом.
  if (!response.ok) throw new Error('Чтение недоступно');
  return response.json();
}
export function createModuleReadCycle(context: LaunchContext): ModuleReader {
  const requests = new Map<string, Promise<any>>();
  const once = (path: string) => {
    // Общий Promise нужен и параллельным привязкам, и logic. Сброс происходит
    // на событии оболочки; неудачное чтение не переживает новый пересчёт.
    if (!requests.has(path)) requests.set(path, get(path));
    return requests.get(path)!;
  };
  return (resource, entityId) => readResource(context, resource, entityId, once);
}

export async function readModuleResource<R extends Resource>(
  context: LaunchContext, resource: R, entityId?: string,
): Promise<ReadData[R]> {
  return createModuleReadCycle(context)(resource, entityId);
}

async function readResource<R extends Resource>(
  context: LaunchContext, resource: R, entityId: string | undefined,
  readPath: (path: string) => Promise<any>,
): Promise<ReadData[R]> {
  if (!context.projectId) throw new Error('Выберите проект');
  const projectId = context.projectId;
  const projects = await readPath('/projects');
  const project = projects.projects?.find((p: any) => p.id === projectId);
  if (!project) throw new Error('Проект недоступен');
  const prefix = `/projects/${encodeURIComponent(projectId)}`;
  let data: ReadData[Resource];
  if (resource === 'project') data = { id: str(project.id), name: str(project.name), code: str(project.code) };
  else if (resource === 'catalog') {
    const catalog = await readPath('/catalog');
    data = { families: (catalog.families || []).filter((family: any) => !entityId || family.id === entityId)
      .map((family: any) => ({ id: str(family.id), name: str(family.name), code: str(family.code), classId: str(family.classId) })) };
  } else if (resource === 'specification') {
    const tags = await readPath(`${prefix}/tags`);
    data = { rows: (tags.tags || []).filter((t: any) => !entityId || t.id === entityId).map(tagData) };
  } else {
    const systems = await readPath(`${prefix}/systems`);
    const components: any[] = (systems.systems || []).flatMap((system: any) => (system.monoblocks || []).flatMap((block: any) => block.components || []));
    const selectedId = entityId || (context.entry === 'equipment' ? context.entityId : null);
    const selected = selectedId ? components.find(item => item.id === selectedId)
      : context.entry === 'tag' ? components.find(item => item.tags?.some((tag: any) => tag.id === context.entityId)) : null;
    if (resource === 'tag') {
      const tags = await readPath(`${prefix}/tags`);
      const tagId = entityId || (context.entry === 'tag' ? context.entityId : selected?.tags?.[0]?.id);
      data = (tags.tags || []).find((tag: any) => tag.id === tagId);
      data = data ? tagData(data) : null;
    } else {
      data = selected ? equipmentData(selected, components) : null;
    }
  }
  return data as ReadData[R];
}
export function equipmentData(item: any, components: any[]): EquipmentData {
  const groups = normalizeSpecs(item.specs).groups;
  let overrides: Record<string, unknown> = {};
  try { overrides = JSON.parse(item.overrides || '{}'); } catch (_) { /* исходные характеристики остаются читаемыми */ }
  const descendants: any[] = [];
  const seen = new Set([item.id]);
  const collect = (parent: string) => {
    for (const child of components.filter(row => row.parentElementId === parent)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id); descendants.push(child); collect(child.id);
    }
  };
  collect(item.id);
  return {
    id: str(item.id), name: str(item.name), itemCode: str(item.itemCode), equipType: str(item.equipType), version: Number(item.version) || 0,
    params: groups.flatMap(group => group.params.map(param => ({ group: str(group.title), key: str(param.key),
      value: str(overrides?.[`${group.title}||${param.key}`] ?? param.value), unit: str(param.unit) }))),
    tags: (item.tags || []).map(tagData),
    composition: descendants.map(row => ({
      id: str(row.id), name: str(row.name), itemCode: str(row.itemCode), parentId: row.parentElementId ? str(row.parentElementId) : null,
    })),
  };
}
