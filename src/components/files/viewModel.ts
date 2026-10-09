import type { WindowsFileEntry } from '../../lib/windowsFiles';

export type FolderLayout = 'extraLarge' | 'large' | 'medium' | 'small' | 'list' | 'details' | 'tiles' | 'content';
export type FolderSort = 'name' | 'modified' | 'type' | 'size';
export type FolderGroup = 'none' | 'name' | 'type' | 'date' | 'size' | 'project' | 'tags';
export type FolderColumn = 'name' | 'created' | 'modified' | 'type' | 'size' | 'author' | 'tags' | 'project' | 'revision' | 'responsible' | 'storage';

export interface FolderView {
  layout: FolderLayout;
  sort: FolderSort;
  descending: boolean;
  group: FolderGroup;
  columns: FolderColumn[];
  widths: Record<string, number>;
  checkboxes: boolean;
  extensions: boolean;
  hidden: boolean;
}

export const VIEW_LABELS: Record<FolderLayout, string> = {
  extraLarge: 'Огромные значки', large: 'Крупные значки', medium: 'Обычные значки', small: 'Мелкие значки',
  list: 'Список', details: 'Таблица', tiles: 'Плитки', content: 'Содержимое',
};

export const FOLDER_COLUMNS: { id: FolderColumn; label: string }[] = [
  { id: 'name', label: 'Имя' }, { id: 'created', label: 'Дата создания' }, { id: 'modified', label: 'Дата изменения' }, { id: 'type', label: 'Тип' }, { id: 'size', label: 'Размер' }, { id: 'author', label: 'Автор' },
  { id: 'tags', label: 'Теги' }, { id: 'project', label: 'Проект' }, { id: 'revision', label: 'Ревизия' },
  { id: 'responsible', label: 'Ответственный' }, { id: 'storage', label: 'Хранение' },
];
const COLUMN_IDS = new Set<FolderColumn>(FOLDER_COLUMNS.map((column) => column.id));
const LAYOUTS = new Set<FolderLayout>(Object.keys(VIEW_LABELS) as FolderLayout[]);
const SORTS = new Set<FolderSort>(['name', 'modified', 'type', 'size']);
const GROUPS = new Set<FolderGroup>(['none', 'name', 'type', 'date', 'size', 'project', 'tags']);

export const DEFAULT_VIEW: FolderView = {
  layout: 'details', sort: 'name', descending: false, group: 'none',
  columns: ['name', 'modified', 'type', 'size'], widths: { name: 320, modified: 160, type: 140, size: 110 },
  checkboxes: false, extensions: true, hidden: false,
};

/** Проверяет сохранённые настройки: оставляет имя и ограничивает ширину столбцов. */
export function normalizeFolderView(value: unknown): FolderView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_VIEW, columns: [...DEFAULT_VIEW.columns], widths: { ...DEFAULT_VIEW.widths } };
  const input = value as Record<string, unknown>;
  const columnsInput = Array.isArray(input.columns) ? input.columns : DEFAULT_VIEW.columns;
  const columns = [...new Set(columnsInput.filter((column): column is FolderColumn => typeof column === 'string' && COLUMN_IDS.has(column as FolderColumn)))];
  if (!columns.includes('name')) columns.unshift('name');
  const widthsInput = input.widths && typeof input.widths === 'object' && !Array.isArray(input.widths) ? input.widths as Record<string, unknown> : {};
  const widths: Record<string, number> = {};
  for (const column of FOLDER_COLUMNS) {
    const width = widthsInput[column.id];
    widths[column.id] = typeof width === 'number' && Number.isFinite(width) ? Math.min(800, Math.max(60, Math.round(width))) : DEFAULT_VIEW.widths[column.id] ?? 140;
  }
  return {
    layout: LAYOUTS.has(input.layout as FolderLayout) ? input.layout as FolderLayout : DEFAULT_VIEW.layout,
    sort: SORTS.has(input.sort as FolderSort) ? input.sort as FolderSort : DEFAULT_VIEW.sort,
    descending: typeof input.descending === 'boolean' ? input.descending : DEFAULT_VIEW.descending,
    group: GROUPS.has(input.group as FolderGroup) ? input.group as FolderGroup : DEFAULT_VIEW.group,
    columns, widths,
    checkboxes: typeof input.checkboxes === 'boolean' ? input.checkboxes : DEFAULT_VIEW.checkboxes,
    extensions: typeof input.extensions === 'boolean' ? input.extensions : DEFAULT_VIEW.extensions,
    hidden: typeof input.hidden === 'boolean' ? input.hidden : DEFAULT_VIEW.hidden,
  };
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLocaleLowerCase('ru') : '';
}

