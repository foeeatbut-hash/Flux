/**
 * Книга Excel с атрибутами E3 по позициям проекта.
 *
 * Инженер скачивает книгу, дописывает пустые столбцы руками (атрибуты без
 * «Да» Flux не заполняет) и отдаёт файл дальше. Позже заполненную книгу
 * будем читать обратно, поэтому устройство листа — договор:
 *
 *   — строка 1: имена атрибутов E3 (то, по чему пишется значение в схему);
 *   — строка 2: описания атрибутов (то, что понимает человек);
 *   — данные с 3-й строки;
 *   — столбец A — служебный ID позиции Flux, скрытый: по нему заполненный
 *     файл вернётся к своей позиции, даже если инженер пересортировал строки.
 *
 * Модуль чистый — ни React, ни сервера: строки приходят готовыми
 * (src/lib/e3Table.ts), здесь только раскладка по листам и запись книги.
 */
import * as XLSX from 'xlsx';
import type { ExportColumn } from '../src/lib/exportSpec';
import { classById, classOrder } from '../equipment/classes';
import { attributesForClass, type E3Attribute } from './attributes';

/** Строка таблицы: позиция проекта и значения по столбцам `e3:` */
export interface E3Row {
  /** Служебный ID позиции Flux */
  id: string;
  /** Тип оборудования (ключ equipment/classes) */
  cls: string;
  /** Чем назвать позицию на экране: тег, а без него наименование. В книгу не попадает */
  label: string;
  cells: string[];
  /** Атрибут к типу этой позиции не относится: ячейка пустая и не считается недостающей */
  na: boolean[];
}

export type E3SheetMode = 'class' | 'single';
export interface E3Sheet { name: string; aoa: string[][] }

export const E3_ID_HEADER = ['ID позиции Flux', 'Служебный столбец: не менять и не удалять'];

export const e3ColumnName = (c: ExportColumn): string => (c.key.startsWith('e3:') ? c.key.slice(3) : c.key);

/** Значение столбцу даёт Flux («Да» в справочнике); иначе столбец пустой — его заполняют руками */
export const isFluxColumn = (c: ExportColumn): boolean => !!c.source && c.source.kind !== 'none';

/** «Да» есть, а у позиции значения нет — такие ячейки подсвечиваются как «нет данных» */
export const isMissingCell = (c: ExportColumn, cell: string, na = false): boolean => !na && isFluxColumn(c) && !String(cell ?? '').trim();

/**
 * Имя листа по правилам Excel: до 31 знака, без `[]:*?/\`, не пустое и не
 * повторяющееся без учёта регистра. Повтор получает номер в конце.
 */
export function safeSheetName(raw: string, taken: Set<string>): string {
  const base = String(raw || '').replace(/[\[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '').slice(0, 31).trim() || 'Лист';
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = ` ${n}`;
    name = base.slice(0, 31 - suffix.length).trim() + suffix;
  }
  taken.add(name.toLowerCase());
  return name;
}

/**
 * Листы книги. `class` — лист на каждый тип, на листе только атрибуты этого
 * типа (на листе двигателей нет столбцов КИП); `single` — один лист со всеми
 * выбранными столбцами, неприменимые к типу ячейки пустые.
 */
export function buildAttributeSheets(input: { columns: ExportColumn[]; items: E3Attribute[]; rows: E3Row[]; mode: E3SheetMode }): E3Sheet[] {
  const { columns, items, rows, mode } = input;
  const byName = new Map<string, E3Attribute>();
  for (const a of items || []) if (!byName.has(a.name)) byName.set(a.name, a);
  const titleOf = (c: ExportColumn): string => byName.get(e3ColumnName(c))?.title || e3ColumnName(c);
  const taken = new Set<string>();

  const make = (name: string, cols: number[], list: E3Row[]): E3Sheet => ({
    name: safeSheetName(name, taken),
    aoa: [
      [E3_ID_HEADER[0], ...cols.map((j) => e3ColumnName(columns[j]))],
      [E3_ID_HEADER[1], ...cols.map((j) => titleOf(columns[j]))],
      ...list.map((r) => [r.id, ...cols.map((j) => r.cells[j] ?? '')]),
    ],
  });

  const all = columns.map((_, j) => j);
  if (mode === 'single' || !rows.length) return [make(mode === 'single' ? 'Атрибуты E3' : 'Атрибуты', all, rows)];

  const classes = [...new Set(rows.map((r) => r.cls || 'ПРОЧЕЕ'))].sort((a, b) => classOrder(a) - classOrder(b));
  return classes.map((cls) => {
    const own = all.filter((j) => {
      const a = byName.get(e3ColumnName(columns[j]));
      return !a || attributesForClass([a], cls).length > 0;
    });
    return make(classById(cls).plural, own, rows.filter((r) => (r.cls || 'ПРОЧЕЕ') === cls));
  });
}

/** Книга: столбец A скрыт, ширины по заголовкам, чтобы имена E3 читались без растягивания */
export function attributeWorkbook(sheets: E3Sheet[]): XLSX.WorkBook {
  const book = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.aoa);
    ws['!cols'] = s.aoa[0].map((h, j) => (j === 0
      ? { hidden: true, wch: 12 }
      : { wch: Math.min(40, Math.max(12, String(h).length + 2, String(s.aoa[1][j] ?? '').length / 2)) }));
    XLSX.utils.book_append_sheet(book, ws, s.name);
  }
  return book;
}

export const attributeWorkbookBytes = (sheets: E3Sheet[]): ArrayBuffer => XLSX.write(attributeWorkbook(sheets), { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
