/**
 * Разметка снимка: геометрия и история, без единого обращения к холсту.
 *
 * Отдельно от рисования по двум причинам. Во-первых, это единственная часть
 * разметки, которую можно проверить без браузера, — а ошибаться здесь дорого:
 * маска, съехавшая на десяток точек, оставляет на снимке ровно то, что человек
 * закрывал. Во-вторых, координаты нормализованы (0…1 от размера снимка), и
 * правило пересчёта должно быть написано один раз: редактор показывает картинку
 * в масштабе 25…400 %, а сохраняется она в своём размере.
 */

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow' | 'pencil' | 'text' | 'mark' | 'mask';

export interface Shape {
  id: string;
  kind: ShapeKind;
  /** Углы или концы — доли от ширины и высоты снимка. */
  x: number; y: number; x2: number; y2: number;
  /** Для карандаша: ломаная теми же долями. */
  points?: Array<{ x: number; y: number }>;
  text?: string;
  /** Номер метки: 1, 2, 3… — по порядку появления. */
  number?: number;
  color: string;
}

/** Область обрезки долями снимка. Пустая — обрезки нет. */
export interface Crop { x: number; y: number; w: number; h: number }

export const WHOLE: Crop = { x: 0, y: 0, w: 1, h: 1 };

/** Меньше этого выделять нечего: попадёт случайное движение мышью. */
export const MIN_REGION_DIP = 16;

/** Насколько увеличивают снимок в редакторе. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

/** Шагов отмены. Больше держать незачем, меньше — уже мешает. */
export const HISTORY_STEPS = 30;

/**
 * Во сколько раз снимок крупнее окна.
 *
 * Считается из фактических размеров, а не умножением на `devicePixelRatio`.
 * Разница видна на втором мониторе с другим масштабом и при масштабе страницы:
 * `devicePixelRatio` там показывает одно, а снимок приходит другого размера — и
 * выделение уезжает тем сильнее, чем дальше от начала координат.
 */
export function scaleOf(
  bitmap: { width: number; height: number }, viewport: { width: number; height: number },
): { x: number; y: number } {
  const x = viewport.width > 0 ? bitmap.width / viewport.width : 1;
  const y = viewport.height > 0 ? bitmap.height / viewport.height : 1;
  return { x: x > 0 ? x : 1, y: y > 0 ? y : 1 };
}

export interface Rect { x: number; y: number; width: number; height: number }

/** Прямоугольник из двух углов: в какую сторону тянули — неважно. */
export function rectOf(ax: number, ay: number, bx: number, by: number): Rect {
  return {
    x: Math.min(ax, bx), y: Math.min(ay, by),
    width: Math.abs(bx - ax), height: Math.abs(by - ay),
  };
}

/**
 * Уложить выделение внутрь снимка.
 *
 * Вылезающее за край выделение — обычное дело: мышь уходит за окно. Обрезаем по
 * границам, а не отказываемся; `null` возвращается только когда после обрезки
 * области не осталось.
 */
export function clampRect(rect: Rect, width: number, height: number, min = MIN_REGION_DIP): Rect | null {
  const x = Math.max(0, Math.min(rect.x, width));
  const y = Math.max(0, Math.min(rect.y, height));
  const right = Math.max(0, Math.min(rect.x + rect.width, width));
  const bottom = Math.max(0, Math.min(rect.y + rect.height, height));
  const out = { x, y, width: right - x, height: bottom - y };
  if (out.width < min || out.height < min) return null;
  return out;
}

/** Доли снимка — в точки его собственного размера. */
export const toPixels = (rect: Crop, width: number, height: number): Rect => ({
  x: Math.round(rect.x * width), y: Math.round(rect.y * height),
  width: Math.round(rect.w * width), height: Math.round(rect.h * height),
});

/** Точки в доли: обратный ход, тот же порядок округления не нужен. */
export const toShare = (rect: Rect, width: number, height: number): Crop => ({
  x: width ? rect.x / width : 0, y: height ? rect.y / height : 0,
  w: width ? rect.width / width : 1, h: height ? rect.height / height : 1,
});

/**
 * Пересчёт разметки после обрезки.
 *
 * Обрезка меняет систему координат: то, что было серединой снимка, может стать
 * его краем. Фигуры за пределами обрезки не переносятся вовсе — их пиксели на
 * сервер не поедут, и оставлять от них стрелку в никуда нельзя.
 */
export function reframe(shapes: Shape[], crop: Crop): Shape[] {
  if (!crop.w || !crop.h) return shapes;
  const move = (x: number, y: number) => ({ x: (x - crop.x) / crop.w, y: (y - crop.y) / crop.h });
  const inside = (p: { x: number; y: number }) => p.x >= -0.02 && p.x <= 1.02 && p.y >= -0.02 && p.y <= 1.02;
  const out: Shape[] = [];
  for (const shape of shapes) {
    const a = move(shape.x, shape.y);
    const b = move(shape.x2, shape.y2);
    if (!inside(a) && !inside(b)) continue;
    out.push({
      ...shape, x: a.x, y: a.y, x2: b.x, y2: b.y,
      ...(shape.points ? { points: shape.points.map((p) => move(p.x, p.y)) } : {}),
    });
  }
  return out;
}

/** Есть ли на снимке хоть одна маска — от этого зависит предупреждение. */
export const hasMask = (shapes: Shape[]): boolean => shapes.some((s) => s.kind === 'mask');

/** Следующий номер метки: по порядку появления, а не по числу фигур. */
export const nextMark = (shapes: Shape[]): number =>
  shapes.reduce((top, s) => (s.kind === 'mark' ? Math.max(top, s.number || 0) : top), 0) + 1;

/**
 * История правок.
 *
 * Ограничена тридцатью шагами: снимок с разметкой — это картинка в памяти, и
 * бесконечная история на нескольких вложениях съедает сотни мегабайт. Отмена
 * работает только внутри редактора: перехватывать Ctrl+Z по всей программе
 * нельзя — человек отменит им не фигуру, а свой текст в форме.
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  constructor(private current: T) {}

  get value(): T { return this.current; }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  push(next: T): void {
    this.past.push(this.current);
    if (this.past.length > HISTORY_STEPS) this.past.shift();
    this.future = [];
    this.current = next;
  }

  undo(): T {
    const previous = this.past.pop();
    if (previous === undefined) return this.current;
    this.future.push(this.current);
    this.current = previous;
    return this.current;
  }

  redo(): T {
    const next = this.future.pop();
    if (next === undefined) return this.current;
    this.past.push(this.current);
    this.current = next;
    return this.current;
  }
}

/** Увеличение в допустимых пределах. */
export const clampZoom = (zoom: number): number => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));

/** Увеличение, при котором снимок целиком помещается в отведённое место. */
export function fitZoom(image: { width: number; height: number }, box: { width: number; height: number }): number {
  if (!image.width || !image.height) return 1;
  return clampZoom(Math.min(box.width / image.width, box.height / image.height));
}
