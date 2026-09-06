/**
 * Раскладка дерева тегов: деревья стоят в ряд, а не столбиком.
 *
 * Проверять это глазами бесполезно: на трёх учебных тегах любая раскладка
 * выглядит опрятно, а разъезжается она на настоящем проекте, где установок
 * два десятка. Здесь у раскладки спрашивают то, ради чего её переписывали:
 * ушло ли второе дерево ВПРАВО от первого, а не под него, — и то, без чего
 * любая раскладка бесполезна: не легли ли карточки друг на друга и не потерялся
 * ли по дороге хоть один тег.
 *
 * Запуск: npx tsx scripts/test-tag-layout.ts
 */
import { readFileSync } from 'fs';
import {
  rootsOf, layoutForest, treeExtent, boundsOf, portAt, linkPath, linkMid,
  snap, clampZoom, zoomAt, screenToWorld, fitZoom, fitView, centerPan, treesPerRow,
  hitTestCard, hitTestBox, boxFromDrag, findFreePosition, parkGrid,
  DEFAULT_BOX, CARD_W, CARD_H, PORT_STUB, PORT_Y, MARGIN_X, MARGIN_Y, GRID,
  type TreeAxis, type Point,
} from '../src/lib/tagLayout';
import type { TreeNode } from '../src/lib/tagTree';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

/** Приточная установка: компоненты и их элементы */
const ahu = (n: string): TreeNode[] => [
  { id: n, connections: [`${n}-клапан`, `${n}-вентилятор`, `${n}-калорифер`] },
  { id: `${n}-клапан`, connections: [`${n}-привод`], parentId: n },
  { id: `${n}-вентилятор`, connections: [`${n}-мотор`], parentId: n },
  { id: `${n}-калорифер`, connections: [], parentId: n },
  { id: `${n}-привод`, connections: [], parentId: `${n}-клапан` },
  { id: `${n}-мотор`, connections: [], parentId: `${n}-вентилятор` },
];

const THREE: TreeNode[] = [...ahu('В-1'), ...ahu('В-2'), ...ahu('В-3')];
/** Без переноса ряда: три дерева обязаны стоять именно в одну строку */
const ONE_ROW = { perRow: 0 };

console.log('Корни находятся и стоят в понятном порядке');
{
  check('три установки — три корня', rootsOf(THREE).join() === 'В-1,В-2,В-3', rootsOf(THREE));
  check('элемент корнем не считается', !rootsOf(THREE).includes('В-1-привод'));
  // Одинокая карточка — не дерево: колонка под неё съедала бы ширину поля зря
  check('одинокий тег корнем не считается', rootsOf([{ id: 'сам-по-себе', connections: [] }]).length === 0);
  check('порядок устойчив к порядку в списке',
    rootsOf(THREE).join() === rootsOf([...THREE].reverse()).join());
  check('порядок задаётся ключом снаружи',
    rootsOf(THREE, (id) => ({ 'В-1': 'я', 'В-2': 'б', 'В-3': 'а' } as any)[id] || id).join() === 'В-3,В-2,В-1');
}

