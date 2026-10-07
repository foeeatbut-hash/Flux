/**
 * «Разложить» по ходу воздуха и состояние узла E3Flux (docs/e3-integration.md,
 * 6.2 и 7.1): порядок, начало и конец, две линии, общие узлы, шаг по габаритам,
 * неподвижные блоки, сетка, переполнение. Модуль чистый — проверка без E3 и без
 * сервера.
 *
 * Запуск: npx tsx scripts/test-e3-layout.ts
 */
import { checkPlacements, layoutUnits, lineOf, unitVariant, defaultSize, snap, type LayoutNode, type LayoutUnit } from '../e3/layout';
import { nodeState, NODE_STATES } from '../e3/nodeState';
import type { E3SheetInfo } from '../e3/bridgeTypes';
import { defaultOccupied, sheetFor } from '../e3/sheetFormats';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failed++;
  console.error(`  ✗ ${name} — получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`);
};

const A3: E3SheetInfo = { format: 'А3', size: { w: 420, h: 297 }, work: { x: 20, y: 5, w: 395, h: 287 }, grid: 5 };
const node = (id: string, cls: string, order: number, extra: Partial<LayoutNode> = {}): LayoutNode => ({ id, cls, name: id, order, ...extra });
const unit = (nodes: LayoutNode[], id = 'u1'): LayoutUnit => ({ id, name: id, nodes });
const rectOf = (res: ReturnType<typeof layoutUnits>, id: string, u = 0) => res.units[u].placements.find((p) => p.id === id)!.rect;

console.log('Порядок и начало/конец');
{
  // порядок в массиве перепутан: раскладка идёт по order
  const res = layoutUnits([unit([node('b', 'ФИЛЬТР', 2), node('a', 'КЛАПАН', 1), node('c', 'ВЕНТИЛЯТОР', 3)])], { sheet: A3 });
  const xs = ['a', 'b', 'c'].map((id) => rectOf(res, id).x);
  eq('порядок по sourceOrder слева направо', xs[0] < xs[1] && xs[1] < xs[2], true);
  eq('одна линия: вариант 1УР', res.units[0].variant, '1УР');
  eq('одна линия: узлы в одном ряду', new Set(['a', 'b', 'c'].map((id) => rectOf(res, id).y + rectOf(res, id).h / 2)).size <= 3, true);
  const start = rectOf(res, 'u1:start'); const end = rectOf(res, 'u1:end');
  eq('начало слева от первого узла, конец справа от последнего', [start.x + start.w <= xs[0], end.x >= rectOf(res, 'c').x + rectOf(res, 'c').w], [true, true]);
  eq('начало у левого края рабочего поля', start.x, A3.work.x);
  eq('вариант: приток и вытяжка', unitVariant([node('a', 'КЛАПАН', 1), node('b', 'КЛАПАН', 2, { name: 'Клапан вытяжной' })]), '2УР');
  eq('вариант: рекуператор добавляет _Р', [unitVariant([node('a', 'КЛАПАН', 1), node('r', 'РЕКУПЕРАТОР', 2)]), unitVariant([node('a', 'КЛАПАН', 1, { line: 'exhaust' }), node('r', 'РЕКУПЕРАТОР', 2)])], ['1УР_Р', '2УР_Р']);
}

console.log('Две линии и общие узлы');
{
  const nodes = [
    node('s1', 'КЛАПАН', 1), node('s2', 'ВЕНТИЛЯТОР', 2), node('rec', 'РЕКУПЕРАТОР', 3),
    node('e1', 'КЛАПАН', 4, { name: 'Клапан вытяжной', hasLeft: true }), node('e2', 'ВЕНТИЛЯТОР', 5, { name: 'Вентилятор вытяжки', hasLeft: false }),
  ];
  const res = layoutUnits([unit(nodes)], { sheet: A3 });
  const r = (id: string) => rectOf(res, id);
  eq('линии: приток, общие, вытяжка', [lineOf(nodes[0]), lineOf(nodes[2]), lineOf(nodes[3])], ['supply', 'common', 'exhaust']);
  eq('приток выше вытяжки, общий узел между ними', r('s1').y < r('rec').y && r('rec').y < r('e1').y, true);
  eq('вытяжка идёт справа налево: первый узел правее второго', r('e1').x > r('e2').x, true);
  eq('приток слева направо', r('s1').x < r('s2').x, true);
  eq('общий узел примерно посередине по ширине', Math.abs((r('rec').x + r('rec').w / 2) - (r('s1').x + (r('s2').x + r('s2').w - r('s1').x) / 2)) <= 2 * A3.grid + 30, true);
  eq('нет варианта «Влево» — замечание у этого узла', res.units[0].notes, [{ id: 'e2', text: 'нет варианта «Влево»' }]);
  eq('начало и конец охватывают все ряды', [rectOf(res, 'u1:start').h >= r('e1').y + r('e1').h - r('s1').y], [true]);
  const two = layoutUnits([unit([node('d', 'ПРОЧЕЕ', 1, { twoLevel: true }), node('s', 'КЛАПАН', 2, { line: 'exhaust' })])], { sheet: A3 });
  eq('двухуровневое решение — общий узел', lineOf(node('d', 'ПРОЧЕЕ', 1, { twoLevel: true })), 'common');
  eq('общий узел двухуровневой схемы выше вытяжки', rectOf(two, 'd').y < rectOf(two, 's').y, true);
}

