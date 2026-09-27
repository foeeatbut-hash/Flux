/**
 * Поля и блоки данных проекта в самом файле: найти, заполнить, обновить.
 *
 * Здесь только байты файла — без базы и без редактора. Значения приходят
 * снаружи (server/routes/projectData.ts разрешает ключи), а как ключ записан
 * в файле, решает общий договор office/fieldKeys.ts.
 *
 * Главное правило — правится только то, что внутри якоря:
 *   - Документ: результат поля Word DOCPROPERTY "flux:<ключ>" (текст между
 *     separate и end). Остальной XML части — байт в байт, остальные части
 *     файла не перезаписываются вовсе;
 *   - Таблица: ячейка определённого имени FLUX_<ключ>, диапазон блока
 *     FLUX_BLOCK_<n> и само определение блока в workbook.xml.
 * Иначе «обновить шифр» однажды переложило бы весь документ по-своему — и
 * инженер нашёл бы это только в распечатке.
 *
 * Значение не изменилось — часть не переписывается: файл остаётся тем же
 * байт в байт, и сохранение не плодит пустых версий отката.
 */
import JSZip from 'jszip';
import {
  BLOCK_RE, cellValue, docInstr, keyOfInstr, keyOfSheetName, NAME_MAX, sheetName,
} from '../office/fieldKeys.js';

export type FieldValue = string | number;

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

async function loadZip(bytes: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(bytes);
}

