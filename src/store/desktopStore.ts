/**
 * Рабочий стол: что на нём лежит и где именно.
 *
 * Два разных вида содержимого, и различие принципиальное:
 *
 *   — ФАЙЛЫ и ПАПКИ настоящие. Они лежат в Проводнике, в системных папках
 *     «Рабочий стол» — своей у каждого сотрудника и одной общей на проект. Стол
 *     показывает обе слитно; из общей приходят помеченные значки. Отдельного
 *     хранилища у стола нет: файл, положенный на стол, обязан находиться в
 *     архиве проекта, иначе через месяц его никто не найдёт;
 *
 *   — ПРОГРАММЫ (ярлыки разделов) — не файлы. Их нет ни в Проводнике, ни в
 *     базе: это настройка сотрудника, как закреплённые кнопки на панели задач.
 *     Хранится у него же, потому что это его привычка, а не документ проекта.
 *
 * Места значков тоже личные и живут в localStorage: у сотрудников разные
 * мониторы, и раскладка, разумная на 27 дюймах, бессмысленна на ноутбуке.
 * В базе ей делать нечего.
 */
import { create } from 'zustand';
import { dataService } from '../services/dataService';
import { arrange, layout, place, withApps, type Cell, type DeskItem, type DeskKind, type SortBy } from '../lib/desktop';
import { deskMetric, DESK_DEFAULT, type DeskScale } from '../lib/metrics';
import { moveInList } from '../lib/startMenu';
import {
  loadGroups, saveGroups, fold, unfold, withoutItems, rename as renameGroupIn,
  hiddenIds, groupIdOf, type DeskGroup,
} from '../lib/deskGroups';

const CELLS_KEY = 'flux_desk_cells';
const APPS_KEY = 'flux_desk_apps';
const BAR_KEY = 'flux_bar_apps';
const SORT_KEY = 'flux_desk_sort';
const SCALE_KEY = 'flux_desk_scale';

/** Разделы, которые лежат на столе у нового сотрудника */
const DEFAULT_APPS = ['/explorer', '/registry', '/equipment', '/constructor'];

/**
 * Что закреплено на панели задач у нового сотрудника. Дальше это его дело:
 * закрепление — привычка человека, а не свойство раздела. Пока список жил
 * в реестре разделов (`pinned` в sections.tsx), он был одинаков у всех, и
 * открепить лишнее было нельзя вовсе.
 */
const DEFAULT_BAR = ['/registry', '/equipment', '/explorer', '/constructor', '/mail'];

const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch (_) { return fallback; }
};
const write = (key: string, value: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* приватный режим */ }
};

/** Значок открывает документ Конструктора, папку или раздел — по виду файла */
const kindOf = (file: any): DeskKind => {
  if (file.type !== 'CONSTRUCTOR') return 'file';
  return 'doc';
};

interface DesktopState {
  items: DeskItem[];
  apps: string[];
  cells: Record<string, Cell>;
  sortBy: SortBy;
  /**
   * Размер значков — личная настройка, как в системе: за одним столом сидят и
   * с двадцати семи дюймов, и с ноутбука, и мелкие значки для второго не
   * причуда, а единственный способ уместить стол.
   */
  scale: DeskScale;
  setScale: (scale: DeskScale) => void;
  selected: string[];
  loading: boolean;
  error: string;
  /** Куда кладём новое: null — стола ещё нет (не вошли) */
  personalFolderId: string | null;
  sharedFolderId: string | null;

  load: (projectId: string) => Promise<void>;
  select: (ids: string[]) => void;
  setCell: (id: string, cell: Cell, area: { w: number; h: number }) => void;
  arrangeBy: (by: SortBy, area: { w: number; h: number }) => void;
  pinApp: (path: string) => void;
  unpinApp: (path: string) => void;
  /** Переставить закреплённую программу: перетаскивание плиток в Пуске */
  moveApp: (from: number, to: number) => void;
  /**
   * Папки на столе — как в системе: значок на значок и они сложились. Список
   * личный: это способ разложить свой стол, а не свойство проекта.
   */
  groups: DeskGroup[];
  foldIcons: (dragged: string, target: string) => void;
  unfoldIcon: (groupId: string, item: string) => void;
  renameGroup: (groupId: string, name: string) => void;

