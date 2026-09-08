/**
 * Текстовый документ → HTML для печати и для выгрузки в Word.
 *
 * Зачем отдельным модулем: это единственное место, где документ превращается в
 * то, что увидит человек на другом компьютере. Раньше сборка лежала внутри
 * экрана редактора, теряла шрифт и выравнивание абзацев, а поля страницы при
 * печати брались свои (15 мм) вместо тех, что заданы документу — на экране
 * одно, на бумаге другое.
 *
 * Про Word. Файл выгружается как HTML с разметкой страницы: Word открывает
 * такой документ как свой, сохраняя шрифты, размеры, начертание, выравнивание
 * и поля листа. Формул в нём нет и быть не может — они живут в программе. На
 * место формулы уходит **значение**, посчитанное на момент выгрузки: получатель
 * в Windows видит готовый текст, а не пустое место и не «ƒ …».
 */

/** Стиль символа в снапшоте Univer */
interface TextStyle {
  ff?: string;              // шрифт
  fs?: number;              // размер, pt
  bl?: number;              // жирный
  it?: number;              // курсив
  ul?: { s?: number };      // подчёркнутый
  st?: { s?: number };      // зачёркнутый
  va?: number;              // 1 — надстрочный, 2 — подстрочный
  cl?: { rgb?: string };    // цвет текста
  bg?: { rgb?: string };    // заливка
}

export interface PageGeometry {
  widthPt: number;
  heightPt: number;
  top: number; right: number; bottom: number; left: number;   // pt
}

/** Лист по умолчанию — как у Word: А4 и поля 2,54 см со всех сторон */
export const DEFAULT_PAGE: PageGeometry = {
  widthPt: 595.3, heightPt: 841.9,
  top: 72, right: 72, bottom: 72, left: 72,
};

const PT_MM = 25.4 / 72;
export const ptToMm = (pt: number) => Math.round(pt * PT_MM * 10) / 10;

export function pageOf(snap: any): PageGeometry {
  const d = snap?.documentStyle || {};
  const num = (v: any, dflt: number) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : dflt);
  return {
    widthPt: num(d.pageSize?.width, DEFAULT_PAGE.widthPt),
    heightPt: num(d.pageSize?.height, DEFAULT_PAGE.heightPt),
    top: num(d.marginTop, DEFAULT_PAGE.top),
    right: num(d.marginRight, DEFAULT_PAGE.right),
    bottom: num(d.marginBottom, DEFAULT_PAGE.bottom),
    left: num(d.marginLeft, DEFAULT_PAGE.left),
  };
}

// ── Разметка страницы: те же наборы, что в Ворде ──
// Значения в пунктах (1 pt = 1/72 дюйма) — так их хранит Univer.
export const PAGE_SIZES: Record<string, { label: string; widthPt: number; heightPt: number }> = {
  A4: { label: 'A4 210 × 297 мм', widthPt: 595.3, heightPt: 841.9 },
  A3: { label: 'A3 297 × 420 мм', widthPt: 841.9, heightPt: 1190.6 },
  A5: { label: 'A5 148 × 210 мм', widthPt: 419.5, heightPt: 595.3 },
  Letter: { label: 'Letter 216 × 279 мм', widthPt: 612, heightPt: 792 },
};

export const MARGIN_PRESETS: Record<string, { label: string; top: number; right: number; bottom: number; left: number }> = {
  // «Обычные» Ворда — 2,54 см со всех сторон
  normal: { label: 'Обычные · 2,54 см', top: 72, right: 72, bottom: 72, left: 72 },
  narrow: { label: 'Узкие · 1,27 см', top: 36, right: 36, bottom: 36, left: 36 },
  moderate: { label: 'Средние · 2,54 / 1,91 см', top: 72, right: 54, bottom: 72, left: 54 },
  wide: { label: 'Широкие · 2,54 / 5,08 см', top: 72, right: 144, bottom: 72, left: 144 },
  // Российский стандарт для пояснительных записок (ГОСТ 2.105: слева 20, справа 10)
  gost: { label: 'ГОСТ · слева 3 см, справа 1,5 см', top: 57, right: 43, bottom: 57, left: 85 },
};