for (const axis of ['down', 'right'] as TreeAxis[]) {
  console.log(`Ось «${axis}»: деревья идут в ряд`);
  const res = layoutForest(THREE, axis, ONE_ROW);
  const pos = res.positions;
  const at = (id: string) => pos[id];

  // Тег без координаты — это пропавшая с холста карточка, и заметить её нечем
  check('у каждого тега есть место', Object.keys(pos).length === THREE.length, Object.keys(pos).length);
  check('три дерева и посчитаны как три', res.trees.length === 3, res.trees.map((t) => t.rootId));
  check('колец и одиночек нет', res.cycled.length === 0 && res.parked.length === 0);

  // Одна проверка ловит почти любую поломку раскладки
  const ids = Object.keys(pos);
  let overlap = '';
  for (let i = 0; i < ids.length && !overlap; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = pos[ids[i]]; const b = pos[ids[j]];
      if (Math.abs(a.x - b.x) < CARD_W && Math.abs(a.y - b.y) < CARD_H) { overlap = `${ids[i]} / ${ids[j]}`; break; }
    }
  }
  check('ни одна карточка не легла на другую', overlap === '', overlap);

  // Ради этого всё и переписывалось: раньше В-2 начинался ПОД В-1
  const b1 = res.trees[0].box; const b2 = res.trees[1].box; const b3 = res.trees[2].box;
  check('второе дерево правее первого', b2.x >= b1.x + b1.w, [b1.x + b1.w, b2.x]);
  check('третье правее второго', b3.x >= b2.x + b2.w, [b2.x + b2.w, b3.x]);
  // «Не снизу»: верх у всех деревьев общий, вниз уходит только состав
  check('деревья начинаются с одной высоты', b1.y === b2.y && b2.y === b3.y, [b1.y, b2.y, b3.y]);
  check('раскладка начинается от полей', b1.x === MARGIN_X && b1.y === MARGIN_Y, [b1.x, b1.y]);

  // Родитель посередине между крайними детьми — иначе дерево завалено набок
  const p = at('В-1');
  const kids = ['В-1-вентилятор', 'В-1-калорифер', 'В-1-клапан'].map(at);
  const across = (q: Point) => (axis === 'down' ? q.x : q.y);
  const lo = Math.min(...kids.map(across)); const hi = Math.max(...kids.map(across));
  check('родитель стоит посередине детей', Math.abs(across(p) - (lo + hi) / 2) < 1, [across(p), (lo + hi) / 2]);

  const kid = at('В-1-клапан');
  const grand = at('В-1-привод');
  if (axis === 'down') {
    check('дети ниже родителя', kid.y > p.y, [p.y, kid.y]);
    check('внук ещё ниже', grand.y > kid.y);
    check('соседи расходятся вбок', at('В-1-вентилятор').x !== kid.x);
    check('братья стоят на одной высоте', at('В-1-вентилятор').y === kid.y);
  } else {
    check('дети правее родителя', kid.x > p.x, [p.x, kid.x]);
    check('внук ещё правее', grand.x > kid.x);
    check('соседи расходятся вниз', at('В-1-вентилятор').y !== kid.y);
    check('братья стоят в одной колонке', at('В-1-вентилятор').x === kid.x);
  }

  // Два нажатия «Упорядочить» обязаны дать одну картинку
  const again = layoutForest([...THREE].reverse(), axis, ONE_ROW).positions;
  check('раскладка не зависит от порядка в списке',
    ids.every((id) => again[id].x === pos[id].x && again[id].y === pos[id].y));
}

console.log('Ось «down» и правда мельче по высоте, чем «right»');
{
  // Настоящая установка широкая и мелкая: компонентов много, а вложенность —
  // два-три уровня. На симметричном дереве (сколько уровней, столько листьев)
  // обе оси дают одинаковый габарит, и сравнивать на нём нечего
  const wide: TreeNode[] = [
    { id: 'ПВ-1', connections: Array.from({ length: 8 }, (_, i) => `ПВ-1-у${i}`) },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `ПВ-1-у${i}`, connections: [], parentId: 'ПВ-1' })),
  ];
  const down = layoutForest(wide, 'down', ONE_ROW).bounds;
  const right = layoutForest(wide, 'right', ONE_ROW).bounds;
  // Ради этого и нужен переключатель: у одной оси вниз уходит глубина (мелкая),
  // у другой — по листу на строку
  check('сверху вниз — заметно ниже', down.h < right.h / 2, [down.h, right.h]);
  check('слева направо — заметно уже', right.w < down.w / 2, [right.w, down.w]);
}

console.log('Ряд деревьев переносится, когда становится непомерно длинным');
{
  // Без предела сорок установок дают полосу в шестьдесят тысяч пикселей — та
  // же болезнь, что и прежняя, только повёрнутая набок
  const many: TreeNode[] = [];
  for (let i = 1; i <= 40; i++) many.push(...ahu(`В-${String(i).padStart(2, '0')}`));
  const wrapped = layoutForest(many, 'down');
  const rows = new Set(wrapped.trees.map((t) => t.box.y));
  check('сорок деревьев не встают в одну строку', rows.size > 1, rows.size);
  check('но и не превращаются в колонку', wrapped.trees.length / rows.size >= 3,
    [wrapped.trees.length, rows.size]);
  check('полоса всё же шире, чем выше', wrapped.bounds.w > wrapped.bounds.h,
    [wrapped.bounds.w, wrapped.bounds.h]);
  const flat = layoutForest(many, 'down', ONE_ROW);
  check('запрет переноса и правда держит одну строку',
    new Set(flat.trees.map((t) => t.box.y)).size === 1);

  // Найдено живой пробой: перенос считался по ширине ряда, и ТРЕТЬЯ установка
  // уезжала вниз — ровно та болезнь, ради которой всё и переписывали
  check('шесть деревьев и меньше не переносятся никогда', treesPerRow(6, 999999, 100) === 0);
  check('три деревца тем более', treesPerRow(3, 999999, 100) === 0);
  check('за десятками — переносится', treesPerRow(40, 33600, 300) >= 6);
  for (const axis of ['down', 'right'] as TreeAxis[]) {
    const six: TreeNode[] = [];
    for (let i = 1; i <= 6; i++) six.push(...ahu(`У-${i}`));
    const r = layoutForest(six, axis);
    check(`${axis}: шесть установок стоят одной строкой`,
      new Set(r.trees.map((t) => t.box.y)).size === 1, r.trees.map((t) => t.box.y));
    const xs = r.trees.map((t) => t.box.x);
    check(`${axis}: и по возрастанию слева направо`,
      xs.every((x, i) => i === 0 || x > xs[i - 1]), xs);
  }
}

