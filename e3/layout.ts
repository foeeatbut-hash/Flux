/**
 * «Разложить» по ходу воздуха (docs/e3-integration.md, 7.1): чистая раскладка
 * блоков установки на листе. Ни E3, ни экрана здесь нет — только числа в
 * миллиметрах листа, поэтому каждое правило проверяется тестом.
 *
 * Правила:
 *  - порядок узлов — порядок состава установки (`order` = sourceOrder);
 *  - слева «Начало установки», справа «Конец»; вариант выбирается по составу:
 *    одна линия — 1УР, приток и вытяжка — 2УР, рекуператор добавляет «_Р»;
 *  - приток идёт слева направо, вытяжка — справа налево (вариант «Влево», если
 *    он есть; нет — блок ставится как есть и в замечаниях это видно);
 *  - общие узлы (рекуператор, двухуровневые решения) стоят между линиями;
 *  - шаг между блоками — по габаритам с отступом под обозначения; габарит
 *    неизвестен — условный по типу;
 *  - блоки, поставленные руками, не двигаются, а раскладка их обходит;
 *  - координаты привязываются к сетке листа; что не поместилось — в overflow.
 */
import type { E3Rect, E3SheetInfo, E3Size } from './bridgeTypes';

export type E3Line = 'supply' | 'exhaust' | 'common';

export interface LayoutNode {
  id: string;
  /** Тип Flux (equipment/classes) */
  cls: string;
  name: string;
  /** Порядок в составе установки */
  order: number;
  /** Известный габарит из кеша; пусто — условный */
  size?: E3Size;
  /** Решение двухуровневое («Двухуровневая схема = Да») */
  twoLevel?: boolean;
  /** В классификаторе есть вариант решения «Влево» */
  hasLeft?: boolean;
  /** Линия задана явно (инженер переставил) */
  line?: E3Line;
  /** Поставлен руками: не двигается */
  manual?: E3Rect;
}
export interface LayoutUnit { id: string; name: string; nodes: LayoutNode[] }

export interface Placement { id: string; kind: 'node' | 'start' | 'end'; rect: E3Rect; manual?: boolean; line?: E3Line }
export interface UnitLayout {
  id: string;
  /** 1УР, 2УР, 1УР_Р, 2УР_Р */
  variant: string;
  placements: Placement[];
  /** Рамка группы установки */
  bounds: E3Rect;
  notes: { id: string; text: string }[];
}
export interface LayoutResult { units: UnitLayout[]; overflow: string[]; fits: boolean }

export interface LayoutOptions {
  sheet: E3SheetInfo;
  /** Занятое на листе: рамка, штамп, то, что нарисовано в E3 */
  occupied?: E3Rect[];
  /** Отступ между блоками по горизонтали и между рядами, мм */
  gap?: { x: number; y: number };
}

const DEFAULT_GAP = { x: 10, y: 15 };
const END_SIZE: E3Size = { w: 30, h: 40 };

/** Условный габарит по типу Flux, пока настоящий не получен из E3 */
export function defaultSize(cls: string): E3Size {
  switch (cls) {
    case 'КЛАПАН': return { w: 40, h: 30 };
    case 'ВЕНТИЛЯТОР': return { w: 60, h: 45 };
    case 'ФИЛЬТР': return { w: 45, h: 35 };
    case 'НАГРЕВАТЕЛЬ': case 'ОХЛАДИТЕЛЬ': return { w: 50, h: 40 };
    case 'РЕКУПЕРАТОР': return { w: 60, h: 50 };
    default: return { w: 50, h: 40 };
  }
}

export const snap = (v: number, grid: number): number => (grid > 0 ? Math.round(v / grid) * grid : v);
const snapUp = (v: number, grid: number): number => (grid > 0 ? Math.ceil(v / grid) * grid : v);

