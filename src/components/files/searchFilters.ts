/**
 * Фильтры поиска: то, что человек выбирает словами («Вчера», «Мелкие»), и то,
 * что понимает мост (даты ISO, размеры в байтах, расширения). Без React.
 *
 * Тип, дата изменения и размер — как в Проводнике Windows 11 (те же слова и те
 * же границы). Тег, проект и «Только черновики» — свойства Flux: Windows их не
 * знает, мост ищет их в своих данных.
 */
import type { WindowsSearchFilters } from '../../lib/windowsFiles';

export type TypeFilter = 'any' | 'folders' | 'documents' | 'tables' | 'presentations' | 'images' | 'video' | 'music' | 'archives';
export type DateFilter = 'any' | 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth' | 'thisYear' | 'older';
export type SizeFilter = 'any' | 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'giant';

export interface SearchUi { type: TypeFilter; modified: DateFilter; size: SizeFilter; tag: string; projectId: string; onlyDrafts: boolean }
export const NO_FILTERS: SearchUi = { type: 'any', modified: 'any', size: 'any', tag: '', projectId: '', onlyDrafts: false };

export const TYPE_LABELS: Record<TypeFilter, string> = {
  any: 'Любой', folders: 'Папки', documents: 'Документы', tables: 'Таблицы', presentations: 'Презентации',
  images: 'Изображения', video: 'Видео', music: 'Музыка', archives: 'Архивы',
};
export const DATE_LABELS: Record<DateFilter, string> = {
  any: 'Любая', today: 'Сегодня', yesterday: 'Вчера', thisWeek: 'На этой неделе', lastWeek: 'На прошлой неделе',
  thisMonth: 'В этом месяце', lastMonth: 'В прошлом месяце', thisYear: 'В этом году', older: 'Давно',
};
export const SIZE_LABELS: Record<SizeFilter, string> = {
  any: 'Любой', tiny: 'Крошечные (до 16 КБ)', small: 'Мелкие (до 1 МБ)', medium: 'Средние (до 128 МБ)',
  large: 'Большие (до 1 ГБ)', huge: 'Огромные (до 4 ГБ)', giant: 'Гигантские (больше 4 ГБ)',
};

const EXTENSIONS: Record<Exclude<TypeFilter, 'any' | 'folders'>, string[]> = {
  documents: ['doc', 'docx', 'rtf', 'odt', 'pdf', 'txt', 'md'],
  tables: ['xls', 'xlsx', 'xlsm', 'csv', 'ods'],
  presentations: ['ppt', 'pptx', 'odp'],
  images: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'tif', 'tiff'],
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm'],
  music: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'],
  archives: ['zip', '7z', 'rar', 'gz', 'tar'],
};

const KB = 1024, MB = KB * 1024, GB = MB * 1024;
const SIZES: Record<Exclude<SizeFilter, 'any'>, { min?: number; max?: number }> = {
  tiny: { max: 16 * KB }, small: { min: 16 * KB, max: MB }, medium: { min: MB, max: 128 * MB },
  large: { min: 128 * MB, max: GB }, huge: { min: GB, max: 4 * GB }, giant: { min: 4 * GB },
};

const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/** Границы дат в местном времени; неделя начинается с понедельника, как в российской Windows. [from, to) */
export function dateRange(filter: Exclude<DateFilter, 'any'>, now: Date): { from?: Date; to?: Date } {
  const today = dayStart(now);
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  switch (filter) {
    case 'today': return { from: today };
    case 'yesterday': return { from: addDays(today, -1), to: today };
    case 'thisWeek': return { from: monday };
    case 'lastWeek': return { from: addDays(monday, -7), to: monday };
    case 'thisMonth': return { from: new Date(today.getFullYear(), today.getMonth(), 1) };
    case 'lastMonth': return { from: new Date(today.getFullYear(), today.getMonth() - 1, 1), to: new Date(today.getFullYear(), today.getMonth(), 1) };
    case 'thisYear': return { from: new Date(today.getFullYear(), 0, 1) };
    case 'older': return { to: new Date(today.getFullYear(), 0, 1) };
  }
}

/** Выбор человека — запрос для моста. Пустые фильтры не попадают в запрос совсем. */
export function toBridgeFilters(ui: SearchUi, now = new Date()): WindowsSearchFilters {
  const out: WindowsSearchFilters = {};
  if (ui.type === 'folders') out.kind = 'directory';
  else if (ui.type !== 'any') { out.kind = 'file'; out.extensions = EXTENSIONS[ui.type]; }
  if (ui.modified !== 'any') {
    const { from, to } = dateRange(ui.modified, now);
    if (from) out.modifiedFrom = from.toISOString();
    if (to) out.modifiedTo = to.toISOString();
  }
  if (ui.size !== 'any') {
    const { min, max } = SIZES[ui.size];
    if (min !== undefined) out.sizeMin = min;
    if (max !== undefined) out.sizeMax = max;
  }
  if (ui.tag.trim()) out.tag = ui.tag.trim();
  if (ui.projectId) out.projectId = ui.projectId;
  if (ui.onlyDrafts) out.onlyDrafts = true;
  return out;
}

/** Сколько фильтров включено — для значка на кнопке и подписей. */
export function activeFilters(ui: SearchUi): string[] {
  const out: string[] = [];
  if (ui.type !== 'any') out.push(`Тип: ${TYPE_LABELS[ui.type]}`);
  if (ui.modified !== 'any') out.push(`Изменён: ${DATE_LABELS[ui.modified]}`);
  if (ui.size !== 'any') out.push(`Размер: ${SIZE_LABELS[ui.size].replace(/ \(.*/, '')}`);
  if (ui.tag.trim()) out.push(`Тег: ${ui.tag.trim()}`);
  if (ui.projectId) out.push('Проект');
  if (ui.onlyDrafts) out.push('Только черновики');
  return out;
}
