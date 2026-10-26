/** Декодирует только явно распознаваемые кодировки XML-источников оборудования. */
export const EQUIPMENT_SOURCE_MAX_BYTES = 16 * 1024 * 1024;

export type EquipmentSourceFilenameRule =
  | { kind: 'exact-tag' }
  | { kind: 'selected-name'; fileName: string };

/** Точный выбранный узел XML; поля fingerprint взяты из XML, не придуманы Flux. */
export interface EquipmentXmlTargetIdentity {
  version: 1;
  targetType: 'system' | 'component';
  unitIndex: number;
  componentIndex?: number;
  fingerprint: {
    name?: string;
    code?: string;
    title?: string;
    equipType?: string;
    role?: string;
    sourceKind?: string;
  };
}

/** Выбор файла хранит явное правило, чтобы повторный скан не брал соседний XML по подстроке. */
export function inferEquipmentSourceFilenameRule(fileName: string, tagIdentifier: string): EquipmentSourceFilenameRule | null {
  if (/[\\/]/u.test(fileName) || !fileName.toLowerCase().endsWith('.xml')) return null;
  const stem = normalizeTag(fileName.slice(0, -4));
  const tag = normalizeTag(tagIdentifier);
  if (!tag) return null;
  if (stem === tag) return { kind: 'exact-tag' };
  return hasTagBoundary(stem, tag) || groupHasTag(stem, tag) ? { kind: 'selected-name', fileName } : null;
}

export function matchesEquipmentSourceFilename(fileName: string, tagIdentifier: string, rule?: EquipmentSourceFilenameRule): boolean {
  if (/[\\/]/u.test(fileName) || !fileName.toLowerCase().endsWith('.xml')) return false;
  const candidate = rule || inferEquipmentSourceFilenameRule(fileName, tagIdentifier);
  if (!candidate) return false;
  if (candidate.kind === 'exact-tag') return normalizeTag(fileName.slice(0, -4)) === normalizeTag(tagIdentifier);
  return !/[\\/]/u.test(candidate.fileName) && normalizeName(fileName) === normalizeName(candidate.fileName) && (hasTagBoundary(normalizeTag(fileName.slice(0, -4)), normalizeTag(tagIdentifier)) || groupHasTag(normalizeTag(fileName.slice(0, -4)), normalizeTag(tagIdentifier)));
}

/**
 * Группа одинаковых установок под одним именем: «3700-B01-AS-001ABC» — это
 * 001A, 001B и 001C с одним расчётом. Буквы после последней цифры должны идти
 * подряд по алфавиту (ABC, BCD), иначе это обычное имя и группы нет.
 */
export function expandEquipmentUnitGroup(name: string): string[] {
  const match = /^(.*\d)([A-Z]{2,10})$/u.exec(String(name || '').normalize('NFC').trim());
  if (!match) return [];
  const letters = Array.from(match[2]);
  if (!letters.every((letter, index) => index === 0 || letter.charCodeAt(0) === letters[index - 1].charCodeAt(0) + 1)) return [];
  return letters.map(letter => `${match[1]}${letter}`);
}

const normalizeTag = (value: string) => value.normalize('NFC').trim().toLowerCase();
const normalizeName = (value: string) => value.normalize('NFC').trim().toLowerCase();
/** Имя файла группы «…001ABC» содержит каждую установку группы. */
function groupHasTag(stem: string, tag: string): boolean {
  return stem.split(/[^\p{L}\p{N}-]+/u).some(token => expandEquipmentUnitGroup(token.toUpperCase()).some(member => normalizeTag(member) === tag));
}
function hasTagBoundary(stem: string, tag: string): boolean {
  let at = stem.indexOf(tag);
  while (at >= 0) {
    const before = at === 0 ? '' : Array.from(stem.slice(0, at)).at(-1) || '';
    const after = Array.from(stem.slice(at + tag.length))[0] || '';
    if ((!before || !/[\p{L}\p{N}]/u.test(before)) && (!after || !/[\p{L}\p{N}]/u.test(after))) return true;
    at = stem.indexOf(tag, at + 1);
  }
  return false;
}

export function decodeEquipmentSourceXml(bytes: Uint8Array): string | null {
  if (!bytes.length || bytes.length > EQUIPMENT_SOURCE_MAX_BYTES) return null;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    if (bytes[0] === 0x3c && bytes[1] === 0x00) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    if (bytes[0] === 0x00 && bytes[1] === 0x3c) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return null; }
}
