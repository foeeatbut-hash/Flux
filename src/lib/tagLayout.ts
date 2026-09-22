/**
 * Раскладка дерева тегов на холсте: где стоит карточка и где у неё порты.
 *
 * Отдельно от `tagTree.ts` намеренно: там правила связи («кто кому родитель»),
 * здесь — геометрия («где это нарисовать»). Правила связи одни на программу и
 * от вида холста не зависят; раскладку же человек выбирает сам.
 *
 * Зачем переписано. Прежняя раскладка вела один сквозной счётчик листьев на
 * ВСЕ деревья сразу. Значит второе дерево начиналось там, где кончились листья
 * первого, — строго ниже. Ширина холста при этом почти не использовалась, и
 * человек ездил по полю сверху вниз тем дольше, чем больше в проекте
 * установок. Здесь правило другое и одно на обе оси: **деревья идут в ряд по
 * горизонтали**, а вниз уходит только то, что не поместилось внутри дерева.
 *
 * Две оси нужны потому, что у них разная цена:
 *   — `down` (родитель сверху, дети под ним) — глубина мелкая, три-пять
 *     уровней, поэтому вниз уходит немного, а вширь разносит число листьев;
 *   — `right` (родитель слева, дети правее) — привычный вид спецификации, но
 *     вниз уходит по листу на строку.
 * Что удобнее, зависит от проекта, поэтому выбор оставлен человеку.
 *
 * Модуль ничего не переписывает в дереве: геометрия, которая тихо правит
 * связи, — это ровно тот способ, каким в программу попала перевёрнутая
 * иерархия. Про кольца он только докладывает; выправляет их `repairTagTree`.
 *
 * Без React и без сети: правила проверяются scripts/test-tag-layout.ts.
 */
import type { TreeNode } from './tagTree';

/** Куда растёт дерево. Деревья друг за другом идут вправо при любой оси */
export type TreeAxis = 'down' | 'right';

export interface Point { x: number; y: number }
export interface Placed { id: string; x: number; y: number }
export interface Extent { x: number; y: number; w: number; h: number }

/**
 * Ширина карточки — ровно та, что в разметке (`w-[310px]`).
 *
 * До этого рядом жила константа 330, и два числа расходились на двадцать
 * пикселей. Эти двадцать — не ошибка, а вынос порта за край карточки: кружок
 * порта нарисован с `translate-x-1/2`, то есть половиной висит снаружи, и
 * линия обязана начинаться в нём, а не у рамки. Теперь это сказано вслух.
 */
export const CARD_W = 310;
/** Вынос порта за край карточки: 310 + 20 — то самое прежнее 330 */
export const PORT_STUB = 20;
/** Высота свёрнутой карточки: шапка с кодом, названием и маркой */
export const CARD_H = 96;
/** Боковой порт — на уровне строки с кодом, а не по центру карточки */
export const PORT_Y = 22;

export interface LayoutBox {
  /** Ширина карточки */
  w: number;
  /** Высота: у свёрнутой постоянная, у развёрнутой — измеренная */
  h: number;
  gapX: number;
  gapY: number;
  /** Отбивка между соседними деревьями — заметно шире обычного промежутка */
  treeGap: number;
}

/** Промежутки подобраны так, чтобы шаг по оси `right` остался прежним: 360×150 */
export const DEFAULT_BOX: LayoutBox = { w: CARD_W, h: CARD_H, gapX: 30, gapY: 54, treeGap: 140 };

export const MARGIN_X = 80;
export const MARGIN_Y = 60;

export interface LayoutOptions {
  box?: LayoutBox;
  /** Порядок корней и детей: реестр передаёт код тега */
  keyOf?: (id: string) => string;
  originX?: number;
  originY?: number;
  /**
   * Сколько деревьев ставить в один ряд. Ноль — не переносить вовсе.
   *
   * Считается по числу деревьев, а не по ширине ряда. Ширина обманчива:
   * пока перенос считался по ней, ТРИ установки уже не влезали в строку — и
   * третья уезжала вниз, ровно в ту болезнь, ради которой всё и делалось.
   * Не задано — считает `treesPerRow`.
   */
  perRow?: number;
  /** Округление к сетке холста; 0 — не округлять */
  grid?: number;
}

