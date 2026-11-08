import { normalizeDocflowConfig } from '../shared/docflow/config.js';
import { kitErrors, normalizeKits } from '../shared/docflow/kits.js';
import { DocflowPlanError } from './docflowPlans.js';
import { readInBatches } from './batchRead.js';

/** Ошибочные ссылки нельзя потерять при нормализации настроек. */
export async function validateKits(prisma: any, raw: any) {
  const errors = kitErrors(raw?.kits);
  if (errors.length) throw new DocflowPlanError(errors.join('; '), 400);
  const kits = normalizeKits(raw?.kits);
  if (!kits.length) return;
  const config = normalizeDocflowConfig(raw);
  const classes = await prisma.catalogClass.findMany({ where: { id: { in: kits.map(k => k.classId) } }, select: { id: true } });
  if (kits.some(k => !classes.some((c: any) => c.id === k.classId))) throw new DocflowPlanError('Класс комплекта не найден в Каталоге', 400);
  const roles = [...new Set(kits.flatMap(k => k.items.map(i => i.responsibleRole)).filter(Boolean))];
  const knownRoles = await readInBatches<any>(roles, part => prisma.role.findMany({ where: { code: { in: part } }, select: { code: true } }));
  for (const kit of kits) for (const item of kit.items) {
    if (!config.vdrTypes.some(type => type.code === item.docType)) throw new DocflowPlanError(`Тип ${item.docType} отсутствует в настройках проекта`, 400);
    if (item.responsibleRole && !knownRoles.some((role: any) => role.code === item.responsibleRole)) throw new DocflowPlanError('Должность комплекта не существует', 400);
    if (item.milestone && !config.deadlines.milestones.some(m => m.code === item.milestone)) throw new DocflowPlanError('Веха комплекта отсутствует в настройках проекта', 400);
    if (item.workdays && !item.milestone) throw new DocflowPlanError('Для срока комплекта выберите веху', 400);
  }
}
