/**
 * Скрытая часть Flux в ZIP-пакете DOCX/XLSX: общая для сервера, окна и
 * оболочки Electron. Здесь только байты и архив, без Buffer и node:, поэтому
 * тот же код переносит часть Flux и на сервере, и в окне Проводника, и в
 * сеансе локальной книги.
 *
 * В XLSX схема лежит в двух местах сразу: в части customXml и на скрытом листе
 * FLUX_SCHEMA. Часть customXml — прежнее место, но внешний редактор (Excel,
 * библиотеки чтения таблиц) вправе выбросить часть, о которой не знает, и тогда
 * файл, вернувшийся во Flux, потерял бы все привязки параметров. Лист — обычное
 * содержимое книги: Excel и библиотеки его сохраняют, а пользователь его не видит
 * (state="veryHidden"). Читаем часть, а если её нет — лист; пишем всегда оба.
 * Ячейки заголовков при этом держатся определёнными именами FLUX_ANCHOR_*,
 * которые Excel сам сдвигает при вставке строк и столбцов.
 */
import JSZip from 'jszip';

export const FLUX_PART = 'customXml/itemFluxOffice.xml';
export const FLUX_PART_MAX_BYTES = 2 * 1024 * 1024;
const ROOT_RELS = '_rels/.rels';
const CONTENT_TYPES = '[Content_Types].xml';
const ROOT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml';

export const FLUX_SHEET = 'FLUX_SCHEMA';
const WORKBOOK = 'xl/workbook.xml';
const WORKBOOK_RELS = 'xl/_rels/workbook.xml.rels';
const SHEET_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const SHEET_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
/** Предел ячейки Excel — 32767 знаков; с запасом на экранирование */
const SHEET_CHUNK = 30000;

const escText = (t: string) => t.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const unescText = (t: string) => t.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'")
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16))).replaceAll('&amp;', '&');
const attrOf = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescText(m[1]) : undefined;
};

/** Листы книги: имя и связь */
function sheetsOf(workbookXml: string): Array<{ name: string; rid: string }> {
  const out: Array<{ name: string; rid: string }> = [];
  for (const m of workbookXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = attrOf(m[0], 'name'), rid = attrOf(m[0], 'r:id');
    if (name !== undefined && rid) out.push({ name, rid });
  }
  return out;
}

