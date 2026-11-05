import type { OfficeChange } from '../../../office/changes';
import type { OfficeFillPlan } from './fluxData';

/**
 * Предпросмотр «Обновить» (решение владельца 4.11.2026): что будет сделано с каждой ячейкой и
 * что человек отметил галочкой. Чистые функции — без React и без запросов, чтобы их проверял
 * test-office-changes.
 *
 * Три группы, у каждой своё действие:
 *  - значения: «было → станет», перезапись как раньше;
 *  - пропавшие значения: ячейка очищается (пустая запись), «было» остаётся в отмене;
 *  - снятые позиции: строка НЕ удаляется, а помечается в части Flux файла (row.removed).
 */
export interface RefreshGroups {
  values: OfficeChange[];
  cleared: OfficeChange[];
  removed: OfficeChange[];
  /** Ручные правки: «Обновить» их не заменит, в предпросмотре — только справка */
  manual: OfficeChange[];
  /** Строки, помеченные раньше: справка, повторно не обрабатываются */
  marked: OfficeChange[];
}

export const changeKey = (change: OfficeChange): string => `${change.kind}\u0000${change.entityId}\u0000${change.anchorId}`;

export function groupChanges(changes: OfficeChange[]): RefreshGroups {
  const groups: RefreshGroups = { values: [], cleared: [], removed: [], manual: [], marked: [] };
  for (const change of changes) {
    if (change.manual) groups.manual.push(change);
    else if (change.kind === 'row-removed') (change.marked ? groups.marked : groups.removed).push(change);
    else if (change.kind === 'cleared') groups.cleared.push(change);
    else groups.values.push(change);
  }
  return groups;
}

/** Есть ли что применять: хотя бы одна отмеченная запись любой группы */
export function pendingCount(groups: RefreshGroups, skipped: ReadonlySet<string>): number {
  return [...groups.values, ...groups.cleared, ...groups.removed].filter((change) => !skipped.has(changeKey(change))).length;
}

export interface RefreshOperations {
  /** Записи в ячейки: значения плана без снятых галочкой плюс очистки пропавших */
  writes: OfficeFillPlan['writes'];
  /** Позиции, строки которых будут помечены как снятые */
  mark: string[];
  /** Обратные записи и снятие пометки: то, что вернёт документ к состоянию до «Обновить» */
  undo: { writes: OfficeFillPlan['writes']; unmark: string[] };
}

/**
 * Что отправить редактору. Запись плана, которой соответствует снятая галочка, выпадает; очистка
 * и пометка идут только по отмеченным. `manualRows` — позиции, которые редактор не тронул
 * (в ячейке уже правка руками): для них отмена не нужна.
 */
export function refreshOperations(planWrites: OfficeFillPlan['writes'], groups: RefreshGroups, skipped: ReadonlySet<string>): RefreshOperations {
  const dropped = new Set(groups.values.filter((change) => skipped.has(changeKey(change))).map((change) => `${change.entityId}\u0000${change.anchorId}`));
  const writes: OfficeFillPlan['writes'] = planWrites.filter((write) => !dropped.has(`${write.entityId}\u0000${write.anchorId}`));
  const undoWrites: OfficeFillPlan['writes'] = [];
  for (const change of groups.values) {
    if (skipped.has(changeKey(change))) continue;
    undoWrites.push({ entityId: change.entityId, anchorId: change.anchorId, value: change.was ?? '' });
  }
  for (const change of groups.cleared) {
    if (skipped.has(changeKey(change))) continue;
    writes.push({ entityId: change.entityId, anchorId: change.anchorId, value: '' });
    undoWrites.push({ entityId: change.entityId, anchorId: change.anchorId, value: change.was ?? '' });
  }
  const mark = [...new Set(groups.removed.filter((change) => !skipped.has(changeKey(change))).map((change) => change.entityId))];
  return { writes, mark, undo: { writes: undoWrites, unmark: mark } };
}

/** Позиции, которых редактор не касался (ручные правки), выпадают из отмены */
export function undoWithoutManual(undo: RefreshOperations['undo'], manualRows: string[]): RefreshOperations['undo'] {
  const skip = new Set(manualRows);
  return { writes: undo.writes.filter((write) => !skip.has(write.entityId)), unmark: undo.unmark };
}
