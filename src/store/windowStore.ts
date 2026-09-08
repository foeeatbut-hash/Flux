/**
 * Окна рабочего стола: список, порядок наложения и раскладка.
 *
 * Хранилище держит только состояние. Вся геометрия — в src/lib/windows.ts, без
 * React и без DOM: так её удаётся проверить скриптом, а здесь остаётся то, что
 * проверять нечем — кто над кем и что открыто.
 *
 * Раскладка сохраняется за человеком и восстанавливается при следующем входе:
 * оболочку заводят ради того, чтобы вернуться к тем же окнам на тех же местах.
 */
import { create } from 'zustand';
import { resolveSectionPath, resolveSectionHref } from '../lib/sectionAliases';
import {
  initialRect, moveRect, resizeRect, snapRect, toggleMaximize, raise, topWindow,
  refit, tile, type Area, type Edge, type SnapZone, type WinState,
} from '../lib/windows';
import { shareRect } from '../lib/layouts';
import { clampDesk, deskName, reindexWindows, safeDesks, stepDesk } from '../lib/desks';
import { sectionForPath } from '../workspace/sections';

const KEY = 'flux_windows';
const DESKS_KEY = 'flux_desks';

interface WindowState {
  windows: WinState[];
  /** Размер стола: приходит от разметки, нужен геометрии */
  area: Area;
  /** Куда прилипнет окно, если отпустить прямо сейчас — рисуется подсветкой */
  snapping: SnapZone;

  /** Заголовки окон: раздел сообщает, как его сейчас зовут (см. lib/paneTitle) */
  titles: Record<string, string>;
  /** Окно под курсором в списке на панели задач — подсвечивается на столе */
  peeked: string | null;
  /** Рабочие столы: имена в порядке следования. Пустой список — стол один */
  desks: string[];
  /** Какой стол показан сейчас */
  desk: number;

  setArea: (area: Area) => void;
  /**
   * Открыть адрес окном.
   *
   * Адрес, а не раздел: `/constructor?doc=42` и `/constructor?doc=43` — два
   * окна. Уже открытый адрес поднимается вместо второго окна того же.
   */
  open: (href: string) => void;
  /** Ещё одно окно того же раздела: Ctrl+N и «Открыть в новом окне» */
  openAnother: (href: string) => void;
  /** Живое окно ушло на другой адрес — запомнить, иначе окно потеряет себя */
  setHref: (id: string, href: string) => void;
  setTitle: (id: string, title: string) => void;
  setPeeked: (id: string | null) => void;
  close: (id: string) => void;
  focus: (id: string) => void;
  /** Нажали кнопку раздела на панели: свернуть, если это верхнее окно */
  toggle: (path: string) => void;
  minimize: (id: string) => void;
  restore: (id: string) => void;
  maximize: (id: string) => void;
  move: (id: string, dx: number, dy: number) => void;
  resize: (id: string, edge: Edge, dx: number, dy: number) => void;
  setSnapping: (zone: SnapZone) => void;
  applySnap: (id: string, zone: SnapZone) => void;
  tileAll: () => void;
  minimizeAll: () => void;
  /** Поставить окно в готовую долю экрана; прежний размер запоминается */
  putInShare: (id: string, share: { x: number; y: number; w: number; h: number }) => void;
  addDesk: () => void;
  removeDesk: (index: number) => void;
  renameDesk: (index: number, name: string) => void;
  goToDesk: (index: number) => void;
  /** Перенести окно на другой стол — перетаскиванием на карточку или из меню */
  moveToDesk: (id: string, index: number) => void;
}

let seq = 0;
const newId = () => `win-${Date.now().toString(36)}-${seq++}`;

/** Что сохраняем: только раскладку, без размера стола — он свой на каждом экране */
const persist = (windows: WinState[]) => {
  try { localStorage.setItem(KEY, JSON.stringify(windows)); } catch (_) { /* приватный режим */ }
};

function restored(): WinState[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    // Разбираем осторожно: в хранилище могло остаться что угодно от прошлых версий
    return parsed.filter((w: any) => w && typeof w.id === 'string' && typeof w.path === 'string')
      .map((w: any): WinState => ({
        // Путь переименованной программы переводим на новый: иначе окно,
        // открытое до обновления, показало бы Главную вместо документа
        id: w.id, path: resolveSectionPath(w.path), desk: Number(w.desk) || 0,
        // Окна прошлых версий записаны без адреса: считаем адресом сам раздел.
        // Человек увидит привычные окна, просто без открытого документа
        href: resolveSectionHref(typeof w.href === 'string' && w.href ? w.href : w.path),
        x: Number(w.x) || 0, y: Number(w.y) || 0,
        w: Number(w.w) || 720, h: Number(w.h) || 480,
        z: Number(w.z) || 1,
        minimized: !!w.minimized, maximized: !!w.maximized,
        restore: w.restore && typeof w.restore === 'object' ? w.restore : null,
      }));
  } catch (_) { return []; }
}

