/**
 * Запись импорта оборудования по предпросмотру: сверка версий и запись — одна транзакция.
 *
 * Предпросмотр (`planEquipmentImport`) несёт `seen` — версии позиций, которые он читал
 * (общий договор — server/planGuard.ts). Запись присылает `seen` обратно, а здесь, в
 * ТОЙ ЖЕ транзакции и ДО первой записи, версии сверяются с базой. Позицию успели
 * изменить или удалить — `PlanChanged`, откатывается всё: «всё или ничего».
 *
 * Без `seen` (старая сборка клиента) запись идёт как раньше, без транзакции: такой
 * запрос сверяется только с чтением самой записи.
 */
import { assertSeenVersions, type SeenVersions } from './planGuard.js';
import { importEquipmentToDB, type IdentityInput, type ImportSummary } from './equipmentImport.js';
import { emitProjectDataChanged } from './entityChanged.js';
import { notifyExporters } from './e3Impact.js';

/** Транзакция записи: у SQLite одно соединение, у остальных — Serializable (как у ввоза с привязкой источника). */
export function importDraftTransactionOptions(prisma: any): { timeout: number; isolationLevel?: 'Serializable' } {
  const provider = prisma?._engineConfig?.activeProvider || prisma?._activeProvider;
  return { timeout: 30_000, ...(provider === 'sqlite' ? {} : { isolationLevel: 'Serializable' as const }) };
}

/**
 * Сверка версий позиций проекта. Позиция другого проекта чужой не отдаётся: её
 * идентификатор считается отсутствующим, а содержимое в отказ не попадает.
 */
export function assertEquipmentSeen(tx: any, projectId: string, seen: SeenVersions | undefined): Promise<void> {
  return assertSeenVersions(tx, 'componentElement', seen, { where: { monoblock: { system: { projectId } } } });
}

export async function importEquipmentGuarded(
  prisma: any,
  seen: SeenVersions | undefined,
  projectId: string,
  category: string,
  fileName: string,
  result: Parameters<typeof importEquipmentToDB>[4],
  conflictMode: 'immediate' | 'wait',
  tagLinks: Parameters<typeof importEquipmentToDB>[6],
  actor: { userId?: string | null },
  identity: IdentityInput,
): Promise<ImportSummary> {
  if (!seen) return importEquipmentToDB(prisma, projectId, category, fileName, result, conflictMode, tagLinks, actor, identity);

  const summary = await prisma.$transaction(async (tx: any) => {
    await assertEquipmentSeen(tx, projectId, seen);
    return importEquipmentToDB(
      tx, projectId, category, fileName, result, conflictMode, tagLinks, actor,
      { ...identity, inTransaction: true, deferEntityChanged: true, deferNotifications: true },
    );
  }, importDraftTransactionOptions(prisma));

  // После фиксации: уведомления и события не должны уйти по записи, которая откатилась
  try { summary.e3Notified = await notifyExporters(prisma, projectId, summary.batchId, actor.userId); }
  catch (e: any) { console.error('[E3] Уведомление о смене выгруженных позиций не отправлено:', e?.message || e); }
  if (summary.newBlocks || summary.updatedBlocks || summary.movedBlocks || summary.supersededBlocks
    || summary.removedBlocks || summary.restoredBlocks) emitProjectDataChanged('element', projectId, actor);
  if (summary.tagsLinked || summary.tagsCreated || summary.tagParents) emitProjectDataChanged('tag', projectId, actor);
  return summary;
}
