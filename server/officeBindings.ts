/** Скрытая схема Flux в ZIP-пакете DOCX/XLSX; значение ячеек остаётся обычным. */
import JSZip from 'jszip';

const PART = 'customXml/itemFluxOffice.xml';
const ROOT_RELS = '_rels/.rels';
const CONTENT_TYPES = '[Content_Types].xml';
const ROOT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml';
const MAX_BYTES = 2 * 1024 * 1024;

export interface OfficePackageBindings {
  version: 1;
  schemaVersion: 1;
  sourceRevision: string;
  anchors: Array<{ id: string; kind: 'word-row' | 'excel-range'; part?: string; sheet?: string; address?: string; parts: unknown[] }>;
  rows: Array<{ entityId: string; entityType: string; sourceId: string; sourceRevision: string; anchorIds: string[]; cells?: Record<string, string>; values?: Record<string, string | number> }>;
}

const escXml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const unescXml = (s: string) => s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');

function validBindings(value: any): value is OfficePackageBindings {
  if (!value || value.version !== 1 || value.schemaVersion !== 1 || typeof value.sourceRevision !== 'string') return false;
  if (!Array.isArray(value.anchors) || !Array.isArray(value.rows) || value.anchors.length > 10000 || value.rows.length > 100000) return false;
  const ids = new Set<string>();
  const kinds = new Map<string, string>();
  for (const anchor of value.anchors) {
    if (!anchor || typeof anchor.id !== 'string' || !anchor.id || ids.has(anchor.id) || !['word-row', 'excel-range'].includes(anchor.kind) || !Array.isArray(anchor.parts)) return false;
    ids.add(anchor.id);
    kinds.set(anchor.id, anchor.kind);
  }
  for (const row of value.rows) {
    if (!row || !['string'].includes(typeof row.entityId) || !row.entityId || typeof row.entityType !== 'string' || typeof row.sourceId !== 'string' || typeof row.sourceRevision !== 'string' || !Array.isArray(row.anchorIds)) return false;
    if (row.anchorIds.some((id: unknown) => typeof id !== 'string' || !ids.has(id))) return false;
    if (row.cells && (typeof row.cells !== 'object' || Array.isArray(row.cells) || Object.entries(row.cells).some(([id, address]) => !ids.has(id) || typeof address !== 'string' || !(kinds.get(id) === 'excel-range' ? /^[A-Z]{1,3}\d+$/i.test(address) : /^FLUXROW_[0-9a-f]{16}$/i.test(address))))) return false;
    if (row.values && (typeof row.values !== 'object' || Array.isArray(row.values) || Object.entries(row.values).some(([id, value]) => !ids.has(id) || !((typeof value === 'string' && value.length <= 32767) || (typeof value === 'number' && Number.isFinite(value)))))) return false;
  }
  return true;
}

/** Считывает только собственную bounded schema; неизвестную версию не угадывает. */
export async function readOfficeBindings(bytes: Buffer): Promise<OfficePackageBindings | null> {
  const zip = await JSZip.loadAsync(bytes);
  const part = zip.file(PART);
  if (!part) return null;
  const declared = Number((part as any)._data?.uncompressedSize);
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error('Скрытая схема Flux слишком велика');
  const xml = await part.async('string');
  if (Buffer.byteLength(xml, 'utf8') > MAX_BYTES) throw new Error('Скрытая схема Flux слишком велика');
  const match = /^<fluxOffice xmlns="urn:flux:office:v1">([\s\S]*)<\/fluxOffice>$/.exec(xml);
  if (!match) throw new Error('Скрытая схема Flux повреждена');
  let value: unknown;
  try { value = JSON.parse(unescXml(match[1])); } catch { throw new Error('Скрытая схема Flux содержит некорректный JSON'); }
  if (!validBindings(value)) throw new Error('Версия или структура скрытой схемы Flux не поддерживается');
  return value;
}

/** Кладёт готовый XML части Flux в пакет и при нужде добавляет связь и тип содержимого. */
async function putPart(bytes: Buffer, xml: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  zip.file(PART, xml);
  const rels = await zip.file(ROOT_RELS)?.async('string');
  if (!rels) throw new Error('Пакет Office не содержит корневых связей');
  if (!rels.includes(`Target="customXml/itemFluxOffice.xml"`)) {
    const ids = [...rels.matchAll(/\bId="rId(\d+)"/g)].map((m) => Number(m[1]));
    const id = `rId${Math.max(0, ...ids) + 1}`;
    const relation = `<Relationship Id="${id}" Type="${ROOT_REL}" Target="customXml/itemFluxOffice.xml"/>`;
    zip.file(ROOT_RELS, rels.replace('</Relationships>', `${relation}</Relationships>`));
  }
  const contentTypes = await zip.file(CONTENT_TYPES)?.async('string');
  if (!contentTypes) throw new Error('Пакет Office не содержит типов содержимого');
  if (!contentTypes.includes('PartName="/customXml/itemFluxOffice.xml"')) {
    zip.file(CONTENT_TYPES, contentTypes.replace('</Types>', '<Override PartName="/customXml/itemFluxOffice.xml" ContentType="application/xml"/></Types>'));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Записывает только валидированную схему и не затрагивает прочие части пакета. */
export async function writeOfficeBindings(bytes: Buffer, bindings: OfficePackageBindings): Promise<Buffer> {
  if (!validBindings(bindings)) throw new Error('Нельзя записать некорректную схему Flux');
  const xml = `<fluxOffice xmlns="urn:flux:office:v1">${escXml(JSON.stringify(bindings))}</fluxOffice>`;
  if (Buffer.byteLength(xml, 'utf8') > MAX_BYTES) throw new Error('Скрытая схема Flux слишком велика');
  return putPart(bytes, xml);
}

/**
 * Часть Flux принадлежит серверу: редактор открыл пакет до записи схемы и
 * при сохранении вернул бы в файл её старую копию. Поэтому в тело сохранения
 * из редактора переносится та часть, что сейчас в файле на сервере — как есть,
 * без разбора. Нет части в файле, нет пакета или части равны — тело не трогаем
 * (тот же объект, без пережатия архива).
 */
export async function carryOfficeBindings(current: Buffer, incoming: Buffer): Promise<Buffer> {
  // Имена частей лежат в архиве несжатыми: файлы без схемы не разбираем
  if (!current.includes(PART)) return incoming;
  try {
    const have = await (await JSZip.loadAsync(current)).file(PART)?.async('string');
    if (have === undefined || Buffer.byteLength(have, 'utf8') > MAX_BYTES) return incoming;
    const mine = await (await JSZip.loadAsync(incoming)).file(PART)?.async('string');
    if (mine === have) return incoming;
    return await putPart(incoming, have);
  } catch { return incoming; }
}
