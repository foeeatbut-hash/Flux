/**
 * Геометрия окон рабочего стола: где окно появляется, куда его можно утащить,
 * как меняется размер и к чему оно прилипает.
 *
 * Без React и без DOM. Это единственная часть оконного слоя, где ошибка не
 * видна глазом: окно, уехавшее за край, или размер, схлопнувшийся в ноль,
 * замечаешь уже когда потерял то, что было внутри.
 */

export interface Rect { x: number; y: number; w: number; h: number }

export interface WinState extends Rect {
  id: string;
  /** Раздел: по нему берутся значок, права и правила раздела */
  path: string;
  /**
   * Полный адрес окна вместе с параметрами: `/doc?file=42`.
   *
   * Именно он отличает одно окно от другого. Раздела для этого мало: два
   * документа Конструктора — это два окна одной программы, а не одно окно,
   * в котором второй документ вытесняет первый.
   */
  href: string;
  /**
   * Номер рабочего стола, на котором живёт окно.
   *
   * Столы делят окна, но не файлы: значки, корзина и папки общие. Иначе
   * пришлось бы объяснять, почему документ, положенный на стол, виден не везде.
   */
  desk: number;
  /** Порядок наложения: больше — выше */
  z: number;
  minimized: boolean;
  /** Развёрнуто на весь стол; при этом помним, куда вернуть */
  maximized: boolean;
  restore: Rect | null;
}

export interface Area { w: number; h: number }

/** Ниже этого таблица перестаёт быть таблицей; программа может поднять порог */
export const MIN_W = 420;
export const MIN_H = 260;

/** Насколько окно обязано остаться видимым, если его тащат за край */
const KEEP_VISIBLE = 96;
/** Полоса у края, в которой срабатывает прилипание */
export const SNAP_EDGE = 12;
/** Шаг каскада для нового окна */
const CASCADE = 28;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Первое окно занимает большую часть стола, но не весь: стол должен быть виден */
export function initialRect(area: Area, index: number): Rect {
  const w = Math.round(clamp(area.w * 0.72, MIN_W, Math.max(MIN_W, area.w - 80)));
  const h = Math.round(clamp(area.h * 0.78, MIN_H, Math.max(MIN_H, area.h - 60)));
  // Каскад по кругу: пятое окно ложится туда же, где первое, а не уезжает вниз
  const step = (index % 6) * CASCADE;
  const x = Math.round(clamp(area.w * 0.06 + step, 0, Math.max(0, area.w - w)));
  const y = Math.round(clamp(area.h * 0.06 + step, 0, Math.max(0, area.h - h)));
  return { x, y, w, h };
}

/**
 * Перемещение: окно нельзя увести так, чтобы за него нельзя было ухватиться.
 * По горизонтали держим видимой полосу, по вертикали — верх окна: за нижний
 * край не тащат, а заголовок обязан остаться на экране.
 */
export function moveRect(r: Rect, dx: number, dy: number, area: Area): Rect {
  return {
    ...r,
    x: Math.round(clamp(r.x + dx, KEEP_VISIBLE - r.w, area.w - KEEP_VISIBLE)),
    y: Math.round(clamp(r.y + dy, 0, Math.max(0, area.h - 34))),
  };
}

export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * Изменение размера за любой из восьми краёв. Тянем за верх или за левый край —
 * двигается и начало: иначе окно «убегает» из-под курсора.
 */
export function resizeRect(r: Rect, edge: Edge, dx: number, dy: number, area: Area): Rect {
  let { x, y, w, h } = r;
  if (edge.includes('e')) w = clamp(w + dx, MIN_W, area.w - x);
  if (edge.includes('s')) h = clamp(h + dy, MIN_H, area.h - y);
  if (edge.includes('w')) {
    const right = x + w;
    x = clamp(x + dx, 0, right - MIN_W);
    w = right - x;
  }
  if (edge.includes('n')) {
    const bottom = y + h;
    y = clamp(y + dy, 0, bottom - MIN_H);
    h = bottom - y;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export type SnapZone = 'left' | 'right' | 'top' | null;

/** К какому краю тянут окно прямо сейчас — по положению курсора, не окна */
export function snapZoneAt(px: number, py: number, area: Area): SnapZone {
  if (py <= SNAP_EDGE) return 'top';
  if (px <= SNAP_EDGE) return 'left';
  if (px >= area.w - SNAP_EDGE) return 'right';
  return null;
}

/** Куда окно встанет, если отпустить в этой зоне */
export function snapRect(zone: Exclude<SnapZone, null>, area: Area): Rect {
  if (zone === 'top') return { x: 0, y: 0, w: area.w, h: area.h };
  const w = Math.round(area.w / 2);
  return { x: zone === 'left' ? 0 : area.w - w, y: 0, w, h: area.h };
}

/** Развернуть или вернуть на место — одна кнопка и двойное нажатие по заголовку */
export function toggleMaximize(win: WinState, area: Area): WinState {
  if (win.maximized) {
    const r = win.restore || initialRect(area, 0);
    return { ...win, ...r, maximized: false, restore: null };
  }
  return {
    ...win,
    restore: { x: win.x, y: win.y, w: win.w, h: win.h },
    x: 0, y: 0, w: area.w, h: area.h,
    maximized: true,
  };
}

/** Поднять окно наверх. Возвращает новый список — порядок в массиве не трогаем */
export function raise(list: WinState[], id: string): WinState[] {
  const top = list.reduce((m, w) => Math.max(m, w.z), 0);
  const cur = list.find((w) => w.id === id);
  if (!cur || cur.z === top) return list;
  return list.map((w) => (w.id === id ? { ...w, z: top + 1 } : w));
}

/** Кто сейчас сверху из видимых — им и командует клавиатура */
export function topWindow(list: WinState[]): WinState | null {
  const visible = list.filter((w) => !w.minimized);
  if (!visible.length) return null;
  return visible.reduce((a, b) => (b.z > a.z ? b : a));
}

/**
 * Стол изменился (окно программы стало у́же, монитор другой): вжимаем окна
 * обратно. Развёрнутые остаются развёрнутыми, остальные ужимаются, но не
 * меньше наименьшего размера — потерять окно за краем нельзя.
 */
export function refit(list: WinState[], area: Area): WinState[] {
  return list.map((w) => {
    if (w.maximized) return { ...w, x: 0, y: 0, w: area.w, h: area.h };
    const width = Math.min(w.w, Math.max(MIN_W, area.w));
    const height = Math.min(w.h, Math.max(MIN_H, area.h));
    return {
      ...w,
      w: width,
      h: height,
      x: Math.round(clamp(w.x, KEEP_VISIBLE - width, Math.max(0, area.w - KEEP_VISIBLE))),
      y: Math.round(clamp(w.y, 0, Math.max(0, area.h - 34))),
    };
  });
}

/** Разложить видимые окна по сетке — «прибраться» одной кнопкой */
export function tile(list: WinState[], area: Area): WinState[] {
  const vis = list.filter((w) => !w.minimized);
  if (!vis.length) return list;
  const cols = Math.ceil(Math.sqrt(vis.length));
  const rows = Math.ceil(vis.length / cols);
  const w = Math.floor(area.w / cols);
  const h = Math.floor(area.h / rows);
  const place = new Map<string, Rect>();
  vis.forEach((win, i) => {
    place.set(win.id, { x: (i % cols) * w, y: Math.floor(i / cols) * h, w, h });
  });
  return list.map((win) => {
    const r = place.get(win.id);
    return r ? { ...win, ...r, maximized: false, restore: null } : win;
  });
}
