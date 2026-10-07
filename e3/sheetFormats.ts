/**
 * Форматы листа для холста, пока размеры не пришли из E3 (`status`, раздел 7):
 * по умолчанию А3. Рамка оставляет слева 20 мм под подшивку, с остальных сторон
 * по 5 мм; штамп 185×55 мм — в правом нижнем углу рабочего поля. Когда появится
 * мост, формат, рамку и сетку читают из E3, а эти значения останутся запасными.
 */
import type { E3Rect, E3SheetInfo } from './bridgeTypes';

export const SHEET_SIZES: Record<string, { w: number; h: number }> = { 'А4': { w: 297, h: 210 }, 'А3': { w: 420, h: 297 }, 'А2': { w: 594, h: 420 } };
export const DEFAULT_FORMAT = 'А3';
const STAMP = { w: 185, h: 55 };

export function sheetFor(format: string): E3SheetInfo {
  const size = SHEET_SIZES[format] || SHEET_SIZES[DEFAULT_FORMAT];
  return { format: SHEET_SIZES[format] ? format : DEFAULT_FORMAT, size, work: { x: 20, y: 5, w: size.w - 25, h: size.h - 10 }, grid: 5 };
}

/** Занятое по умолчанию: штамп */
export function defaultOccupied(sheet: E3SheetInfo): E3Rect[] {
  const w = sheet.work;
  return [{ x: w.x + w.w - STAMP.w, y: w.y + w.h - STAMP.h, ...STAMP }];
}
