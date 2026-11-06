import { BAR_H } from './metrics';

/** Отступ панели «Черновики» от краёв монитора и от панели задач. */
export const DRAFTS_GAP = 4;

export interface DraftsWorkRect { x: number; y: number; w: number; h: number }

/**
 * Где стоит панель «Черновики» в координатах стола.
 *
 * `barInside` — панель задач лежит внутри рабочей области монитора (режим
 * «Рабочий стол на всех мониторах»). В обычном окне панель задач стоит под
 * столом, и вычитать её высоту второй раз нельзя: панель повисала бы на 48 px
 * выше кнопки.
 */
export function draftsPanelFrame(o: { work: DraftsWorkRect; barInside: boolean; anchorLeft?: number | null; width: number; height: number; fullWidth?: boolean }) {
  const bottom = o.work.y + o.work.h - (o.barInside ? BAR_H : 0) - DRAFTS_GAP;
  const width = o.fullWidth ? Math.max(0, o.work.w - 2 * DRAFTS_GAP) : Math.min(o.width, Math.max(0, o.work.w - 2 * DRAFTS_GAP));
  const height = Math.min(o.height, Math.max(0, bottom - o.work.y - DRAFTS_GAP));
  const wanted = o.fullWidth ? o.work.x + DRAFTS_GAP : o.anchorLeft ?? o.work.x + DRAFTS_GAP;
  const left = Math.max(o.work.x + DRAFTS_GAP, Math.min(wanted, o.work.x + o.work.w - width - DRAFTS_GAP));
  return { left, top: bottom - height, width, height };
}