export interface PageSetup {
  size: keyof typeof PAGE_SIZES | string;
  orientation: 'portrait' | 'landscape';
  margins: { top: number; right: number; bottom: number; left: number };
}

/** Текущая разметка страницы документа — для окна «Разметка страницы» */
export function readPageSetup(snap: any): PageSetup {
  const g = pageOf(snap);
  const landscape = g.widthPt > g.heightPt;
  const long = Math.max(g.widthPt, g.heightPt);
  const short = Math.min(g.widthPt, g.heightPt);
  // Формат ищем с допуском: Univer хранит дробные пункты (841.9 против 841.98)
  const size = Object.keys(PAGE_SIZES).find((k) => {
    const s = PAGE_SIZES[k];
    return Math.abs(Math.max(s.widthPt, s.heightPt) - long) < 3 && Math.abs(Math.min(s.widthPt, s.heightPt) - short) < 3;
  }) || 'A4';
  return {
    size,
    orientation: landscape ? 'landscape' : 'portrait',
    margins: { top: g.top, right: g.right, bottom: g.bottom, left: g.left },
  };
}

// Числа вместо enum из @univerjs/core: модуль остаётся без зависимостей, его
// целиком закрывают проверки. documentFlavor: 1 — TRADITIONAL, разбивка на
// страницы как в Ворде (2 — MODERN, бесконечная лента без страниц).
export const FLAVOR_WORD = 1;
const ORIENT = { portrait: 0, landscape: 1 };
/** Отступ до колонтитула — 1,25 см, как в Ворде */
export const MARGIN_HEADER_PT = 35.4;

/** Новый documentStyle по выбору пользователя. Сам снапшот не меняем — возвращаем копию. */
export function applyPageSetup(snap: any, setup: PageSetup): any {
  const s = PAGE_SIZES[setup.size] || PAGE_SIZES.A4;
  const landscape = setup.orientation === 'landscape';
  const width = landscape ? Math.max(s.widthPt, s.heightPt) : Math.min(s.widthPt, s.heightPt);
  const height = landscape ? Math.min(s.widthPt, s.heightPt) : Math.max(s.widthPt, s.heightPt);
  const m = setup.margins;
  const prev = snap?.documentStyle || {};
  return {
    ...snap,
    documentStyle: {
      ...prev,
      documentFlavor: FLAVOR_WORD,
      pageSize: { width, height },
      // Ориентацию движок держит отдельным полем: без него поворачивается лист,
      // но не колонтитулы и разбивка
      pageOrient: landscape ? ORIENT.landscape : ORIENT.portrait,
      marginTop: m.top, marginRight: m.right, marginBottom: m.bottom, marginLeft: m.left,
      marginHeader: prev.marginHeader ?? MARGIN_HEADER_PT,
      marginFooter: prev.marginFooter ?? MARGIN_HEADER_PT,
    },
  };
}

const esc = (x: string) =>
  String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Стиль символа → CSS. Шрифт раньше терялся — из-за этого документ в Word
 *  приходил другим шрифтом, хотя в программе был выбран нужный. */
export function runCss(ts: TextStyle | null | undefined): string {
  if (!ts) return '';
  const css: string[] = [];
  if (ts.ff) css.push(`font-family:'${String(ts.ff).replace(/'/g, '')}'`);
  if (ts.fs) css.push(`font-size:${ts.fs}pt`);
  if (ts.bl === 1) css.push('font-weight:bold');
  if (ts.it === 1) css.push('font-style:italic');
  const deco: string[] = [];
  if (ts.ul?.s === 1) deco.push('underline');
  if (ts.st?.s === 1) deco.push('line-through');
  if (deco.length) css.push(`text-decoration:${deco.join(' ')}`);
  if (ts.va === 1) css.push('vertical-align:super;font-size:smaller');
  if (ts.va === 2) css.push('vertical-align:sub;font-size:smaller');
  if (ts.cl?.rgb) css.push(`color:${ts.cl.rgb}`);
  if (ts.bg?.rgb) css.push(`background:${ts.bg.rgb}`);
  return css.join(';');
}