console.log('Одинокие и закольцованные теги вынесены отдельно');
{
  const withLost: TreeNode[] = [
    ...ahu('В-1'),
    { id: 'сирота-1', connections: [] },
    { id: 'сирота-2', connections: [] },
    // Кольцо без корня: обход до него не дойдёт ни от одного корня
    { id: 'а', connections: ['б'], parentId: 'в' },
    { id: 'б', connections: ['в'], parentId: 'а' },
    { id: 'в', connections: ['а'], parentId: 'б' },
  ];
  const res = layoutForest(withLost, 'down', ONE_ROW);
  check('расставлены все, включая потерянных',
    Object.keys(res.positions).length === withLost.length, Object.keys(res.positions).length);
  check('одиночки названы одиночками', res.parked.sort().join() === 'сирота-1,сирота-2', res.parked);
  // Про кольцо геометрия только докладывает: чинит связи repairTagTree
  check('кольцо названо кольцом', res.cycled.sort().join() === 'а,б,в', res.cycled);

  const tree = res.trees[0].box;
  for (const id of ['сирота-1', 'а']) {
    check(`«${id}» вынесен под дерево, а не в него`, res.positions[id].y >= tree.y + tree.h, res.positions[id]);
  }
  check('никого не потеряли и не задвоили', new Set(Object.keys(res.positions)).size === withLost.length);
}

console.log('Пустой и односложный случай не роняет раскладку');
{
  const empty = layoutForest([], 'down');
  check('пустой проект', Object.keys(empty.positions).length === 0 && empty.bounds.w === 0);
  const one = layoutForest([{ id: 'один', connections: [] }], 'right');
  check('единственный тег встаёт в поле',
    one.positions['один'].x === MARGIN_X && one.positions['один'].y === MARGIN_Y, one.positions['один']);
  check('габарит несуществующего дерева не падает', treeExtent(THREE, 'нет-такого', 'down').w === 0);
  check('габарит без известных тегов — нули', boundsOf({}, ['нет-такого']).w === 0);
}

console.log('Порты и линии знают об оси');
{
  const a: Point = { x: 0, y: 0 };
  const b: Point = { x: 500, y: 300 };

  // 310 + 20 — то самое прежнее 330: порт висит половиной снаружи карточки,
  // и линия обязана начинаться в нём, а не у рамки
  check('вправо: выход в кружке порта за краем карточки',
    portAt(a, 'out', 'right').x === CARD_W + PORT_STUB && CARD_W + PORT_STUB === 330, portAt(a, 'out', 'right'));
  check('вправо: порт на уровне строки с кодом', portAt(a, 'out', 'right').y === PORT_Y);
  check('вправо: вход у левого края', portAt(b, 'in', 'right').x === 500);

  check('вниз: выход снизу по центру',
    portAt(a, 'out', 'down').x === CARD_W / 2 && portAt(a, 'out', 'down').y === CARD_H, portAt(a, 'out', 'down'));
  check('вниз: вход сверху по центру', portAt(b, 'in', 'down').y === 300);
  // Развёрнутая карточка выше свёрнутой: без измеренной высоты линия отрывается
  check('нижний порт едет за высотой карточки',
    portAt(a, 'out', 'down', { ...DEFAULT_BOX, h: 420 }).y === 420);

  for (const axis of ['down', 'right'] as TreeAxis[]) {
    const d = linkPath(a, b, axis);
    const s = portAt(a, 'out', axis); const e = portAt(b, 'in', axis);
    check(`${axis}: линия начинается в порту родителя`, d.startsWith(`M ${s.x} ${s.y} `), d.slice(0, 26));
    check(`${axis}: и кончается в порту ребёнка`, d.trim().endsWith(`${e.x} ${e.y}`), d.slice(-26));
    // Крестик «разорвать» садится на саму линию, а не рядом с ней
    const m = linkMid(a, b, axis);
    check(`${axis}: середина лежит между концами`,
      m.x >= Math.min(s.x, e.x) - 1 && m.x <= Math.max(s.x, e.x) + 1
      && m.y >= Math.min(s.y, e.y) - 1 && m.y <= Math.max(s.y, e.y) + 1, m);
  }
  check('вправо: кривая', linkPath(a, b, 'right').includes(' C '));
  // У десяти братьев кривые расходятся веером и пересекаются; ломаная даёт
  // одну общую шину — поэтому так и рисуют оргсхемы
  check('вниз: ломаная со скруглением', linkPath(a, b, 'down').includes(' Q '), linkPath(a, b, 'down'));
  check('вниз: строго под родителем — прямая, без лишних углов',
    linkPath({ x: 0, y: 0 }, { x: 0, y: 300 }, 'down') === 'M 155 96 L 155 300');
}

