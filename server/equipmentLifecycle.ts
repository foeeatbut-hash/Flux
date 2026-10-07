/**
 * Жизнь записи позиции при повторной загрузке: снять, вернуть, передвинуть,
 * передать теги (docs/e3-integration.md, 1.5).
 *
 * Запись позиции никогда не удаляется загрузкой: тег, история и связь с E3
 * принадлежат её ID. Снятая позиция получает `status = 'REMOVED'`, а в
 * `conflictLog` — отметка `__removal` с датой, партией и причиной. Без новой
 * колонки и миграции: спорные параметры живут в том же поле под ключами имён
 * полей, а снятая позиция конфликтов не разбирает.
 *
 * Каждое действие оставляет в истории строку с партией — по ней отмена ввоза
 * находит, что вернуть (`equipmentUndo.ts`). Версия растёт на каждом шаге
 * (`equipmentVersion.ts`).
 */
import { withBump } from './equipmentVersion.js';
import { recordChangeSets, TAG_SOURCE, TAG_CHANGE_KIND, type TagChangeSet } from './tagHistory.js';
import type { DbItem } from './equipmentIdentity.js';

export type RemovalWhy = 'missing' | 'reselected' | 'other';

/**
 * Снять позицию. `replacedBy` есть только у «Переподобрано»: связь «заменено
 * на». `releaseTags` — теги уходят от снятой (их примет новая запись).
 */
export async function markRemoved(
  prisma: any, old: DbItem, batchId: string, why: RemovalWhy,
  opts: { replacedBy?: string; releaseTags?: boolean } = {},
): Promise<void> {
  const row = old.row;
  await prisma.componentElement.update({
    where: { id: old.id },
    data: withBump({
      status: 'REMOVED', hasConflict: false, conflictType: null, paramConflicts: null,
      conflictLog: JSON.stringify({
        __removal: { at: new Date().toISOString(), batchId, why, ...(opts.replacedBy ? { replacedBy: opts.replacedBy } : {}) },
      }),
      ...(opts.releaseTags && old.tagIds.length ? { tags: { disconnect: old.tagIds.map(id => ({ id })) } } : {}),
    }),
  });
  await prisma.equipmentHistory.create({
    data: {
      elementId: old.id, version: row.version ?? 1,
      oldSpecs: row.specs ?? null, newSpecs: row.specs ?? null,
      changeType: 'REMOVE', batchId,
    },
  });
}

/** Вернуть пропавшую позицию: та же запись, статус OK, отметка о снятии убрана */
export async function restoreRemoved(prisma: any, row: any, batchId: string): Promise<void> {
  await prisma.equipmentHistory.create({
    data: {
      elementId: row.id, version: row.version ?? 1,
      // Прежнее содержимое conflictLog — отмена партии вернёт его обратно
      oldSpecs: row.conflictLog ?? null, newSpecs: null,
      changeType: 'RESTORE', batchId,
    },
  });
  await prisma.componentElement.update({
    where: { id: row.id },
    data: withBump({ status: 'OK', conflictLog: null, hasConflict: false, conflictType: null, paramConflicts: null }),
  });
}

/** Адрес записи — то, что отмена вернёт, если позиция переехала */
export const addressJson = (r: { monoblockId: string; itemCode: string; parentElementId?: string | null }) =>
  JSON.stringify({ monoblockId: r.monoblockId, itemCode: r.itemCode, parentElementId: r.parentElementId ?? null });

export async function recordMove(prisma: any, row: any, next: { monoblockId: string; itemCode: string; parentElementId: string | null }, batchId: string): Promise<void> {
  await prisma.equipmentHistory.create({
    data: {
      elementId: row.id, version: row.version ?? 1,
      oldSpecs: addressJson(row), newSpecs: addressJson(next),
      changeType: 'MOVE', batchId,
    },
  });
}

/**
 * «Переподобрано»: теги прежней записи переходят на новую. Тег — это позиция,
 * а не изделие; изделие заменили, позиция в схеме осталась. Старая запись
 * хранит ссылку `replacedBy`, в истории тега остаётся строка о переносе.
 */
export async function transferTags(
  prisma: any, ctx: { projectId: string; userId?: string | null }, from: DbItem, to: { id: string; title: string }, batchId: string,
): Promise<void> {
  if (!from.tagIds.length) return;
  await prisma.componentElement.update({
    where: { id: to.id },
    // Новая запись только что заведена этим же ввозом: её версия остаётся первой
    data: { tags: { connect: from.tagIds.map(id => ({ id })) } },
  });
  await prisma.equipmentHistory.create({
    data: {
      elementId: from.id, version: from.row.version ?? 1,
      oldSpecs: JSON.stringify({ tagIds: from.tagIds, elementId: from.id }),
      newSpecs: JSON.stringify({ tagIds: from.tagIds, elementId: to.id }),
      changeType: 'TAG_MOVE', batchId,
    },
  });
  const sets: TagChangeSet[] = from.tagIds.map(tagId => ({
    tagId, projectId: ctx.projectId,
    entries: [{ kind: TAG_CHANGE_KIND.changed, field: 'equipmentElement', before: from.title, after: to.title }],
  }));
  await recordChangeSets(prisma, { projectId: ctx.projectId, userId: ctx.userId, source: TAG_SOURCE.equipmentImport }, sets);
}
