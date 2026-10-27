/**
 * Привязка XML не живёт без установки.
 *
 * Удаление установки раньше оставляло `EquipmentXmlSource` и запись в журнале
 * привязок: тег и ссылка на XML были, самой установки — нет. Такая «осиротевшая»
 * привязка отвечала 409 на проверку и на повторный импорт того же файла, а окно
 * «Обновления источников» показывало её как «Источник недоступен».
 *
 * Здесь два шага: снять привязки вместе с удаляемым (в той же транзакции) и
 * найти уже осиротевшие — у тех, кто успел удалить установку до исправления.
 *
 * Привязка не стирается из таблицы, а получает `deletedAt`: кандидаты и
 * применения остаются историей ревизий, а восстановить привязку можно, сняв
 * отметку. Живой она больше нигде не показывается.
 */
import { removeEquipmentDocumentBindingsInTransaction } from './routes/equipmentDocumentBindings.js';

export interface DetachedSource { sourceId: string; tagId: string; elementId: string; systemId: string | null }

/** Снять привязки источников, чьи установка или позиция удаляются сейчас. */
export async function detachXmlSourcesInTransaction(
  tx: any, projectId: string, scope: { systemIds?: string[]; elementIds?: string[]; sourceIds?: string[] },
): Promise<DetachedSource[]> {
  const systemIds = [...new Set(scope.systemIds || [])];
  const elementIds = [...new Set(scope.elementIds || [])];
  const sourceIds = [...new Set(scope.sourceIds || [])];
  const or: any[] = [];
  if (systemIds.length) or.push({ systemId: { in: systemIds } });
  if (elementIds.length) or.push({ elementId: { in: elementIds } });
  if (sourceIds.length) or.push({ id: { in: sourceIds } });
  if (!or.length) return [];
  const rows: any[] = await tx.equipmentXmlSource.findMany({ where: { projectId, deletedAt: null, OR: or } });
  const now = new Date();
  for (const row of rows) {
    // Условие на deletedAt: параллельное снятие той же привязки не считается дважды
    await tx.equipmentXmlSource.updateMany({ where: { id: row.id, deletedAt: null }, data: { deletedAt: now } });
  }
  await removeEquipmentDocumentBindingsInTransaction(tx, projectId, {
    xmlSourceIds: rows.map(row => row.id), systemIds, elementIds,
  });
  return rows.map(row => ({ sourceId: row.id, tagId: row.tagId, elementId: row.elementId, systemId: row.systemId ?? null }));
}

/**
 * Какие из живых источников проекта потеряли свою установку или служебную
 * позицию. Источник компонента сиротой становится, когда исчезла его позиция.
 */
export async function findOrphanXmlSources(prisma: any, projectId: string, rows?: any[]): Promise<any[]> {
  const sources: any[] = rows || await prisma.equipmentXmlSource.findMany({ where: { projectId, deletedAt: null } });
  if (!sources.length) return [];
  const elementIds = [...new Set(sources.map(row => row.elementId).filter(Boolean))];
  const systemIds = [...new Set(sources.map(row => row.systemId).filter(Boolean))];
  const [elements, systems] = await Promise.all([
    elementIds.length ? prisma.componentElement.findMany({ where: { id: { in: elementIds } }, select: { id: true } }) : [],
    systemIds.length ? prisma.equipmentSystem.findMany({ where: { id: { in: systemIds }, projectId }, select: { id: true } }) : [],
  ]);
  const liveElements = new Set(elements.map((row: any) => row.id));
  const liveSystems = new Set(systems.map((row: any) => row.id));
  return sources.filter(row => !liveElements.has(row.elementId) || (row.systemId && !liveSystems.has(row.systemId)));
}
