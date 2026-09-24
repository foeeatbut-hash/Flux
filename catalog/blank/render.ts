/**
 * Отрисовка шаблона бланка в сетку ячеек.
 *
 * Сетка — единственный результат: из неё окно рисует предпросмотр, клиент
 * пишет xlsx и собирает PDF. Поэтому Excel и PDF одного выпуска совпадают по
 * построению, а не по старанию — это то, чего не хватало бланкам E06, где PDF
 * печатался отдельной кнопкой из уже поправленного руками листа.
 */
import type { Block, BlankLang, BlankTemplate, GridCell, GridImage, SheetGrid, SheetTemplate, TableSource, CellStyle } from './model';
import { evalExpr, textIn, type Scope } from './expr';
import type { BlankData, GroupData } from './data';

interface Ctx {
  lang: BlankLang;
  cols: number;
  widths: number[];
  cells: GridCell[];
  images: GridImage[];
  heights: Record<number, number>;
  breaks: number[];
  r: number;
  scopes: Scope[];
  assets: Record<string, string>;
}

/** Подпись с полями: язык выбирается до подстановки, поля — после */
function label(t: { ru: string; en?: string } | undefined, ctx: Ctx, scopes = ctx.scopes): string {
  return String(evalExpr(textIn(t, ctx.lang), scopes, ctx.lang));
}

function put(ctx: Ctx, c: number, span: number, v: string | number, s: CellStyle, block?: string, options?: string[], rs = 1): void {
  const cs = Math.max(1, Math.min(span, ctx.cols - c + 1));
  ctx.cells.push({ r: ctx.r, c, v, s, ...(cs > 1 ? { cs } : {}), ...(rs > 1 ? { rs } : {}), ...(block ? { block } : {}), ...(options?.length ? { options } : {}) });
  fitHeight(ctx, ctx.r, c, cs, String(v ?? ''), s);
}

/**
 * Высота строки по тексту: Excel сам высоту объединённых ячеек не подбирает,
 * и длинное описание в объединении обрезалось бы на печати. Оцениваем по
 * ширине объединения в символах.
 */
function fitHeight(ctx: Ctx, r: number, c: number, cs: number, text: string, s: CellStyle): void {
  let width = 0;
  for (let i = c; i < c + cs && i <= ctx.widths.length; i++) width += ctx.widths[i - 1] || 10;
  const perLine = Math.max(6, Math.floor(width * 1.1));
  const lines = text.split('\n').reduce((n, part) => n + Math.max(1, Math.ceil(part.length / perLine)), 0);
  const base = s === 'title' ? 26 : 15;
  const h = Math.max(base, lines * 14.5);
  ctx.heights[r] = Math.max(ctx.heights[r] || 0, h);
}

function nextRow(ctx: Ctx): void { ctx.r++; }

function sectionTitle(ctx: Ctx, b: Block): void {
  if (!b.title) return;
  put(ctx, 1, ctx.cols, label(b.title, ctx), 'section', b.id);
  nextRow(ctx);
}

function visible(b: Block, ctx: Ctx): boolean {
  if (!b.visibleIf) return true;
  const v = evalExpr(b.visibleIf, ctx.scopes, ctx.lang);
  return !(v === '' || v === 0 || v === 'нет' || v === 'no' || v === 'false');
}

function rowsOf(source: TableSource, ctx: Ctx, group?: GroupData): Scope[] {
  const root = ctx.scopes[ctx.scopes.length - 1] as any;
  switch (source) {
    case 'items': return group?.items || [];
    case 'actuators': return group?.actuators || [];
    case 'heating': return group?.heating || [];
    case 'revisions': return root.revisions || [];
    case 'families': return root.families || [];
  }
}