/** Записать только правленые части; ничего не правили — прежние байты */
async function saveZip(bytes: Buffer, zip: JSZip, changed: Map<string, string>): Promise<Buffer> {
  if (!changed.size) return bytes;
  for (const [name, xml] of changed) zip.file(name, xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ════════════════════════════ Документ ════════════════════════════

/** Части с текстом: тело, колонтитулы, сноски */
const DOCX_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

export interface DocxField {
  part: string; key: string; text: string;
  /** Где результат поля в XML части: [начало, конец) */
  from: number; to: number;
  /** Можно ли заменить результат: внутри только прогоны текста */
  plain: boolean;
  /** Формат первого прогона результата — новый текст наследует его */
  rPr: string;
}

/** Текст прогонов фрагмента XML */
const textOf = (xml: string) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => unesc(m[1])).join('');

/** Начало прогона, внутри которого стоит позиция */
function runStart(xml: string, at: number): number {
  const a = xml.lastIndexOf('<w:r>', at);
  const b = xml.lastIndexOf('<w:r ', at);
  return Math.max(a, b);
}
function runEnd(xml: string, at: number): number {
  const e = xml.indexOf('</w:r>', at);
  return e < 0 ? -1 : e + '</w:r>'.length;
}

/**
 * Только прогоны — такой результат можно заменить целиком. Между ними
 * допускаются отметки проверки орфографии (Word ставит их в русский текст
 * сам); закладки, исправления и ссылки внутри результата — нет: их молча
 * выбросила бы замена
 */
const ONLY_RUNS = /^(?:\s*(?:<w:proofErr\b[^>]*\/>|<w:r(?:\s[^>]*)?>(?:(?!<w:r[\s>])[\s\S])*?<\/w:r>))*\s*$/;

/** Поля Flux в одной части документа */
export function docxFieldsIn(part: string, xml: string): DocxField[] {
  const out: DocxField[] = [];
  // Сложные поля: begin … instrText … separate … результат … end.
  // Вложенные поля считаются глубиной; якорь — только поле верхнего уровня
  const tok = /<w:fldChar\b[^>]*w:fldCharType="(begin|separate|end)"[^>]*\/?>|<w:instrText(?:\s[^>]*)?>([^<]*)<\/w:instrText>/g;
  let depth = 0;
  let cur: { instr: string; sepAt: number; nested: boolean } | null = null;
  for (let m: RegExpExecArray | null; (m = tok.exec(xml));) {
    const type = m[1];
    if (!type) { if (cur && depth === 1 && cur.sepAt < 0) cur.instr += unesc(m[2]); continue; }
    if (type === 'begin') {
      depth++;
      if (depth === 1) cur = { instr: '', sepAt: -1, nested: false };
      else if (cur) cur.nested = true;
    } else if (type === 'separate') {
      if (depth === 1 && cur) cur.sepAt = m.index;
    } else {
      if (depth === 1 && cur) {
        const key = keyOfInstr(cur.instr);
        if (key && cur.sepAt >= 0) {
          const from = runEnd(xml, cur.sepAt);
          const to = runStart(xml, m.index);
          if (from > 0 && to >= from) {
            const region = xml.slice(from, to);
            const rPr = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(region)?.[0] || '';
            out.push({ part, key, text: textOf(region), from, to, plain: !cur.nested && ONLY_RUNS.test(region), rPr });
          }
        }
        cur = null;
      }
      depth = Math.max(0, depth - 1);
    }
  }
  // Простые поля: <w:fldSimple w:instr="…">результат</w:fldSimple>
  for (const m of xml.matchAll(/<w:fldSimple\b([^>]*?)(\/?)>/g)) {
    const instr = /\bw:instr="([^"]*)"/.exec(m[1])?.[1];
    const key = instr ? keyOfInstr(unesc(instr)) : null;
    if (!key || m[2] === '/') continue;
    const from = m.index! + m[0].length;
    const to = xml.indexOf('</w:fldSimple>', from);
    if (to < 0) continue;
    const region = xml.slice(from, to);
    const rPr = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(region)?.[0] || '';
    out.push({ part, key, text: textOf(region), from, to, plain: ONLY_RUNS.test(region), rPr });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** Прогон с текстом; пробелы по краям — xml:space, иначе Word их съест */
const runXml = (rPr: string, text: string) => `<w:r>${rPr}<w:t xml:space="preserve">${escText(text)}</w:t></w:r>`;

/** Поле целиком: так же, как его пишет редактор Документа */
export const docxFieldXml = (key: string, text: string, rPr = '') =>
  `<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r>` +
  `<w:r>${rPr}<w:instrText xml:space="preserve"> ${escText(docInstr(key))} </w:instrText></w:r>` +
  `<w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r>` +
  runXml(rPr, text) +
  `<w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`;

export async function listDocxFields(bytes: Buffer): Promise<DocxField[]> {
  const zip = await loadZip(bytes);
  const out: DocxField[] = [];
  for (const name of Object.keys(zip.files)) {
    if (!DOCX_PART.test(name)) continue;
    out.push(...docxFieldsIn(name, await zip.file(name)!.async('string')));
  }
  return out;
}

export interface UpdateReport {
  bytes: Buffer;
  /** Что поменялось: ключ, было, стало */
  changed: { key: string; from: string; to: string; where: string }[];
  /** Что не тронуто и почему */
  skipped: { key: string; why: string; where: string }[];
}

/**
 * Обновить результаты полей Документа. Ключ без значения не трогается:
 * «не знаю» — не повод стирать то, что стоит в документе
 */
export async function updateDocxFields(bytes: Buffer, values: Record<string, FieldValue>): Promise<UpdateReport> {
  const zip = await loadZip(bytes);
  const changedParts = new Map<string, string>();
  const report: UpdateReport = { bytes, changed: [], skipped: [] };
  for (const name of Object.keys(zip.files)) {
    if (!DOCX_PART.test(name)) continue;
    const xml = await zip.file(name)!.async('string');
    const fields = docxFieldsIn(name, xml);
    if (!fields.length) continue;
    let next = '';
    let at = 0;
    for (const f of fields) {
      if (!(f.key in values)) continue;
      const text = String(values[f.key] ?? '');
      if (text === f.text) continue;
      if (!f.plain) { report.skipped.push({ key: f.key, why: 'внутри поля не только текст — не трогаю', where: name }); continue; }
      next += xml.slice(at, f.from) + runXml(f.rPr, text);
      at = f.to;
      report.changed.push({ key: f.key, from: f.text, to: text, where: name });
    }
    if (at) changedParts.set(name, next + xml.slice(at));
  }
  report.bytes = await saveZip(bytes, zip, changedParts);
  return report;
}

/**
 * Метки {{ключ}} в тексте — в поля. Так шаблон, набранный в Word, получает
 * поля Flux без ручной вставки каждого: «Шифр {{project.code}}».
 * Метка должна лежать целиком в одном прогоне (Word так и пишет набранное
 * без правок посередине); разорванную метку не трогаем
 */
export async function fillDocxMarkers(bytes: Buffer, values: Record<string, FieldValue>): Promise<UpdateReport> {
  const zip = await loadZip(bytes);
  const changedParts = new Map<string, string>();
  const report: UpdateReport = { bytes, changed: [], skipped: [] };
  for (const name of Object.keys(zip.files)) {
    if (!DOCX_PART.test(name)) continue;
    const xml = await zip.file(name)!.async('string');
    if (!xml.includes('{{')) continue;
    const next = xml.replace(/<w:r(\s[^>]*)?>((?:(?!<\/w:r>)[\s\S])*?)<\/w:r>/g, (run, _attrs, inner) => {
      const t = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/.exec(inner);
      if (!t || !t[1].includes('{{') || /<w:(tab|br|drawing|fldChar|instrText)\b/.test(inner)) return run;
      const rPr = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(inner)?.[0] || '';
      const text = unesc(t[1]);
      const parts: string[] = [];
      let last = 0;
      let hit = false;
      for (const m of text.matchAll(/\{\{\s*([^{}"\\]+?)\s*\}\}/g)) {
        const key = m[1];
        if (!(key in values)) { report.skipped.push({ key, why: 'нет значения', where: name }); continue; }
        hit = true;
        if (m.index! > last) parts.push(runXml(rPr, text.slice(last, m.index!)));
        parts.push(docxFieldXml(key, String(values[key] ?? ''), rPr));
        report.changed.push({ key, from: m[0], to: String(values[key] ?? ''), where: name });
        last = m.index! + m[0].length;
      }
      if (!hit) return run;
      if (last < text.length) parts.push(runXml(rPr, text.slice(last)));
      return parts.join('');
    });
    if (next !== xml) changedParts.set(name, next);
  }
  report.bytes = await saveZip(bytes, zip, changedParts);
  return report;
}

// ════════════════════════════ Таблица ════════════════════════════

export interface XlsxName { name: string; ref: string; sheet: string; from: string; to: string; localSheetId?: string }

/** Разбор ссылки имени: 'Лист'!$A$1 или 'Лист'!$A$1:$C$5 */
export function parseRef(ref: string): { sheet: string; from: string; to: string } | null {
  const m = /^(?:'((?:[^']|'')+)'|([^!'"]+))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/.exec(ref.trim());
  if (!m) return null;
  const sheet = (m[1] ?? m[2]).replace(/''/g, "'");
  const from = `${m[3]}${m[4]}`;
  return { sheet, from, to: m[5] ? `${m[5]}${m[6]}` : from };
}
const quoteSheet = (s: string) => `'${s.replace(/'/g, "''")}'`;
const absRef = (sheet: string, from: string, to: string) => {
  const abs = (c: string) => c.replace(/^([A-Z]+)(\d+)$/, '$$$1$$$2');
  return `${quoteSheet(sheet)}!${abs(from)}${from === to ? '' : ':' + abs(to)}`;
};

const colNum = (c: string) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n: number) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const splitCell = (ref: string) => { const m = /^([A-Z]+)(\d+)$/.exec(ref)!; return { col: colNum(m[1]), row: Number(m[2]) }; };
const cellRef = (col: number, row: number) => `${colName(col)}${row}`;

interface Book {
  zip: JSZip;
  workbook: string;
  names: XlsxName[];
  /** Имя листа → путь его части */
  sheets: Map<string, string>;
  shared: string[];
}

async function openBook(bytes: Buffer): Promise<Book> {
  const zip = await loadZip(bytes);
  const workbook = await zip.file('xl/workbook.xml')?.async('string');
  if (!workbook) throw new Error('В книге нет xl/workbook.xml — это не файл Excel');
  const rels = (await zip.file('xl/_rels/workbook.xml.rels')?.async('string')) || '';
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[1])?.[1];
    const t = /\bTarget="([^"]*)"/.exec(m[1])?.[1];
    if (id && t) target.set(id, t.startsWith('/') ? t.slice(1) : `xl/${t}`);
  }
  const sheets = new Map<string, string>();
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1])?.[1];
    const rid = /\br:id="([^"]*)"/.exec(m[1])?.[1];
    if (name && rid && target.has(rid)) sheets.set(unesc(name), target.get(rid)!);
  }
  const names: XlsxName[] = [];
  for (const m of workbook.matchAll(/<definedName\b([^>]*)>([^<]*)<\/definedName>/g)) {
    const name = unesc(/\bname="([^"]*)"/.exec(m[1])?.[1] || '');
    const ref = unesc(m[2]);
    const p = parseRef(ref);
    if (!name || !p) continue;
    names.push({ name, ref, ...p, localSheetId: /\blocalSheetId="([^"]*)"/.exec(m[1])?.[1] });
  }
  const sst = (await zip.file('xl/sharedStrings.xml')?.async('string')) || '';
  const shared = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => unesc(t[1])).join(''));
  return { zip, workbook, names, sheets, shared };
}