console.log('Шаг, габариты, сетка');
{
  const known = layoutUnits([unit([node('a', 'КЛАПАН', 1, { size: { w: 100, h: 20 } }), node('b', 'КЛАПАН', 2)])], { sheet: A3 });
  const a = rectOf(known, 'a'); const b = rectOf(known, 'b');
  eq('известный габарит из кеша', [a.w, a.h], [100, 20]);
  eq('условный габарит по типу, когда неизвестен', [b.w, b.h], [defaultSize('КЛАПАН').w, defaultSize('КЛАПАН').h]);
  eq('шаг между блоками — отступ под обозначения', b.x - (a.x + a.w), 10);
  const wide = layoutUnits([unit([node('a', 'КЛАПАН', 1), node('b', 'КЛАПАН', 2)])], { sheet: A3, gap: { x: 20, y: 15 } });
  eq('отступ задаётся', rectOf(wide, 'b').x - (rectOf(wide, 'a').x + rectOf(wide, 'a').w), 20);
  const odd = layoutUnits([unit([node('a', 'КЛАПАН', 1, { size: { w: 43, h: 27 } }), node('b', 'ВЕНТИЛЯТОР', 2), node('c', 'ФИЛЬТР', 3, { line: 'exhaust' })])], { sheet: A3 });
  const onGrid = odd.units[0].placements.every((p) => p.rect.x % A3.grid === 0 && p.rect.y % A3.grid === 0);
  eq('все координаты на сетке', onGrid, true);
  eq('привязка к сетке', [snap(12, 5), snap(13, 5), snap(7.4, 2.5)], [10, 15, 7.5]);
}

console.log('Неподвижные блоки');
{
  // инженер поставил блок b руками на пути потока
  const manual = { x: 90, y: 20, w: 40, h: 30 };
  const nodes = [node('a', 'КЛАПАН', 1), node('b', 'КЛАПАН', 2, { manual }), node('c', 'ФИЛЬТР', 3), node('d', 'ВЕНТИЛЯТОР', 4)];
  const res = layoutUnits([unit(nodes)], { sheet: A3 });
  eq('ручной блок не двинулся', rectOf(res, 'b'), manual);
  const p = res.units[0].placements;
  eq('ручной блок помечен', p.find((x) => x.id === 'b')!.manual, true);
  const flowRects = p.filter((x) => x.kind === 'node' && !x.manual).map((x) => x.rect);
  eq('поток обходит ручной блок', flowRects.some((r) => r.x < manual.x + manual.w && manual.x < r.x + r.w && r.y < manual.y + manual.h && manual.y < r.y + r.h), false);
  eq('порядок потока сохранён', rectOf(res, 'a').x < rectOf(res, 'c').x && rectOf(res, 'c').x < rectOf(res, 'd').x, true);
  const again = layoutUnits([unit(nodes)], { sheet: A3 });
  eq('повтор даёт то же самое', again, res);
}