const ALIGN: Record<number, string> = { 0: 'left', 1: 'center', 2: 'right', 3: 'justify' };

/** Выравнивание абзаца по его началу. Раньше терялось совсем: всё уходило влево. */
export function paraCss(p: any): string {
  const st = p?.paragraphStyle || {};
  const css: string[] = [];
  const a = ALIGN[st.horizontalAlign as number];
  if (a && a !== 'left') css.push(`text-align:${a}`);
  if (st.lineSpacing) css.push(`line-height:${st.lineSpacing}`);
  if (st.indentFirstLine?.v) css.push(`text-indent:${st.indentFirstLine.v}pt`);
  if (st.indentStart?.v) css.push(`margin-left:${st.indentStart.v}pt`);
  if (st.spaceAbove?.v) css.push(`margin-top:${st.spaceAbove.v}pt`);
  if (st.spaceBelow?.v) css.push(`margin-bottom:${st.spaceBelow.v}pt`);
  return css.join(';');
}

/** Абзацы документа с готовой разметкой символов */
export function bodyToHtml(snap: any): string {
  const body = snap?.body || {};
  const ds: string = typeof body.dataStream === 'string' ? body.dataStream : '';
  const runs: any[] = Array.isArray(body.textRuns) ? body.textRuns : [];
  const paras: any[] = Array.isArray(body.paragraphs) ? body.paragraphs : [];

  const styleAt = (i: number) => runs.find((r) => i >= r.st && i < r.ed)?.ts || null;
  const paraAt = (endIndex: number) => paras.find((p) => p.startIndex === endIndex) || null;

  let html = '';
  let para = '';
  let curCss: string | null = null;
  let openSpan = false;

  const closeRun = () => { if (openSpan) { para += '</span>'; openSpan = false; } };
  const pushPara = (endIndex: number) => {
    closeRun();
    const css = paraCss(paraAt(endIndex));
    html += `<p${css ? ` style="${css}"` : ''}>${para || '&nbsp;'}</p>`;
    para = '';
    curCss = null;
  };

  for (let i = 0; i < ds.length; i++) {
    const ch = ds[i];
    if (ch === '\r') { pushPara(i); continue; }   // конец абзаца
    if (ch === '\n') continue;                     // конец секции
    if (ch.charCodeAt(0) < 32) continue;           // служебные маркеры
    const css = runCss(styleAt(i));
    if (css !== curCss) {
      closeRun();
      curCss = css;
      if (css) { para += `<span style="${css}">`; openSpan = true; }
    }
    para += esc(ch);
  }
  if (para) pushPara(ds.length);
  return html;
}

interface DocMeta {
  title: string;
  subtitle?: string;
  /** Готовый HTML титульного листа — уже со значениями формул */
  titlePageHtml?: string;
}

/**
 * Готовый документ для печати и для Word.
 *
 * @param forWord добавить разметку, по которой Word открывает файл как документ
 *                со своими полями и размером листа
 */
