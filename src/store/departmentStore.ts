/**
 * Справочник подразделений в памяти окна.
 *
 * Дерево нужно сразу нескольким местам экрана «Сотрудники» (вкладка, фильтр,
 * карточка, импорт), поэтому оно читается один раз и обновляется по событию
 * сервера `departments:changed` и после собственных правок.
 */
import { create } from 'zustand';
import { departmentService, type DepartmentRow } from '../services/departmentService';

interface DepartmentState {
  departments: DepartmentRow[];
  rootId: string;
  unassigned: number;
  loaded: boolean;
  error: string;
  load: () => Promise<void>;
}

let inflight: Promise<void> | null = null;

export const useDepartmentStore = create<DepartmentState>((set) => ({
  departments: [],
  rootId: '',
  unassigned: 0,
  loaded: false,
  error: '',
  load: () => {
    // Параллельные запросы схлопываются в один: дерево читают сразу несколько компонентов
    inflight ??= departmentService.tree(true)
      .then((r) => set({ departments: r.departments || [], rootId: r.rootId || '', unassigned: r.unassigned || 0, loaded: true, error: '' }))
      .catch((e: any) => set({ error: e?.message || 'Не удалось загрузить подразделения', loaded: true }))
      .finally(() => { inflight = null; });
    return inflight;
  },
}));
