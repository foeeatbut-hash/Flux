/**
 * Значения ячеек книги XLSX по адресам — только чтение сохранённых байтов.
 * Нужно, чтобы сравнить то, что видит человек в файле, с тем, что Flux записал
 * сам (панель изменений и ручные правки), не открывая редактор.
 */
import JSZip from 'jszip';

const unesc = (t: string) => t.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'")
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16))).replaceAll('&amp;', '&');
const attr = (tag: string, name: string) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unesc(m[1]) : undefined; };

/** Путь листа по имени: книга → связь → часть пакета */
async function sheetPath(zip: JSZip, sheetName: string): Promise<string | null> {
  const workbook = await zip.file('xl/workbook.xml')?.async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!workbook || !rels) return null;
  let rid = '';
  for (const m of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) if (attr(m[0], 'name') === sheetName) rid = attr(m[0], 'r:id') || '';
  if (!rid) return null;
  for (const m of rels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    if (attr(m[0], 'Id') !== rid) continue;
    const target = attr(m[0], 'Target') || '';
    return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  }
  return null;
}

/** Текст ячеек листа по адресам; пустых ячеек в ответе нет */
export async function readSheetCells(zip: JSZip, sheetName: string, addresses: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const path = await sheetPath(zip, sheetName);
  const xml = path ? await zip.file(path)?.async('string') : undefined;
  if (!xml || !addresses.length) return out;
  const wanted = new Set(addresses.map((a) => a.toUpperCase()));
  const shared: string[] = [];
  const sst = /t="s"/.test(xml) ? await zip.file('xl/sharedStrings.xml')?.async('string') : undefined;
  if (sst) for (const si of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(unesc([...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = /\br="([A-Z]+\d+)"/.exec(m[1])?.[1];
    if (!ref || !wanted.has(ref) || m[2] === undefined) continue;
    const kind = /\bt="([^"]*)"/.exec(m[1])?.[1];
    let text = '';
    if (kind === 'inlineStr') text = unesc([...m[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
    else if (kind === 's') text = shared[Number(/<v\b[^>]*>(\d+)<\/v>/.exec(m[2])?.[1])] ?? '';
    else text = unesc(/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(m[2])?.[1] ?? '');
    if (text !== '') out.set(ref, text);
  }
  return out;
}