export interface LayoutResult {
  positions: Record<string, Point>;
  /** Габарит каждого дерева — по нему «Центрировать» вписывает одно дерево */
  trees: { rootId: string; box: Extent }[];
  /** Теги без родителя и без детей: вынесены отдельной полосой */
  parked: string[];
  /** Теги в кольце: обход до них не дошёл. Их выправляет repairTagTree */
  cycled: string[];
  bounds: Extent;
}

// ── Разбор связей ───────────────────────────────────────────────────────────

interface Graph {
  ids: string[];
  children: Map<string, string[]>;
  /** Родитель по спискам детей: список — то, по чему рисуются линии */
  parent: Map<string, string>;
}

/**
 * Собрать связи один раз.
 *
 * `parentOf` из tagTree честно перебирает весь список на каждый вопрос, и для
 * одной карточки это правильно. Но раскладка спрашивает про каждый тег, и на
 * проекте в две тысячи тегов перебор превращается в четыре миллиона сравнений.
 */
function graphOf(nodes: TreeNode[], keyOf: (id: string) => string): Graph {
  const ids = nodes.map((n) => n.id);
  const live = new Set(ids);
  const children = new Map<string, string[]>();
  const parent = new Map<string, string>();
  for (const n of nodes) {
    const seen = new Set<string>();
    const kids: string[] = [];
    for (const c of Array.isArray(n.connections) ? n.connections : []) {
      if (!c || c === n.id || !live.has(c) || seen.has(c)) continue;
      seen.add(c);
      kids.push(c);
      // Первый назвавший и есть родитель: двух родителей у тега не бывает, а
      // если запись двоится, её выправляет repairTagTree при загрузке
      if (!parent.has(c)) parent.set(c, n.id);
    }
    // Порядок детей задаётся кодом тега, а не тем, в каком порядке связи
    // заводили: иначе два нажатия «Упорядочить» дают разную картинку, и это
    // читается как поломка
    kids.sort((a, b) => keyOf(a).localeCompare(keyOf(b), 'ru'));
    children.set(n.id, kids);
  }
  return { ids, children, parent };
}

/**
 * Корни — теги, которых никто не держит ребёнком и у кого есть состав.
 *
 * Одинокий тег корнем не считается: дерево из одной карточки — не дерево, а
 * целая колонка под него впустую съедает ширину поля.
 */
export function rootsOf(nodes: TreeNode[], keyOf: (id: string) => string = (id) => id): string[] {
  const g = graphOf(nodes, keyOf);
  return g.ids
    .filter((id) => !g.parent.has(id) && (g.children.get(id) || []).length > 0)
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b), 'ru'));
}

/** Шаг по оси роста дерева и по оси, вдоль которой расходятся соседи */
function steps(axis: TreeAxis, box: LayoutBox): { grow: number; spread: number } {
  return axis === 'down'
    ? { grow: box.h + box.gapY, spread: box.w + box.gapX }
    : { grow: box.w + PORT_STUB + box.gapX, spread: box.h + box.gapY };
}

interface Local { depth: number; slot: number }

/**
 * Сколько деревьев ставить в ряд.
 *
 * Владелец просил именно ряда — «чтобы не таскаться по полю сверху вниз», —
 * поэтому перенос вообще не должен случаться, пока деревьев мало. Порог в
 * шесть взят не с потолка: это и есть «мало» на глаз, а живая проба показала,
 * что при расчёте по ширине уже ТРЕТЬЯ установка уезжала на вторую строку —
 * ровно та болезнь, которую чинили.
 *
 * Дальше шести ряд всё же переносится: сорок установок в одну строку — это
 * полоса в шестьдесят тысяч пикселей, та же болезнь, только повёрнутая набок.
 * Число рядов подбирается так, чтобы поле вышло близко к пропорциям экрана.
 */
export function treesPerRow(count: number, totalWidth: number, tallest: number): number {
  if (count <= 6) return 0;
  const rows = Math.max(1, Math.round(Math.sqrt(totalWidth / Math.max(1, tallest))));
  return Math.max(6, Math.ceil(count / rows));
}

/**
 * Разместить одно дерево в собственных координатах: глубина и номер дорожки.
 *
 * Родитель встаёт посередине между первым и последним ребёнком — иначе линии
 * к крайним детям идут под разными углами и дерево выглядит завалившимся.
 */