export const useWindowStore = create<WindowState>((set, get) => {
  const update = (fn: (list: WinState[]) => WinState[]) => {
    const windows = fn(get().windows);
    persist(windows);
    set({ windows });
  };

  return {
    windows: restored(),
    titles: {},
    peeked: null,
    desks: restoredDesks(),
    desk: 0,
    area: { w: 1280, h: 720 },
    snapping: null,

    setArea: (area) => {
      if (area.w < 1 || area.h < 1) return;
      const cur = get().area;
      if (cur.w === area.w && cur.h === area.h) return;
      set({ area, windows: refit(get().windows, area) });
    },

    open: (href) => {
      const { windows } = get();
      const path = pathOf(href);
      // Единичный раздел занимает одно окно и просто переезжает на новый адрес:
      // второе окно Почты не даёт ничего, кроме двух счётчиков непрочитанного
      const multi = !!sectionForPath(path).multi;
      const found = multi
        ? windows.find((w) => w.href === href)
        : windows.find((w) => w.path === path);
      if (found) {
        update((list) => raise(
          list.map((w) => (w.id === found.id ? { ...w, href, minimized: false } : w)),
          found.id,
        ));
        // Документ уже открыт, но на другом столе — уходим туда, а не заводим
        // второе окно того же: иначе одну книгу правили бы два окна сразу
        if (found.desk !== get().desk) set({ desk: found.desk });
        return;
      }
      get().openAnother(href);
    },

    openAnother: (href) => {
      const { windows, area } = get();
      const z = windows.reduce((m, w) => Math.max(m, w.z), 0) + 1;
      const rect = initialRect(area, windows.length);
      update((list) => [...list, {
        id: newId(), path: pathOf(href), href, desk: get().desk, ...rect,
        z, minimized: false, maximized: false, restore: null,
      }]);
    },

    setHref: (id, href) => {
      const w = get().windows.find((x) => x.id === id);
      if (!w || w.href === href) return;
      update((list) => list.map((x) => (x.id === id ? { ...x, href, path: pathOf(href) } : x)));
    },

    setPeeked: (id) => { if (get().peeked !== id) set({ peeked: id }); },

    setTitle: (id, title) => {
      const cur = get().titles[id] || '';
      if (cur === title) return;
      set({ titles: { ...get().titles, [id]: title } });
    },

    close: (id) => {
      update((list) => list.filter((w) => w.id !== id));
      const { [id]: gone, ...rest } = get().titles;
      if (gone !== undefined) set({ titles: rest });
    },
    focus: (id) => update((list) => raise(list.map((w) => (w.id === id ? { ...w, minimized: false } : w)), id)),

    // Повторное нажатие по кнопке верхнего окна сворачивает его — так же
    // ведёт себя панель задач в системе, и на это рассчитывают.
    // Окон у раздела может быть несколько: берём верхнее из них
    toggle: (path) => {
      const { windows, desk } = get();
      // Свой стол вперёд: кнопка на панели показывает окна этого стола, и
      // нажатие обязано отвечать тем же. Окно того же раздела на соседнем
      // столе — повод перейти туда, а не молчать
      const here = windows.filter((w) => w.path === path && w.desk === desk);
      const mine = here.length ? here : windows.filter((w) => w.path === path);
      if (!mine.length) { get().open(path); return; }
      const front = mine.reduce((a, b) => (b.z > a.z ? b : a));
      if (front.desk !== desk) { set({ desk: front.desk }); get().focus(front.id); return; }
      const top = topWindow(windows.filter((w) => w.desk === desk));
      if (top && top.id === front.id && !front.minimized) {
        update((list) => list.map((w) => (w.id === front.id ? { ...w, minimized: true } : w)));
      } else get().focus(front.id);
    },

    minimize: (id) => update((list) => list.map((w) => (w.id === id ? { ...w, minimized: true } : w))),
    restore: (id) => get().focus(id),
    maximize: (id) => update((list) => list.map((w) => (w.id === id ? toggleMaximize(w, get().area) : w))),

    move: (id, dx, dy) => update((list) => list.map((w) => {
      if (w.id !== id) return w;
      // Тащим развёрнутое — оно «отклеивается» и возвращает прежний размер
      const base = w.maximized && w.restore ? { ...w, ...w.restore, maximized: false, restore: null } : w;
      return { ...base, ...moveRect(base, dx, dy, get().area) };
    })),

    resize: (id, edge, dx, dy) => update((list) => list.map((w) => (
      w.id === id ? { ...w, ...resizeRect(w, edge, dx, dy, get().area), maximized: false } : w
    ))),

    setSnapping: (zone) => { if (get().snapping !== zone) set({ snapping: zone }); },

    applySnap: (id, zone) => {
      if (!zone) { set({ snapping: null }); return; }
      const area = get().area;
      update((list) => list.map((w) => {
        if (w.id !== id) return w;
        const rect = snapRect(zone, area);
        return {
          ...w, ...rect,
          maximized: zone === 'top',
          restore: { x: w.x, y: w.y, w: w.w, h: w.h },
        };
      }));
      set({ snapping: null });
    },

    putInShare: (id, share) => {
      const area = get().area;
      const rect = shareRect(share, area);
      update((list) => list.map((w) => {
        if (w.id !== id) return w;
        return {
          ...w, ...rect,
          maximized: false,
          // Прежний размер запоминаем: «Вернуть размер» возвращает именно его,
          // а не выдуманный. Уже стоявшее в доле окно не затирает свою память
          restore: w.restore || { x: w.x, y: w.y, w: w.w, h: w.h },
        };
      }));
      get().focus(id);
    },

    tileAll: () => {
      const here = get().desk;
      const mine = get().windows.filter((w) => w.desk === here);
      const placed = tile(mine, get().area);
      update((list) => list.map((w) => placed.find((p) => p.id === w.id) || w));
    },
    minimizeAll: () => {
      const here = get().desk;
      update((list) => list.map((w) => (w.desk === here ? { ...w, minimized: true } : w)));
    },

    addDesk: () => {
      const desks = [...get().desks, deskName(get().desks.length)];
      persistDesks(desks);
      set({ desks, desk: desks.length - 1 });
    },

    /** Убрать стол; окна с него переезжают на соседний (см. lib/desks) */
    removeDesk: (index) => {
      const { desks } = get();
      if (desks.length <= 1 || index < 0 || index >= desks.length) return;
      const next = desks.filter((_, i) => i !== index);
      persistDesks(next);
      update((list) => reindexWindows(list, index));
      set({ desks: next, desk: clampDesk(get().desk, next.length) });
    },

    renameDesk: (index, name) => {
      const desks = get().desks.map((d, i) => (i === index ? (name.trim() || d) : d));
      persistDesks(desks);
      set({ desks });
    },

    goToDesk: (index) => {
      const { desks } = get();
      if (index < 0 || index >= desks.length || index === get().desk) return;
      set({ desk: index });
    },

    moveToDesk: (id, index) => {
      if (index < 0 || index >= get().desks.length) return;
      update((list) => list.map((w) => (w.id === id ? { ...w, desk: index } : w)));
    },
  };
});