export interface XlsxAnchors {
  fields: { name: string; key: string; sheet: string; cell: string; text: string }[];
  blocks: { name: string; sheet: string; from: string; to: string }[];
}

export async function listXlsxAnchors(bytes: Buffer): Promise<XlsxAnchors> {
  const book = await openBook(bytes);
  const out: XlsxAnchors = { fields: [], blocks: [] };
  const xmlOf = new Map<string, string>();
  for (const n of book.names) {
    if (BLOCK_RE.test(n.name)) { out.blocks.push({ name: n.name, sheet: n.sheet, from: n.from, to: n.to }); continue; }
    const key = keyOfSheetName(n.name);
    if (!key) continue;
    const path = book.sheets.get(n.sheet);
    let text = '';
    if (path) {
      if (!xmlOf.has(path)) xmlOf.set(path, (await book.zip.file(path)?.async('string')) || '');
      text = cellText(xmlOf.get(path)!, n.from, book.shared);
    }
    out.fields.push({ name: n.name, key, sheet: n.sheet, cell: n.from, text });
  }
  return out;
}

/** Найти элемент ячейки в XML листа */
function findCell(xml: string, ref: string): { at: number; end: number; xml: string } | null {
  const re = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
  const m = re.exec(xml);
  return m ? { at: m.index, end: m.index + m[0].length, xml: m[0] } : null;
}

