/** Скрытая схема Flux в ZIP-пакете DOCX/XLSX; значение ячеек остаётся обычным. */
import JSZip from 'jszip';
import { FLUX_PART, FLUX_PART_MAX_BYTES, carryFluxPart, putFluxPart } from '../office/fluxPart.js';

const PART = FLUX_PART;
const MAX_BYTES = FLUX_PART_MAX_BYTES;

export type OfficePackageAnchor = { id: string; kind: 'word-row' | 'excel-range'; part?: string; sheet?: string; address?: string; parts: unknown[] };

/**
 * Шаблон, который применён к файлу, и снимок его схемы на момент применения.
 * Снимок, а не ссылка: шаблон потом изменят или удалят, а «Исходная шапка»
 * должна вернуть шапку к тому виду, с которого файл начинался. Хранится один,
 * последний применённый (решение владельца 12.10.2026).
 */
export interface OfficeTemplateSnapshot { templateId: string; name?: string; appliedAt: string; anchors: OfficePackageAnchor[] }

export interface OfficePackageBindings {
  version: 1;
  schemaVersion: 1;
  sourceRevision: string;
  anchors: OfficePackageAnchor[];
  template?: OfficeTemplateSnapshot;
  rows: Array<{ entityId: string; entityType: string; sourceId: string; sourceRevision: string; anchorIds: string[]; cells?: Record<string, string>; values?: Record<string, string | number> }>;
  /** Ограниченный журнал источника/назначения для переводов в самом файле. */
  translations?: OfficePackageTranslationRecord[];
  translationBindings?: OfficeTranslationBinding[];
  displayLabels?: Record<string, string>;
}

