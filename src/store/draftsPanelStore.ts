import { create } from 'zustand';
import type { WindowsDraftEntry, WindowsDraftListing } from '../../filesystem/contracts';
import { onWindowsFilesChanged, windowsFilesRequest } from '../lib/windowsFiles';

interface Anchor { left: number; top: number; width: number; height: number }
interface DraftsPanelState {
  displayId: number | null; anchor: Anchor | null; entries: WindowsDraftEntry[];
  loading: boolean; error: string; total: number; unavailable: number;
  /** «Разобрать старые»: компактная панель с отбором давних черновиков */
  review: boolean;
  /** Названия проектов для подсказки и групп; принадлежность задаёт привязка папки */
  projectNames: Record<string, string>;
  /** Лист настроек открыт поверх панели */
  sheet: boolean;
  setReview: (review: boolean) => void;
  setSheet: (sheet: boolean) => void;
  toggle: (displayId: number, anchor?: Anchor) => void;
  close: () => void;
  reload: () => Promise<void>;
}
let flight: Promise<void> | null = null;
let again = false;
let generation = 0;
let users = 0;
let profile = '';
let release: (() => void) | undefined;
let refresh: ReturnType<typeof setTimeout> | undefined;
export const useDraftsPanelStore = create<DraftsPanelState>((set, get) => ({
  displayId: null, anchor: null, entries: [], loading: false, error: '', total: 0, unavailable: 0, review: false, sheet: false, projectNames: {},
  setReview: (review) => set({ review }),
  setSheet: (sheet) => set({ sheet }),
  toggle: (displayId, anchor) => set(get().displayId === displayId ? { displayId: null, review: false, sheet: false } : { displayId, anchor: anchor || null }),
  close: () => set({ displayId: null, review: false, sheet: false }),
  reload: async () => {
    if (flight) { again = true; return flight; }
    const epoch = generation;
    flight = (async () => {
      do {
        again = false;
        set({ loading: true, error: '' });
        const entries = new Map<string, WindowsDraftEntry>();
        let offset: number | null = 0, total = 0, unavailable = 0;
        try {
          while (offset !== null) {
            const response = await windowsFilesRequest<WindowsDraftListing>({ action: 'draftsList', offset, limit: 500 });
            if ('error' in response) throw new Error(response.error.message);
            const page = response.data;
            for (const entry of page.entries) if (entry.draftId) entries.set(entry.draftId, entry);
            total = page.total; unavailable += page.unreadableCount;
            if (page.nextOffset !== null && page.nextOffset <= offset) throw new Error('Список черновиков изменился. Обновите панель.');
            offset = page.nextOffset;
            if (epoch !== generation) return;
          }
          if (epoch === generation) set({ entries: [...entries.values()], total, unavailable, loading: false });
        } catch (error) {
          if (epoch === generation) set({ loading: false, error: error instanceof Error ? error.message : 'Черновики недоступны' });
        }
      } while (again && epoch === generation);
    })().finally(() => {
      flight = null;
      // Смена профиля не теряет перечитывание, ожидавшее старый запрос.
      if (again && users > 0) void get().reload();
    });
    return flight;
  },
}));
export function acquireDraftsSource(userId: string) {
  if (profile !== userId) {
    profile = userId; generation++;
    useDraftsPanelStore.setState({ entries: [], total: 0, unavailable: 0, error: '', loading: false, displayId: null });
    if (users) void useDraftsPanelStore.getState().reload();
  }
  if (!users++) {
    release = onWindowsFilesChanged(() => {
      clearTimeout(refresh);
      refresh = setTimeout(() => { void useDraftsPanelStore.getState().reload(); }, 100);
    });
    void useDraftsPanelStore.getState().reload();
  }
  return () => {
    if (!--users) { release?.(); clearTimeout(refresh); generation++; useDraftsPanelStore.getState().close(); }
  };
}
