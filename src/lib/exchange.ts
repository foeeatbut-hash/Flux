/**
 * Обмен данными: что выгружаем, куда и сколько это будет.
 *
 * Просьба владельца дословно: «сейчас всё слишком много места занимает, чтобы
 * что-то найти, нужно постоянно двигать мышкой вниз». Речь про полосы «Экспорт
 * и импорт», где все варианты разложены сразу и занимают экран целиком.
 *
 * Вариантов на деле три вопроса: ЧТО выгружаем, КУДА и КАКИЕ столбцы. Ответы на
 * них помещаются в одно окно без прокрутки — но только если под ними стоит
 * четвёртая строка: сколько получится. Без неё человек нажимает «Выгрузить» и
 * узнаёт результат из файла, а если результат не тот — повторяет всё заново.
 *
 * Здесь правила: подпись результата, сборка CSV и имя файла. Без React и без
 * DOM — их легко проверить и легко ошибиться незаметно (разделитель, кавычки,
 * BOM: без него Excel открывает кириллицу крякозябрами).
 */

/**
 * Куда выгружаем. «office» — файл .xlsx в «Выгрузках» на своём столе, сразу
 * открытый Таблицей Flux Office; «xlsx» — тот же файл в Windows (скачать)
 */
export type Target = 'office' | 'xlsx' | 'csv' | 'clipboard';

export const TARGET_LABEL: Record<Target, string> = {
  office: 'Таблица Flux Office',
  xlsx: 'XLSX в Windows',
  csv: 'CSV',
  clipboard: 'Буфер обмена',
};

/** Что выгружаем: набор строк с понятным человеку названием */
export interface Scope {
  id: string;
  label: string;
  count: number;
}

export interface Column {
  key: string;
  label: string;
}

const plural = (n: number, one: string, few: string, many: string): string => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};

/** «≈48 КБ» — грубая, но честная оценка: важен порядок, а не байты */
export function sizeHint(rows: number, cols: number): string {
  const bytes = Math.max(0, rows) * Math.max(0, cols) * 18 + 512;
  if (bytes < 1024 * 1024) return `~${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `~${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/**
 * Строка результата до нажатия: «37 строк · 5 столбцов · ~48 КБ».
 *
 * Она и есть замена простыне: человек видит, что получится, не выгружая.
 */
export function summary(rows: number, cols: number): string {
  if (rows <= 0) return 'Под эти условия не попала ни одна строка';
  if (cols <= 0) return 'Не выбран ни один столбец';
  return `${rows} ${plural(rows, 'строка', 'строки', 'строк')} · `
    + `${cols} ${plural(cols, 'столбец', 'столбца', 'столбцов')} · ${sizeHint(rows, cols)}`;
}

/** Можно ли выгружать прямо сейчас; пустая строка — можно */
export function blocker(rows: number, cols: number): string {
  if (cols <= 0) return 'Выберите хотя бы один столбец.';
  if (rows <= 0) return 'Под текущие условия не попала ни одна строка.';
  return '';
}

/**
 * CSV для Excel.
 *
 * Три вещи, без которых файл открывается неправильно, и все три уже случались
 * в этом проекте: BOM (иначе кириллица крякозябрами), точка с запятой (русский
 * Excel считает запятую разделителем разрядов) и удвоение кавычек внутри
 * значения (иначе строка рвётся посередине).
 */
export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.map(cell).join(';')];
  for (const r of rows) lines.push(r.map(cell).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Текст для буфера обмена: столбцы табуляцией — так его и ждёт Excel */
export function toClipboard(headers: string[], rows: (string | number)[][]): string {
  const cell = (v: unknown) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  return [headers.map(cell).join('\t'), ...rows.map((r) => r.map(cell).join('\t'))].join('\n');
}

/** Имя файла: раздел и дата — по ним его потом и ищут в «Загрузках» */
export function fileName(section: string, target: Target, at: Date = new Date()): string {
  const d = `${String(at.getDate()).padStart(2, '0')}-${String(at.getMonth() + 1).padStart(2, '0')}-${at.getFullYear()}`;
  const clean = String(section || 'Данные').replace(/[\\/:*?"<>|]+/g, ' ').trim();
  return `Flux — ${clean} — ${d}.${target === 'xlsx' || target === 'office' ? 'xlsx' : 'csv'}`;
}

/** Отобрать столбцы в том порядке, в каком они объявлены разделом */
export function pickColumns(all: Column[], chosen: string[]): Column[] {
  const want = new Set(chosen);
  return all.filter((c) => want.has(c.key));
}

/** Книга .xlsx из строк — один лист; библиотека грузится только при выгрузке */
export async function toXlsx(headers: string[], rows: unknown[][], sheet = 'Данные'): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers, ...rows]), sheet.slice(0, 31));
  return new Uint8Array(XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer);
}
