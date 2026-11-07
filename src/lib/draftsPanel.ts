/**
 * Панель «Черновики»: что показывать и в каком порядке.
 *
 * Чистые функции без React и моста — их проверяет scripts/test-drafts-view.ts.
 * Источник один (draftsPanelStore), а полоса и компактная панель лишь по-разному
 * раскладывают то, что здесь отобрано и упорядочено.
 */
import type { WindowsDraftEntry } from '../../filesystem/contracts';

export type DraftKind = 'table' | 'doc' | 'drawing' | 'folder' | 'other';
export type DraftKindFilter = 'all' | Exclude<DraftKind, 'other'>;
/** Состояние файла — точка и слово (01-design.md, «Смысловые цвета»). */
export type DraftState = 'draft' | 'editing' | 'unsent';
export type DraftSort = 'modified' | 'created' | 'name' | 'size' | 'type' | 'project';
export type DraftGroup = 'none' | 'date' | 'project' | 'type' | 'state';

export const KIND_FILTERS: { id: DraftKindFilter; label: string; short: string }[] = [
  { id: 'all', label: 'Все', short: 'Все' },
  { id: 'table', label: 'Таблицы', short: 'Таблицы' },
  { id: 'doc', label: 'Документы', short: 'Документы' },
  { id: 'drawing', label: 'Чертежи и PDF', short: 'Чертежи' },
  { id: 'folder', label: 'Папки', short: 'Папки' },
];
export const STATE_LABEL: Record<DraftState, string> = { draft: 'черновик', editing: 'правится', unsent: 'не в проекте' };
export const STATE_ORDER: DraftState[] = ['draft', 'editing', 'unsent'];
export const SORT_LABEL: Record<DraftSort, string> = { modified: 'Изменён', created: 'Создан', name: 'Имя', size: 'Размер', type: 'Тип', project: 'Проект' };
/** Порядок, в котором кнопка сортировки перебирает ключи (лист «Compact»). */
export const SORT_CYCLE: DraftSort[] = ['modified', 'size', 'name', 'type', 'project'];

const KIND_BY_EXT: Record<string, DraftKind> = {
  xlsx: 'table', xls: 'table', xlsm: 'table', csv: 'table', ods: 'table',
  docx: 'doc', doc: 'doc', txt: 'doc', md: 'doc', rtf: 'doc', odt: 'doc',
  pdf: 'drawing', dwg: 'drawing', dxf: 'drawing',
};

export function draftExt(entry: Pick<WindowsDraftEntry, 'name' | 'kind'>): string {
  if (entry.kind === 'directory') return '';
  const dot = entry.name.lastIndexOf('.');
  return dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : '';
}
export function draftKind(entry: Pick<WindowsDraftEntry, 'name' | 'kind'>): DraftKind {
  if (entry.kind === 'directory') return 'folder';
  return KIND_BY_EXT[draftExt(entry)] ?? 'other';
}
/** Метка на значке: XLSX, DOCX, PDF… Длинные расширения обрезаются, чтобы метка не вылезала за лист. */
export const extLabel = (entry: Pick<WindowsDraftEntry, 'name' | 'kind'>) => draftExt(entry).slice(0, 4).toUpperCase();

export type DraftProjectOf = (entry: WindowsDraftEntry) => string | null;
const noProject: DraftProjectOf = () => null;

export function draftState(entry: WindowsDraftEntry, openDrafts: ReadonlySet<string>, projectOf: DraftProjectOf = noProject): DraftState {
  if (entry.draftId && openDrafts.has(entry.draftId)) return 'editing';
  return projectOf(entry) ? 'draft' : 'unsent';
}

export interface DraftsQuery {
  kind: DraftKindFilter; state: DraftState | null; text: string;
  folders: boolean; scope: 'all' | 'current'; projectId?: string | null;
  /** Только черновики старше стольких дней — режим «Разобрать старые» */
  olderThanDays?: number; now?: number; openDrafts: ReadonlySet<string>;
}