function compareEntries(a: WindowsFileEntry, b: WindowsFileEntry, sort: FolderSort): number {
  if (sort === 'modified') return (Date.parse(a.modifiedAt) || 0) - (Date.parse(b.modifiedAt) || 0) || a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' });
  if (sort === 'size') return a.size - b.size || a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' });
  if (sort === 'type') return extensionOf(a.name).localeCompare(extensionOf(b.name), 'ru', { numeric: true, sensitivity: 'base' }) || a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' });
  return a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' });
}

export function orderedEntries(entries: WindowsFileEntry[], view: FolderView): WindowsFileEntry[] {
  const direction = view.descending ? -1 : 1;
  return [...entries].sort((a, b) => {
    if ((a.kind === 'directory') !== (b.kind === 'directory')) return a.kind === 'directory' ? -1 : 1;
    const primary = view.group === 'none' ? 0 : groupLabel(a, view.group).localeCompare(groupLabel(b, view.group), 'ru', { numeric: true, sensitivity: 'base' });
    return primary * direction || compareEntries(a, b, view.sort) * direction;
  });
}

export function groupLabel(entry: WindowsFileEntry, group: FolderGroup): string {
  if (group === 'none') return '';
  if (group === 'tags') return entry.metadata?.tags.slice().sort().join(', ') || 'Без тегов';
  if (group === 'project') return (entry.projectNames || entry.metadata?.projectIds)?.slice().sort().join(', ') || 'Без проекта';
  if (group === 'name') return entry.name.slice(0, 1).toLocaleUpperCase('ru') || '#';
  if (group === 'type') return entry.kind === 'directory' ? 'Папки' : extensionOf(entry.name).toLocaleUpperCase('ru') || 'Без расширения';
  if (group === 'size') return entry.kind === 'directory' ? 'Папки' : entry.size === 0 ? 'Пустые' : entry.size < 1024 * 1024 ? 'Маленькие' : entry.size < 100 * 1024 * 1024 ? 'Средние' : 'Большие';
  const date = new Date(entry.modifiedAt);
  return Number.isNaN(date.getTime()) ? 'Неизвестная дата' : new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(date);
}

export type ContentsRow = { kind: 'group'; key: string; label: string } | { kind: 'entry'; key: string; entry: WindowsFileEntry };

/** Строки панели используют тот же порядок, что и клавиатурное перемещение. */
export function contentsRows(entries: WindowsFileEntry[], view: FolderView): ContentsRow[] {
  const ordered = orderedEntries(entries, view);
  if (view.group === 'none') return ordered.map((entry) => ({ kind: 'entry', key: entry.fileId, entry }));
  const rows: ContentsRow[] = [];
  let previous = '';
  for (const entry of ordered) {
    const label = groupLabel(entry, view.group);
    const groupKey = `${entry.kind === 'directory' ? 'Папки' : 'Файлы'} · ${label}`;
    if (groupKey !== previous) {
      rows.push({ kind: 'group', key: `group:${groupKey}:${rows.length}`, label: groupKey });
      previous = groupKey;
    }
    rows.push({ kind: 'entry', key: entry.fileId, entry });
  }
  return rows;
}