/** Что показывает ячейка — для сравнения «не изменилось ли» */
function cellText(sheetXml: string, ref: string, shared: string[]): string {
  const c = findCell(sheetXml, ref);
  if (!c) return '';
  const type = /\bt="([^"]*)"/.exec(c.xml.slice(0, c.xml.indexOf('>')))?.[1] || '';
  if (type === 'inlineStr') return [...c.xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => unesc(m[1])).join('');
  const v = /<v>([^<]*)<\/v>/.exec(c.xml)?.[1];
  if (v === undefined) return '';
  if (type === 's') return shared[Number(v)] ?? '';
  return unesc(v);
}

/** Ячейка с новым значением; оформление (s) остаётся прежним */
function cellXml(ref: string, style: string, value: FieldValue | null): string {
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === '') return `<c r="${ref}"${s}/>`;
  const v = cellValue(value);
  if (typeof v === 'number') return `<c r="${ref}"${s}><v>${v}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escText(String(v))}</t></is></c>`;
}

/**
 * Поставить значения в ячейки листа. Трогаются только эти ячейки (и, если
 * ячейки ещё не было, её строка и граница листа <dimension>)
 */
export function setCells(sheetXml: string, cells: Map<string, FieldValue | null>): string {
  let xml = sheetXml;
  const extra: { col: number; row: number; ref: string; value: FieldValue | null }[] = [];
  for (const [ref, value] of cells) {
    const c = findCell(xml, ref);
    if (c) {
      const style = /\bs="(\d+)"/.exec(c.xml.slice(0, c.xml.indexOf('>')))?.[1] || '';
      xml = xml.slice(0, c.at) + cellXml(ref, style, value) + xml.slice(c.end);
    } else if (value !== null && value !== '') {
      extra.push({ ...splitCell(ref), ref, value });
    }
  }
  if (!extra.length) return xml;
  // Недостающие ячейки — в свои строки по порядку столбцов
  if (!/<sheetData\s*\/>/.test(xml) && !/<sheetData[^>]*>/.test(xml)) throw new Error('в листе нет sheetData');
  xml = xml.replace(/<sheetData\s*\/>/, '<sheetData></sheetData>');
  const byRow = new Map<number, typeof extra>();
  for (const e of extra) byRow.set(e.row, [...(byRow.get(e.row) || []), e]);
  for (const [row, list] of [...byRow].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.col - b.col);
    const rowRe = new RegExp(`<row\\b[^>]*\\br="${row}"[^>]*?(?:/>|>([\\s\\S]*?)</row>)`);
    const m = rowRe.exec(xml);
    if (m) {
      const open = m[0].slice(0, m[0].indexOf('>') + 1).replace(/\/>$/, '>');
      let inner = m[1] ?? '';
      for (const e of list) {
        // После последней ячейки левее новой
        let insertAt = 0;
        for (const c of inner.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
          if (colNum(c[1]) < e.col) insertAt = c.index! + c[0].length;
        }
        inner = inner.slice(0, insertAt) + cellXml(e.ref, '', e.value) + inner.slice(insertAt);
      }
      const spans = /\bspans="(\d+):(\d+)"/.exec(open);
      const openFixed = spans
        ? open.replace(spans[0], `spans="${Math.min(Number(spans[1]), list[0].col)}:${Math.max(Number(spans[2]), list[list.length - 1].col)}"`)
        : open;
      xml = xml.slice(0, m.index) + openFixed + inner + '</row>' + xml.slice(m.index + m[0].length);
    } else {
      const rowXml = `<row r="${row}">${list.map((e) => cellXml(e.ref, '', e.value)).join('')}</row>`;
      // Перед первой строкой ниже, иначе — в конец sheetData
      let at = -1;
      for (const r of xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)) { if (Number(r[1]) > row) { at = r.index!; break; } }
      if (at < 0) at = xml.indexOf('</sheetData>');
      xml = xml.slice(0, at) + rowXml + xml.slice(at);
    }
  }
  // Граница листа — чтобы Excel не счёл новые ячейки лишними
  const dim = /<dimension ref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"\s*\/>/.exec(xml);
  if (dim) {
    let c1 = colNum(dim[1]), r1 = Number(dim[2]), c2 = colNum(dim[3] || dim[1]), r2 = Number(dim[4] || dim[2]);
    for (const e of extra) { c1 = Math.min(c1, e.col); r1 = Math.min(r1, e.row); c2 = Math.max(c2, e.col); r2 = Math.max(r2, e.row); }
    xml = xml.replace(dim[0], `<dimension ref="${cellRef(c1, r1)}:${cellRef(c2, r2)}"/>`);
  }
  return xml;
}