const DAY = 86_400_000;
const time = (iso: string | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : 0; };

export const isOld = (entry: WindowsDraftEntry, days: number, now: number) => days > 0 && time(entry.modifiedAt) > 0 && now - time(entry.modifiedAt) > days * DAY;

/** Черновики, которые видит панель до фильтров типа и состояния: настройки «Что показывать». */
export function scopedDrafts(entries: readonly WindowsDraftEntry[], q: Pick<DraftsQuery, 'folders' | 'scope' | 'projectId'>, projectOf: DraftProjectOf = noProject): WindowsDraftEntry[] {
  return entries.filter((entry) => (q.folders || entry.kind !== 'directory')
    && (q.scope === 'all' || !q.projectId || projectOf(entry) === q.projectId));
}

export function filterDrafts(entries: readonly WindowsDraftEntry[], q: DraftsQuery, projectOf: DraftProjectOf = noProject): WindowsDraftEntry[] {
  const text = q.text.trim().toLocaleLowerCase('ru');
  const now = q.now ?? Date.now();
  return scopedDrafts(entries, q, projectOf).filter((entry) => (q.kind === 'all' || draftKind(entry) === q.kind)
    && (!q.state || draftState(entry, q.openDrafts, projectOf) === q.state)
    && (!text || entry.name.toLocaleLowerCase('ru').includes(text))
    && (!q.olderThanDays || isOld(entry, q.olderThanDays, now)));
}

const projectKey = (entry: WindowsDraftEntry, projectOf: DraftProjectOf) => projectOf(entry) || '';

export function sortDrafts(entries: readonly WindowsDraftEntry[], sort: DraftSort, dir: 'asc' | 'desc', pinned: readonly string[] = [], projectOf: DraftProjectOf = noProject): WindowsDraftEntry[] {
  const sign = dir === 'desc' ? -1 : 1;
  const name = (a: WindowsDraftEntry, b: WindowsDraftEntry) => a.name.localeCompare(b.name, 'ru', { numeric: true });
  const by: Record<DraftSort, (a: WindowsDraftEntry, b: WindowsDraftEntry) => number> = {
    modified: (a, b) => time(a.modifiedAt) - time(b.modifiedAt),
    created: (a, b) => time(a.createdAt || a.modifiedAt) - time(b.createdAt || b.modifiedAt),
    name,
    size: (a, b) => (a.size || 0) - (b.size || 0),
    type: (a, b) => draftKind(a).localeCompare(draftKind(b)) || draftExt(a).localeCompare(draftExt(b)),
    project: (a, b) => projectKey(a, projectOf).localeCompare(projectKey(b, projectOf), 'ru'),
  };
  const pin = (entry: WindowsDraftEntry) => { const index = entry.draftId ? pinned.indexOf(entry.draftId) : -1; return index < 0 ? Infinity : index; };
  // Закреплённые всегда впереди и в порядке закрепления; при равенстве ключа — по имени, чтобы порядок не прыгал между обновлениями.
  return [...entries].sort((a, b) => (pin(a) - pin(b)) || (by[sort](a, b) * sign) || name(a, b));
}

export type DateGroup = 'Сегодня' | 'Вчера' | 'Неделя' | 'Раньше';
const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export function dateGroup(iso: string | undefined, now = Date.now()): DateGroup {
  const t = time(iso);
  const today = dayStart(now);
  if (t >= today) return 'Сегодня';
  if (t >= today - DAY) return 'Вчера';
  if (t >= today - 6 * DAY) return 'Неделя';
  return 'Раньше';
}

