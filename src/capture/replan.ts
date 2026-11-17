import { buildPlan, type ExistingTag, type PlanRow } from './plan';
import type { CaptureRow, Shape } from './recognize';

/**
 * План заново после отказа «теги изменили, пока вы смотрели».
 *
 * Сервер не записал ничего: хоть один тег, на который опирался план, изменили или
 * удалили. Экран перечитывает теги проекта и строит план по ним (тот же `buildPlan`, что
 * и в первый раз), а решения человека переносит туда, где основание плана не менялось:
 * тот же тег-цель, тот же класс конфликта, цель не из отказа.
 *
 * Там, где основание изменилось, прежнее решение относилось к прежней записи — строка
 * приходит со снятой отметкой. Человек читал перечень изменений и отмечает её заново
 * сам: программа не применяет план к записи, которую он не подтверждал в нынешнем виде.
 */
export function replan(
  previous: PlanRow[], rows: CaptureRow[], fresh: ExistingTag[], shape: Shape, changedIds: ReadonlySet<string>,
): PlanRow[] {
  const was = new Map(previous.map((r) => [r.key, r]));
  return buildPlan(rows, fresh, shape).map((next) => {
    const old = was.get(next.key);
    if (!old) return next;
    const sameBasis = (old.existing?.id ?? '') === (next.existing?.id ?? '')
      && old.cls === next.cls
      && !(next.existing && changedIds.has(next.existing.id));
    if (sameBasis) return next.options.includes(old.action) ? { ...next, action: old.action, on: old.on } : next;
    return { ...next, on: false };
  });
}
