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

/** Перенос части Flux из файла на сервере в тело сохранения из редактора (office/fluxPart.ts). */
export async function carryOfficeBindings(current: Buffer, incoming: Buffer): Promise<Buffer> {
  const carried = await carryFluxPart(current, incoming);
  return carried === incoming ? incoming : Buffer.from(carried);
}