/** Имена столов переживают выход: раскладку заводят не на один раз */
function restoredDesks(): string[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(DESKS_KEY);
    return safeDesks(raw ? JSON.parse(raw) : null);
  } catch (_) { return safeDesks(null); }
}
const persistDesks = (desks: string[]) => {
  try { localStorage.setItem(DESKS_KEY, JSON.stringify(desks)); } catch (_) { /* приватный режим */ }
};

/** Раздел адреса: всё до знака вопроса */
const pathOf = (href: string): string => href.split('?')[0].split('#')[0] || '/';

/**
 * Пути открытых окон в порядке появления — панели задач больше ничего не нужно.
 * Стол задан — считаем только его окна: панель показывает то, что видно.
 */
export const openPaths = (list: WinState[], desk?: number): string[] => {
  const seen: string[] = [];
  for (const w of list) {
    if (desk !== undefined && w.desk !== desk) continue;
    if (!seen.includes(w.path)) seen.push(w.path);
  }
  return seen;
};

/**
 * Окна одного раздела сверху вниз: панель задач показывает их стопкой.
 * Стол задан, если панель показывает окна только текущего стола.
 */
export const windowsOf = (list: WinState[], path: string, desk?: number): WinState[] =>
  list.filter((w) => w.path === path && (desk === undefined || w.desk === desk))
    .sort((a, b) => b.z - a.z);

/** Раздел верхнего окна: его кнопка на панели показывается активной */
export const activeWindowPath = (list: WinState[], desk?: number): string =>
  topWindow(desk === undefined ? list : list.filter((w) => w.desk === desk))?.path || '';
