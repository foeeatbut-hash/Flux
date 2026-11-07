/**
 * Раскладка значков рабочего стола: сетка, свободные клетки, упорядочивание.
 *
 * Без React и без DOM — как и геометрия окон рядом (src/lib/windows.ts), и по
 * той же причине. Ошибки здесь не видны глазом: два значка, попавшие в одну
 * клетку, выглядят как один, а значок, оставшийся за краем после сужения окна,
 * выглядит как пропавший файл. И то и другое человек замечает не сразу, а когда
 * начинает искать документ, который «точно клал на стол».
 *
 * Поэтому раскладка обязана отвечать за три вещи: одна клетка — один значок,
 * ничего не уезжает за край, а то, что не поместилось, честно объявляется
 * (см. overflow в layout) — вместо того чтобы молча исчезнуть.
 */
import { DESK } from './metrics';

/**
 * Что лежит на столе. Программы — не файлы, см. пояснение в desktopStore;
 * «bin» — корзина, тоже системный значок и тоже не файл.
 */
export type DeskKind = 'app' | 'bin' | 'group' | 'folder' | 'doc' | 'text' | 'note' | 'file';

/**
 * Значки, которых нет в Проводнике: они системные, а не документы проекта.
 * Папка-виджет тоже системная: это способ разложить стол, а не место хранения.
 */
export const isSystemKind = (kind: DeskKind): boolean =>
  kind === 'app' || kind === 'bin' || kind === 'group';

export interface DeskItem {
  /** Что лежит в папке-виджете: идентификаторы значков */
  members?: string[];
  /** Для программ — «app:/registry», для остального — идентификатор из базы */
  id: string;
  kind: DeskKind;
  name: string;
  /** Лежит в общей папке стола: видят все, и значок помечается */
  shared: boolean;
  /** Документ Конструктора, который открывает этот значок */
  refId?: string | null;
  /** Раздел программы */
  path?: string;
  /** Папка стола, в которой лежит файл, — по ней его находит Проводник */
  folderId?: string | null;
  /** Основной тег: по нему документ и ищут в проекте */
  tag?: string;
  /** Кто менял последним */
  updatedBy?: string;
  /** Размер в байтах, 0 — неизвестен */
  size?: number;
  /** Когда изменён — для упорядочивания по дате */
  updatedAt?: string | number | null;
}

export interface Cell { col: number; row: number }
export interface DeskArea { w: number; h: number }

/**
 * Клетка и значок — общая мера оболочки (src/lib/metrics.ts), а не число,
 * придуманное здесь: значок на столе обязан быть того же роста, что значок на
 * панели задач и в Пуске.
 *
 * Размер выбирает человек — крупные, обычные, мелкие, как «Вид» в системе.
 * Поэтому всё, что считает клетки, принимает размер параметром; без него берётся
 * обычный. Так старые вызовы (и проверки) остаются верными, а стол умеет
 * перестраиваться, не заводя второй сетки.
 */
export const CELL_W = DESK.normal.w;
export const CELL_H = DESK.normal.h;
/** Отступ от краёв стола: значок у самой кромки трудно поддеть мышью */
export const PAD = 10;

export type CellSize = { w: number; h: number };
const SIZE: CellSize = { w: CELL_W, h: CELL_H };

export interface GridSize { cols: number; rows: number }

export function gridSize(area: DeskArea, size: CellSize = SIZE): GridSize {
  return {
    cols: Math.max(1, Math.floor((area.w - PAD * 2) / size.w)),
    rows: Math.max(1, Math.floor((area.h - PAD * 2) / size.h)),
  };
}

export const cellKey = (c: Cell): string => `${c.col}:${c.row}`;

export const cellToXY = (c: Cell, size: CellSize = SIZE): { x: number; y: number } => ({
  x: PAD + c.col * size.w,
  y: PAD + c.row * size.h,
});

/** Куда попал курсор при перетаскивании. За края не выпускаем */
export function xyToCell(x: number, y: number, area: DeskArea, size: CellSize = SIZE): Cell {
  const { cols, rows } = gridSize(area, size);
  const col = Math.round((x - PAD) / size.w);
  const row = Math.round((y - PAD) / size.h);
  return {
    col: Math.min(cols - 1, Math.max(0, col)),
    row: Math.min(rows - 1, Math.max(0, row)),
  };
}

export const insideGrid = (c: Cell, size: GridSize): boolean =>
  c.col >= 0 && c.row >= 0 && c.col < size.cols && c.row < size.rows;

/**
 * Первая свободная клетка сверху вниз, потом следующий столбец — так
 * заполняется стол в системе, и на это рассчитывают. Если стол полон,
 * возвращаем null: пусть вызывающий скажет об этом вслух, а не кладёт значок
 * поверх чужого.
 */
export function nextFreeCell(taken: Set<string>, size: GridSize): Cell | null {
  for (let col = 0; col < size.cols; col++) {
    for (let row = 0; row < size.rows; row++) {
      const c = { col, row };
      if (!taken.has(cellKey(c))) return c;
    }
  }
  return null;
}

