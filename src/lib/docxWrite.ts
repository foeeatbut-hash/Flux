/**
 * Настоящий документ Word из документа Flux.
 *
 * Выгрузка «в Word» до этого отдавала HTML с расширением `.doc`. Word такой
 * файл открывает, но с предупреждением «формат не соответствует расширению», и
 * человек, который просто хотел отправить документ заказчику, каждый раз
 * объяснял получателю, что это нормально. Это не выгрузка в Word — это
 * страница, притворяющаяся документом.
 *
 * Здесь собирается настоящий `.docx`: zip (src/lib/zipWrite.ts) с четырьмя
 * файлами внутри — ровно тот минимум, который Word считает документом.
 * Сохраняются абзацы, заголовки и таблицы; сложное оформление не переносится, и
 * об этом человеку сказано при открытии, а не после отправки.
 */
import { zip } from './zipWrite';

/** Кусок документа: абзац, заголовок, таблица, картинка или разрыв страницы */
export type DocPart =
  | { kind: 'para'; text: string }
  | { kind: 'head'; text: string; level?: number }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'image'; data: Uint8Array; ext: 'png' | 'jpeg'; widthMm: number; heightMm: number }
  | { kind: 'break' };

/**
 * Лист документа: размер и поля в миллиметрах.
 *
 * Без него выгрузка всегда отдавала A4 книжной с полями по 2 см — что бы
 * человек ни выставил в «Параметрах листа». Альбомный лист и поля по ГОСТ
 * оставались на экране и не доезжали до получателя.
 */
export interface DocPage {
  widthMm: number;
  heightMm: number;
  topMm: number;
  rightMm: number;
  bottomMm: number;
  leftMm: number;
}

/** Миллиметры в двадцатые доли пункта — мера, в которой Word держит размеры */
const tw = (mm: number) => Math.round((Number(mm) || 0) * 56.6929);

/** A4 книжной с полями по 2 см — то, что было зашито намертво */
export const DEFAULT_DOC_PAGE: DocPage = {
  widthMm: 210, heightMm: 297, topMm: 20, rightMm: 20, bottomMm: 20, leftMm: 20,
};

