/**
 * Какой значок у файла. Один ответ на всю программу: стол, Проводник, Пуск,
 * окно и командная строка берут вид отсюда (components/ui/FileBadge.tsx).
 * Раньше их было пять разных, и стол показывал .docx, .xlsx и .pdf одним
 * серым листом — документ нельзя было узнать, не прочитав подпись.
 *
 * Вид — по сути файла, а не по расширению: .xlsx и .csv — оба таблицы.
 * Подпись на полосе — само расширение: по ней отличают .xlsx от .xlsm и .csv.
 *
 * Значков Windows в программе нет совсем: ни системных картинок файла, ни
 * значков оболочки. Любой формат получает рисунок отсюда, а формат, которого
 * у нас нет и открыть нечем, — «закрытый» лист: серая полоса и замок
 * (`closed`). Решает `canOpenInFlux` из fileTypes.ts — тот же ответ, по
 * которому файл открывается или отдаётся Windows.
 */
import { canOpenInFlux, extOf, faceOf, type FileLike } from './fileTypes';

export type BadgeKind =
  | 'doc' | 'sheet' | 'pdf' | 'note' | 'markdown' | 'text'
  | 'image' | 'archive' | 'cad' | 'file'
  | 'slide' | 'code' | 'app' | 'shortcut' | 'video' | 'audio' | 'e3' | 'closed';

const ARCHIVE = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz']);
const CAD = new Set(['dwg', 'dxf', 'dwf', 'step', 'stp', 'ifc', 'rvt', 'nwd']);
const SLIDE = new Set(['ppt', 'pptx', 'pps', 'ppsx', 'odp']);
/** Исходный текст и разметка данных: json и xml Flux открывает как текст, но рисует «кодом» */
const CODE = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'html', 'htm', 'css', 'scss', 'json', 'xml', 'py', 'c', 'h', 'cpp', 'cs', 'java', 'sql', 'sh', 'ps1']);
const APP = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'app']);
const SHORTCUT = new Set(['lnk', 'url']);
const VIDEO = new Set(['mp4', 'avi', 'mkv', 'mov', 'wmv', 'webm', 'm4v']);
const AUDIO = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma']);
/** Проекты E3.series: своя программа, свой значок */
const E3 = new Set(['e3s', 'e3p', 'e3t']);
/** Картинки, которые Flux не показывает, но узнаёт по виду */
const IMAGE_EXTRA = new Set(['tif', 'tiff', 'ico', 'heic']);
const SHEET_EXTRA = new Set(['ods']);

/** Подпись по умолчанию, когда имя файла передано без расширения */
const DEFAULT_LABEL: Record<BadgeKind, string> = {
  doc: 'DOCX',
  sheet: 'XLSX',
  pdf: 'PDF',
  note: 'ЗАМ',
  markdown: 'MD',
  text: 'TXT',
  image: 'PNG',
  archive: 'ZIP',
  cad: 'DWG',
  file: '',
  slide: 'PPTX',
  code: 'XML',
  app: 'EXE',
  shortcut: 'LNK',
  video: 'MP4',
  audio: 'MP3',
  e3: 'E3S',
  closed: '',
};

/** Вид значка по имени (и по типу из базы для заметок) */
export function badgeOf(f: FileLike | string): BadgeKind {
  const name = typeof f === 'string' ? f : f.name || '';
  const type = typeof f === 'string' ? '' : String(f.type || '');
  if (type === 'NOTE') return 'note';
  const ext = extOf(name);
  if (ext === 'md') return 'markdown';
  if (ARCHIVE.has(ext)) return 'archive';
  if (CAD.has(ext)) return 'cad';
  if (SLIDE.has(ext)) return 'slide';
  if (E3.has(ext)) return 'e3';
  if (CODE.has(ext)) return 'code';
  if (APP.has(ext)) return 'app';
  if (SHORTCUT.has(ext)) return 'shortcut';
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  if (IMAGE_EXTRA.has(ext)) return 'image';
  if (SHEET_EXTRA.has(ext)) return 'sheet';
  switch (faceOf(name)) {
    case 'text': return 'doc';
    case 'sheet': return 'sheet';
    case 'pdf': return 'pdf';
    case 'image': return 'image';
    case 'plain': return 'text';
    // Формат не опознан. С расширением и без возможности открыть — «закрытый»
    // лист; без расширения (черновик, имя без точки) — просто пустой лист
    default: return ext && !canOpenInFlux(f) ? 'closed' : 'file';
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
  slide: '#c2410c',
  code: '#0369a1',
  app: '#1e3a5f',
  shortcut: '#0ea5e9',
  video: '#db2777',
  audio: '#c026d3',
  e3: '#4f46e5',
  // Приглушённая серая полоса: «этот формат здесь не открывается»
  closed: '#7a8698',
};

/** Подпись полосы: расширение, не длиннее четырёх букв; у заметки — «ЗАМ» */
export function badgeLabel(f: FileLike | string, kind = badgeOf(f)): string {
  if (kind === 'note') return 'ЗАМ';
  const ext = extOf(typeof f === 'string' ? f : f.name || '').toUpperCase();
  if (ext) return ext.slice(0, 4);
  return DEFAULT_LABEL[kind] || '';
}

/** Вид значка недавней вещи: по имени файла, а у старых записей без расширения — по программе */
export function recentBadge(d: { title: string; kind: string }): BadgeKind {
  if (d.kind === 'note') return 'note';
  const byName = badgeOf(d.title);
  if (byName !== 'file') return byName;
  return d.kind === 'sheet' ? 'sheet' : d.kind === 'pdf' ? 'pdf' : 'doc';
}
