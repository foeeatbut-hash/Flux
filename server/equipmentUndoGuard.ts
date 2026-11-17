/**
 * Отмена импорта расчёта: версии позиций, которые видел план отмены.
 *
 * План отмены (GET) читает позиции партии и показывает человеку, сколько вернётся,
 * сколько исчезнет и что откат обойдёт стороной. Применение (POST) пересчитывает
 * план в момент отката — по записям той же транзакции — и сверяет его с тем, что
 * подтвердил человек (общий договор — server/planGuard.ts):
 *  • позицию из `seen` изменили или удалили — `PlanChanged`, ничего не записано;
 *  • в новом плане есть позиция, которой человек не видел (её прежде пропускали, а
 *    теперь откат дошёл бы и до неё), — тоже `PlanChanged`: к тому, что человек не
 *    подтверждал, программа молча не применяется.
 *
 * Запрос без `seen` (старая сборка клиента) принимается: пересчёт плана в транзакции
 * есть всегда, а сверки с подтверждённым нет.
 */
import { assertSeenVersions, PlanChanged, type SeenVersions } from './planGuard.js';
import { undoChangedText } from '../src/lib/refusalTexts.js';
import { shownRowOf, type ShownRow } from './equipmentPlanSeen.js';
import type { ElementNow, UndoPlan } from './equipmentUndo.js';

/** Позиции, которых коснётся откат: по плану и по тем, чьи теги он переносит. */
export function touchedIds(plan: UndoPlan): string[] {
  const ids = new Set<string>();
  for (const list of [plan.restore, plan.remove, plan.reinstate, plan.reremove, plan.unmove, plan.unrename, plan.retag]) {
    for (const it of list) {
      if (it.elementId) ids.add(it.elementId);
      if (it.action === 'retag' && it.toId) ids.add(it.toId);
    }
  }
  return [...ids];
}

/** Версии и показанные поля позиций плана — в ответ на GET. Позиции, которой уже нет в карте, нет и в перечне. */
export function seenOfUndoPlan(plan: UndoPlan, map: Map<string, ElementNow>, rawById: Map<string, any>): { seen: SeenVersions; seenRows: Record<string, ShownRow> } {
  const seen: SeenVersions = {};
  const seenRows: Record<string, ShownRow> = {};
  for (const id of touchedIds(plan)) {
    const el = map.get(id);
    if (!el) continue;
    seen[id] = Number(el.version || 1);
    seenRows[id] = shownRowOf(rawById.get(id));
  }
  return { seen, seenRows };
}

/** Запись для отказа: без вложенного дерева моноблока и установки, которое читал загрузчик партии. */
export const presentUndoRow = (row: any): any => {
  if (!row || typeof row !== 'object') return row;
  const { monoblock: _monoblock, ...rest } = row;
  return rest;
};

/**
 * Сверка применения с подтверждённым планом. Внутри транзакции, до первой записи.
 * `rawById` — позиции партии, как их прочитала эта же транзакция; `batchIds` — все
 * позиции, о которых у партии есть записи истории (в том числе уже удалённые).
 * Идентификатор не из партии откат не заденет, поэтому он не сверяется и в отказ не попадает.
 */
export async function assertUndoSeen(
  tx: any, plan: UndoPlan, seen: SeenVersions | undefined, rawById: Map<string, any>, batchIds: Set<string>,
): Promise<void> {
  if (!seen) return;
  const own: SeenVersions = {};
  for (const [id, version] of Object.entries(seen)) if (batchIds.has(id)) own[id] = version;
  await assertSeenVersions(tx, 'componentElement', own, { message: undoChangedText() });
  const extra = touchedIds(plan).filter((id) => !(id in own));
  if (extra.length) throw new PlanChanged(extra.map((id) => ({ id, current: presentUndoRow(rawById.get(id)) })), [], undoChangedText());
}