const WEEKDAY = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const two = (n: number) => String(n).padStart(2, '0');
/** Короткое время под плиткой: сегодня и вчера — часы, на неделе — день недели, раньше — дата. */
export function shortWhen(iso: string | undefined, now = Date.now()): string {
  const t = time(iso);
  if (!t) return '—';
  const d = new Date(t);
  const group = dateGroup(iso, now);
  if (group === 'Сегодня') return `${d.getHours()}:${two(d.getMinutes())}`;
  if (group === 'Вчера') return `вчера ${d.getHours()}:${two(d.getMinutes())}`;
  if (group === 'Неделя') return WEEKDAY[d.getDay()];
  return d.getFullYear() === new Date(now).getFullYear() ? `${two(d.getDate())}.${two(d.getMonth() + 1)}` : `${two(d.getDate())}.${two(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}

export function formatSize(bytes: number | undefined): string {
  const b = bytes || 0;
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} КБ`;
  return `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

export interface DraftsSection { key: string; label: string; items: WindowsDraftEntry[] }

/**
 * Разбивка уже упорядоченного списка на группы. Порядок внутри группы — тот,
 * что дала сортировка; сами группы — в порядке первого появления, а у дат —
 * всегда от свежих к старым, иначе «Раньше» оказывалась бы впереди «Сегодня».
 */
export function groupDrafts(sorted: readonly WindowsDraftEntry[], group: DraftGroup, opts: { now?: number; openDrafts: ReadonlySet<string>; projectName?: (id: string) => string; pinned?: readonly string[]; projectOf?: DraftProjectOf }): DraftsSection[] {
  if (group === 'none') return [{ key: 'all', label: '', items: [...sorted] }];
  // Закреплённые — своя первая группа: иначе «первым» было бы только внутри «Раньше» или «Проект».
  const pinnedIds = new Set(opts.pinned || []);
  const pinnedItems = sorted.filter((entry) => entry.draftId && pinnedIds.has(entry.draftId));
  if (pinnedItems.length) {
    const rest = groupDrafts(sorted.filter((entry) => !(entry.draftId && pinnedIds.has(entry.draftId))), group, { ...opts, pinned: [] });
    return [{ key: 'pinned', label: 'Закреплённые', items: pinnedItems }, ...rest];
  }
  const keyOf = (entry: WindowsDraftEntry): [string, string] => {
    if (group === 'date') { const g = dateGroup(entry.modifiedAt, opts.now); return [g, g]; }
    if (group === 'project') { const id = projectKey(entry, opts.projectOf || noProject); return [id || '-', id ? opts.projectName?.(id) || 'Проект' : 'Без проекта']; }
    if (group === 'type') { const kind = draftKind(entry); return [kind, KIND_FILTERS.find((k) => k.id === kind)?.short || 'Другое']; }
    const state = draftState(entry, opts.openDrafts, opts.projectOf); return [state, STATE_LABEL[state]];
  };
  const map = new Map<string, DraftsSection>();
  for (const entry of sorted) {
    const [key, label] = keyOf(entry);
    if (!map.has(key)) map.set(key, { key, label, items: [] });
    map.get(key)!.items.push(entry);
  }
  const sections = [...map.values()];
  if (group === 'date') { const order: string[] = ['Сегодня', 'Вчера', 'Неделя', 'Раньше']; sections.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)); }
  return sections;
}

/** Число на кнопке панели задач: «не в проекте» по умолчанию, все или ничего — настройка. */
export function badgeCount(entries: readonly WindowsDraftEntry[], mode: 'all' | 'unsent' | 'off', openDrafts: ReadonlySet<string>, projectOf: DraftProjectOf = noProject): number {
  if (mode === 'off') return 0;
  return mode === 'all' ? entries.length : entries.filter((entry) => draftState(entry, openDrafts, projectOf) === 'unsent').length;
}

/** Открытые в окнах черновики: «правится» — открыт у вас (адрес окна несёт draft=…). */
export function openDraftIds(hrefs: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const href of hrefs) {
    if (!href.startsWith('/windows-file')) continue;
    const id = new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('draft');
    if (id) ids.add(id);
  }
  return ids;
}

/** «Документ (2).docx» — то же правило свободного имени, что у Проводника при «Оставить оба». */
export function numberedName(name: string, n: number, isDirectory: boolean): string {
  if (n < 2) return name;
  const dot = isDirectory ? -1 : name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}
