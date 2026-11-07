import { BAR_H } from './metrics';

/** Отступ меню «Пуск» от левого края монитора и от панели задач. */
export const START_GAP_X = 8;
export const START_GAP_Y = 6;

export interface StartWorkRect { x: number; y: number; w: number; h: number }

/**
 * Где стоит меню «Пуск» в координатах стола: левый край и нижняя кромка.
 *
 * В режиме «Рабочий стол на всех мониторах» у каждого монитора своя панель
 * задач, и меню обязано открыться над кнопкой той панели, где нажали, а не
 * всегда у левого края всего окна (то есть на первом мониторе).
 *
 * `barInside` — панель задач лежит внутри рабочей области монитора; в обычном
 * окне она стоит под столом, и вычитать её высоту второй раз нельзя (как и в
 * draftsPanelFrame). Меню не выходит за правый край своего монитора.
 */
export function startMenuFrame(o: { work: StartWorkRect; barInside: boolean; width: number }) {
  const width = Math.min(o.width, Math.max(0, o.work.w - 2 * START_GAP_X));
  const left = Math.max(o.work.x, Math.min(o.work.x + START_GAP_X, o.work.x + o.work.w - width - START_GAP_X));
  const bottom = o.work.y + o.work.h - (o.barInside ? BAR_H : 0) - START_GAP_Y;
  return { left, bottom, width };
}
