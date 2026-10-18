import { fileName as exportFileName, toCsv, toXlsx } from '../../lib/exchange';
import type { OfficeField, OfficeQueryResult } from './fluxData';

/**
 * Таблица из выборки Flux Office: «Вставить все» и выгрузка XLSX / CSV / «Книга
 * Flux». Перенесено из старой панели (FluxPanel.insert и exportRows) с тем же
 * поведением: выбранные строки, иначе все отобранные; не более 500 строк в
 * документ; выгрузка без предела; заголовки — подписи столбцов; значения —
 * строки (пусто вместо null). Чистые функции — их сверяет
 * scripts/test-office-flux-table.ts с результатом старой панели на тех же данных.
 */
export interface TableColumn { key: string; title: string }
export interface TableRow { id: string; cells: string[] }
export type TableCell = string | number;
export type ExportFormat = 'csv' | 'xlsx' | 'office';

/** Сколько строк уходит в документ за одну вставку; остальные — только выгрузкой. */
export const INSERT_LIMIT = 500;

export const SOURCE_TITLES: Record<string, string> = { tags: 'Теги', equipment: 'Оборудование', management: 'Менеджмент', e3: 'E3Flux', e3flux: 'E3Flux' };
export const sourceTitle = (sourceId: string): string => SOURCE_TITLES[sourceId] || 'Данные';

/** Столбцы выгрузки источника: поля каталога в порядке каталога, без повторов. */
export function tableColumns(fields: OfficeField[], sourceId: string): TableColumn[] {
  const seen = new Set<string>();
  const columns: TableColumn[] = [];
  for (const field of fields) {
    if (field.sourceId !== sourceId || seen.has(field.fieldKey)) continue;
    seen.add(field.fieldKey);
    columns.push({ key: field.fieldKey, title: field.displayName });
  }
  return columns;
}

/**
 * Строки выборки как таблица. pickIds — выбранные строки (порядок выборки
 * сохраняется, как у старой панели); пусто — все строки.
 */
export function tableRows(result: OfficeQueryResult, columns: TableColumn[], pickIds: string[] = []): TableRow[] {
  const picked = pickIds.length ? new Set(pickIds) : null;
  return result.rows
    .filter((row) => !picked || picked.has(row.entityId))
    .map((row) => ({ id: row.entityId, cells: columns.map((column) => String(row.values[column.key]?.value ?? '')) }));
}

/** Таблица для вставки в документ: заголовки и не более INSERT_LIMIT строк. */
export function insertTable(columns: TableColumn[], rows: TableRow[], limit = INSERT_LIMIT): { table: TableCell[][]; truncated: boolean } {
  const capped = rows.slice(0, limit);
  return { table: [columns.map((column) => column.title), ...capped.map((row) => row.cells)], truncated: rows.length > limit };
}

export const insertMessage = (inserted: boolean, truncated: boolean): string =>
  inserted ? (truncated ? `Вставлены первые ${INSERT_LIMIT} строк из выбранного набора.` : 'Таблица вставлена.') : 'Редактор не смог вставить таблицу.';

export interface ExportFile {
  headers: string[];
  body: TableCell[][];
  sheetTitle: string;
  /** Имя файла: раздел, дата и расширение (lib/exchange.fileName). */
  name: string;
}

export function exportFile(columns: TableColumn[], rows: TableRow[], title: string, format: ExportFormat, at: Date = new Date()): ExportFile {
  return {
    headers: columns.map((column) => column.title), body: rows.map((row) => row.cells), sheetTitle: title,
    name: exportFileName(title, format === 'csv' ? 'csv' : 'xlsx', at),
  };
}

export const csvText = (file: ExportFile): string => toCsv(file.headers, file.body);
export const xlsxBytes = (file: ExportFile): Promise<Uint8Array> => toXlsx(file.headers, file.body, file.sheetTitle);

export const exportMessage = (format: ExportFormat, count: number): string =>
  `${format === 'csv' ? 'CSV скачан.' : format === 'office' ? 'Книга сохранена в Flux Office.' : 'XLSX скачан.'} · ${count} строк`;