export interface OfficePackageTranslationRecord {
  sourceId: string; key: string; destination: string; revision: string; time: number;
  mode: string; scope: string; targetLocation: Record<string, unknown>; targetText: string; sourceText: string;
}
export interface OfficeTranslationBinding {
  sourceId: string; key: string; targetText: string; targetLocation?: Record<string, unknown>;
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
  if (value.template !== undefined) {
    const t = value.template;
    if (!t || typeof t.templateId !== 'string' || !t.templateId || t.templateId.length > 200 || typeof t.appliedAt !== 'string' || !t.appliedAt) return false;
    if (t.name !== undefined && typeof t.name !== 'string') return false;
    if (!Array.isArray(t.anchors) || t.anchors.length > 10000) return false;
    const snapshotIds = new Set<string>();
    for (const anchor of t.anchors) {
      if (!anchor || typeof anchor.id !== 'string' || !anchor.id || snapshotIds.has(anchor.id) || !['word-row', 'excel-range'].includes(anchor.kind) || !Array.isArray(anchor.parts)) return false;
      snapshotIds.add(anchor.id);
    }
  }
  if (value.translations !== undefined) {
    if (!Array.isArray(value.translations) || value.translations.length > 5000) return false;
    for (const record of value.translations) {
      if (!record || typeof record.sourceId !== 'string' || record.sourceId.length > 300 || typeof record.key !== 'string' || record.key.length > 300 ||
          typeof record.destination !== 'string' || record.destination.length > 300 || typeof record.revision !== 'string' || record.revision.length > 200 ||
          !Number.isFinite(record.time) || typeof record.mode !== 'string' || record.mode.length > 40 || typeof record.scope !== 'string' || record.scope.length > 20 ||
          !record.targetLocation || typeof record.targetLocation !== 'object' || typeof record.targetText !== 'string' || record.targetText.length > 32767 ||
          typeof record.sourceText !== 'string' || record.sourceText.length > 32767) return false;
    }
  }
  if (value.translationBindings !== undefined && (!Array.isArray(value.translationBindings) || value.translationBindings.length > 10000 || value.translationBindings.some((item) =>
    !item || typeof item.sourceId !== 'string' || item.sourceId.length > 300 || typeof item.key !== 'string' || item.key.length > 300 ||
    typeof item.targetText !== 'string' || item.targetText.length > 32767 || (item.targetLocation !== undefined && (!item.targetLocation || typeof item.targetLocation !== 'object'))))) return false;
  if (value.displayLabels !== undefined && (!value.displayLabels || typeof value.displayLabels !== 'object' || Array.isArray(value.displayLabels) || Object.entries(value.displayLabels).length > 10000 ||
    Object.entries(value.displayLabels).some(([key, label]) => key.length > 300 || typeof label !== 'string' || label.length > 2000))) return false;
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

/** Кладёт готовый XML части Flux в пакет; сама работа с архивом общая (office/fluxPart.ts). */
async function putPart(bytes: Buffer, xml: string): Promise<Buffer> {
  return Buffer.from(await putFluxPart(bytes, xml));
}

/** Записывает только валидированную схему и не затрагивает прочие части пакета. */
export async function writeOfficeBindings(bytes: Buffer, bindings: OfficePackageBindings): Promise<Buffer> {
  if (!validBindings(bindings)) throw new Error('Нельзя записать некорректную схему Flux');
  const xml = `<fluxOffice xmlns="urn:flux:office:v1">${escXml(JSON.stringify(bindings))}</fluxOffice>`;
  if (Buffer.byteLength(xml, 'utf8') > MAX_BYTES) throw new Error('Скрытая схема Flux слишком велика');
  return putPart(bytes, xml);
}

export interface OfficeTranslationDelta {
  records?: OfficePackageTranslationRecord[];
  removeRecords?: OfficePackageTranslationRecord[];
  headerSchema?: { anchors?: Array<Record<string, any>> };
  displayLabels?: Record<string, string>;
  bindings?: OfficeTranslationBinding[];
}

/** Меняет только связи перевода в актуальной части Flux, сохраняя строки и шаблон. */
export async function mergeOfficeTranslations(bytes: Buffer, delta: OfficeTranslationDelta): Promise<Buffer> {
  const current = await readOfficeBindings(bytes) || { version: 1 as const, schemaVersion: 1 as const, sourceRevision: '', anchors: [], rows: [] };
  const key = (record: OfficePackageTranslationRecord) => `${record.sourceId}\u0000${record.key}\u0000${record.destination}\u0000${record.revision}\u0000${record.time}`;
  const removed = new Set((delta.removeRecords || []).map(key));
  const translations = (current.translations || []).filter((record) => !removed.has(key(record)));
  const identities = new Set(translations.map(key));
  for (const record of delta.records || []) if (!identities.has(key(record))) { identities.add(key(record)); translations.push(record); }
  const anchors = delta.headerSchema?.anchors
    ? delta.headerSchema.anchors.map((anchor: any) => ({ id: String(anchor.id || ''), kind: anchor.kind, ...(anchor.documentPart || anchor.part ? { part: anchor.documentPart || anchor.part } : {}), ...(anchor.sheetName || anchor.sheet ? { sheet: anchor.sheetName || anchor.sheet } : {}), ...(anchor.address ? { address: anchor.address } : {}), parts: Array.isArray(anchor.parts) ? anchor.parts : [] }))
    : current.anchors;
  const byBinding = new Map((current.translationBindings || []).map((binding) => [`${binding.sourceId}\u0000${binding.key}\u0000${JSON.stringify(binding.targetLocation || {})}`, binding]));
  for (const binding of delta.bindings || []) byBinding.set(`${binding.sourceId}\u0000${binding.key}\u0000${JSON.stringify(binding.targetLocation || {})}`, binding);
  const merged: OfficePackageBindings = {
    ...current,
    anchors,
    translations: translations.slice(-5000),
    translationBindings: [...byBinding.values()].slice(-10000),
    ...(delta.displayLabels ? { displayLabels: { ...(current.displayLabels || {}), ...delta.displayLabels } } : {}),
  };
  return writeOfficeBindings(bytes, merged);
}

/** Перенос части Flux из файла на сервере в тело сохранения из редактора (office/fluxPart.ts). */
export async function carryOfficeBindings(current: Buffer, incoming: Buffer): Promise<Buffer> {
  const carried = await carryFluxPart(current, incoming);
  return carried === incoming ? incoming : Buffer.from(carried);
}
