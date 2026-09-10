/**
 * Снимок и разметка: геометрия и история.
 *
 * Рисование браузерное и в Node его не проверить, но всё, чем разметка
 * промахивается, — здесь: пересчёт координат, обрезка выделения по краю окна,
 * перенос фигур после кадрирования и предел истории. Маска, съехавшая на
 * десяток точек, оставляет на снимке ровно то, что человек закрывал, — поэтому
 * счёт проверяется отдельно от картинки.
 *
 * Запуск: npx tsx scripts/test-feedback-capture.ts
 */

import {
  History, WHOLE, clampRect, clampZoom, fitZoom, hasMask, nextMark, rectOf, reframe,
  scaleOf, toPixels, toShare, HISTORY_STEPS, MIN_REGION_DIP, type Shape,
} from '../src/feedback/shapes';
import { fitRegion } from '../electron/feedbackCapture';
import { shrinkTo } from '../src/feedback/flatten';

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`, detail === undefined ? '' : detail); }
};

const shape = (kind: Shape['kind'], x: number, y: number, x2: number, y2: number): Shape =>
  ({ id: `${kind}-${x}`, kind, x, y, x2, y2, color: '#000' });

console.log('1. Во сколько раз снимок крупнее окна');
{
  // Ровно тот случай, ради которого коэффициент не берут из devicePixelRatio:
  // окно 1000×800 при масштабе 125 % даёт снимок 1250×1000
  const scale = scaleOf({ width: 1250, height: 1000 }, { width: 1000, height: 800 });
  ok('масштаб 125 % считается из размеров', scale.x === 1.25 && scale.y === 1.25, scale);
  const odd = scaleOf({ width: 1200, height: 1000 }, { width: 1000, height: 800 });
  ok('разные коэффициенты по осям не усредняются', odd.x === 1.2 && odd.y === 1.25, odd);
  const none = scaleOf({ width: 100, height: 100 }, { width: 0, height: 0 });
  ok('нулевое окно не даёт деления на ноль', none.x === 1 && none.y === 1, none);
}

console.log('\n2. Выделение укладывается в окно');
{
  const out = clampRect({ x: -50, y: -20, width: 400, height: 300 }, 1000, 800);
  ok('ушедшее за левый край обрезается', out?.x === 0 && out?.y === 0, out);
  ok('ширина считается по видимой части', out?.width === 350 && out?.height === 280, out);
  const over = clampRect({ x: 900, y: 700, width: 400, height: 400 }, 1000, 800);
  ok('за правым краем — тоже', over?.width === 100 && over?.height === 100, over);
  ok('меньше шестнадцати точек не берём',
    clampRect({ x: 10, y: 10, width: 15, height: 40 }, 1000, 800) === null);
  ok('ровно шестнадцать — берём',
    clampRect({ x: 10, y: 10, width: MIN_REGION_DIP, height: MIN_REGION_DIP }, 1000, 800) !== null);
  ok('выделение целиком за краем даёт отказ',
    clampRect({ x: 2000, y: 2000, width: 100, height: 100 }, 1000, 800) === null);
}

console.log('\n3. Оболочка не верит окну на слово');
{
  const bounds = { width: 1000, height: 800 };
  ok('дробное округляется', fitRegion({ x: 10.4, y: 10.6, width: 100.7, height: 50.2 }, bounds)?.x === 10);
  ok('отрицательное не проходит', fitRegion({ x: -5, y: -5, width: 100, height: 100 }, bounds)?.x === 0);
  ok('выходящее за окно подрезается',
    fitRegion({ x: 950, y: 700, width: 500, height: 500 }, bounds)?.width === 50);
  ok('мелкое отвергается', fitRegion({ x: 0, y: 0, width: 4, height: 4 }, bounds) === null);
  ok('строки вместо чисел не проходят', fitRegion({ x: 'a', y: 'b', width: 'c', height: 'd' }, bounds) === null);
  ok('пусто вместо выделения не проходит', fitRegion(null, bounds) === null);
  ok('огромное подрезается по окну, а не отвергается',
    fitRegion({ x: 0, y: 0, width: 99999, height: 99999 }, bounds)?.width === 1000);
}

console.log('\n4. Доли и точки');
{
  const box = toPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 800, 600);
  ok('доли переводятся в точки', box.x === 200 && box.y === 300 && box.width === 400 && box.height === 150, box);
  const back = toShare({ x: 200, y: 300, width: 400, height: 150 }, 800, 600);
  ok('и обратно', back.x === 0.25 && back.w === 0.5, back);
  ok('прямоугольник не зависит от направления',
    JSON.stringify(rectOf(100, 100, 10, 10)) === JSON.stringify(rectOf(10, 10, 100, 100)));
}

console.log('\n5. Обрезка переносит разметку');
{
  const shapes = [
    shape('mask', 0.5, 0.5, 0.75, 0.75),
    shape('arrow', 0.1, 0.1, 0.2, 0.2),
  ];
  const moved = reframe(shapes, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  ok('фигура за пределами обрезки не переносится', moved.length === 1, moved.length);
  ok('маска попала в новое начало координат', moved[0].x === 0 && moved[0].y === 0, moved[0]);
  ok('и сохранила размер', Math.abs(moved[0].x2 - 0.5) < 1e-9, moved[0].x2);
  ok('без обрезки ничего не меняется', reframe(shapes, WHOLE).length === 2);
}

console.log('\n6. История правок');
{
  const history = new History<number>(0);
  ok('в начале отменять нечего', !history.canUndo && !history.canRedo);
  history.push(1); history.push(2);
  ok('отмена возвращает предыдущее', history.undo() === 1);
  ok('повтор возвращает обратно', history.redo() === 2);
  history.undo(); history.push(9);
  ok('новая правка стирает будущее', !history.canRedo && history.value === 9);
  for (let i = 0; i < HISTORY_STEPS + 20; i++) history.push(i);
  let steps = 0;
  while (history.canUndo) { history.undo(); steps++; }
  ok('глубже тридцати шагов не помним', steps === HISTORY_STEPS, steps);
}

console.log('\n7. Мелочи, на которых спотыкаются');
{
  ok('метки идут по порядку', nextMark([
    shape('mark', 0, 0, 0, 0), { ...shape('mark', 0, 0, 0, 0), number: 3 },
  ] as Shape[]) === 4);
  ok('маска опознаётся', hasMask([shape('rect', 0, 0, 1, 1), shape('mask', 0, 0, 1, 1)]));
  ok('без маски предупреждения нет', !hasMask([shape('rect', 0, 0, 1, 1)]));
  ok('увеличение не выходит за пределы', clampZoom(50) === 4 && clampZoom(0.01) === 0.25);
  ok('«вписать» уменьшает большой снимок',
    Math.abs(fitZoom({ width: 2000, height: 1000 }, { width: 1000, height: 1000 }) - 0.5) < 1e-9);
  ok('маленький снимок не растягивается сверх предела',
    fitZoom({ width: 10, height: 10 }, { width: 1000, height: 1000 }) === 4);
  ok('снимок в шестнадцать мегапикселей не уменьшается', shrinkTo(4000, 4000, 16000000) === 1);
  ok('снимок вчетверо больше предела ужимается вдвое',
    Math.abs(shrinkTo(8000, 8000, 16000000) - 0.5) < 1e-9);
}

console.log('\n8. Рамка выбора отдаёт то, что обвели');
{
  // Рамка живёт в окне и работает в тех же независимых точках, в которых потом
  // считается разметка. Проверяется стык: что уходит в оболочку после того, как
  // человек протащил мышь
  const window = { width: 1280, height: 800 };
  const dragged = clampRect(rectOf(900, 600, 300, 200), window.width, window.height);
  ok('обратное направление даёт тот же прямоугольник',
    dragged?.x === 300 && dragged?.y === 200 && dragged?.width === 600 && dragged?.height === 400, dragged);

  const overflown = clampRect(rectOf(1000, 700, 1600, 1200), window.width, window.height);
  ok('уехавшее за окно подрезается по окну',
    overflown?.width === 280 && overflown?.height === 100, overflown);

  ok('случайное нажатие областью не считается',
    clampRect(rectOf(100, 100, 103, 104), window.width, window.height) === null);

  // Оболочка получает ровно это и проверяет ещё раз — сама себе не доверяет
  const forShell = fitRegion(dragged, window);
  ok('оболочка принимает то, что отдала рамка',
    forShell?.width === 600 && forShell?.height === 400, forShell);
}

console.log(`\nПройдено: ${passed}, провалено: ${failed}`);
if (failed) { console.log('ЕСТЬ ПРОВАЛЫ'); process.exit(1); }
console.log('ВСЕ ТЕСТЫ ПРОЙДЕНЫ');