console.log('Сетка, масштаб и «по размеру»');
{
  check('прилипание округляет к ближайшему шагу сетки',
    snap(37) === 48 && snap(13) === 24 && snap(11) === 0 && snap(-5) === 0,
    [snap(37), snap(13), snap(11), snap(-5)]);
  check('прилипание не сдвигает уже ровное', snap(snap(37)) === snap(37));
  check('шаг прилипания — тот же, что у нарисованной сетки', GRID === 24);
  check('масштаб не выходит за края', clampZoom(9) === 2.5 && clampZoom(0.01) === 0.15);
  check('обычный масштаб не трогается', clampZoom(0.9) === 0.9);

  // Свойство, которое делает зум правильным на ощупь и ломается незаметно
  const pan = { x: 40, y: 15 };
  const cursor = { x: 620, y: 380 };
  const before = screenToWorld(cursor, pan, 0.9);
  const z1 = zoomAt(0.9, pan, cursor, 1);
  const after = screenToWorld(cursor, z1.pan, z1.zoom);
  check('точка под курсором остаётся под курсором',
    Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6, [before, after]);
  // Шаг геометрический: при линейном «отдалить и вернуть» масштаб уползает
  const back = zoomAt(z1.zoom, z1.pan, cursor, -1);
  check('отдалить и приблизить возвращает прежний масштаб', Math.abs(back.zoom - 0.9) < 1e-9, back.zoom);
  check('зум не выпрыгивает за предел', zoomAt(2.5, pan, cursor, 40).zoom === 2.5);

  const ext = { x: 100, y: 100, w: 2000, h: 1000 };
  const view = { w: 1200, h: 800 };
  const z = fitZoom(ext, view);
  check('вписанное помещается по ширине', ext.w * z <= view.w, [ext.w * z, view.w]);
  check('вписанное помещается по высоте', ext.h * z <= view.h);
  check('мелкое не раздувается до плаката', fitZoom({ x: 0, y: 0, w: 200, h: 100 }, view) <= 1.1);
  check('пустой габарит не даёт деления на ноль', fitZoom({ x: 0, y: 0, w: 0, h: 0 }, view) === 1);

  const cx = (ext.x + ext.w / 2) * z + centerPan(ext, view, z).x;
  check('центр габарита попадает в центр экрана', Math.abs(cx - view.w / 2) < 0.5, cx);
  check('«вписать» отдаёт и масштаб, и сдвиг одним ответом',
    fitView(ext, view).zoom === z && fitView(ext, view).pan.x === centerPan(ext, view, z).x);
}

