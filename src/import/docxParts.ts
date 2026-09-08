/**
 * Части документа Word, которых не отдаёт mammoth.
 *
 * Из-за них ворды и открывались пустыми. Библиотека разбора отдаёт только
 * основной поток документа — а в бланках по ГОСТ, в опросных листах и в
 * заданиях половина содержимого лежит НЕ там: в колонтитуле (штамп, шифр,
 * лист), в надписи поверх страницы (`w:txbxContent`) и в сносках. Человек
 * видел пустой документ и решал, что программа не умеет читать Word.
 *
 * Читаем сами: docx — это обычный zip. Разжимаем встроенным
 * `DecompressionStream('deflate-raw')` — он есть и в браузере, и в Node 18,
 * — так что чужой библиотеки для этого не нужно.
 *
 * Здесь только разбор: ни React, ни сети, ни хранилищ (см. flux-architecture).
 */

/** Один файл внутри архива: имя и байты */
export type ZipFiles = Map<string, Uint8Array>;

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as any).DecompressionStream;
  if (!DS) throw new Error('в этой среде нет разжатия zip');
  const stream = new Blob([data as any]).stream().pipeThrough(new DS('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Разобрать zip по ЦЕНТРАЛЬНОМУ КАТАЛОГУ, а не по потоку заголовков.
 *
 * Разница существенная: у записи в потоке размеры бывают нулевыми (данные
 * идут с «дескриптором» после содержимого), и разбор по потоку на таких
 * файлах молча читает пустоту. В каталоге размеры есть всегда — он затем и
 * нужен.
 */
export async function unzip(buf: ArrayBuffer | Uint8Array): Promise<ZipFiles> {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const out: ZipFiles = new Map();

  // Хвост архива: подпись конца каталога. Ищем с конца — за ней может быть
  // комментарий длиной до 64 КБ
  let end = -1;
  for (let i = b.length - 22; i >= 0 && i > b.length - 22 - 65536; i--) {
    if (u32(b, i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return out;

  const count = u16(b, end + 10);
  let at = u32(b, end + 16);
  for (let n = 0; n < count && at + 46 <= b.length; n++) {
    if (u32(b, at) !== 0x02014b50) break;
    const method = u16(b, at + 10);
    const compressed = u32(b, at + 20);
    const nameLen = u16(b, at + 28);
    const extraLen = u16(b, at + 30);
    const commentLen = u16(b, at + 32);
    const localAt = u32(b, at + 42);
    const name = new TextDecoder('utf-8').decode(b.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;

    // У локальной записи своя длина полей: размеры берём из каталога, а
    // начало данных считаем по её заголовку
    if (u32(b, localAt) !== 0x04034b50) continue;
    const dataAt = localAt + 30 + u16(b, localAt + 26) + u16(b, localAt + 28);
    const raw = b.subarray(dataAt, dataAt + compressed);
    try {
      out.set(name, method === 0 ? raw.slice() : await inflateRaw(raw));
    } catch (_) { /* испорченная запись — не повод терять весь документ */ }
  }
  return out;
}

/** Текст абзацев из куска WordprocessingML: `<w:t>` внутри `<w:p>` */
function paragraphs(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const text = [...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((t) => t[1])
      .join('')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
      .trim();
    if (text) out.push(text);
  }
  return out;
}

const decode = (bytes: Uint8Array | undefined) =>
  bytes ? new TextDecoder('utf-8').decode(bytes) : '';

/**
 * Текст, который живёт вне основного потока: колонтитулы, надписи, сноски.
 *
 * Возвращается отдельно от основного текста, а не подмешивается в него: в
 * колонтитуле лежит штамп, и вклинивать его в середину пояснительной записки
 * значило бы испортить и то и другое. Подписи говорят, откуда что взято.
 */
export async function docxOuterText(buf: ArrayBuffer | Uint8Array): Promise<string[]> {
  let files: ZipFiles;
  try { files = await unzip(buf); } catch (_) { return []; }
  const lines: string[] = [];

  const collect = (label: string, xml: string) => {
    const rows = paragraphs(xml);
    if (!rows.length) return;
    lines.push(label);
    lines.push(...rows);
    lines.push('');
  };

  const named = [...files.keys()].sort();
  for (const name of named) {
    if (/^word\/header\d*\.xml$/.test(name)) collect('— Колонтитул (верх) —', decode(files.get(name)));
    if (/^word\/footer\d*\.xml$/.test(name)) collect('— Колонтитул (низ) —', decode(files.get(name)));
  }
  if (files.has('word/footnotes.xml')) collect('— Сноски —', decode(files.get('word/footnotes.xml')));
  if (files.has('word/endnotes.xml')) collect('— Концевые сноски —', decode(files.get('word/endnotes.xml')));

  // Надписи поверх страницы: mammoth их не видит вовсе, а в бланках в них
  // лежат и шифр, и наименование системы
  const doc = decode(files.get('word/document.xml'));
  const boxes: string[] = [];
  for (const m of doc.matchAll(/<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g)) {
    boxes.push(...paragraphs(m[1]));
  }
  if (boxes.length) {
    lines.push('— Надписи —');
    lines.push(...boxes);
    lines.push('');
  }

  return lines;
}
