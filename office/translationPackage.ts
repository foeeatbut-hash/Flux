import JSZip from 'jszip';
import { FLUX_PART, FLUX_PART_MAX_BYTES, putFluxPart, utf8Length } from './fluxPart';

/** Запись журнала перевода в части Flux файла; src/translate/placement.ts её переиспользует. */
export interface OfficeTranslationRecord {
  sourceId: string; key: string; destination: string; revision: string; time: number;
  mode: string; scope: string; targetLocation: Record<string, unknown>; targetText: string; sourceText: string;
  /** Хеш исходного текста на момент перевода: по нему находят устаревшие переводы. */
  sourceHash?: string;
}

/** Метаданные пакета не зависят от React-панели: их читает и нативный процесс. */
export interface OfficeTranslationMetadata {
  baseHash: string;
  records: OfficeTranslationRecord[];
  bindings: Array<Record<string, unknown>>;
  headerSchema: any;
  displayLabels: Record<string, string>;
}

export interface OfficeTranslationDelta {
  records?: OfficeTranslationRecord[];
  removeRecords?: OfficeTranslationRecord[];
  headerSchema?: any;
  displayLabels?: Record<string, string>;
  bindings?: Array<Record<string, unknown>>;
}

const escapeXml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const unescapeXml = (value: string): string => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');

/** Read the committed local custom XML part; malformed package state is an error, never an empty journal. */
export async function readOfficeTranslationPackage(bytes: Uint8Array, baseHash: string): Promise<OfficeTranslationMetadata> {
  const zip = await JSZip.loadAsync(bytes);
  const part = zip.file(FLUX_PART);
  let bindings: any = { version: 1, schemaVersion: 1, anchors: [], rows: [] };
  if (part) {
    const xml = await part.async('string');
    if (utf8Length(xml) > FLUX_PART_MAX_BYTES) throw new Error('Скрытые данные Flux слишком велики');
    const match = /^<fluxOffice xmlns="urn:flux:office:v1">([\s\S]*)<\/fluxOffice>$/.exec(xml);
    if (!match) throw new Error('Скрытая схема Flux повреждена; перевод не прочитан');
    try { bindings = JSON.parse(unescapeXml(match[1])); }
    catch { throw new Error('Скрытая схема Flux повреждена; перевод не прочитан'); }
    if (!bindings || bindings.version !== 1 || bindings.schemaVersion !== 1 || !Array.isArray(bindings.anchors) || !Array.isArray(bindings.rows)) {
      throw new Error('Структура скрытой схемы Flux не поддерживается; перевод не прочитан');
    }
  }
  if (bindings.translations !== undefined && !Array.isArray(bindings.translations)) throw new Error('Журнал перевода повреждён; перевод не прочитан');
  if (bindings.translationBindings !== undefined && !Array.isArray(bindings.translationBindings)) throw new Error('Связи перевода повреждены; перевод не прочитан');
  return {
    baseHash,
    records: Array.isArray(bindings.translations) ? bindings.translations : [],
    bindings: Array.isArray(bindings.translationBindings) ? bindings.translationBindings : [],
    headerSchema: { version: bindings.schemaVersion, anchors: bindings.anchors.map(({ part, sheet, ...anchor }: any) => ({ ...anchor, ...(part ? { documentPart: part } : {}), ...(sheet ? { sheetName: sheet } : {}) })) },
    displayLabels: bindings.displayLabels && typeof bindings.displayLabels === 'object' ? bindings.displayLabels : {},
  };
}

function packAnchors(schema: any): any[] {
  if (!Array.isArray(schema?.anchors)) return [];
  return schema.anchors.map((anchor: any) => ({
    id: String(anchor.id || ''), kind: anchor.kind,
    ...(anchor.documentPart || anchor.part ? { part: anchor.documentPart || anchor.part } : {}),
    ...(anchor.sheetName || anchor.sheet ? { sheet: anchor.sheetName || anchor.sheet } : {}),
    ...(anchor.address ? { address: anchor.address } : {}),
    parts: Array.isArray(anchor.parts) ? anchor.parts : [],
  }));
}

function blankBindings() {
  return { version: 1, schemaVersion: 1, sourceRevision: '', anchors: [], rows: [] };
}

/** Переносит только данные перевода в ZIP редактора перед его единственной записью. */
export async function mergeOfficeTranslationPackage(bytes: Uint8Array, delta: OfficeTranslationDelta): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const part = zip.file(FLUX_PART);
  let bindings: any = blankBindings();
  if (part) {
    const xml = await part.async('string');
    if (utf8Length(xml) > FLUX_PART_MAX_BYTES) throw new Error('Скрытые данные Flux слишком велики');
    const match = /^<fluxOffice xmlns="urn:flux:office:v1">([\s\S]*)<\/fluxOffice>$/.exec(xml);
    if (!match) throw new Error('Скрытая схема Flux повреждена; перевод не записан');
    try { bindings = JSON.parse(unescapeXml(match[1])); }
    catch { throw new Error('Скрытая схема Flux повреждена; перевод не записан'); }
    if (!bindings || bindings.version !== 1 || bindings.schemaVersion !== 1 || !Array.isArray(bindings.anchors) || !Array.isArray(bindings.rows)) {
      throw new Error('Структура скрытой схемы Flux не поддерживается; перевод не записан');
    }
  }

  const removeIds = new Set((delta.removeRecords || []).map((record) => recordIdentity(record)));
  const prior: OfficeTranslationRecord[] = Array.isArray(bindings.translations) ? bindings.translations : [];
  const kept = prior.filter((record: OfficeTranslationRecord) => !removeIds.has(recordIdentity(record)));
  const merged = [...kept];
  const identities = new Set(merged.map(recordIdentity));
  for (const record of delta.records || []) {
    const key = recordIdentity(record);
    if (!identities.has(key)) { identities.add(key); merged.push(record); }
  }
  if (merged.length > 5000) throw new Error('В файле слишком много связей перевода; сохраните копию и обратитесь к администратору');
  bindings.translations = merged;
  if (Array.isArray(delta.bindings)) {
    const existing = new Map((Array.isArray(bindings.translationBindings) ? bindings.translationBindings : []).map((item: any) => [bindingIdentity(item), item]));
    for (const binding of delta.bindings) existing.set(bindingIdentity(binding), binding);
    bindings.translationBindings = [...existing.values()].slice(-10000);
  }
  if (delta.headerSchema) bindings.anchors = packAnchors(delta.headerSchema);
  if (delta.displayLabels) bindings.displayLabels = { ...(bindings.displayLabels || {}), ...delta.displayLabels };
  const xml = `<fluxOffice xmlns="urn:flux:office:v1">${escapeXml(JSON.stringify(bindings))}</fluxOffice>`;
  if (utf8Length(xml) > FLUX_PART_MAX_BYTES) throw new Error('Скрытые данные Flux превысили допустимый размер; перевод не записан');
  return await putFluxPart(bytes, xml);
}

function recordIdentity(record: OfficeTranslationRecord): string {
  return `${record.sourceId}\u0000${record.key}\u0000${record.destination}\u0000${record.revision}\u0000${record.time}`;
}
function bindingIdentity(binding: any): string {
  return `${String(binding?.sourceId || '')}\u0000${String(binding?.key || '')}\u0000${JSON.stringify(binding?.targetLocation || {})}`;
}
