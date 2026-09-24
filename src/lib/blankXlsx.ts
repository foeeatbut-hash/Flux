/**
 * Сетка бланка → книга Excel с оформлением.
 *
 * SheetJS, которым программа пишет остальные таблицы, в свободной редакции не
 * сохраняет оформление: бланк вышел бы без рамок, заливок и переноса строк, и
 * заводу ушла бы голая таблица. Поэтому бланк пишется через exceljs — он
 * умеет рамки, объединения, выпадающие списки, картинки, параметры печати и
 * колонтитулы. Грузится лениво: он нужен только в момент выгрузки.
 */
import type { SheetGrid, CellStyle } from '../../catalog/blank/model';
import { toBase64 } from './saveToWindows';
import { ENV_CONFIG } from '../config/env';

/**
 * Готовый файл → Проводник. Ревизия пишется в карточку файла: по ней в
 * Проводнике видно, какой выпуск комплекта лежит, не открывая книгу.
 */
export async function bytesToExplorer(name: string, bytes: Uint8Array, type: 'XLSX' | 'PDF', revision?: string, userId?: string | null): Promise<string | null> {
  const res = await fetch(`${ENV_CONFIG.apiUrl}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, filePath: `/shared/${name}`, size: bytes.length, type, content: toBase64(bytes), createdById: userId || null, ...(revision ? { revision } : {}) }),
  });
  if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
  const d = await res.json().catch(() => ({}));
  return d?.id || d?.file?.id || null;
}

const PAPER: Record<string, number> = { A4: 9, A3: 8 };
const MM_PER_INCH = 25.4;

/** Колонтитул Excel: `&P` — номер страницы, `&N` — число страниц */
const hf = (s: string) => s.replace(/&/g, '&&').replace(/\{page\}/g, '&P').replace(/\{pages\}/g, '&N');

function footerOf(g: SheetGrid, which: 'footer' | 'header'): string {
  const part = g[which];
  const out = [part.left && `&L${hf(part.left)}`, part.center && `&C${hf(part.center)}`, part.right && `&R${hf(part.right)}`].filter(Boolean).join('');
  return out;
}

export async function gridsToXlsx(grids: SheetGrid[]): Promise<Uint8Array> {
  const mod: any = await import('exceljs');
  const ExcelJS = mod.default || mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Flux';
  wb.created = new Date();

  for (const g of grids) {
    const ws = wb.addWorksheet(g.name, {
      pageSetup: {
        paperSize: PAPER[g.page.paper] || 9,
        orientation: g.page.orientation,
        fitToPage: !!g.page.fitWidth,
        fitToWidth: 1,
        fitToHeight: 0,
        horizontalCentered: true,
        margins: {
          top: g.page.margins.top / MM_PER_INCH, bottom: g.page.margins.bottom / MM_PER_INCH,
          left: g.page.margins.left / MM_PER_INCH, right: g.page.margins.right / MM_PER_INCH,
          header: 0.3, footer: 0.3,
        },
        ...(g.printTitleRows ? { printTitlesRow: `1:${g.printTitleRows}` } : {}),
      },
      headerFooter: { oddFooter: footerOf(g, 'footer'), oddHeader: footerOf(g, 'header') },
    });
    ws.columns = g.columns.map((w) => ({ width: w }));
    const font = { name: g.style.font, size: g.style.size };
    const thin = g.style.border === 'none' ? undefined : { style: 'thin', color: { argb: 'FF444444' } };
    const border = thin ? { top: thin, left: thin, bottom: thin, right: thin } : undefined;
    const fill = (hex: string) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${hex}` } });

    const styleOf = (s: CellStyle) => {
      const base: any = { font: { ...font }, alignment: { wrapText: true, vertical: 'top', horizontal: 'left' }, border };
      if (s === 'title') { base.font = { ...font, size: g.style.titleSize, bold: true }; base.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }; }
      if (s === 'head') { base.font = { ...font, bold: true }; base.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }; base.fill = fill(g.style.headFill); }
      if (s === 'section') { base.font = { ...font, bold: true }; base.fill = fill(g.style.headFill); }
      if (s === 'label') { base.font = { ...font, bold: true }; base.fill = fill(g.style.labelFill); }
      if (s === 'cellC' || s === 'unit') base.alignment = { wrapText: true, vertical: 'top', horizontal: 'center' };
      if (s === 'note') base.font = { ...font, italic: true, color: { argb: 'FF555555' } };
      if (s === 'bold') base.font = { ...font, bold: true };
      if (s === 'plain') base.border = undefined;
      return base;
    };

    for (const c of g.cells) {
      const cell = ws.getCell(c.r, c.c);
      cell.value = typeof c.v === 'number' ? c.v : String(c.v ?? '');
      const st = styleOf(c.s);
      cell.font = st.font;
      cell.alignment = st.alignment;
      if (st.fill) cell.fill = st.fill;
      if (st.border) cell.border = st.border;
      if (c.options?.length) {
        // Список в проверке данных Excel — строка через запятую не длиннее 255
        // знаков; длиннее Excel молча выбрасывает при открытии
        const list = c.options.join(',').slice(0, 250);
        cell.dataValidation = { type: 'list', allowBlank: true, formulae: [`"${list.replace(/"/g, '')}"`] };
      }
      if ((c.cs || 1) > 1 || (c.rs || 1) > 1) {
        ws.mergeCells(c.r, c.c, c.r + (c.rs || 1) - 1, c.c + (c.cs || 1) - 1);
        // Рамка объединения — по всем его клеткам, иначе в Excel видна только
        // рамка первой клетки и таблица выглядит «рваной»
        if (st.border) {
          for (let r = c.r; r < c.r + (c.rs || 1); r++) for (let k = c.c; k < c.c + (c.cs || 1); k++) ws.getCell(r, k).border = st.border;
        }
      }
    }
    for (const [r, h] of Object.entries(g.rowHeights)) ws.getRow(Number(r)).height = Math.min(409, h);
    for (const r of g.breaks) ws.getRow(r).addPageBreak();

    for (const im of g.images) {
      const m = /^data:image\/(png|jpe?g|gif);base64,(.+)$/i.exec(im.src);
      if (!m) continue;
      const id = wb.addImage({ base64: m[2], extension: m[1].toLowerCase().replace('jpg', 'jpeg') });
      ws.addImage(id, { tl: { col: im.c - 1 + 0.1, row: im.r - 1 + 0.1 }, br: { col: im.c - 1 + im.cs - 0.1, row: im.r - 1 + im.rs - 0.1 }, editAs: 'oneCell' });
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