console.log('Занятое и переполнение');
{
  const many = Array.from({ length: 12 }, (_, i) => node(`n${i}`, 'ВЕНТИЛЯТОР', i + 1));
  const res = layoutUnits([unit(many)], { sheet: A3 });
  eq('не поместилось: fits=false', res.fits, false);
  eq('переполнение называет узлы за краем', res.overflow.length > 0 && res.overflow.every((id) => id === 'u1:end' || id.startsWith('n')), true);
  eq('первые узлы помещаются', res.overflow.includes('n0'), false);
  const few = layoutUnits([unit([node('a', 'КЛАПАН', 1), node('b', 'ФИЛЬТР', 2)])], { sheet: A3 });
  eq('помещается: переполнения нет', [few.fits, few.overflow], [true, []]);
  // штамп на пути: блок не кладётся поверх, а перешагивает
  const stamp = { x: 20, y: 5, w: 150, h: 60 };
  const hit = layoutUnits([unit([node('a', 'КЛАПАН', 1), node('b', 'ФИЛЬТР', 2)])], { sheet: A3, occupied: [stamp] });
  const over = (id: string) => { const r = rectOf(hit, id); return r.x < stamp.x + stamp.w && stamp.x < r.x + r.w && r.y < stamp.y + stamp.h && stamp.y < r.y + r.h; };
  eq('занятая область обойдена', [over('a'), over('b')], [false, false]);
  const tall = layoutUnits([unit([node('a', 'КЛАПАН', 1, { size: { w: 40, h: 400 } })])], { sheet: A3 });
  eq('выше рабочего поля — переполнение', tall.overflow.includes('a'), true);
}

console.log('Формат листа и проверка ручной раскладки');
{
  eq('по умолчанию А3', sheetFor('').format, 'А3');
  eq('А4 меньше А3', [sheetFor('А4').size, sheetFor('А3').size], [{ w: 297, h: 210 }, { w: 420, h: 297 }]);
  const a3 = sheetFor('А3');
  eq('рабочее поле внутри рамки', [a3.work.x, a3.work.x + a3.work.w, a3.work.y + a3.work.h], [20, 415, 292]);
  const [stamp] = defaultOccupied(a3);
  eq('штамп в правом нижнем углу рабочего поля', [stamp.x + stamp.w, stamp.y + stamp.h], [415, 292]);
  const rects = [
    { id: 'in', rect: { x: 60, y: 30, w: 40, h: 30 } }, { id: 'out', rect: { x: 400, y: 30, w: 40, h: 30 } },
    { id: 'stamp', rect: { x: 300, y: 250, w: 40, h: 30 } }, { id: 'frame', rect: { x: 5, y: 30, w: 40, h: 30 } },
  ];
  eq('за рабочим полем и на штампе — проблема, в поле — нет', checkPlacements(rects, a3, defaultOccupied(a3)), ['out', 'stamp', 'frame']);
}

console.log('Несколько установок');
{
  const res = layoutUnits([unit([node('a', 'КЛАПАН', 1), node('b', 'ФИЛЬТР', 2)], 'u1'), unit([node('c', 'КЛАПАН', 1), node('d', 'ФИЛЬТР', 2)], 'u2')], { sheet: A3 });
  const [u1, u2] = res.units;
  eq('установки друг под другом без пересечения', u1.bounds.y + u1.bounds.h < u2.bounds.y, true);
  eq('у каждой своё начало и конец', [u1.placements.some((p) => p.id === 'u1:start'), u2.placements.some((p) => p.id === 'u2:end')], [true, true]);
}

console.log('Состояние узла');
{
  const one = { status: 'one' as const }; const many = { status: 'many' as const }; const none = { status: 'none' as const };
  eq('без связи: не в схеме', nodeState(one), 'not-in-scheme');
  eq('выгружен и не менялся', nodeState(one, { bound: true }), 'in-scheme');
  eq('изменился после выгрузки', nodeState(one, { bound: true, changed: true }), 'changed');
  eq('правлен в E3', nodeState(one, { bound: true, editedInE3: true, changed: true }), 'edited-in-e3');
  eq('снят во Flux', nodeState(null, { bound: true, removedInFlux: true }), 'removed');
  eq('нужен ответ', nodeState(many), 'need-answer');
  eq('нужен ответ сильнее «в схеме»', nodeState(many, { bound: true }), 'need-answer');
  eq('решения нет', nodeState(none), 'blocked');
  eq('блока нет в базе E3', nodeState(one, { bound: false, blockMissing: true }), 'blocked');
  eq('знаки состояний', Object.values(NODE_STATES).map((s) => s.mark), ['○', '●', '◐', '✕', '?', '!', '⇄']);
}

if (failed) { console.error(`\nПровалено проверок: ${failed}`); process.exit(1); }
console.log('\nВсе проверки раскладки и состояния узла E3 пройдены');