  /** Закреплённые на панели задач — личный список этого сотрудника */
  bar: string[];
  pinBar: (path: string) => void;
  unpinBar: (path: string) => void;
  createFolder: (projectId: string, scope: 'SHARED' | 'PERSONAL') => Promise<void>;
  createDoc: (projectId: string, kind: 'DOC' | 'TEXT' | 'NOTE', scope: 'SHARED' | 'PERSONAL') => Promise<string | null>;
  rename: (id: string, name: string, projectId: string) => Promise<void>;
  remove: (id: string, projectId: string) => Promise<void>;
  share: (id: string, to: 'SHARED' | 'PERSONAL', projectId: string) => Promise<void>;
  setStatus: (id: string, code: string, projectId: string) => Promise<void>;
  /** Перетащили с Проводника на стол: кладём в свою папку стола */
  acceptDrop: (ids: string[], projectId: string) => Promise<void>;
  /** Сколько лежит в корзине Проводника — числом на значке корзины */
  trashCount: number;
}

/** Имя нового документа: дата, а не «Документ 1» — по ней его потом и ищут */
const newName = (kind: string): string => {
  const d = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  if (kind === 'TEXT') return `Документ — ${d}`;
  if (kind === 'NOTE') return `Заметка — ${d}`;
  return `Таблица — ${d}`;
};