function placeTree(g: Graph, root: string, visited: Set<string>): {
  local: Map<string, Local>; slots: number; depth: number;
} {
  const local = new Map<string, Local>();
  let slot = 0;
  let maxDepth = 0;

  const walk = (id: string, depth: number): number => {
    visited.add(id);
    if (depth > maxDepth) maxDepth = depth;
    const kids = (g.children.get(id) || []).filter((k) => !visited.has(k));
    let center: number;
    if (kids.length === 0) {
      center = slot;
      slot += 1;
    } else {
      const centers = kids.map((k) => walk(k, depth + 1));
      center = (centers[0] + centers[centers.length - 1]) / 2;
    }
    local.set(id, { depth, slot: center });
    return center;
  };

  walk(root, 0);
  return { local, slots: Math.max(1, slot), depth: maxDepth + 1 };
}

/** Габарит одного дерева: по нему деревья и разводятся друг от друга */
export function treeExtent(
  nodes: TreeNode[], root: string, axis: TreeAxis, box: LayoutBox = DEFAULT_BOX,
): { w: number; h: number } {
  const g = graphOf(nodes, (id) => id);
  if (!g.children.has(root)) return { w: 0, h: 0 };
  const { slots, depth } = placeTree(g, root, new Set<string>());
  const s = steps(axis, box);
  const along = depth * s.grow - (axis === 'down' ? box.gapY : box.gapX);
  const across = slots * s.spread - (axis === 'down' ? box.gapX : box.gapY);
  return axis === 'down' ? { w: across, h: along } : { w: along, h: across };
}

const round = (v: number, grid: number): number => (grid > 0 ? Math.round(v / grid) * grid : v);

/**
 * Разложить все деревья проекта.
 *
 * Главное правило: следующее дерево встаёт СПРАВА от предыдущего, а не под
 * ним, — при обеих осях. Ради этого всё и затевалось.
 *
 * Одинокие теги идут отдельной полосой внизу, а не колонкой между деревьями:
 * прежняя раскладка подмешивала их к первому дереву, и человек принимал их за
 * состав установки.
 */
export function layoutForest(nodes: TreeNode[], axis: TreeAxis, opts: LayoutOptions = {}): LayoutResult {
  const box = opts.box || DEFAULT_BOX;
  const keyOf = opts.keyOf || ((id: string) => id);
  const grid = opts.grid === undefined ? 0 : opts.grid;
  const originX = opts.originX === undefined ? MARGIN_X : opts.originX;
  const originY = opts.originY === undefined ? MARGIN_Y : opts.originY;

  const g = graphOf(nodes, keyOf);
  const s = steps(axis, box);
  const visited = new Set<string>();
  const positions: Record<string, Point> = {};
  const trees: { rootId: string; box: Extent }[] = [];

  const roots = rootsOf(nodes, keyOf);

  // Прикидка размеров всех деревьев — по ней решается, сколько их в ряду
  const sizes = new Map<string, { w: number; h: number }>();
  {
    const dry = new Set<string>();
    for (const r of roots) {
      if (dry.has(r)) continue;
      const t = placeTree(g, r, dry);
      sizes.set(r, axis === 'down'
        ? { w: t.slots * s.spread, h: t.depth * s.grow }
        : { w: t.depth * s.grow, h: t.slots * s.spread });
    }
  }
  const totalW = [...sizes.values()].reduce((a, t) => a + t.w + box.treeGap, 0);
  const tallest = [...sizes.values()].reduce((a, t) => Math.max(a, t.h), 1);
  const perRow = opts.perRow === undefined ? treesPerRow(roots.length, totalW, tallest) : opts.perRow;

  let cursorX = originX;
  let rowY = originY;
  let rowH = 0;
  let inRow = 0;

  for (const root of roots) {
    if (visited.has(root)) continue;
    const { local, slots, depth } = placeTree(g, root, visited);
    const width = axis === 'down' ? slots * s.spread : depth * s.grow;
    const height = axis === 'down' ? depth * s.grow : slots * s.spread;

    if (perRow > 0 && inRow >= perRow) {
      cursorX = originX;
      rowY += rowH + box.treeGap;
      rowH = 0;
      inRow = 0;
    }
    inRow++;

    for (const [id, at] of local) {
      const p = axis === 'down'
        ? { x: cursorX + at.slot * s.spread, y: rowY + at.depth * s.grow }
        : { x: cursorX + at.depth * s.grow, y: rowY + at.slot * s.spread };
      positions[id] = { x: round(p.x, grid), y: round(p.y, grid) };
    }
    trees.push({ rootId: root, box: { x: cursorX, y: rowY, w: width - box.gapX, h: height - box.gapY } });

    cursorX += width + box.treeGap;
    if (height > rowH) rowH = height;
  }

  // Всё, до чего обход не дошёл: одиночки и кольца. Кольца отмечаем отдельно —
  // геометрия про них только докладывает, чинит связи repairTagTree
  const rest = g.ids.filter((id) => !visited.has(id));
  const cycled = rest.filter((id) => g.parent.has(id) || (g.children.get(id) || []).length > 0);
  const parked = rest.filter((id) => !cycled.includes(id));

  const bandY = roots.length ? rowY + rowH + box.treeGap : originY;
  // Одиночки — компактной полосой, а не колонкой на весь холст
  const band = parkGrid(rest.length, { x: originX, y: bandY }, box);
  rest.forEach((id, i) => {
    positions[id] = { x: round(band[i].x, grid), y: round(band[i].y, grid) };
  });

  return { positions, trees, parked, cycled, bounds: boundsOf(positions, g.ids, box) };
}