/** Обновить ячейки полей книги по ключам */
export async function updateXlsxFields(bytes: Buffer, values: Record<string, FieldValue>): Promise<UpdateReport> {
  const book = await openBook(bytes);
  const report: UpdateReport = { bytes, changed: [], skipped: [] };
  const perSheet = new Map<string, Map<string, FieldValue>>();
  const xmlOf = new Map<string, string>();
  for (const n of book.names) {
    const key = keyOfSheetName(n.name);
    if (!key || !(key in values)) continue;
    const path = book.sheets.get(n.sheet);
    if (!path) { report.skipped.push({ key, why: `нет листа «${n.sheet}»`, where: n.name }); continue; }
    if (!xmlOf.has(path)) xmlOf.set(path, (await book.zip.file(path)?.async('string')) || '');
    const was = cellText(xmlOf.get(path)!, n.from, book.shared);
    const want = values[key];
    if (String(cellValue(want)) === String(cellValue(was))) continue;
    if (!perSheet.has(path)) perSheet.set(path, new Map());
    perSheet.get(path)!.set(n.from, want);
    report.changed.push({ key, from: was, to: String(want), where: `${n.sheet}!${n.from}` });
  }
  const changed = new Map<string, string>();
  for (const [path, cells] of perSheet) changed.set(path, setCells(xmlOf.get(path)!, cells));
  report.bytes = await saveZip(bytes, book.zip, changed);
  return report;
}

/** Заменить текст одного определения имени в workbook.xml; остальное — как было */
function setNameRef(workbook: string, name: string, ref: string): string {
  const re = new RegExp(`(<definedName\\b[^>]*\\bname="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>)[^<]*(</definedName>)`);
  return workbook.replace(re, (_, a, b) => `${a}${escText(ref)}${b}`);
}

/** Добавить имя в workbook.xml */
function addName(workbook: string, name: string, ref: string): string {
  const el = `<definedName name="${escAttr(name)}">${escText(ref)}</definedName>`;
  if (/<definedNames\s*\/>/.test(workbook)) return workbook.replace(/<definedNames\s*\/>/, `<definedNames>${el}</definedNames>`);
  if (workbook.includes('</definedNames>')) return workbook.replace('</definedNames>', `${el}</definedNames>`);
  // Порядок элементов книги задан схемой: имена — после листов и внешних ссылок
  for (const after of ['</externalReferences>', '</functionGroups>', '</sheets>']) {
    const at = workbook.indexOf(after);
    if (at >= 0) return workbook.slice(0, at + after.length) + `<definedNames>${el}</definedNames>` + workbook.slice(at + after.length);
  }
  throw new Error('в книге нет списка листов — некуда добавить имя');
}

