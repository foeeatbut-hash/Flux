/**
 * Английская версия файла Word и Excel: тексты файла по кусочкам и обратно.
 *
 * Переводит окно — движком Переводчика с памятью и словарём проекта (он живёт
 * в окне, src/store/translateStore.ts). Сервер делает две вещи, для которых
 * окну пришлось бы разбирать OOXML: достаёт из файла то, что надо перевести,
 * и кладёт переводы обратно так, чтобы оформление не сдвинулось.
 *
 * Кусочек перевода:
 *   - Документ — абзац `w:p` тела, колонтитулов и сносок. Прогоны `w:r`
 *     внутри абзаца режут фразу по смене шрифта, и перевод по прогонам давал
 *     бы «слово — слово». Перевод абзаца ложится в первый текстовый прогон (его
 *     оформление остаётся), остальные текстовые прогоны пустеют. Абзац с полем
 *     Word (данные проекта, номер страницы) не трогается целиком: результат
 *     поля — данные, а не текст, и «Обновить поля» переписал бы перевод;
 *   - Таблица — строка ячейки: общая `si` (xl/sharedStrings.xml, так пишет
 *     Excel) или строка прямо в ячейке `is` (inlineStr, так пишут SheetJS и
 *     другие программы). Числа и формулы в строках не живут и не трогаются.
 *     Строка с разным оформлением частей (rich text) после перевода становится
 *     строкой одного вида — по-английски части фразы стоят в другом порядке, и
 *     оформление не с чем сопоставить.
 *
 * Все остальные части файла остаются байт в байт: переписываются только
 * тронутые XML-части.
 */
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { worthTranslating } from '../src/translate/lang.js';

export type FileKind = 'docx' | 'xlsx';
export interface Segment { key: string; text: string }

export const kindOfName = (name: string): FileKind | null =>
  /\.docx$/i.test(name) ? 'docx' : /\.xls[xm]$/i.test(name) ? 'xlsx' : null;

const unesc = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Части Документа, где живёт видимый текст */
const DOCX_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

/** Части Таблицы со строками: общий список и листы (строки прямо в ячейке) */
const XLSX_PART = /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/;

/** Абзацы без вложенных абзацев (надпись внутри абзаца — свой абзац): [начало, конец) */
function leafParagraphs(xml: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const stack: Array<{ at: number; leaf: boolean }> = [];
  for (const m of xml.matchAll(/<w:p\b[^>]*?(\/?)>|<\/w:p>/g)) {
    if (m[0] === '</w:p>') {
      const top = stack.pop();
      if (top && top.leaf) out.push([top.at, m.index! + m[0].length]);
      if (stack.length) stack[stack.length - 1].leaf = false;
    } else if (m[1] !== '/') {
      if (stack.length) stack[stack.length - 1].leaf = false;
      stack.push({ at: m.index!, leaf: true });
    }
  }
  return out;
}

const T_RE = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g;
const hasField = (p: string) => /<w:(fldSimple|fldChar|instrText)\b/.test(p);
const paraText = (p: string) => Array.from(p.matchAll(T_RE), (m) => unesc(m[2])).join('');

/** Текст общей строки: все `t`, кроме фонетических подсказок `rPh` */
const siText = (si: string) => Array.from(si.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g), (m) => unesc(m[1])).join('');

