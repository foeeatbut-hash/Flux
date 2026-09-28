/**
 * Какой значок у файла. Один ответ на всю программу: стол, Проводник, Пуск,
 * окно и командная строка берут вид отсюда (components/ui/FileBadge.tsx).
 * Раньше их было пять разных, и стол показывал .docx, .xlsx и .pdf одним
 * серым листом — документ нельзя было узнать, не прочитав подпись.
 *
 * Вид — по сути файла, а не по расширению: .xlsx и .csv — оба таблицы.
 * Подпись на полосе — само расширение: по ней отличают .xlsx от .xlsm.
 */
import { extOf, faceOf, type FileLike } from './fileTypes';

export type BadgeKind =
  | 'doc' | 'sheet' | 'pdf' | 'note' | 'markdown' | 'text'
  | 'image' | 'archive' | 'cad' | 'file';

const ARCHIVE = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz']);
const CAD = new Set(['dwg', 'dxf', 'dwf', 'step', 'stp', 'ifc', 'rvt', 'nwd']);

/** Вид значка по имени (и по типу из базы для заметок) */
export function badgeOf(f: FileLike | string): BadgeKind {
  const name = typeof f === 'string' ? f : f.name || '';
  const type = typeof f === 'string' ? '' : String(f.type || '');
  if (type === 'NOTE') return 'note';
  const ext = extOf(name);
  if (ext === 'md') return 'markdown';
  if (ARCHIVE.has(ext)) return 'archive';
  if (CAD.has(ext)) return 'cad';
  switch (faceOf(name)) {
    case 'text': return 'doc';
    case 'sheet': return 'sheet';
    case 'pdf': return 'pdf';
    case 'image': return 'image';
    case 'plain': return 'text';
    default: return 'file';
  }
}

/** Цвет вида: полоса и знак. Тот же, что у программы, которая его открывает */
export const BADGE_COLOR: Record<BadgeKind, string> = {
  doc: '#2563eb',
  sheet: '#059669',
  pdf: '#e11d48',
  note: '#d97706',
  markdown: '#7c3aed',
  text: '#475569',
  image: '#0891b2',
  archive: '#64748b',
  cad: '#ea580c',
  file: '#94a3b8',
};

/** Подпись полосы: расширение, не длиннее четырёх букв; у заметки — «ЗАМ» */
export function badgeLabel(f: FileLike | string, kind = badgeOf(f)): string {
  if (kind === 'note') return 'ЗАМ';
  const ext = extOf(typeof f === 'string' ? f : f.name || '').toUpperCase();
  return ext.slice(0, 4);
}

/** Вид значка недавней вещи: по имени файла, а у старых записей без расширения — по программе */
export function recentBadge(d: { title: string; kind: string }): BadgeKind {
  if (d.kind === 'note') return 'note';
  const byName = badgeOf(d.title);
  if (byName !== 'file') return byName;
  return d.kind === 'sheet' ? 'sheet' : d.kind === 'pdf' ? 'pdf' : 'doc';
}
