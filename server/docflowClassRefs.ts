import { classMappingErrors } from '../shared/docflow/classMapping.js';
import { DocflowPlanError } from './docflowPlans.js';

/** Чтение старого JSON терпимо, но запись не должна терять ошибочные соответствия. */
export async function validateClassMappings(prisma: any, config: any) {
  const errors = classMappingErrors(config?.equipmentClasses);
  if (errors.length) throw new DocflowPlanError(errors.join('; '), 400);
  const ids = [...new Set<string>((config?.equipmentClasses || []).map((row: any) => row.classId.trim()))];
  if (!ids.length) return;
  const found = await prisma.catalogClass.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const actual = new Set(found.map((row: any) => row.id));
  if (ids.some(id => !actual.has(id))) throw new DocflowPlanError('Один из классов каталога не существует. Обновите соответствия.', 400);
}