console.log('Попадание указателем: связь бросается на карточку, а не в кружок');
{
  const pos = { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } };
  const ids = ['a', 'b'];
  check('середина карточки — попадание', hitTestCard(pos, { x: 150, y: 40 }, ids) === 'a');
  check('край карточки — тоже попадание', hitTestCard(pos, { x: CARD_W, y: CARD_H }, ids) === 'a');
  check('мимо карточки — пусто', hitTestCard(pos, { x: 350, y: 40 }, ids) === null);
  // Верхние карточки нарисованы позже и перекрывают нижние
  check('перекрытие решается в пользу верхней',
    hitTestCard({ a: { x: 0, y: 0 }, b: { x: 10, y: 10 } }, { x: 50, y: 50 }, ids) === 'b');

  check('рамка ловит обе карточки',
    hitTestBox(pos, { x: -10, y: -10, w: 900, h: 200 }, ids).join() === 'a,b');
  check('рамка ловит и задетую краем', hitTestBox(pos, { x: 390, y: 0, w: 20, h: 20 }, ids).join() === 'b');
  check('пустая рамка не ловит никого', hitTestBox(pos, { x: 340, y: 0, w: 10, h: 10 }, ids).length === 0);
  // Рамку тянут в любую сторону, в том числе снизу вверх и справа налево
  check('рамка снизу вверх — тот же прямоугольник',
    JSON.stringify(boxFromDrag({ x: 100, y: 100 }, { x: 20, y: 40 }))
      === JSON.stringify({ x: 20, y: 40, w: 80, h: 60 }));
}

console.log('Новый тег не ложится на чужую карточку');
{
  const taken = [{ x: 100, y: 100 }];
  const free = findFreePosition(taken, { x: 100, y: 100 });
  check('место сдвинуто', free.x !== 100 || free.y !== 100, free);
  check('и оно свободно',
    Math.abs(free.x - 100) >= CARD_W + DEFAULT_BOX.gapX || Math.abs(free.y - 100) >= CARD_H + 14, free);
  check('на пустом холсте место не двигают',
    JSON.stringify(findFreePosition([], { x: 300, y: 200 })) === JSON.stringify({ x: 300, y: 200 }));

  const grid = parkGrid(30, { x: 80, y: 60 });
  check('сетка выдаёт столько мест, сколько тегов', grid.length === 30);
  check('места не повторяются', new Set(grid.map((p) => `${p.x}:${p.y}`)).size === 30);
  // Колонка на весь холст заставляла бы листать сразу после открытия проекта
  const g = boundsOf(Object.fromEntries(grid.map((p, i) => [String(i), p])), grid.map((_, i) => String(i)));
  check('сетка шире, чем выше', g.w > g.h, [g.w, g.h]);
}

console.log('Реестр пользуется общими правилами, а не своими');
{
  const reg = readFileSync(new URL('../src/screens/Registry.tsx', import.meta.url), 'utf8');
  check('раскладка берётся из общего модуля', reg.includes("from '../lib/tagLayout'"));
  // Числа 330 и 22 жили вписанными в четырёх местах: линии целились мимо края
  check('ширина карточки не вписана в линии руками', !/[+]\s*330\b/.test(reg));
  check('своей раскладки в реестре не осталось', !reg.includes('const COL_W = 360'));
  check('пределы масштаба не переписаны заново', !/Math\.max\(0\.15,/.test(reg));
  // Раскладка на 2000 тегов — это 2000 запросов, если не одним махом
  check('раскладка сохраняется массовым запросом', reg.includes('bulk-metadata'));
  // Второй акцент, которого в программе не объявляли: проверка палитры видит
  // только классы Tailwind, поэтому hex и дожил до сегодня
  check('в линиях не осталось чужого оттенка',
    !/#6366f1|#4f46e5|#c084fc/i.test(reg), (reg.match(/#6366f1|#4f46e5|#c084fc/gi) || []).slice(0, 4));
}

console.log('Колесо переживает уход на другую вкладку');
{
  // Холст живёт внутри `AnimatePresence mode="wait"`: при возврате на вкладку
  // он появляется в DOM не сразу, а после выхода уходящего вида. Эффект,
  // подписанный на вкладку, застаёт ссылку пустой и больше не повторяется —
  // колесо остаётся без узла. Поэтому подписка идёт на САМ УЗЕЛ, который
  // приходит функцией-ссылкой
  const src = readFileSync(new URL('../src/screens/Registry.tsx', import.meta.url), 'utf8');
  check('узел холста приходит функцией-ссылкой', src.includes('ref={attachBoard}'));
  check('узел холста живёт состоянием', src.includes('const [boardEl, setBoardEl]'));
  const wheel = src.slice(src.indexOf("board.addEventListener('wheel'"));
  const deps = wheel.slice(0, wheel.indexOf('}, ') + 40);
  check('слушатель колеса подписан на узел, а не на вкладку', deps.includes('}, [boardEl]);'), deps.slice(-60));
  check('наблюдатель размера — тоже', /observer\.disconnect\(\);\s*\}, \[boardEl\]\);/.test(src));
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки раскладки пройдены');
