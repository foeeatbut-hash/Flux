/**
 * Разница между версиями модуля: по файлам построчно и отдельно — по
 * разрешениям.
 *
 * Разница не хранится, а считается из двух пакетов: запрос подписан вместе с
 * выпуском, от которого он отсчитан (`baseRelease`), значит, разница
 * однозначна и подделать её отдельно от кода нельзя. Разрешения выделены
 * отдельно, потому что «модуль теперь читает ВДР» — главное, что владелец
 * должен увидеть, а в построчной разнице это одна строка из сотен.
 *
 * Без зависимостей: считает и окно владельца, и сервер.
 */
import { bundleText, type BundleFiles } from './bundle';
import { connectionsOf, grantKey } from '../connections/model';
import { PERMISSION_KINDS } from '../permissions/registry';
import type { ModuleManifest } from '../contract';

export type DiffLine = { op: ' ' | '+' | '-'; text: string };
export interface FileDiff { path: string; status: 'added' | 'removed' | 'changed' | 'same'; binary: boolean; lines: DiffLine[] }

/** Дальше построчная разница слишком дорога для окна: показываем «заменён целиком» */
const LCS_LIMIT = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n'), b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head = a.slice(0, start).map((text): DiffLine => ({ op: ' ', text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ op: ' ', text }));
  const x = a.slice(start, endA), y = b.slice(start, endB);
  if (x.length * y.length > LCS_LIMIT) {
    return [...head, ...x.map((text): DiffLine => ({ op: '-', text })), ...y.map((text): DiffLine => ({ op: '+', text })), ...tail];
  }
  // Длина общей подпоследовательности с конца: по ней идём вперёд без рекурсии
  const w = y.length + 1, table = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      table[i * w + j] = x[i] === y[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  const middle: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { middle.push({ op: ' ', text: x[i] }); i++; j++; }
    else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) middle.push({ op: '-', text: x[i++] });
    else middle.push({ op: '+', text: y[j++] });
  }
  while (i < x.length) middle.push({ op: '-', text: x[i++] });
  while (j < y.length) middle.push({ op: '+', text: y[j++] });
  return [...head, ...middle, ...tail];
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export function diffFiles(before: BundleFiles | null, after: BundleFiles): FileDiff[] {
  const prev = before || {};
  const paths = [...new Set([...Object.keys(prev), ...Object.keys(after)])].sort();
  return paths.map((path): FileDiff => {
    const a = prev[path], b = after[path];
    const ta = a ? bundleText(prev, path) : '', tb = b ? bundleText(after, path) : '';
    const binary = ta === null || tb === null;
    const status = !a ? 'added' : !b ? 'removed' : sameBytes(a, b) ? 'same' : 'changed';
    const lines = binary || status === 'same' ? []
      : status === 'added' ? (tb || '').split('\n').map((text): DiffLine => ({ op: '+', text }))
        : status === 'removed' ? (ta || '').split('\n').map((text): DiffLine => ({ op: '-', text }))
          : diffLines(ta || '', tb || '');
    return { path, status, binary, lines };
  });
}

/** Поля манифеста, которые расширяют доступ модуля. Подключения (этап 3) добавятся сюда же */
const PERMISSION_FIELDS = ['reads', 'entries', 'connections', 'permissions'] as const;
export interface PermissionDiff { isNew: boolean; added: Record<string, string[]>; removed: Record<string, string[]>; widened: boolean }

const listOf = (manifest: Record<string, unknown> | null, field: string): string[] => {
  // Подключения сравниваются по адресу и виду доступа: новый адрес или «читать → изменять» — новое подключение, смена текста — нет
  // Интернет и локальная сеть — по названию вида и тексту «что делает»: новое заметное разрешение или смена его смысла — «новое»
  if (field === 'permissions') return PERMISSION_KINDS.filter((k) => k.field === 'permissions').flatMap((k) => k.items((manifest || {}) as unknown as ModuleManifest)).map((i) => i.label);
  if (field === 'connections') return connectionsOf(manifest as { connections?: unknown } | null).map(grantKey);
  const value = manifest?.[field];
  return Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))) : [];
};

export function diffPermissions(before: Record<string, unknown> | null, after: Record<string, unknown>): PermissionDiff {
  const added: Record<string, string[]> = {}, removed: Record<string, string[]> = {};
  for (const field of PERMISSION_FIELDS) {
    const a = listOf(before, field), b = listOf(after, field);
    const plus = b.filter((v) => !a.includes(v)), minus = a.filter((v) => !b.includes(v));
    if (plus.length) added[field] = plus;
    if (minus.length) removed[field] = minus;
  }
  return { isNew: !before, added, removed, widened: Object.keys(added).length > 0 };
}

export function manifestOf(files: BundleFiles | null): Record<string, unknown> | null {
  if (!files) return null;
  try {
    const value = JSON.parse(bundleText(files, 'manifest.json') || '');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