/** Часть пакета по связи книги; цель бывает относительной и абсолютной */
function targetOf(rels: string, rid: string): string | null {
  for (const m of rels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    if (attrOf(m[0], 'Id') !== rid) continue;
    const target = attrOf(m[0], 'Target');
    if (!target) return null;
    return target.startsWith('/') ? target.slice(1) : `xl/${target}`.replace(/\/\.\//g, '/');
  }
  return null;
}

const isWorkbook = (zip: JSZip): boolean => !!zip.file(WORKBOOK);

/** Текст схемы со скрытого листа: ячейки столбца A по порядку строк; нет листа — undefined */
export async function readFluxSheet(zip: JSZip): Promise<string | undefined> {
  const workbook = await zip.file(WORKBOOK)?.async('string');
  const rels = await zip.file(WORKBOOK_RELS)?.async('string');
  if (!workbook || !rels) return undefined;
  const sheet = sheetsOf(workbook).find((item) => item.name === FLUX_SHEET);
  const path = sheet && targetOf(rels, sheet.rid);
  const xml = path ? await zip.file(path)?.async('string') : undefined;
  if (xml === undefined) return undefined;
  // Внешний редактор переписывает строки в общую таблицу строк — читаем и её
  const shared: string[] = [];
  const sst = await zip.file('xl/sharedStrings.xml')?.async('string');
  if (sst && /t="s"/.test(xml)) {
    for (const si of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(unescText([...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  }
  const cells: Array<{ row: number; text: string }> = [];
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = /\br="A(\d+)"/.exec(m[1]);
    if (!ref || m[2] === undefined) continue;
    const kind = /\bt="([^"]*)"/.exec(m[1])?.[1];
    let text = '';
    if (kind === 'inlineStr') text = unescText([...m[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
    else if (kind === 's') text = shared[Number(/<v\b[^>]*>(\d+)<\/v>/.exec(m[2])?.[1])] ?? '';
    else text = unescText(/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(m[2])?.[1] ?? '');
    cells.push({ row: Number(ref[1]), text });
  }
  if (!cells.length) return '';
  return cells.sort((a, b) => a.row - b.row).map((c) => c.text).join('');
}

/** Лист схемы целиком: текст порезан на ячейки столбца A */
function fluxSheetXml(xml: string): string {
  const rows: string[] = [];
  for (let at = 0, n = 1; at < xml.length || n === 1; at += SHEET_CHUNK, n++) {
    rows.push(`<row r="${n}"><c r="A${n}" t="inlineStr"><is><t xml:space="preserve">${escText(xml.slice(at, at + SHEET_CHUNK))}</t></is></c></row>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A${rows.length}"/><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

/** Кладёт схему на скрытый лист: заменяет прежний лист или заводит новый */
async function putFluxSheet(zip: JSZip, xml: string): Promise<void> {
  let workbook = await zip.file(WORKBOOK)?.async('string');
  let rels = await zip.file(WORKBOOK_RELS)?.async('string');
  if (!workbook || !rels || !workbook.includes('</sheets>')) return;
  const have = sheetsOf(workbook).find((item) => item.name === FLUX_SHEET);
  const known = have && targetOf(rels, have.rid);
  if (known) { zip.file(known, fluxSheetXml(xml)); return; }
  const ids = [...workbook.matchAll(/<sheet\b[^>]*\bsheetId="(\d+)"/g)].map((m) => Number(m[1]));
  const rids = [...rels.matchAll(/\bId="rId(\d+)"/g)].map((m) => Number(m[1]));
  let n = 1; while (zip.file(`xl/worksheets/sheet${n}.xml`)) n++;
  const rid = `rId${Math.max(0, ...rids) + 1}`;
  const path = `xl/worksheets/sheet${n}.xml`;
  workbook = workbook.replace('</sheets>', `<sheet name="${FLUX_SHEET}" sheetId="${Math.max(0, ...ids) + 1}" state="veryHidden" r:id="${rid}"/></sheets>`);
  if (!/xmlns:r="/.test(workbook)) workbook = workbook.replace(/<workbook\b/, '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
  rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="${SHEET_REL}" Target="worksheets/sheet${n}.xml"/></Relationships>`);
  zip.file(WORKBOOK, workbook);
  zip.file(WORKBOOK_RELS, rels);
  zip.file(path, fluxSheetXml(xml));
  const contentTypes = await zip.file(CONTENT_TYPES)?.async('string');
  if (contentTypes && !contentTypes.includes(`PartName="/${path}"`)) {
    zip.file(CONTENT_TYPES, contentTypes.replace('</Types>', `<Override PartName="/${path}" ContentType="${SHEET_TYPE}"/></Types>`));
  }
}

/**
 * Текст схемы из открытого пакета: часть customXml, а если внешний редактор её
 * выбросил, — скрытый лист. Нет ни того ни другого — undefined.
 */
export async function readFluxXml(zip: JSZip): Promise<string | undefined> {
  const part = await zip.file(FLUX_PART)?.async('string');
  if (part !== undefined) return part;
  const sheet = await readFluxSheet(zip);
  return sheet || undefined;
}

/** Длина текста в UTF-8: так считается предел части, где бы код ни работал. */
export const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/** Имена частей лежат в архиве несжатыми: файлы без схемы не разбираем. */
function mentionsFluxPart(bytes: Uint8Array): boolean {
  const needle = new TextEncoder().encode(FLUX_PART);
  for (let at = bytes.indexOf(needle[0]); at !== -1 && at <= bytes.length - needle.length; at = bytes.indexOf(needle[0], at + 1)) {
    let same = true;
    for (let i = 1; i < needle.length; i++) if (bytes[at + i] !== needle[i]) { same = false; break; }
    if (same) return true;
  }
  return false;
}

/** Кладёт готовый XML части Flux в пакет и при нужде добавляет связь и тип содержимого. */
export async function putFluxPart(bytes: Uint8Array, xml: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  zip.file(FLUX_PART, xml);
  const rels = await zip.file(ROOT_RELS)?.async('string');
  if (!rels) throw new Error('Пакет Office не содержит корневых связей');
  if (!rels.includes(`Target="${FLUX_PART}"`)) {
    const ids = [...rels.matchAll(/\bId="rId(\d+)"/g)].map((m) => Number(m[1]));
    const id = `rId${Math.max(0, ...ids) + 1}`;
    const relation = `<Relationship Id="${id}" Type="${ROOT_REL}" Target="${FLUX_PART}"/>`;
    zip.file(ROOT_RELS, rels.replace('</Relationships>', `${relation}</Relationships>`));
  }
  const contentTypes = await zip.file(CONTENT_TYPES)?.async('string');
  if (!contentTypes) throw new Error('Пакет Office не содержит типов содержимого');
  if (!contentTypes.includes(`PartName="/${FLUX_PART}"`)) {
    zip.file(CONTENT_TYPES, contentTypes.replace('</Types>', `<Override PartName="/${FLUX_PART}" ContentType="application/xml"/></Types>`));
  }
  if (isWorkbook(zip)) await putFluxSheet(zip, xml);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/**
 * Часть Flux принадлежит тому, кто её пишет (сервер или хост панели): редактор
 * открыл пакет до записи схемы и при сохранении вернул бы в файл её старую
 * копию. Поэтому в тело сохранения из редактора переносится та часть, что
 * сейчас в файле, — как есть, без разбора. Нет части в файле, нет пакета или
 * части равны — тело не трогаем (тот же объект, без пережатия архива).
 */
export async function carryFluxPart(current: Uint8Array, incoming: Uint8Array): Promise<Uint8Array> {
  if (!mentionsFluxPart(current)) return incoming;
  try {
    const have = await (await JSZip.loadAsync(current)).file(FLUX_PART)?.async('string');
    if (have === undefined || utf8Length(have) > FLUX_PART_MAX_BYTES) return incoming;
    const incomingZip = await JSZip.loadAsync(incoming);
    const mine = await incomingZip.file(FLUX_PART)?.async('string');
    // Книга: редактор несёт и свою (возможно, старую) копию на скрытом листе
    const sheet = isWorkbook(incomingZip) ? await readFluxSheet(incomingZip) : have;
    if (mine === have && sheet === have) return incoming;
    return await putFluxPart(incoming, have);
  } catch { return incoming; }
}