/** Вставить поле в ячейку: значение + имя FLUX_<ключ> (второе вхождение — FLUX_<ключ>__2) */
export async function insertXlsxField(bytes: Buffer, sheet: string, cell: string, key: string, value: FieldValue): Promise<{ bytes: Buffer; name: string }> {
  const book = await openBook(bytes);
  const path = book.sheets.get(sheet);
  if (!path) throw new Error(`нет листа «${sheet}»`);
  const taken = new Set(book.names.map((n) => n.name));
  let n = 1;
  while (taken.has(sheetName(key, n))) {
    const same = book.names.find((x) => x.name === sheetName(key, n));
    if (same && same.sheet === sheet && same.from === cell) break;
    n++;
  }
  const name = sheetName(key, n);
  if (name.length > NAME_MAX) throw new Error('ключ поля слишком длинный для имени Excel');
  const changed = new Map<string, string>();
  const sheetXml = (await book.zip.file(path)!.async('string'));
  changed.set(path, setCells(sheetXml, new Map([[cell, value]])));
  if (!taken.has(name)) changed.set('xl/workbook.xml', addName(book.workbook, name, absRef(sheet, cell, cell)));
  return { bytes: await saveZip(bytes, book.zip, changed), name };
}

/**
 * Записать умный блок: строки с верхнего левого угла диапазона FLUX_BLOCK_<n>.
 * Ячейки прежнего диапазона, не вошедшие в новый, очищаются (оформление
 * остаётся), имя растягивается на новый размер. Больше ничего в книге не
 * меняется: ни соседние ячейки, ни другие листы
 */
export async function writeXlsxBlock(bytes: Buffer, name: string, rows: FieldValue[][]): Promise<{ bytes: Buffer; ref: string; cleared: number }> {
  const book = await openBook(bytes);
  const def = book.names.find((n) => n.name === name);
  if (!def) throw new Error(`в книге нет блока ${name}`);
  const path = book.sheets.get(def.sheet);
  if (!path) throw new Error(`нет листа «${def.sheet}»`);
  const top = splitCell(def.from);
  const old = { c2: splitCell(def.to).col, r2: splitCell(def.to).row };
  const width = Math.max(1, ...rows.map((r) => r.length));
  const height = Math.max(1, rows.length);
  const c2 = top.col + width - 1;
  const r2 = top.row + height - 1;
  const cells = new Map<string, FieldValue | null>();
  let cleared = 0;
  for (let r = top.row; r <= Math.max(r2, old.r2); r++) {
    for (let c = top.col; c <= Math.max(c2, old.c2); c++) {
      const inside = r <= r2 && c <= c2;
      const v = inside ? rows[r - top.row]?.[c - top.col] ?? null : null;
      if (!inside) cleared++;
      cells.set(cellRef(c, r), v);
    }
  }
  const sheetXml = await book.zip.file(path)!.async('string');
  const changed = new Map<string, string>();
  const nextSheet = setCells(sheetXml, cells);
  if (nextSheet !== sheetXml) changed.set(path, nextSheet);
  const ref = absRef(def.sheet, def.from, cellRef(c2, r2));
  if (ref !== def.ref) changed.set('xl/workbook.xml', setNameRef(book.workbook, name, ref));
  return { bytes: await saveZip(bytes, book.zip, changed), ref, cleared };
}

/** Завести блок в книге: имя на диапазон с верхнего левого угла и сами строки */
export async function insertXlsxBlock(bytes: Buffer, sheet: string, cell: string, name: string, rows: FieldValue[][]): Promise<Buffer> {
  const book = await openBook(bytes);
  if (!book.sheets.has(sheet)) throw new Error(`нет листа «${sheet}»`);
  if (book.names.some((n) => n.name === name)) throw new Error(`имя ${name} в книге уже есть`);
  const withName = await saveZip(bytes, book.zip, new Map([['xl/workbook.xml', addName(book.workbook, name, absRef(sheet, cell, cell))]]));
  return (await writeXlsxBlock(withName, name, rows)).bytes;
}
