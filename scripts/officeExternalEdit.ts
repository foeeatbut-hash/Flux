/**
 * Имитация правки книги во внешнем редакторе (Excel и библиотеки чтения таблиц)
 * для наборов, проверяющих круг «Flux → xlsx → внешняя правка → Flux».
 * Правки идут по XML пакета: именно так Excel меняет книгу, и ничего Flux-ского
 * здесь не используется — вся правка «чужая».
 */
import JSZip from 'jszip';

const SHEET_PART = /^xl\/worksheets\/sheet\d+\.xml$/;

/**
 * Вставка строки над строкой n на листе и в определённых именах, которые на неё
 * ссылаются, — как делает Excel. Лист схемы Flux (скрытый) не трогается.
 */
export async function insertRowAbove(bytes: Buffer, n: number, sheetPart = 'xl/worksheets/sheet1.xml'): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  let xml = await zip.file(sheetPart)!.async('string');
  xml = xml.replace(/<row r="(\d+)"/g, (_m, r) => `<row r="${Number(r) >= n ? Number(r) + 1 : r}"`)
    .replace(/<c r="([A-Z]+)(\d+)"/g, (_m, c, r) => `<c r="${c}${Number(r) >= n ? Number(r) + 1 : r}"`)
    .replace(/<dimension ref="A1:([A-Z]+)(\d+)"\/>/, (_m, c, r) => `<dimension ref="A1:${c}${Number(r) + 1}"/>`);
  zip.file(sheetPart, xml);
  const wb = await zip.file('xl/workbook.xml')!.async('string');
  zip.file('xl/workbook.xml', wb.replace(/(<definedName\b[^>]*>'[^']*'!\$[A-Z]+\$)(\d+)/g, (_m, head, r) => `${head}${Number(r) >= n ? Number(r) + 1 : r}`));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Новый текст в ячейке (строка идёт в ячейку встроенной строкой) */
export async function setCellText(bytes: Buffer, address: string, text: string, sheetPart = 'xl/worksheets/sheet1.xml'): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  let xml = await zip.file(sheetPart)!.async('string');
  const esc = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const cell = new RegExp(`<c r="${address}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
  if (!cell.test(xml)) throw new Error(`в листе нет ячейки ${address}`);
  xml = xml.replace(cell, `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${esc}</t></is></c>`);
  zip.file(sheetPart, xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Excel сохранил книгу: строки листов переписаны в общую таблицу строк, а часть
 * customXml, о которой он не знает, при желании выброшена.
 */
export async function excelSaves(bytes: Buffer, opts: { dropCustomXml: boolean }): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  const old = (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"></sst>';
  let index = (old.match(/<si>/g) || []).length;
  const added: string[] = [];
  for (const name of Object.keys(zip.files).filter((n) => SHEET_PART.test(n))) {
    const xml = await zip.file(name)!.async('string');
    zip.file(name, xml.replace(/<c r="([A-Z]+\d+)"((?: s="\d+")?) t="inlineStr"><is>([\s\S]*?)<\/is><\/c>/g, (_m, ref, style, is) => {
      added.push(`<si>${is.replace(/<t[^>]*>/, '<t xml:space="preserve">')}</si>`);
      return `<c r="${ref}"${style} t="s"><v>${index++}</v></c>`;
    }));
  }
  zip.file('xl/sharedStrings.xml', old.replace('</sst>', `${added.join('')}</sst>`));
  if (!zip.file('xl/sharedStrings.xml')) throw new Error('таблица строк не записана');
  const ct = await zip.file('[Content_Types].xml')!.async('string');
  if (!ct.includes('/xl/sharedStrings.xml')) {
    zip.file('[Content_Types].xml', ct.replace('</Types>', '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'));
    const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
    const ids = [...rels.matchAll(/\bId="rId(\d+)"/g)].map((m) => Number(m[1]));
    zip.file('xl/_rels/workbook.xml.rels', rels.replace('</Relationships>', `<Relationship Id="rId${Math.max(0, ...ids) + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`));
  }
  if (opts.dropCustomXml) {
    zip.remove('customXml/itemFluxOffice.xml');
    const rels = await zip.file('_rels/.rels')!.async('string');
    zip.file('_rels/.rels', rels.replace(/<Relationship\b[^>]*itemFluxOffice\.xml"[^>]*\/>/, ''));
    const types = await zip.file('[Content_Types].xml')!.async('string');
    zip.file('[Content_Types].xml', types.replace(/<Override\b[^>]*itemFluxOffice\.xml"[^>]*\/>/, ''));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
