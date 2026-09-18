/**
 * Разметка на листе: чипы в шапке, чтение и запись по столбцам.
 *
 * Отделено от экрана редактора по двум причинам. Первая — размер: экран стоит
 * у планки, и класть туда ещё сотню строк нельзя. Вторая важнее: здесь
 * геометрия, а геометрию легко сломать незаметно. Столбцы разметки могут идти
 * с пропусками — человек разметил A, B и F, — и запись «одним прямоугольником»
 * затёрла бы то, что он написал в C, D и E. Поэтому каждый столбец читается и
 * пишется своим диапазоном, и это проверяется скриптом на поддельном листе.
 *
 * Движок таблиц сюда не импортируется: нужен только объект, умеющий `getRange`.
 */

import { CHIP, headerText, type TableLayout } from './tableLayout';

/** То немногое, что нужно от листа. Настоящий лист движка это умеет. */
export interface SheetLike {
  getRange: (row: number, col: number, rows?: number, cols?: number) => RangeLike | null;
}

export interface RangeLike {
  setValue?: (v: unknown) => unknown;
  setValues?: (v: unknown[][]) => unknown;
  getValues?: () => unknown[][];
  setFontWeight?: (v: string) => unknown;
  setBackgroundColor?: (v: string) => unknown;
  setHorizontalAlignment?: (v: string) => unknown;
  setFontColor?: (v: string) => unknown;
}

/** Движок бросает на закрытом листе — ни одна правка вида не стоит падения. */
const quiet = <T,>(fn: () => T): T | null => {
  try { return fn(); } catch (_) { return null; }
};

/**
 * Нарисовать шапку разметки.
 *
 * Пока не собрано — подложка мятная и буквы зелёные: видно, что место занято
 * полем, но данных ещё нет. После сборки — серая с тёмными буквами, как
 * обычная шапка таблицы. Это единственное отличие «заготовки» от готовой
 * таблицы на вид, и большего не нужно: в Excel уедет обычная ячейка с
 * текстом, а не пустота с картинкой.
 *
 * Рамку не рисуем намеренно. Движок умеет её ставить, но только через свои
 * перечисления, а тащить их сюда — значит привязать эти правила к движку
 * таблиц ради одной линии. Цвет буквы отличает заготовку не хуже.
 */
export function paintHeader(ws: SheetLike, layout: TableLayout, collected: boolean): void {
  for (const c of layout.columns) {
    quiet(() => {
      const r = ws.getRange(layout.headerRow, c.col, 1, 1);
      if (!r) return;
      r.setValue?.(headerText(c));
      r.setFontWeight?.('bold');
      r.setBackgroundColor?.(collected ? CHIP.collected : CHIP.pending);
      r.setFontColor?.(collected ? CHIP.collectedInk : CHIP.pendingInk);
      r.setHorizontalAlignment?.('center');
    });
  }
}

/** Убрать поле из шапки: текст, подложку и цвет — иначе останется призрак. */
export function clearHeaderCell(ws: SheetLike, headerRow: number, col: number): void {
  quiet(() => {
    const r = ws.getRange(headerRow, col, 1, 1);
    if (!r) return;
    r.setValue?.('');
    r.setFontWeight?.('normal');
    r.setBackgroundColor?.('');
    r.setFontColor?.(CHIP.collectedInk);
  });
}

/**
 * Прочитать значения под шапкой — по столбцу за раз.
 *
 * Возвращает строка × столбец разметки в том же порядке, что `layout.columns`.
 * Пропущенные столбцы листа не читаются вовсе: они принадлежат человеку.
 */
export function readColumnValues(
  ws: SheetLike, layout: TableLayout, top: number, count: number,
): string[][] {
  if (count <= 0) return [];
  const byCol: string[][] = layout.columns.map((c) => {
    const got = quiet(() => ws.getRange(top, c.col, count, 1)?.getValues?.() || []);
    return Array.from({ length: count }, (_, i) => String((got as any)?.[i]?.[0] ?? ''));
  });
  return Array.from({ length: count }, (_, i) => byCol.map((col) => col[i] ?? ''));
}

/**
 * Записать значения под шапкой — по столбцу за раз.
 *
 * `rows` — строка × столбец разметки. Значения, которых нет, пишутся пустыми:
 * иначе от прошлой сборки остались бы хвосты в строках, которых больше нет.
 */
export function writeColumnValues(
  ws: SheetLike, layout: TableLayout, top: number, rows: string[][],
): void {
  layout.columns.forEach((c, j) => {
    const column = rows.map((r) => [String(r?.[j] ?? '')]);
    if (!column.length) return;
    quiet(() => ws.getRange(top, c.col, column.length, 1)?.setValues?.(column));
  });
}

/** Стереть столько строк данных, сколько было: после сборки с меньшим числом. */
export function clearColumnValues(
  ws: SheetLike, layout: TableLayout, top: number, count: number,
): void {
  if (count <= 0) return;
  const blank = Array.from({ length: count }, () => ['']);
  for (const c of layout.columns) {
    quiet(() => ws.getRange(top, c.col, count, 1)?.setValues?.(blank));
  }
}

/**
 * Куда встанет следующее поле, если человек не выбрал ячейку сам.
 *
 * Вправо от последнего размеченного столбца — так разметка растёт естественно,
 * и не приходится целиться мышью в каждую следующую клетку.
 */
export function nextFreeColumn(layout: TableLayout): number {
  if (!layout.columns.length) return 0;
  return Math.max(...layout.columns.map((c) => c.col)) + 1;
}