// ── Геометрия связи ─────────────────────────────────────────────────────────

/**
 * Где у карточки порт.
 *
 * До этого числа 330 и 22 были вписаны прямо в четырёх местах реестра — в
 * отрисовке линий, в их обновлении через DOM и дважды в перетаскивании связи.
 * Стоило поменять ширину карточки, и линии начинали целиться мимо, причём не
 * везде сразу.
 *
 * `out` — откуда линия выходит у родителя, `in` — куда приходит у ребёнка.
 * Высоту нижнего порта берут из `box.h`: у развёрнутой карточки она измеренная,
 * иначе линия отрывается от карточки ровно на величину раскрытия.
 */
export function portAt(p: Point, side: 'in' | 'out', axis: TreeAxis, box: LayoutBox = DEFAULT_BOX): Point {
  if (axis === 'down') return { x: p.x + box.w / 2, y: side === 'out' ? p.y + box.h : p.y };
  return { x: side === 'out' ? p.x + box.w + PORT_STUB : p.x, y: p.y + PORT_Y };
}

/** Скругление угла ломаной: без него стык читается как надлом */
const CORNER = 14;

/**
 * Линия между родителем и ребёнком.
 *
 * При `right` — кубическая кривая, как и была: для горизонтального потока она
 * верна, и трогать её значило бы менять картинку без причины.
 *
 * При `down` — ломаная со скруглёнными углами, а не кривая. У десяти братьев
 * под одним родителем кривые расходятся веером и пересекаются между собой;
 * ломаная даёт одну общую горизонтальную шину, от которой ветки уходят вниз, —
 * ровно поэтому так рисуют все оргсхемы.
 */
export function linkPath(from: Point, to: Point, axis: TreeAxis, box: LayoutBox = DEFAULT_BOX): string {
  const a = portAt(from, 'out', axis, box);
  const b = portAt(to, 'in', axis, box);
  if (axis === 'right') {
    const off = Math.max(100, Math.abs(b.x - a.x) * 0.45);
    return `M ${a.x} ${a.y} C ${a.x + off} ${a.y}, ${b.x - off} ${b.y}, ${b.x} ${b.y}`;
  }
  const midY = (a.y + b.y) / 2;
  if (Math.abs(b.x - a.x) < 1) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  const r = Math.min(CORNER, Math.abs(b.x - a.x) / 2, Math.abs(midY - a.y) || CORNER, Math.abs(b.y - midY) || CORNER);
  const dir = b.x > a.x ? 1 : -1;
  return [
    `M ${a.x} ${a.y}`,
    `L ${a.x} ${midY - r}`,
    `Q ${a.x} ${midY} ${a.x + r * dir} ${midY}`,
    `L ${b.x - r * dir} ${midY}`,
    `Q ${b.x} ${midY} ${b.x} ${midY + r}`,
    `L ${b.x} ${b.y}`,
  ].join(' ');
}

/**
 * Середина линии — туда садится крестик «разорвать связь».
 *
 * У кривой это не полусумма концов: при t = 0.5 точка смещена к управляющим
 * точкам, и крестик отъезжал от линии тем дальше, чем круче изгиб. У ломаной
 * середина — центр горизонтальной шины.
 */
export function linkMid(from: Point, to: Point, axis: TreeAxis, box: LayoutBox = DEFAULT_BOX): Point {
  const a = portAt(from, 'out', axis, box);
  const b = portAt(to, 'in', axis, box);
  if (axis === 'down') return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const off = Math.max(100, Math.abs(b.x - a.x) * 0.45);
  return {
    x: 0.125 * a.x + 0.375 * (a.x + off) + 0.375 * (b.x - off) + 0.125 * b.x,
    y: 0.125 * a.y + 0.375 * a.y + 0.375 * b.y + 0.125 * b.y,
  };
}

