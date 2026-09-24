/**
 * Сетка бланка → HTML: предпросмотр в окне и страница для PDF.
 *
 * Из той же сетки пишется и xlsx (blankXlsx.ts), поэтому то, что видно в
 * предпросмотре, и есть то, что уйдёт в Excel и PDF. Ширины колонок Excel
 * задаются в символах; здесь они переводятся в доли ширины листа, чтобы
 * страница PDF повторяла пропорции книги, а не ширину окна.
 */
import type { SheetGrid, GridCell, CellStyle } from '../../catalog/blank/model';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const CELL_CSS: Record<CellStyle, string> = {
  title: 'font-weight:700;text-align:center;vertical-align:middle;',
  section: 'font-weight:700;text-align:left;',
  label: 'font-weight:600;',
  value: '',
  head: 'font-weight:700;text-align:center;vertical-align:middle;',
  cell: 'text-align:left;',
  cellC: 'text-align:center;',
  unit: 'text-align:center;color:#555;',
  note: 'color:#555;font-style:italic;',
  bold: 'font-weight:700;',
  sign: '',
  plain: '',
};

/** Карта «строка → ячейки» с учётом объединений: какие клетки заняты */
function layout(g: SheetGrid) {
  const byRow = new Map<number, GridCell[]>();
  const covered = new Set<string>();
  for (const c of g.cells) {
    for (let dr = 0; dr < (c.rs || 1); dr++) for (let dc = 0; dc < (c.cs || 1); dc++) if (dr || dc) covered.add(`${c.r + dr}:${c.c + dc}`);
    byRow.set(c.r, [...(byRow.get(c.r) || []), c]);
  }
  return { byRow, covered };
}

export interface HtmlOptions {
  /** Для предпросмотра: подсветить блок и дать щёлкнуть по нему */
  selectedBlock?: string;
  interactive?: boolean;
}

export function sheetHtml(g: SheetGrid, opts: HtmlOptions = {}): string {
  const total = g.columns.reduce((a, b) => a + b, 0) || 1;
  const { byRow, covered } = layout(g);
  const border = g.style.border === 'none' ? 'none' : '0.6pt solid #444';
  const img = new Map(g.images.map((im) => [`${im.r}:${im.c}`, im]));
  const rows: string[] = [];
  for (let r = 1; r <= g.rowCount; r++) {
    const cells = (byRow.get(r) || []).sort((a, b) => a.c - b.c);
    const tds: string[] = [];
    let c = 1;
    while (c <= g.columns.length) {
      if (covered.has(`${r}:${c}`)) { c++; continue; }
      const cell = cells.find((x) => x.c === c);
      if (!cell) { tds.push('<td class="e"></td>'); c++; continue; }
      const fill = cell.s === 'head' || cell.s === 'section' ? `background:#${g.style.headFill};` : cell.s === 'label' ? `background:#${g.style.labelFill};` : '';
      const size = cell.s === 'title' ? `font-size:${g.style.titleSize}pt;` : '';
      const lines = cell.s === 'plain' && cell.v === '' ? 'border:none;' : `border:${border};`;
      const im = img.get(`${r}:${c}`);
      const sel = opts.selectedBlock && cell.block === opts.selectedBlock ? 'outline:2px solid #059669;outline-offset:-2px;' : '';
      const content = im ? `<img src="${im.src}" style="max-height:${14 * (im.rs || 1)}mm;max-width:100%" alt="">` : esc(cell.v).replace(/\n/g, '<br>');
      tds.push(`<td${cell.cs ? ` colspan="${cell.cs}"` : ''}${cell.rs ? ` rowspan="${cell.rs}"` : ''}${opts.interactive && cell.block ? ` data-block="${esc(cell.block)}"` : ''} style="${CELL_CSS[cell.s]}${fill}${size}${lines}${sel}">${content}</td>`);
      c += cell.cs || 1;
    }
    const h = g.rowHeights[r];
    const brk = g.breaks.includes(r - 1) && r > 1 ? ' class="br"' : '';
    rows.push(`<tr${brk}${h ? ` style="height:${Math.round(h * 0.35)}mm"` : ''}>${tds.join('')}</tr>`);
  }
  const cols = g.columns.map((w) => `<col style="width:${((w / total) * 100).toFixed(2)}%">`).join('');
  return `<table class="bl" style="font-family:${esc(g.style.font)},sans-serif;font-size:${g.style.size}pt"><colgroup>${cols}</colgroup><tbody>${rows.join('')}</tbody></table>`;
}

const BASE_CSS = `
  table.bl { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.bl td { padding: 2px 4px; vertical-align: top; word-wrap: break-word; overflow-wrap: anywhere; }
  table.bl td.e { border: none; }
  tr.br { break-before: page; }
`;

/** Страница для печати: листы подряд, каждый с новой страницы */
export function documentHtml(sheets: SheetGrid[], title: string): string {
  const first = sheets[0];
  const size = `${first?.page.paper || 'A4'} ${first?.page.orientation || 'portrait'}`;
  const m = first?.page.margins || { top: 15, bottom: 15, left: 15, right: 10 };
  const body = sheets.map((s, i) => `<section style="${i ? 'break-before:page;' : ''}">${sheetHtml(s)}</section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page { size: ${size}; margin: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm; }
    body { margin: 0; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    ${BASE_CSS}
  </style></head><body>${body}</body></html>`;
}

/** Колонтитул Chromium: номер страницы — его собственные поля pageNumber/totalPages */
export function footerTemplate(g: SheetGrid | undefined): string {
  if (!g) return '<span></span>';
  const part = (s: string) => esc(s).replace(/\{page\}/g, '<span class="pageNumber"></span>').replace(/\{pages\}/g, '<span class="totalPages"></span>');
  return `<div style="font-family:Arial,sans-serif;font-size:7pt;width:100%;display:flex;justify-content:space-between;padding:0 10mm;color:#333">
    <span>${part(g.footer.left)}</span><span>${part(g.footer.center)}</span><span>${part(g.footer.right)}</span></div>`;
}

export const PREVIEW_CSS = BASE_CSS;
