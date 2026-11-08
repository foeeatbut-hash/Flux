import { createHash } from 'node:crypto';
import { readCatalog } from './routes/catalog.js';
import type { Catalog } from '../catalog/model.js';
import { DocflowPlanError } from './docflowPlans.js';

export type ProjectCatalogSource = 'effective' | 'project' | 'common';
export function familyDocument(row: any) {
  return { ...JSON.parse(row.dataJson), id: row.id, classId: row.classId, manufacturerId: row.manufacturerId, code: row.code, status: row.status };
}
export function projectFamilyRevision(row: any): string {
  return createHash('sha256').update(JSON.stringify(row ? [row.id, row.dataJson, row.status, row.deletedAt, row.updatedAt] : null)).digest('hex');
}
export async function projectFamilyRows(prisma: any, projectId: string) {
  return prisma.catalogFamily.findMany({ where: { projectId, deletedAt: null }, orderBy: [{ sort: 'asc' }, { code: 'asc' }] });
}

/** Контекст передаётся от проверенного проекта; прежний общий каталог остаётся общим. */
export async function catalogForProject(prisma: any, projectId?: string, source: ProjectCatalogSource = 'effective'): Promise<Catalog & { meta: Record<string, any>; projectId?: string; hasProjectCatalog: boolean }> {
  const common = await readCatalog(prisma);
  if (!projectId) return { ...common, hasProjectCatalog: false };
  const rows = await projectFamilyRows(prisma, projectId);
  if (source === 'common') return { ...common, projectId, hasProjectCatalog: rows.length > 0 };
  const replaced = new Set(rows.map((row: any) => row.basedOnFamilyId).filter(Boolean));
  const families = source === 'project' ? [] : common.families.filter(f => !replaced.has(f.id));
  const meta = source === 'project' ? {} : { ...common.meta };
  for (const row of rows) (meta as any)[row.id] = {
    updatedAt: row.updatedAt, projectId, basedOnFamilyId: row.basedOnFamilyId,
    basedOnRevision: row.basedOnRevision, revision: projectFamilyRevision(row),
    overrides: JSON.parse(row.overridesJson),
  };
  return { ...common, components: source === 'project' ? [] : common.components, families: [...families, ...rows.map(familyDocument)], meta, projectId, hasProjectCatalog: rows.length > 0 };
}

export async function elementProjectId(prisma: any, el: any): Promise<string> {
  const projectId = el.monoblock?.system?.projectId || (await prisma.monoblock.findUnique({ where: { id: el.monoblockId }, include: { system: true } }))?.system?.projectId;
  if (!projectId || !await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })) throw new DocflowPlanError('Проект оборудования не найден', 404);
  return projectId;
}
export async function catalogForElement(prisma: any, el: any, source: ProjectCatalogSource = 'effective') {
  return catalogForProject(prisma, await elementProjectId(prisma, el), source);
}
