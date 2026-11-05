/**
 * Настройки панели «Черновики» и её фильтры.
 *
 * Хранятся в localStorage рабочего места, как тема и прозрачность
 * (src/lib/glass.ts): это вид и привычка человека на этом компьютере, а не
 * данные проекта. Фильтры типа и состояния тоже сохраняются — открыл панель
 * завтра и видишь то же, на чём остановился; строка поиска — нет.
 */
import { create } from 'zustand';
import type { DraftGroup, DraftKindFilter, DraftSort, DraftState } from '../lib/draftsPanel';

export interface DraftsSettings {
  view: 'strip' | 'compact';
  rows: 1 | 2; icons: 'S' | 'M' | 'L';
  columns: 3 | 4 | 5 | 6; compactMode: 'grid' | 'list';
  groupLabels: boolean;
  sort: DraftSort; dir: 'asc' | 'desc'; group: DraftGroup;
  scope: 'all' | 'current'; folders: boolean; dots: boolean;
  badge: 'all' | 'unsent' | 'off';
  openOn: 'click' | 'hover'; closeOutside: boolean; dropPublish: boolean;
  /** Напоминать о черновиках старше N дней; 0 — никогда */
  remindDays: 0 | 7 | 14 | 30;
  kind: DraftKindFilter; state: DraftState | null;
  /** Закреплённые первыми — в порядке закрепления */
  pinned: string[];
  /** Старые черновики, которые человек решил оставить: напоминание о них молчит */
  kept: string[];
  /** «Позже»: напоминание спит до этого времени (мс) */
  snoozeUntil: number;
}

export const DRAFTS_DEFAULTS: DraftsSettings = {
  view: 'strip', rows: 1, icons: 'M', columns: 4, compactMode: 'grid', groupLabels: true,
  sort: 'modified', dir: 'desc', group: 'date', scope: 'all', folders: true, dots: true,
  badge: 'unsent', openOn: 'click', closeOutside: true, dropPublish: true, remindDays: 14,
  kind: 'all', state: null, pinned: [], kept: [], snoozeUntil: 0,
};

const KEY = 'flux_drafts_panel';
const pick = <T,>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? value as T : fallback);
const ids = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 500) : [];

/** Чужое или старое значение в хранилище не ломает панель: каждое поле проверяется отдельно. */
export function normalizeDraftsSettings(raw: unknown): DraftsSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DRAFTS_DEFAULTS;
  const bool = (key: keyof DraftsSettings) => typeof r[key] === 'boolean' ? r[key] as boolean : d[key] as boolean;
  return {
    view: pick(r.view, ['strip', 'compact'] as const, d.view),
    rows: pick(r.rows, [1, 2] as const, d.rows),
    icons: pick(r.icons, ['S', 'M', 'L'] as const, d.icons),
    columns: pick(r.columns, [3, 4, 5, 6] as const, d.columns),
    compactMode: pick(r.compactMode, ['grid', 'list'] as const, d.compactMode),
    groupLabels: bool('groupLabels'),
    sort: pick(r.sort, ['modified', 'created', 'name', 'size', 'type', 'project'] as const, d.sort),
    dir: pick(r.dir, ['asc', 'desc'] as const, d.dir),
    group: pick(r.group, ['none', 'date', 'project', 'type', 'state'] as const, d.group),
    scope: pick(r.scope, ['all', 'current'] as const, d.scope),
    folders: bool('folders'), dots: bool('dots'),
    badge: pick(r.badge, ['all', 'unsent', 'off'] as const, d.badge),
    openOn: pick(r.openOn, ['click', 'hover'] as const, d.openOn),
    closeOutside: bool('closeOutside'), dropPublish: bool('dropPublish'),
    remindDays: pick(r.remindDays, [0, 7, 14, 30] as const, d.remindDays),
    kind: pick(r.kind, ['all', 'table', 'doc', 'drawing', 'folder'] as const, d.kind),
    state: pick(r.state, ['draft', 'editing', 'unsent', null] as const, d.state),
    pinned: ids(r.pinned), kept: ids(r.kept),
    snoozeUntil: typeof r.snoozeUntil === 'number' && Number.isFinite(r.snoozeUntil) ? r.snoozeUntil : 0,
  };
}

function load(): DraftsSettings {
  try { return normalizeDraftsSettings(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { return { ...DRAFTS_DEFAULTS }; }
}

interface DraftsSettingsState extends DraftsSettings {
  set: (patch: Partial<DraftsSettings>) => void;
  reset: () => void;
}

export const useDraftsSettings = create<DraftsSettingsState>((set, get) => {
  const save = (next: DraftsSettings) => { try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* приватное окно: настройки живут до перезагрузки */ } };
  const plain = (): DraftsSettings => { const { set: _s, reset: _r, ...rest } = get(); return rest; };
  return {
    ...load(),
    set: (patch) => { set(patch); save(plain()); },
    reset: () => { const keep = { pinned: get().pinned, kept: get().kept }; set({ ...DRAFTS_DEFAULTS, ...keep }); save(plain()); },
  };
});