async function eachUnit(bytes: Buffer | Uint8Array, kind: FileKind,
  visit: (part: string, xml: string, units: Array<{ key: string; text: string; start: number; end: number }>) => void): Promise<JSZip> {
  const zip = await JSZip.loadAsync(bytes);
  const parts = Object.keys(zip.files).filter((p) => (kind === 'docx' ? DOCX_PART.test(p) : XLSX_PART.test(p))).sort();
  for (const part of parts) {
    const xml = await zip.file(part)!.async('string');
    const units: Array<{ key: string; text: string; start: number; end: number }> = [];
    if (kind === 'docx') {
      leafParagraphs(xml).forEach(([start, end], i) => {
        const p = xml.slice(start, end);
        if (hasField(p)) return;
        const text = paraText(p);
        if (worthTranslating(text)) units.push({ key: `${part}#${i}`, text, start, end });
      });
    } else if (part === 'xl/sharedStrings.xml') {
      let i = 0;
      for (const m of xml.matchAll(/<si>[\s\S]*?<\/si>|<si\/>/g)) {
        const text = siText(m[0]);
        if (worthTranslating(text)) units.push({ key: `ss#${i}`, text, start: m.index!, end: m.index! + m[0].length });
        i++;
      }
    } else {
      let i = 0;
      // Ячейка-строка: inlineStr (<is>) или t="str" без формулы (<v>, так пишет
      // SheetJS). t="str" с формулой — результат вычисления, его не трогаем
      for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = m[1] || '';
        const inner = m[2] || '';
        let text = '';
        if (/\bt="inlineStr"/.test(attrs)) text = siText(inner);
        else if (/\bt="str"/.test(attrs) && !/<f\b/.test(inner)) text = unesc((/<v>([^<]*)<\/v>/.exec(inner) || [])[1] || '');
        if (text && worthTranslating(text)) units.push({ key: `${part}#c${i}`, text, start: m.index!, end: m.index! + m[0].length });
        i++;
      }
    }
    visit(part, xml, units);
  }
  return zip;
}

/** Что переводить. Отпечаток — от текстов: по нему видно, что оригинал правили после перевода */
export async function listFileSegments(bytes: Buffer | Uint8Array, kind: FileKind): Promise<{ segments: Segment[]; fingerprint: string }> {
  const segments: Segment[] = [];
  await eachUnit(bytes, kind, (_p, _x, units) => { for (const u of units) segments.push({ key: u.key, text: u.text }); });
  const fingerprint = createHash('sha256').update(segments.map((s) => s.text).join('\u0000')).digest('hex').slice(0, 32);
  return { segments, fingerprint };
}

/** Абзац с переводом: текст — в первый `w:t`, остальные `w:t` пустеют, прочее как было */
function translatedParagraph(p: string, text: string): string {
  let first = true;
  return p.replace(T_RE, (_m, attrs: string | undefined) => {
    if (!first) return `<w:t${attrs || ''}></w:t>`;
    first = false;
    const a = /xml:space=/.test(attrs || '') ? attrs : `${attrs || ''} xml:space="preserve"`;
    return `<w:t${a}>${esc(text)}</w:t>`;
  });
}

/** Общая строка или ячейка-строка с переводом; прочие атрибуты ячейки (стиль) — как были */
function translatedCell(unit: string, text: string): string {
  const t = `<t xml:space="preserve">${esc(text)}</t>`;
  if (unit.startsWith('<si')) return `<si>${t}</si>`;
  if (/<is>/.test(unit)) return unit.replace(/<is>[\s\S]*?<\/is>/, `<is>${t}</is>`);
  return unit.replace(/<v>[^<]*<\/v>/, `<v>${esc(text)}</v>`);
}

/** Файл с переводами. Кусочки без перевода остаются как были */
export async function applyFileTranslation(bytes: Buffer | Uint8Array, kind: FileKind, pairs: Record<string, string>): Promise<{ bytes: Buffer; applied: number }> {
  const changed = new Map<string, string>();
  let applied = 0;
  const zip = await eachUnit(bytes, kind, (part, xml, units) => {
    let out = xml;
    let touched = false;
    for (const u of [...units].reverse()) {
      const t = pairs[u.key];
      if (typeof t !== 'string' || !t.trim() || t === u.text) continue;
      const unit = out.slice(u.start, u.end);
      const next = kind === 'docx' ? translatedParagraph(unit, t) : translatedCell(unit, t);
      out = out.slice(0, u.start) + next + out.slice(u.end);
      touched = true;
      applied++;
    }
    if (touched) changed.set(part, out);
  });
  if (!changed.size) return { bytes: Buffer.from(bytes), applied: 0 };
  for (const [part, xml] of changed) zip.file(part, xml);
  const body = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { bytes: body, applied };
}

/** «Смета.xlsx» → «Смета (EN).xlsx» */
export const englishName = (name: string): string => {
  const m = /^(.*?)(\.[^.]+)?$/.exec(name)!;
  return `${m[1]} (EN)${m[2] || ''}`;
};
