/**
 * Скрытая часть Flux в ZIP-пакете DOCX/XLSX: общая для сервера, окна и
 * оболочки Electron. Здесь только байты и архив, без Buffer и node:, поэтому
 * тот же код переносит часть Flux и на сервере, и в окне Проводника, и в
 * сеансе локальной книги.
 */
import JSZip from 'jszip';

export const FLUX_PART = 'customXml/itemFluxOffice.xml';
export const FLUX_PART_MAX_BYTES = 2 * 1024 * 1024;
const ROOT_RELS = '_rels/.rels';
const CONTENT_TYPES = '[Content_Types].xml';
const ROOT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml';

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
    const mine = await (await JSZip.loadAsync(incoming)).file(FLUX_PART)?.async('string');
    if (mine === have) return incoming;
    return await putFluxPart(incoming, have);
  } catch { return incoming; }
}