// ── Габариты, масштаб, сетка ────────────────────────────────────────────────

/** Прямоугольник вокруг расставленных карточек — для «по размеру» */
export function boundsOf(positions: Record<string, Point>, ids: string[], box: LayoutBox = DEFAULT_BOX): Extent {
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  let seen = 0;
  for (const id of ids) {
    const p = positions[id];
    if (!p) continue;
    seen++;
    if (p.x < x1) x1 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.x + box.w > x2) x2 = p.x + box.w;
    if (p.y + box.h > y2) y2 = p.y + box.h;
  }
  if (!seen) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Шаг точечной сетки холста: к ней и прилипают карточки при переносе */
export const GRID = 24;

/**
 * Прилипание к сетке.
 *
 * Сетка нарисована давно, но координаты оставались произвольными — оттого
 * соседние карточки никогда не стояли на одной линии, и ровный ряд получался
 * только случайно.
 */
export const snap = (v: number, step: number = GRID): number => Math.round(v / step) * step;

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 2.5;
/** Одно место вместо трёх переписанных чисел: колесо и обе кнопки */
export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Точка экрана в координатах холста */
export const screenToWorld = (p: Point, pan: Point, zoom: number): Point =>
  ({ x: (p.x - pan.x) / zoom, y: (p.y - pan.y) / zoom });

/**
 * Шаг масштаба с сохранением точки под курсором.
 *
 * Шаг геометрический, а не линейный: при линейном «отдалить и вернуть» не
 * приводит обратно к тому же числу, и масштаб медленно уползает.
 */
export function zoomAt(zoom: number, pan: Point, cursor: Point, steps: number): { zoom: number; pan: Point } {
  const next = clampZoom(zoom * Math.exp(steps * 0.12));
  const world = screenToWorld(cursor, pan, zoom);
  return { zoom: next, pan: { x: cursor.x - world.x * next, y: cursor.y - world.y * next } };
}

/**
 * Масштаб, при котором всё помещается на экран.
 *
 * Верхняя граница 1.1, а не MAX_ZOOM: вписать три карточки на весь экран
 * технически можно, но читать их потом неудобно — они становятся плакатом.
 */
export function fitZoom(ext: Extent, view: { w: number; h: number }, pad = 80): number {
  if (ext.w <= 0 || ext.h <= 0) return 1;
  return Math.min(1.1, clampZoom(Math.min((view.w - pad) / ext.w, (view.h - pad) / ext.h)));
}

/** Сдвиг, при котором прямоугольник встаёт по центру видимой области */
export function centerPan(ext: Extent, view: { w: number; h: number }, zoom: number): Point {
  return { x: view.w / 2 - (ext.x + ext.w / 2) * zoom, y: view.h / 2 - (ext.y + ext.h / 2) * zoom };
}

/** Масштаб и сдвиг «вписать это» одним ответом */
export function fitView(ext: Extent, view: { w: number; h: number }, pad = 80): { zoom: number; pan: Point } {
  const zoom = fitZoom(ext, view, pad);
  return { zoom, pan: centerPan(ext, view, zoom) };
}

// ── Попадание указателем ────────────────────────────────────────────────────

/**
 * Какая карточка под точкой холста.
 *
 * Нужна затем, чтобы связь можно было бросить на ВСЮ карточку, а не только в
 * кружок порта шириной шестнадцать пикселей: сейчас цель ищется исключительно
 * по наведению на порт, и промах читается как «связь не создаётся».
 */
export function hitTestCard(
  positions: Record<string, Point>, world: Point, ids: string[], box: LayoutBox = DEFAULT_BOX,
): string | null {
  // С конца: верхние карточки нарисованы позже и перекрывают нижние
  for (let i = ids.length - 1; i >= 0; i--) {
    const p = positions[ids[i]];
    if (!p) continue;
    if (world.x >= p.x && world.x <= p.x + box.w && world.y >= p.y && world.y <= p.y + box.h) return ids[i];
  }
  return null;
}