function renderBlock(b: Block, ctx: Ctx, group?: GroupData): void {
  if (!visible(b, ctx)) return;
  if (b.breakBefore && ctx.r > 1) ctx.breaks.push(ctx.r - 1);
  switch (b.type) {
    case 'title': {
      const logoCols = b.logo ? 2 : 0;
      const logoRightCols = b.logoRight ? 2 : 0;
      const rows = Math.max(1, b.height || 1);
      if (b.logo && ctx.assets[b.logo]) ctx.images.push({ r: ctx.r, c: 1, cs: logoCols, rs: rows, src: ctx.assets[b.logo] });
      if (b.logoRight && ctx.assets[b.logoRight]) ctx.images.push({ r: ctx.r, c: ctx.cols - logoRightCols + 1, cs: logoRightCols, rs: rows, src: ctx.assets[b.logoRight] });
      if (logoCols) put(ctx, 1, logoCols, '', 'plain', b.id, undefined, rows);
      put(ctx, 1 + logoCols, ctx.cols - logoCols - logoRightCols, label(b.text, ctx), 'title', b.id, undefined, rows);
      if (logoRightCols) put(ctx, ctx.cols - logoRightCols + 1, logoRightCols, '', 'plain', b.id, undefined, rows);
      for (let i = 0; i < rows; i++) ctx.heights[ctx.r + i] = Math.max(ctx.heights[ctx.r + i] || 0, rows > 1 ? 20 : 30);
      ctx.r += rows;
      return;
    }
    case 'fields':
    case 'signatures': {
      sectionTitle(ctx, b);
      const ls = b.type === 'fields' ? Math.max(1, b.labelSpan) : 2;
      const vs = b.type === 'fields' ? Math.max(1, b.valueSpan) : 2;
      const per = Math.max(1, Math.floor(ctx.cols / (ls + vs)));
      const pairs = b.type === 'fields' ? b.pairs : b.rows;
      pairs.forEach((p, i) => {
        const slot = i % per;
        const c = 1 + slot * (ls + vs);
        const last = slot === per - 1 || i === pairs.length - 1;
        put(ctx, c, ls, label(p.label, ctx), 'label', b.id);
        const span = last ? ctx.cols - c - ls + 1 : vs;
        put(ctx, c + ls, span, evalExpr(p.value, ctx.scopes, ctx.lang), b.type === 'signatures' ? 'sign' : 'value', b.id);
        if (last) nextRow(ctx);
      });
      return;
    }
    case 'table': {
      sectionTitle(ctx, b);
      const cols = b.columns;
      const spans = fitSpans(cols.map((c) => c.span), ctx.cols);
      let c = 1;
      cols.forEach((col, i) => { put(ctx, c, spans[i], label(col.title, ctx), 'head', b.id); c += spans[i]; });
      nextRow(ctx);
      const rows = rowsOf(b.source, ctx, group);
      if (!rows.length) {
        put(ctx, 1, ctx.cols, label({ ru: b.emptyText || '—', en: b.emptyText || '—' }, ctx), 'note', b.id);
        nextRow(ctx);
        return;
      }
      for (const row of rows) {
        const scopes = [row, ...ctx.scopes];
        let cc = 1;
        cols.forEach((col, i) => {
          const v = evalExpr(col.value, scopes, ctx.lang);
          put(ctx, cc, spans[i], v, col.align === 'left' ? 'cell' : 'cellC', b.id, col.options);
          cc += spans[i];
        });
        nextRow(ctx);
      }
      return;
    }
    case 'specs': {
      sectionTitle(ctx, b);
      const ls = Math.max(1, b.labelSpan);
      const us = Math.max(0, b.unitSpan);
      const vs = Math.max(1, ctx.cols - ls - us);
      for (const row of b.rows) {
        put(ctx, 1, ls, label(row.label, ctx), 'label', b.id);
        const v = evalExpr(row.value, ctx.scopes, ctx.lang);
        put(ctx, 1 + ls, vs, v === '' ? '-' : v, 'value', b.id, row.options);
        if (us) put(ctx, 1 + ls + vs, us, label(row.unit, ctx), 'unit', b.id);
        nextRow(ctx);
      }
      return;
    }
    case 'text': {
      sectionTitle(ctx, b);
      put(ctx, 1, ctx.cols, label(b.text, ctx), b.tone === 'bold' ? 'bold' : b.tone === 'note' ? 'note' : 'plain', b.id);
      nextRow(ctx);
      return;
    }
    case 'spacer': {
      ctx.r += Math.max(1, b.rows || 1);
      return;
    }
  }
}

