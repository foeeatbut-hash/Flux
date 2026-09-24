/**
 * Конструктор: открытая ведомость и её позиции.
 *
 * Все изменения уходят на сервер пакетом (`apply`) и возвращаются строками
 * базы — окно не держит «своей» версии позиции, которая могла бы разойтись с
 * сохранённой. Пакеты складываются в стопку отмены: Ctrl+Z отменяет и правку
 * ячейки, и импорт на сотню строк одинаково.
 */
import { create } from 'zustand';
import type { SelectionItemData } from '../../catalog/selection';
import { catalogService, type SelectionList } from '../services/catalogService';

interface BuilderState {
  projectId: string;
  lists: SelectionList[];
  listId: string;
  list: SelectionList | null;
  items: SelectionItemData[];
  loading: boolean;
  saving: boolean;
  error: string;
  /** Отменяемые действия этой сессии, последнее — сверху */
  undoStack: Array<{ batchId: string; title: string }>;
  loadLists: (projectId: string) => Promise<void>;
  openList: (id: string) => Promise<void>;
  reload: () => Promise<void>;
  createList: (name: string, classId: string, templateId?: string | null) => Promise<void>;
  updateList: (patch: Partial<Pick<SelectionList, 'name' | 'header' | 'orderNos' | 'templateId' | 'lang'>>) => Promise<void>;
  removeList: (id: string) => Promise<void>;
  apply: (title: string, upserts: Array<Partial<SelectionItemData>>, removeIds?: string[]) => Promise<SelectionItemData[]>;
  undo: () => Promise<string>;
}

const LAST_KEY = 'flux_builder_last_list';

export const useBuilderStore = create<BuilderState>((set, get) => ({
  projectId: '',
  lists: [],
  listId: '',
  list: null,
  items: [],
  loading: false,
  saving: false,
  error: '',
  undoStack: [],

  loadLists: async (projectId) => {
    if (!projectId) { set({ projectId: '', lists: [], listId: '', list: null, items: [] }); return; }
    set({ loading: true, error: '', projectId });
    try {
      const { lists } = await catalogService.lists(projectId);
      set({ lists, loading: false });
      // Человек возвращается к той ведомости, с которой ушёл, — в своём проекте
      let last = '';
      try { last = localStorage.getItem(`${LAST_KEY}:${projectId}`) || ''; } catch { /* нет хранилища — откроем первую */ }
      const pick = lists.find((l) => l.id === (get().listId || last)) || lists[0];
      if (pick) await get().openList(pick.id);
      else set({ listId: '', list: null, items: [] });
    } catch (e: any) {
      set({ loading: false, error: e?.message || 'Ведомости не загрузились' });
    }
  },

  openList: async (id) => {
    set({ loading: true, error: '', listId: id, undoStack: get().listId === id ? get().undoStack : [] });
    try {
      const { list, items } = await catalogService.list(id);
      set({ list, items, loading: false });
      try { localStorage.setItem(`${LAST_KEY}:${list.projectId}`, id); } catch { /* не страшно */ }
    } catch (e: any) {
      set({ loading: false, error: e?.message || 'Ведомость не открылась' });
    }
  },

  reload: async () => { if (get().listId) await get().openList(get().listId); },

  createList: async (name, classId, templateId) => {
    const projectId = get().projectId;
    if (!projectId) return;
    const { list } = await catalogService.createList({ projectId, classId, name, templateId });
    set({ lists: [list, ...get().lists] });
    await get().openList(list.id);
  },

  updateList: async (patch) => {
    const id = get().listId;
    if (!id) return;
    set({ saving: true });
    try {
      const { list } = await catalogService.updateList(id, patch);
      set({ list, lists: get().lists.map((l) => (l.id === id ? { ...l, ...list } : l)), saving: false });
    } catch (e) { set({ saving: false }); throw e; }
  },

  removeList: async (id) => {
    await catalogService.removeList(id);
    const lists = get().lists.filter((l) => l.id !== id);
    set({ lists });
    if (get().listId === id) {
      if (lists[0]) await get().openList(lists[0].id);
      else set({ listId: '', list: null, items: [] });
    }
  },

  apply: async (title, upserts, removeIds = []) => {
    const id = get().listId;
    if (!id) throw new Error('Ведомость не открыта');
    set({ saving: true, error: '' });
    try {
      const res = await catalogService.apply(id, title, upserts, removeIds);
      const byId = new Map(get().items.map((it) => [it.id, it]));
      for (const it of res.items) byId.set(it.id, it);
      for (const rid of res.removed || []) byId.delete(rid);
      const items = [...byId.values()].sort((a, b) => a.sort - b.sort);
      set({
        items, saving: false,
        undoStack: res.batchId ? [{ batchId: res.batchId, title }, ...get().undoStack].slice(0, 50) : get().undoStack,
      });
      return res.items;
    } catch (e: any) {
      set({ saving: false, error: e?.message || 'Не сохранилось' });
      throw e;
    }
  },

  undo: async () => {
    const [top, ...rest] = get().undoStack;
    if (!top) return '';
    await catalogService.undo(top.batchId);
    set({ undoStack: rest });
    await get().reload();
    return top.title;
  },
}));

/** Следующий порядковый номер позиции — в конец ведомости */
export const nextSort = (items: SelectionItemData[]) => items.reduce((m, it) => Math.max(m, it.sort || 0), 0) + 1;

/** Временный id для новой позиции: сервер примет его как есть */
export const newItemId = () => {
  try { return crypto.randomUUID(); } catch { /* старый движок */ }
  return `i-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};