/** Что попало в рамку выделения */
export function hitTestBox(
  positions: Record<string, Point>, area: Extent, ids: string[], box: LayoutBox = DEFAULT_BOX,
): string[] {
  const x2 = area.x + area.w; const y2 = area.y + area.h;
  return ids.filter((id) => {
    const p = positions[id];
    return !!p && p.x < x2 && p.x + box.w > area.x && p.y < y2 && p.y + box.h > area.y;
  });
}

/** Прямоугольник по двум углам: рамку тянут в любую сторону */
export const boxFromDrag = (a: Point, b: Point): Extent =>
  ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });

/**
 * Свободное место рядом с заданной точкой: новый тег не должен лечь на чужой.
 *
 * Каскад, а не поиск лучшего места: человек всё равно перетащит карточку туда,
 * куда ему надо, а вот появление тега ПОД другим выглядит как «тег не создался».
 */
export function findFreePosition(taken: Point[], base: Point, box: LayoutBox = DEFAULT_BOX): Point {
  const collides = (x: number, y: number) =>
    taken.some((p) => Math.abs(p.x - x) < box.w + box.gapX && Math.abs(p.y - y) < box.h + 14);
  let x = base.x; let y = base.y;
  for (let attempt = 1; collides(x, y) && attempt < 400; attempt++) {
    y = base.y + (attempt % 16) * 62;
    x = base.x + Math.floor(attempt / 16) * (box.w + box.gapX + 10);
  }
  return { x, y };
}

/**
 * Сетка для тегов, у которых координат в базе не было.
 *
 * Пропорции близки к экранным: колонка на весь холст заставляла бы листать
 * сразу после открытия проекта.
 */
export function parkGrid(count: number, origin: Point, box: LayoutBox = DEFAULT_BOX): Point[] {
  const colW = box.w + box.gapX + 20;
  const rowH = box.h + 34;
  const perRow = Math.max(6, Math.ceil(Math.sqrt((count * rowH * 1.6) / colW)));
  return Array.from({ length: count }, (_, i) => ({
    x: origin.x + (i % perRow) * colW,
    y: origin.y + Math.floor(i / perRow) * rowH,
  }));
}

// ── Теги без координат ──────────────────────────────────────────────────────

/**
 * Метаданные тега к записи — без служебных пометок окна.
 *
 * Ключи на `_` окно вычисляет само при разборе (`_noPos` — «координат в базе
 * нет»). Пока они уезжали в базу вместе с координатами, перенесённый автотег
 * возвращался на место: окно видело свою же пометку и снова ставило карточку
 * в сетку неразмещённых.
 */
export function cleanMeta<T extends object>(meta: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta || {})) if (!k.startsWith('_')) out[k] = v;
  return out as T;
}

/** Тег для раскладки: `at` — координаты из базы; нет их — место выдаётся */
export type PlaceNode = TreeNode & { at?: Point };

/**
 * Места для тегов без координат — такие, что не перескакивают.
 *
 * Прежняя сетка раздавала места по порядку и по ЧИСЛУ неразмещённых: стоило
 * одной карточке уйти из сетки, как число менялось, и все остальные
 * перескакивали на соседние клетки. Теперь место, однажды выданное,
 * помнится (`remembered`) и больше не меняется, а новым тегам места выдаются
 * деревьями по связям родитель—потомок НИЖЕ всего, что уже стоит: ввезённая
 * установка ложится своим деревом, а не россыпью поверх расставленного.
 *
 * `remembered` дополняется новыми местами — это и есть память на сессию.
 */
export function placeUnplaced(
  nodes: PlaceNode[], remembered: Record<string, Point>, axis: TreeAxis,
  opts: { box?: LayoutBox; keyOf?: (id: string) => string } = {},
): Record<string, Point> {
  const box = opts.box || DEFAULT_BOX;
  const out: Record<string, Point> = {};
  const fresh: TreeNode[] = [];
  for (const n of nodes) {
    const p = n.at || remembered[n.id];
    if (p) out[n.id] = p; else fresh.push(n);
  }
  if (!fresh.length) return out;
  const taken = Object.keys(out);
  const b = taken.length ? boundsOf(out, taken, box) : null;
  const res = layoutForest(fresh, axis, {
    box, keyOf: opts.keyOf, grid: GRID,
    originX: b ? snap(Math.min(b.x, MARGIN_X)) : MARGIN_X,
    originY: b ? snap(b.y + b.h + box.treeGap) : MARGIN_Y,
  });
  for (const n of fresh) {
    out[n.id] = res.positions[n.id];
    remembered[n.id] = res.positions[n.id];
  }
  return out;
}