/** Линия узла: явная, иначе рекуператор и двухуровневые — общие, «вытяжка» в названии — вытяжная */
export function lineOf(n: Pick<LayoutNode, 'cls' | 'name' | 'twoLevel' | 'line'>): E3Line {
  if (n.line) return n.line;
  if (n.cls === 'РЕКУПЕРАТОР' || n.twoLevel) return 'common';
  return /вытяж|удален|exhaust/i.test(n.name) ? 'exhaust' : 'supply';
}

/** Вариант начала и конца установки по составу */
export function unitVariant(nodes: Pick<LayoutNode, 'cls' | 'name' | 'twoLevel' | 'line'>[]): string {
  const lines = nodes.map(lineOf);
  const recup = nodes.some((n) => n.cls === 'РЕКУПЕРАТОР');
  return `${lines.includes('exhaust') ? '2УР' : '1УР'}${recup ? '_Р' : ''}`;
}

const overlaps = (a: E3Rect, b: E3Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const sizeOf = (n: LayoutNode): E3Size => n.size || defaultSize(n.cls);

/** Ряд блоков: идём по x в нужную сторону, обходя неподвижное; возвращает позиции и конец ряда */
function flow(
  list: LayoutNode[], rowY: number, rowH: number, startX: number, dir: 1 | -1, obstacles: E3Rect[], gapX: number, grid: number,
): { placed: { node: LayoutNode; rect: E3Rect }[]; end: number } {
  const placed: { node: LayoutNode; rect: E3Rect }[] = [];
  let cursor = startX;
  for (const node of list) {
    const { w, h } = sizeOf(node);
    const y = snap(rowY + (rowH - h) / 2, grid);
    let x = dir === 1 ? snapUp(cursor, grid) : snap(cursor - w, grid);
    // Неподвижный блок на пути: перешагиваем через него, а не кладём поверх
    for (let guard = 0; guard < 200; guard++) {
      const hit = obstacles.find((o) => overlaps({ x, y, w, h }, o));
      if (!hit) break;
      x = dir === 1 ? snapUp(hit.x + hit.w + gapX, grid) : snap(hit.x - gapX - w, grid);
    }
    placed.push({ node, rect: { x, y, w, h } });
    cursor = dir === 1 ? x + w + gapX : x - gapX;
  }
  return { placed, end: dir === 1 ? cursor - gapX : cursor + gapX };
}

/** Что из уже стоящего на листе вылезло за рабочее поле или лежит на занятом месте (ручная раскладка) */
export function checkPlacements(items: { id: string; rect: E3Rect }[], sheet: E3SheetInfo, occupied: E3Rect[] = []): string[] {
  const a = sheet.work;
  return items.filter(({ rect: r }) => r.x < a.x || r.y < a.y || r.x + r.w > a.x + a.w || r.y + r.h > a.y + a.h || occupied.some((o) => overlaps(r, o))).map((i) => i.id);
}

export function layoutUnits(units: LayoutUnit[], opts: LayoutOptions): LayoutResult {
  const { sheet } = opts;
  const grid = sheet.grid;
  const gap = opts.gap || DEFAULT_GAP;
  const occupied = opts.occupied || [];
  const out: UnitLayout[] = [];
  const overflow: string[] = [];
  let y0 = snapUp(sheet.work.y + gap.y, grid);

  for (const unit of units) {
    const ordered = unit.nodes.map((n, i) => ({ n, i })).sort((a, b) => a.n.order - b.n.order || a.i - b.i).map((x) => x.n);
    const fixed = ordered.filter((n) => n.manual);
    const moving = ordered.filter((n) => !n.manual);
    const obstacles = [...occupied, ...fixed.map((n) => n.manual as E3Rect)];
    const variant = unitVariant(ordered);
    const two = variant.startsWith('2');
    const supply = moving.filter((n) => lineOf(n) === 'supply');
    const exhaust = moving.filter((n) => lineOf(n) === 'exhaust');
    const common = moving.filter((n) => lineOf(n) === 'common');
    const rowH = (list: LayoutNode[], min = 0) => Math.max(min, ...list.map((n) => sizeOf(n).h));

    // Одна линия: общие узлы стоят в ряду по порядку состава; две — между линиями
    const mainRow = two ? supply : moving.filter((n) => lineOf(n) !== 'exhaust');
    const hMain = rowH(mainRow, END_SIZE.h);
    const hCommon = two && common.length ? rowH(common) : 0;
    const hExh = two ? rowH(exhaust) : 0;
    const yMain = y0;
    const yCommon = yMain + hMain + gap.y;
    const yExh = two ? yCommon + (hCommon ? hCommon + gap.y : 0) : yMain;
    const total = two ? yExh + hExh - y0 : hMain;

    const x0 = snapUp(sheet.work.x + END_SIZE.w + gap.x, grid);
    const main = flow(mainRow, yMain, hMain, x0, 1, obstacles, gap.x, grid);
    const comm = flow(common, yCommon, hCommon, x0, 1, obstacles, gap.x, grid);
    // Вытяжка идёт справа налево от правого края самой длинной линии
    const rightEdge = Math.max(main.end, comm.end, ...(two ? [x0 + exhaust.reduce((s, n) => s + sizeOf(n).w + gap.x, 0) - gap.x] : [x0]));
    // Общие узлы — по середине между линиями
    const commW = comm.placed.length ? comm.end - x0 : 0;
    const shift = snap(Math.max(0, (rightEdge - x0 - commW) / 2), grid);
    for (const p of comm.placed) p.rect = { ...p.rect, x: p.rect.x + shift };
    const exh = flow(exhaust, yExh, hExh, rightEdge, -1, obstacles, gap.x, grid);
    const flowRight = Math.max(rightEdge, ...exh.placed.map((p) => p.rect.x + p.rect.w), ...comm.placed.map((p) => p.rect.x + p.rect.w));

    const placements: Placement[] = [
      { id: `${unit.id}:start`, kind: 'start', rect: { x: snap(sheet.work.x, grid), y: yMain, w: END_SIZE.w, h: total } },
      ...main.placed.map((p) => ({ id: p.node.id, kind: 'node' as const, rect: p.rect, line: lineOf(p.node) })),
      ...comm.placed.map((p) => ({ id: p.node.id, kind: 'node' as const, rect: p.rect, line: 'common' as const })),
      ...exh.placed.map((p) => ({ id: p.node.id, kind: 'node' as const, rect: p.rect, line: 'exhaust' as const })),
      { id: `${unit.id}:end`, kind: 'end', rect: { x: snapUp(flowRight + gap.x, grid), y: yMain, w: END_SIZE.w, h: total } },
      ...fixed.map((n) => ({ id: n.id, kind: 'node' as const, rect: n.manual as E3Rect, manual: true, line: lineOf(n) })),
    ];
    const notes = exhaust.filter((n) => n.hasLeft === false).map((n) => ({ id: n.id, text: 'нет варианта «Влево»' }));

    const flowRects = placements.filter((p) => !p.manual).map((p) => p.rect);
    const minX = Math.min(...flowRects.map((r) => r.x)); const minY = Math.min(...flowRects.map((r) => r.y));
    const maxX = Math.max(...flowRects.map((r) => r.x + r.w)); const maxY = Math.max(...flowRects.map((r) => r.y + r.h));
    const bounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

    const area = sheet.work;
    for (const p of placements) {
      const r = p.rect;
      const outside = r.x < area.x || r.y < area.y || r.x + r.w > area.x + area.w || r.y + r.h > area.y + area.h;
      // Неподвижное уже стоит в obstacles, поэтому с ним сравниваются только занятые области
      const hits = (p.manual ? occupied : obstacles.filter((o) => o !== p.rect)).some((o) => overlaps(r, o));
      if (!p.manual ? outside || hits : outside) overflow.push(p.id);
    }
    out.push({ id: unit.id, variant, placements, bounds, notes });
    y0 = snapUp(bounds.y + bounds.h + gap.y * 2, grid);
  }
  return { units: out, overflow, fits: overflow.length === 0 };
}
