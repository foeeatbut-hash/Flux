/**
 * Правые панели оболочки: уведомления с календарём и помощник.
 *
 * Как в Windows 11, это скруглённые карточки у правого края над панелью задач.
 * Они не перекрывают ни панель задач, ни друг друга: на широком экране стоят
 * рядом колонками (справа центр уведомлений, левее него помощник), на узком
 * показывается только та, что открыта последней. Раньше они делили одну колонку
 * по высоте с подвижным разделителем — на низком экране от каждой оставался
 * огрызок, а календарю вовсе не хватало места.
 *
 * Без React и без DOM: у раскладки есть правильный ответ, и его проверяет
 * скрипт (scripts/test-right-panels.ts). Ошибка здесь не падает, а тихо
 * отрезает кусок экрана — заметить это можно только глазами и не сразу.
 */

export type PanelId = 'notifications' | 'assistant';

/** Ширина колонок и зазор до края и между ними */
export const NOTIF_W = 360;
export const ASSIST_W = 380;
export const DOCK_GAP = 8;
/** Уже этого колонки вдвоём не помещаются рядом с окнами программ */
export const NARROW_W = 1100;

export const panelWidth = (id: PanelId): number => (id === 'notifications' ? NOTIF_W : ASSIST_W);

export interface DockPlan {
  /** Открытые панели в порядке открытия, без повторов */
  order: PanelId[];
  /** Что показать слева направо; пусто — колонок нет вовсе */
  columns: PanelId[];
  /** Открыта, но не показана: на узком экране уступила место более новой */
  hidden: PanelId[];
}

/**
 * Что и как показать.
 *
 * `opened` — порядок открытия. Слева направо панели стоят всегда одинаково:
 * помощник левее, уведомления у самого угла рядом с часами, откуда их и
 * открывали. Порядок открытия нужен только узкому экрану — там остаётся
 * последняя.
 */
export function dockPlan(opened: PanelId[], width: number): DockPlan {
  const order = opened.filter((p, i) => opened.indexOf(p) === i);
  let shown = order;
  if (order.length > 1 && width < NARROW_W) shown = [order[order.length - 1]];
  const columns = (['assistant', 'notifications'] as PanelId[]).filter((p) => shown.includes(p));
  return { order, columns, hidden: order.filter((p) => !shown.includes(p)) };
}

/** Сколько места колонки занимают по ширине, вместе с зазорами и краем */
export function dockWidth(columns: PanelId[]): number {
  if (!columns.length) return 0;
  return columns.reduce((sum, id) => sum + panelWidth(id), 0) + DOCK_GAP * (columns.length + 1);
}

/**
 * Открыть панель: она встаёт в конец очереди, если её там ещё нет.
 * Возвращает новый порядок — состояние живёт снаружи.
 */
export function openPanel(opened: PanelId[], id: PanelId): PanelId[] {
  return opened.includes(id) ? opened : [...opened, id];
}

/** Закрыть панель */
export function closePanel(opened: PanelId[], id: PanelId): PanelId[] {
  return opened.filter((p) => p !== id);
}

/** Нажали на кнопку панели: открыта — закроем, закрыта — откроем */
export function togglePanel(opened: PanelId[], id: PanelId): PanelId[] {
  return opened.includes(id) ? closePanel(opened, id) : openPanel(opened, id);
}

export const panelTitle = (id: PanelId): string =>
  (id === 'notifications' ? 'Уведомления' : 'Помощник');