export const useDesktopStore = create<DesktopState>((set, get) => ({
  items: [],
  apps: read<string[]>(APPS_KEY, DEFAULT_APPS),
  bar: read<string[]>(BAR_KEY, DEFAULT_BAR),
  groups: loadGroups(),
  cells: read<Record<string, Cell>>(CELLS_KEY, {}),
  sortBy: read<SortBy>(SORT_KEY, 'name'),
  scale: read<DeskScale>(SCALE_KEY, DESK_DEFAULT),
  selected: [],
  loading: false,
  error: '',
  personalFolderId: null,
  sharedFolderId: null,
  trashCount: 0,

  load: async (projectId) => {
    set({ loading: true, error: '' });
    try {
      const r = await dataService.getDesktop(projectId);
      const files: DeskItem[] = (r.files || []).map((f: any) => ({
        id: f.id,
        kind: kindOf(f),
        name: f.name,
        shared: f.scope !== 'PERSONAL',
        refId: f.refId || null,
        folderId: f.folderId || null,
        status: f.statusCode || 'D',
        revision: f.revision || '1',
        tag: (f.mainTags || [])[0]?.identifier || '',
        updatedBy: f.updatedBy?.name || f.createdBy?.name || '',
        size: Number(f.size) || 0,
        updatedAt: f.updatedAt || f.createdAt || null,
      }));
      const folders: DeskItem[] = (r.folders || []).map((f: any) => ({
        id: f.id, kind: 'folder' as const, name: f.name,
        shared: f.scope !== 'PERSONAL', updatedAt: f.updatedAt || null,
      }));
      set({
        items: [...folders, ...files],
        personalFolderId: r.personalFolderId || null,
        sharedFolderId: r.sharedFolderId || null,
        trashCount: Number(r.trashCount) || 0,
        loading: false,
      });
    } catch (err: any) {
      // Стол без сети не пуст, а неизвестен: показываем это словами, иначе
      // человек решит, что его документы пропали, и начнёт создавать заново
      set({ loading: false, error: err?.message || 'Не удалось прочитать рабочий стол' });
    }
  },

  select: (ids) => set({ selected: ids }),

  setCell: (id, cell, area) => {
    const { items, apps, cells, scale } = get();
    const all = withApps(items, apps);
    const placed = layout(all, cells, area, deskMetric(scale)).cells;
    const next = place(cells, id, cell, placed);
    write(CELLS_KEY, next);
    set({ cells: next });
  },

  arrangeBy: (by, area) => {
    const next = arrange(withApps(get().items, get().apps), by, area, deskMetric(get().scale));
    write(CELLS_KEY, next);
    write(SORT_KEY, by);
    set({ cells: next, sortBy: by });
  },

  // Места значков не сбрасываем: клетка остаётся та же, меняется её размер.
  // Что не влезло в новую сетку, разложит layout — и объявит, если стол мал
  setScale: (scale) => {
    write(SCALE_KEY, scale);
    set({ scale });
  },

  /**
   * Закрепить программу на столе.
   *
   * Закрепление считается по ВИДИМОСТИ, а не по списку. Раньше здесь стоял
   * выход «уже закреплено», и этого хватало, чтобы кнопка перестала работать
   * совсем: значок, однажды убранный в папку, из списка не исчезает — стол
   * прячет его отдельно, по составу папок. Человек нажимал «Закрепить на
   * рабочем столе», список уже содержал путь, папка по-прежнему прятала
   * значок, и на столе не появлялось ничего.
   *
   * Поэтому закрепление всегда вынимает значок из папки. Обратное действие —
   * убрать со стола — заодно чистит состав папок: путь, которого на столе нет,
   * не должен продолжать числиться внутри папки.
   */
  pinApp: (path) => {
    const id = `app:${path}`;
    // withoutItems всегда отдаёт новый массив, поэтому сравнивать надо не
    // ссылки, а факт: числится ли значок хоть в одной папке
    if (get().groups.some((g) => g.items.includes(id))) {
      const groups = withoutItems(get().groups, [id]);
      saveGroups(groups);
      set({ groups });
    }
    if (get().apps.includes(path)) return;
    const apps = [...get().apps, path];
    write(APPS_KEY, apps);
    set({ apps });
  },

  unpinApp: (path) => {
    const id = `app:${path}`;
    if (get().groups.some((g) => g.items.includes(id))) {
      const groups = withoutItems(get().groups, [id]);
      saveGroups(groups);
      set({ groups });
    }
    const apps = get().apps.filter((p) => p !== path);
    write(APPS_KEY, apps);
    set({ apps });
  },

  moveApp: (from, to) => {
    const apps = moveInList(get().apps, from, to);
    if (apps === get().apps) return;
    write(APPS_KEY, apps);
    set({ apps });
  },

  foldIcons: (dragged, target) => {
    const groups = fold(get().groups, dragged, target);
    saveGroups(groups);
    set({ groups });
  },

  unfoldIcon: (groupId, item) => {
    const groups = unfold(get().groups, groupId, item);
    saveGroups(groups);
    set({ groups });
  },

  renameGroup: (groupId, name) => {
    const groups = renameGroupIn(get().groups, groupId, name);
    saveGroups(groups);
    set({ groups });
  },

  pinBar: (path) => {
    if (get().bar.includes(path)) return;
    const bar = [...get().bar, path];
    write(BAR_KEY, bar);
    set({ bar });
  },

  unpinBar: (path) => {
    const bar = get().bar.filter((p) => p !== path);
    write(BAR_KEY, bar);
    set({ bar });
  },

  createFolder: async (projectId, scope) => {
    // Имя уникализируем на клиенте: две «Новые папки» рядом неразличимы
    const base = 'Новая папка';
    const taken = new Set(get().items.map((i) => i.name));
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;
    await dataService.createDesktopFolder(projectId, name, scope);
    await get().load(projectId);
  },

  createDoc: async (projectId, kind, scope) => {
    const r = await dataService.createDesktopDoc(projectId, kind, newName(kind), scope);
    await get().load(projectId);
    return r?.doc?.id || null;
  },

  rename: async (id, name, projectId) => {
    const item = get().items.find((i) => i.id === id);
    if (!item || !name.trim()) return;
    await dataService.renameNode(id, item.kind !== 'folder', name.trim());
    await get().load(projectId);
  },

  remove: async (id, projectId) => {
    const item = get().items.find((i) => i.id === id);
    if (!item) return;
    await dataService.trashNode(id, item.kind !== 'folder');
    // Место освободилось — забываем его, иначе клетка останется занятой
    const cells = { ...get().cells };
    delete cells[id];
    write(CELLS_KEY, cells);
    // Удалённый документ не должен остаться лежать в папке: там он выглядел бы
    // существующим, а открыть его было бы нечем
    const groups = withoutItems(get().groups, [id]);
    saveGroups(groups);
    set({ groups });
    set({ cells, selected: get().selected.filter((s) => s !== id) });
    await get().load(projectId);
  },

  share: async (id, to, projectId) => {
    await dataService.moveDesktopItem(projectId, id, to);
    await get().load(projectId);
  },

  // Статус меняется прямо со стола: чаще всего его и меняют, закончив работу
  // над документом, — а закончив, человек смотрит на стол, а не в Проводник
  setStatus: async (id, code, projectId) => {
    await dataService.setFileStatus(id, code);
    await get().load(projectId);
  },

  // Перенос на стол — обычный перенос в папку Проводника, тем же запросом.
  // Кладём на личный стол: положить документ всем на виду случайным
  // перетаскиванием нельзя, для этого есть отдельное «Положить на общий стол»
  acceptDrop: async (ids, projectId) => {
    const target = get().personalFolderId || get().sharedFolderId;
    if (!target || !ids.length) return;
    await dataService.moveNodes(ids, target);
    await get().load(projectId);
  },
}));