export function buildDocHtml(snap: any, meta: DocMeta, forWord = false): string {
  const g = pageOf(snap);
  // Шрифт документа по умолчанию — тем текстом, у которого свой стиль не задан.
  // Берём из самого документа, а не подставляем один на всех.
  const dts: TextStyle = snap?.documentStyle?.textStyle || {};
  const baseFf = dts.ff ? `'${String(dts.ff).replace(/'/g, '')}', serif` : `'Times New Roman', serif`;
  const baseFs = typeof dts.fs === 'number' && dts.fs > 0 ? dts.fs : 12;
  const page = `size:${ptToMm(g.widthPt)}mm ${ptToMm(g.heightPt)}mm; margin:${ptToMm(g.top)}mm ${ptToMm(g.right)}mm ${ptToMm(g.bottom)}mm ${ptToMm(g.left)}mm`;

  // Word читает эти объявления и ставит те же поля, что в программе. Без них
  // он подставляет свои 2,54 см, и документ на бумаге расходится с экраном.
  const wordHead = forWord ? `
  <xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml>
  <style>@page WordSection1 { ${page}; } div.WordSection1 { page:WordSection1; }</style>` : '';

  // Метка разрыва нужна только файлу для Word: в печати разрыв делает CSS
  // `page-break-after`, а в docx никакого CSS нет, и титул с первой строкой
  // записки оказывались на одном листе
  const wordBreak = forWord ? '<div data-page-break="1"></div>' : '';
  const titleBlock = meta.titlePageHtml
    ? `<div style="page-break-after:always">${meta.titlePageHtml}</div>${wordBreak}`
    : `<h1 style="font-size:16pt;margin:0 0 2pt">${esc(meta.title)}</h1>` +
      (meta.subtitle ? `<div style="font-size:9pt;color:#64748b;margin-bottom:10pt">${esc(meta.subtitle)}</div>` : '');

  // Пространства имён и обёртка WordSection1 нужны только файлу для Word.
  // В окне печати они лишние — там это обычная страница браузера.
  const htmlTag = forWord
    ? '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">'
    : '<html>';
  const openWrap = forWord ? '<div class="WordSection1">' : '<div>';

  return `<!doctype html>
${htmlTag}
<head><meta charset="utf-8"><title>${esc(meta.title)}</title>${wordHead}
<style>
  body { font-family: ${baseFf}; font-size: ${baseFs}pt; line-height: 1.15; color: #000; }
  p { margin: 0 0 8pt; }
  table { border-collapse: collapse; }
  td, th { border: 0.5pt solid #000; padding: 3pt 5pt; }
  @page { ${page} }
</style></head>
<body>${openWrap}
${titleBlock}
${bodyToHtml(snap)}
</div></body></html>`;
}

/**
 * Шрифты в списке редактора.
 *
 * Свой список нужен потому, что встроенный у Univer — четыре латинских шрифта и
 * девять китайских: в русском КБ выбрать нечего. Здесь то, что действительно
 * стоит в Windows и в Ворде, плюс чертёжные шрифты по ГОСТ.
 *
 * label без точек: Univer прогоняет его через переводчик, а тот при отсутствии
 * ключа возвращает саму строку — получаем читаемое название.
 */
export const DOC_FONTS: { value: string; label: string; category?: 'sans-serif' | 'serif' | 'monospace' }[] = [
  { value: 'Times New Roman', label: 'Times New Roman', category: 'serif' },
  { value: 'Calibri', label: 'Calibri', category: 'sans-serif' },
  { value: 'Arial', label: 'Arial', category: 'sans-serif' },
  { value: 'Cambria', label: 'Cambria', category: 'serif' },
  { value: 'Georgia', label: 'Georgia', category: 'serif' },
  { value: 'Verdana', label: 'Verdana', category: 'sans-serif' },
  { value: 'Tahoma', label: 'Tahoma', category: 'sans-serif' },
  { value: 'Segoe UI', label: 'Segoe UI', category: 'sans-serif' },
  { value: 'Courier New', label: 'Courier New', category: 'monospace' },
  { value: 'Consolas', label: 'Consolas', category: 'monospace' },
  { value: 'ISOCPEUR', label: 'ISOCPEUR (чертёжный)', category: 'sans-serif' },
  { value: 'GOST type A', label: 'GOST type A (чертёжный)', category: 'sans-serif' },
  { value: 'GOST type B', label: 'GOST type B (чертёжный)', category: 'sans-serif' },
  { value: 'PT Sans', label: 'PT Sans', category: 'sans-serif' },
  { value: 'PT Serif', label: 'PT Serif', category: 'serif' },
];

/** Имя файла: без символов, запрещённых в Windows */
export function safeFileName(title: string, ext: string): string {
  const clean = String(title || 'Документ').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 80);
  return `${clean || 'Документ'}.${ext}`;
}
