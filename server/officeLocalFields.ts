import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { parseKey } from '../office/fieldKeys.js';
import type { OfficeLocalFieldRefreshResult } from '../office/fieldRefresh.js';
import {
  fillDocxMarkers, listDocxFields, listDocxMarkers, listXlsxAnchors,
  updateDocxFields, updateXlsxFields,
} from './officeFields.js';
import { resolveKeys } from './projectFields.js';

type PackageKind = 'docx' | 'xlsx';
type FieldLocation = { key: string; where: string };

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function officeKindOf(bytes: Buffer): Promise<PackageKind> {
  const zip = await JSZip.loadAsync(bytes);
  const files = zip.files;
  const docx = !!files['[Content_Types].xml'] && !!files['word/document.xml'];
  const xlsx = !!files['[Content_Types].xml'] && !!files['xl/workbook.xml'];
  if (docx === xlsx) throw new Error('Поля обновляются только в файлах DOCX и XLSX');
  return docx ? 'docx' : 'xlsx';
}

async function localValues(keys: string[], projectId: string) {
  const unavailable = new Map<string, string>();
  const resolvable = keys.filter(key => {
    const kind = parseKey(key)?.kind;
    if (kind === 'doc' || kind === 'sign') {
      // Для локального файла нет FileNode, поэтому его свойства и подписи нельзя подменять пустым fileId.
      unavailable.set(key, 'локальному файлу неизвестен контекст документа или подписи');
      return false;
    }
    return true;
  });
  const values = await resolveKeys(resolvable, { projectId });
  for (const key of resolvable) {
    const value = values[key];
    if (value === undefined || (typeof value === 'string' && value.startsWith('#НЕТ_'))) {
      unavailable.set(key, 'значение поля недоступно; текущее содержимое оставлено');
      delete values[key];
    }
  }
  return { values, unavailable };
}

function skipsFor(locations: FieldLocation[], unavailable: Map<string, string>) {
  return locations.flatMap(({ key, where }) => {
    const why = unavailable.get(key);
    return why ? [{ key, why, where }] : [];
  });
}

/** Обновить распознаваемые поля в присланном пакете, не записывая файл на сервер. */
export async function refreshOfficeLocalFields(bytes: Buffer, projectId: string): Promise<OfficeLocalFieldRefreshResult> {
  const kind = await officeKindOf(bytes);
  const before = bytes;
  const changed: OfficeLocalFieldRefreshResult['changed'] = [];
  const skipped: OfficeLocalFieldRefreshResult['skipped'] = [];

  if (kind === 'docx') {
    const markers = await listDocxMarkers(bytes);
    if (markers.length) {
      const resolved = await localValues(markers, projectId);
      const filled = await fillDocxMarkers(bytes, resolved.values);
      bytes = filled.bytes;
      changed.push(...filled.changed);
      skipped.push(...filled.skipped);
    }
    const fields = await listDocxFields(bytes);
    const resolved = await localValues(fields.map(field => field.key), projectId);
    const updated = await updateDocxFields(bytes, resolved.values);
    bytes = updated.bytes;
    changed.push(...updated.changed);
    skipped.push(...updated.skipped);
    skipped.push(...skipsFor(fields.map(field => ({ key: field.key, where: field.part })), resolved.unavailable));
  } else {
    const anchors = await listXlsxAnchors(bytes);
    const resolved = await localValues(anchors.fields.map(field => field.key), projectId);
    const updated = await updateXlsxFields(bytes, resolved.values);
    bytes = updated.bytes;
    changed.push(...updated.changed);
    skipped.push(...updated.skipped);
    skipped.push(...skipsFor(anchors.fields.map(field => ({ key: field.key, where: `${field.sheet}!${field.cell}` })), resolved.unavailable));
  }

  return { changed, skipped, unchanged: bytes.equals(before), sha256: sha256(bytes), base64: bytes.toString('base64') };
}
