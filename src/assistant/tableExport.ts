/**
 * Выгрузка ответа помощника: тот же список, но файлом.
 *
 * Отдельно от хранилища разговора по одной причине: библиотека xlsx весит
 * около 900 КБ, а хранилище поднимается при старте программы. Статический
 * импорт держал бы всю библиотеку в стартовом куске ради кнопки, которую
 * нажимают раз в неделю, — поэтому она грузится по требованию.
 *
 * Модуль остаётся без React и без побочных эффектов (правило для src/assistant):
 * здесь только байты и имя, класть файл во Flux и открывать его — дело
 * вызывающего (assistantStore), у него есть навигация.
 */
import type { AssistantTable } from './types';
import { buildDocx, type DocPart } from '../lib/docxWrite';

export interface ExportedTableFile { bytes: Uint8Array; name: string }

export async function exportTableToExcel(table: AssistantTable): Promise<ExportedTableFile> {
  const XLSX = await import('xlsx');
  const aoa = [table.columns, ...table.rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Данные');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return { bytes: new Uint8Array(out), name: `PDM_${ts}.xlsx` };
}

/** Настоящий .docx: раньше сюда уходила HTML-страница под именем .doc, и Word
 * открывал её с предупреждением «формат не соответствует расширению» */
export function exportTableToWord(table: AssistantTable): ExportedTableFile {
  const parts: DocPart[] = [
    { kind: 'head', text: table.title, level: 1 },
    { kind: 'table', rows: [table.columns, ...table.rows.map((r) => r.map((c) => String(c ?? '')))] },
  ];
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return { bytes: buildDocx(parts), name: `PDM_${ts}.docx` };
}