/** Корзина — один значок на стол, а не файл: свой идентификатор ей и не нужен */
export const BIN_ID = 'bin:trash';

/**
 * Системные значки идут наравне с файлами, но приходят не из базы: программы —
 * настройка сотрудника, корзина — вид Проводника. Название значка берёт сам
 * стол из реестра разделов: реестр лежит слоем выше и сюда не попадает.
 *
 * Корзина стоит после программ и всегда последней из системных — так её место
 * не съезжает от закрепления новой программы.
 */
export const withApps = (items: DeskItem[], apps: string[]): DeskItem[] => [
  ...apps.map((path): DeskItem => ({ id: `app:${path}`, kind: 'app', name: path, shared: false, path })),
  { id: BIN_ID, kind: 'bin', name: 'Корзина', shared: false },
  ...items,
];

export type SortBy = 'name' | 'kind' | 'date';


/** Программы всегда впереди файлов: они системные и с места не уходят */
const KIND_ORDER: Record<DeskKind, number> = {
  app: 0, bin: 1, group: 2, folder: 3, doc: 4, text: 5, note: 6, file: 7,
};

const byName = (a: DeskItem, b: DeskItem) => a.name.localeCompare(b.name, 'ru');
const stamp = (i: DeskItem) => (i.updatedAt ? new Date(i.updatedAt).getTime() : 0);

export function sortItems(items: DeskItem[], by: SortBy): DeskItem[] {
  const list = [...items];
  list.sort((a, b) => {
    const sa = isSystemKind(a.kind);
    const sb = isSystemKind(b.kind);
    if (sa && !sb) return -1;
    if (sb && !sa) return 1;
    // Системные значки между собой не сортируем: они стоят в том порядке, в
    // каком их закрепили. Переставлять закреплённое по алфавиту — значит
    // ломать руку, которая уже привыкла тянуться в определённое место
    if (sa && sb) return 0;
    if (by === 'kind') {
      const d = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      if (d) return d;
      return byName(a, b);
    }
    if (by === 'date') {
      const d = stamp(b) - stamp(a);
      if (d) return d;
      return byName(a, b);
    }
    return byName(a, b);
  });
  return list;
}

export interface DeskLayout {
  /** Значок → клетка. Только то, что действительно поместилось */
  cells: Map<string, Cell>;
  /** Что не влезло: стол мал. Показывается отдельной подсказкой, не теряется */
  overflow: DeskItem[];
  size: GridSize;
}

/**
 * Разложить значки: сохранённые места уважаем, остальным ищем свободные клетки.
 *
 * Сохранённое место может оказаться негодным — стол стал у́же, или два значка
 * претендуют на одну клетку (такое бывает после переноса значка на другом
 * мониторе). Тогда значок не пропадает и не ложится поверх соседа, а получает
 * ближайшую свободную клетку.
 */
export function layout(
  items: DeskItem[], saved: Record<string, Cell>, area: DeskArea, cell: CellSize = SIZE,
): DeskLayout {
  const size = gridSize(area, cell);
  const cells = new Map<string, Cell>();
  const taken = new Set<string>();
  const pending: DeskItem[] = [];

  for (const item of items) {
    const want = saved[item.id];
    if (want && insideGrid(want, size) && !taken.has(cellKey(want))) {
      cells.set(item.id, want);
      taken.add(cellKey(want));
    } else {
      pending.push(item);
    }
  }

  const overflow: DeskItem[] = [];
  for (const item of pending) {
    const free = nextFreeCell(taken, size);
    if (!free) { overflow.push(item); continue; }
    cells.set(item.id, free);
    taken.add(cellKey(free));
  }

  return { cells, overflow, size };
}

/** «Упорядочить значки»: разложить всё заново по порядку, забыв прежние места */
export function arrange(
  items: DeskItem[], by: SortBy, area: DeskArea, cell: CellSize = SIZE,
): Record<string, Cell> {
  const size = gridSize(area, cell);
  const out: Record<string, Cell> = {};
  let i = 0;
  for (const item of sortItems(items, by)) {
    const col = Math.floor(i / size.rows);
    const row = i % size.rows;
    if (col >= size.cols) break; // не поместилось — layout объявит это overflow
    out[item.id] = { col, row };
    i++;
  }
  return out;
}

/**
 * Перенос значка в занятую клетку меняет их местами, а не кладёт один поверх
 * другого: потерять значок под значком — та самая невидимая ошибка.
 */
export function place(
  saved: Record<string, Cell>, id: string, target: Cell, cells: Map<string, Cell>,
): Record<string, Cell> {
  const out: Record<string, Cell> = { ...saved };
  const key = cellKey(target);
  let occupant: string | null = null;
  cells.forEach((c, other) => { if (other !== id && cellKey(c) === key) occupant = other; });
  const from = cells.get(id);
  out[id] = target;
  if (occupant && from) out[occupant] = from;
  return out;
}