/** В XML нельзя класть сырой текст: пять символов имеют своё значение */
export function xmlEscape(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Абзац: перевод строки внутри текста остаётся переводом строки, а не пропадает */
function paraXml(text: string, style?: string): string {
  const runs = String(text ?? '').split('\n').map((line, i) =>
    `${i ? '<w:r><w:br/></w:r>' : ''}<w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r>`).join('');
  const props = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${props}${runs}</w:p>`;
}

function tableXml(rows: string[][]): string {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  // Ширина колонок одинаковая: ширина листа за вычетом полей, поделённая поровну
  const width = Math.floor(9360 / cols);
  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`;
  const borders = '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="999999"/>`).join('')
    + '</w:tblBorders>';
  const body = rows.map((row) => {
    const cells = Array.from({ length: cols }, (_, i) =>
      `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${paraXml(row[i] ?? '')}</w:tc>`).join('');
    return `<w:tr>${cells}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>${grid}${body}</w:tbl>`;
}

/** Разрыв страницы: им титульный лист отделяется от текста */
const BREAK_XML = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

/**
 * Картинка внутри абзаца.
 *
 * Мера здесь третья по счёту: Word держит размеры картинки в EMU —
 * 360 000 на миллиметр. Ошибка в мере даёт подпись во весь лист или точку.
 */
function imageXml(id: number, widthMm: number, heightMm: number): string {
  const cx = Math.max(1, Math.round(widthMm * 36000));
  const cy = Math.max(1, Math.round(heightMm * 36000));
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  return '<w:p><w:r><w:drawing>'
    + `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Рисунок ${id}"/>`
    + `<a:graphic xmlns:a="${A}"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="Рисунок ${id}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdImg${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
}

function bodyXml(parts: DocPart[], page: DocPage): string {
  let img = 0;
  const out = parts.map((p) => {
    if (p.kind === 'table') return tableXml(p.rows);
    if (p.kind === 'head') return paraXml(p.text, `Heading${Math.min(3, Math.max(1, p.level || 1))}`);
    if (p.kind === 'break') return BREAK_XML;
    if (p.kind === 'image') return imageXml(++img, p.widthMm, p.heightMm);
    return paraXml(p.text);
  }).join('');
  // Word требует раздел в конце тела: без него документ считается испорченным.
  // Размер листа и поля — те, что человек выставил в «Параметрах листа»
  const landscape = page.widthMm > page.heightMm ? ' w:orient="landscape"' : '';
  const section = `<w:sectPr><w:pgSz w:w="${tw(page.widthMm)}" w:h="${tw(page.heightMm)}"${landscape}/>`
    + `<w:pgMar w:top="${tw(page.topMm)}" w:right="${tw(page.rightMm)}" w:bottom="${tw(page.bottomMm)}"`
    + ` w:left="${tw(page.leftMm)}" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<w:document xmlns:w="${W}"><w:body>${out}${section}</w:body></w:document>`;
}

const contentTypes = (exts: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  // Тип картинки объявляется здесь: без объявления Word считает архив
  // испорченным целиком, а не просто пропускает рисунок
  + exts.map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join('')
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '</Types>';

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '</Relationships>';

const docRels = (exts: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + exts.map((ext, i) => `<Relationship Id="rIdImg${i + 1}" `
    + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
    + `Target="media/img${i + 1}.${ext}"/>`).join('')
  + '</Relationships>';

/** Три заголовка и обычный текст: больше нашим документам и не нужно */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
  + `<w:styles xmlns:w="${W}">`
  + '<w:docDefaults><w:rPrDefault><w:rPr>'
  + '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/>'
  + '</w:rPr></w:rPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + [1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}">`
    + `<w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/>`
    + `<w:pPr><w:outlineLvl w:val="${n - 1}"/><w:spacing w:before="240" w:after="120"/></w:pPr>`
    + `<w:rPr><w:b/><w:sz w:val="${32 - (n - 1) * 4}"/></w:rPr></w:style>`).join('')
  + '</w:styles>';

/** Документ Word целиком, готовый лечь на диск */
export function buildDocx(parts: DocPart[], page: DocPage = DEFAULT_DOC_PAGE): Uint8Array {
  const images = parts.filter((p): p is Extract<DocPart, { kind: 'image' }> => p.kind === 'image');
  return zip([
    // Порядок не случаен: список типов должен идти первым — так делают все,
    // кто пишет docx, и так его быстрее находят читатели попроще
    { name: '[Content_Types].xml', data: contentTypes([...new Set(images.map((i) => i.ext))]) },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: bodyXml(parts, page) },
    { name: 'word/_rels/document.xml.rels', data: docRels(images.map((i) => i.ext)) },
    { name: 'word/styles.xml', data: STYLES },
    ...images.map((img, i) => ({ name: `word/media/img${i + 1}.${img.ext}`, data: img.data })),
  ]);
}

/**
 * Разметка документа Flux → куски для Word.
 *
 * Заголовки узнаются по тегам и остаются заголовками — в Word это оглавление и
 * навигация, а не просто крупный шрифт. Разбор таблиц не повторяется: он уже
 * написан там, где программа читает чужие документы (src/import/extractors),
 * и второй такой же разбор однажды разошёлся бы с первым.
 */
export function partsFromHtml(html: string, tableRows: (fragment: string) => string[][]): DocPart[] {
  const parts: DocPart[] = [];
  let rest = stripHead(String(html || ''));
  // Таблицы и картинки вырезаются одним проходом: разрежь их по очереди — и
  // картинка внутри таблицы уехала бы из документа в его начало
  const blockRe = /<table[\s\S]*?<\/table>|<img\b[^>]*>/i;
  while (true) {
    const m = blockRe.exec(rest);
    if (!m) break;
    pushHtmlParas(rest.slice(0, m.index), parts);
    if (m[0][1] === 'i' || m[0][1] === 'I') {
      const img = imagePart(m[0]);
      if (img) parts.push(img);
    } else {
      const rows = tableRows(m[0]);
      if (rows.length) parts.push({ kind: 'table', rows });
    }
    rest = rest.slice(m.index + m[0].length);
  }
  pushHtmlParas(rest, parts);
  return parts;
}

/**
 * Голова страницы и таблицы стилей — вон.
 *
 * Разрез по тегам сам по себе оставляет СОДЕРЖИМОЕ `<style>`: теги пропадают,
 * а правила остаются текстом. В выгруженный документ уезжала страница CSS
 * перед первой строкой — и это видел не мы, а получатель.
 */
function stripHead(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<xml[\s\S]*?<\/xml>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/** Разбор base64 без Buffer: та же работа и в окне, и в проверках */
function fromBase64(b64: string): Uint8Array {
  const bin = typeof atob === 'function'
    ? atob(b64)
    : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * `<img src="data:image/png;base64,…">` → рисунок документа.
 *
 * Раньше картинку съедал разрез по тегам, и подпись в полях «Разработал —
 * Проверил — Утвердил» пропадала ровно там, где она и нужна: в файле,
 * отправленном заказчику.
 */
function imagePart(tag: string): DocPart | null {
  const src = /src="data:image\/(png|jpe?g);base64,([^"]+)"/i.exec(tag);
  if (!src) return null;
  const mm = (name: string, fallback: number) => {
    const v = new RegExp(`${name}\\s*:\\s*([\\d.]+)mm`, 'i').exec(tag);
    return v ? Number(v[1]) : fallback;
  };
  const heightMm = mm('height', 10);
  return {
    kind: 'image',
    data: fromBase64(src[2].replace(/\s+/g, '')),
    ext: src[1].toLowerCase() === 'png' ? 'png' : 'jpeg',
    // Ширина у подписи задаётся редко: держим пропорцию расписки — вчетверо
    // шире высоты, иначе Word растянет её в квадрат
    widthMm: mm('width', heightMm * 4),
    heightMm,
  };
}

function pushHtmlParas(html: string, parts: DocPart[]): void {
  // Разрез по закрывающим тегам абзацев: то же правило, что у разбора чужих
  // документов, — иначе один и тот же документ разбирался бы по-разному
  for (const piece of String(html).split(/<\/(?:p|h[1-6]|li|div)>/i)) {
    // Титульный лист отделён от текста разрывом страницы. Без него титул и
    // первая строка записки оказывались на одном листе. Метку ставит сборка
    // документа для Word (src/lib/docExport.ts): в печати разрыв делает CSS,
    // а CSS в docx не доезжает
    if (/data-page-break/i.test(piece)) parts.push({ kind: 'break' });
    const head = /<h([1-6])[^>]*>/i.exec(piece);
    const text = piece
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (!text) continue;
    if (head) parts.push({ kind: 'head', text, level: Number(head[1]) });
    else parts.push({ kind: 'para', text });
  }
}

/**
 * Текст документа Flux → куски для Word.
 *
 * Текстовый документ хранится строками; таблицы в нём — строки с табуляцией
 * (так их кладёт разбор Word при открытии). Обратное превращение узнаёт их по
 * той же примете, чтобы таблица, пришедшая из Word, вернулась в Word таблицей.
 */
export function partsFromText(text: string): DocPart[] {
  const parts: DocPart[] = [];
  let table: string[][] = [];
  const flush = () => {
    if (table.length) { parts.push({ kind: 'table', rows: table }); table = []; }
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.includes('\t')) { table.push(line.split('\t')); continue; }
    flush();
    if (!line.trim()) { parts.push({ kind: 'para', text: '' }); continue; }
    parts.push({ kind: 'para', text: line });
  }
  flush();
  return parts;
}
