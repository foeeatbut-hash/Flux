/**
 * Пустые файлы Flux Office: «Создать → Документ / Таблицу» в Проводнике, на
 * столе и в стартовом окне программы кладут настоящий .docx / .xlsx, который
 * сразу открывается редактором и так же открывается в Word и Excel.
 *
 * Документ — один пустой абзац на листе А4 (docxWrite, без чужих
 * библиотек); книга — один лист «Лист1» (SheetJS — та же библиотека, что у
 * выгрузок). Имена по умолчанию — как у Word и Excel.
 */
import { buildDocx } from './docxWrite';

export type BlankKind = 'doc' | 'sheet';

export const BLANK_NAME: Record<BlankKind, string> = {
  doc: 'Новый документ.docx',
  sheet: 'Новая таблица.xlsx',
};

export function blankDocx(): Uint8Array {
  return buildDocx([{ kind: 'para', text: '' }]);
}

export async function blankXlsx(): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Лист1');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

export async function blankBytes(kind: BlankKind): Promise<Uint8Array> {
  return kind === 'doc' ? blankDocx() : blankXlsx();
}