/** Ширины колонок таблицы в колонках сетки: сумма ровно равна ширине листа */
export function fitSpans(spans: number[], cols: number): number[] {
  const out = spans.map((s) => Math.max(1, Math.round(s || 1)));
  let sum = out.reduce((a, b) => a + b, 0);
  // Лишние колонки срезаем с самых широких, недостающие отдаём последней —
  // так таблица всегда закрывает лист целиком и ничего не вылезает за край
  while (sum > cols) {
    const i = out.indexOf(Math.max(...out));
    if (out[i] <= 1) break;
    out[i]--; sum--;
  }
  if (sum < cols && out.length) out[out.length - 1] += cols - sum;
  return out;
}

function protectPage(expr: string | undefined): string {
  return String(expr ?? '').replace(/\{pages\}/g, '\u0001N').replace(/\{page\}/g, '\u0001P');
}
function restorePage(s: string | number): string {
  return String(s).replace(/\u0001N/g, '{pages}').replace(/\u0001P/g, '{page}');
}

function sheetFor(t: BlankTemplate, sheet: SheetTemplate, scopes: Scope[], lang: BlankLang, group?: GroupData): SheetGrid {
  const ctx: Ctx = {
    lang, cols: t.columns.length, widths: t.columns, cells: [], images: [], heights: {}, breaks: [], r: 1, scopes, assets: t.assets || {},
  };
  for (const b of sheet.blocks) renderBlock(b, ctx, group);
  const f = (e?: string) => restorePage(evalExpr(protectPage(e), scopes, lang));
  const name = String(evalExpr(sheet.name, scopes, lang) || 'Лист').replace(/[\\/?*[\]:]/g, '-').slice(0, 31);
  return {
    name,
    columns: t.columns,
    cells: ctx.cells,
    rowCount: ctx.r - 1,
    rowHeights: ctx.heights,
    breaks: ctx.breaks,
    images: ctx.images,
    printTitleRows: sheet.printTitleRows,
    page: t.page,
    footer: { left: f(t.page.footer.left), center: f(t.page.footer.center), right: f(t.page.footer.right) },
    header: { left: f(t.page.header?.left), center: f(t.page.header?.center), right: f(t.page.header?.right) },
    style: t.style,
  };
}

/** Весь документ: листы шаблона, повторённые по группам позиций */
export function renderBlank(t: BlankTemplate, data: BlankData, lang: BlankLang): SheetGrid[] {
  const out: SheetGrid[] = [];
  for (const sheet of t.sheets) {
    if (sheet.repeat === 'none') {
      out.push(sheetFor(t, sheet, [data.root], lang, data.groups.length === 1 ? data.groups[0] : undefined));
      continue;
    }
    for (const g of data.groups) out.push(sheetFor(t, sheet, [g, data.root], lang, g));
  }
  // Имена листов в книге уникальны — Excel не откроет книгу с двумя «КПУ-1Н»
  const seen = new Map<string, number>();
  for (const s of out) {
    const n = seen.get(s.name) || 0;
    seen.set(s.name, n + 1);
    if (n) s.name = `${s.name.slice(0, 27)} (${n + 1})`;
  }
  return out;
}

/** Все выражения шаблона — для проверки «на что ссылается и чего нет в данных» */
export function exprsOf(t: BlankTemplate): string[] {
  const out: string[] = [];
  const add = (x?: string | { ru: string; en?: string }) => {
    if (!x) return;
    if (typeof x === 'string') out.push(x);
    else { out.push(x.ru); if (x.en) out.push(x.en); }
  };
  for (const s of t.sheets) {
    add(s.name);
    for (const b of s.blocks) {
      add(b.title); add(b.visibleIf);
      if (b.type === 'title' || b.type === 'text') add(b.text);
      if (b.type === 'fields') b.pairs.forEach((p) => { add(p.label); add(p.value); });
      if (b.type === 'signatures') b.rows.forEach((p) => { add(p.label); add(p.value); });
      if (b.type === 'table') b.columns.forEach((c) => { add(c.title); add(c.value); });
      if (b.type === 'specs') b.rows.forEach((r) => { add(r.label); add(r.value); add(r.unit); });
    }
  }
  add(t.page.footer.left); add(t.page.footer.center); add(t.page.footer.right);
  return out;
}
