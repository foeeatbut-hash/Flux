/** Положение меню «Пуск»: монитор, смещение, ширина, панель задач внутри или под столом. */
import assert from 'node:assert/strict';
import { startMenuFrame, START_GAP_X, START_GAP_Y } from '../src/lib/startMenuFrame';
import { BAR_H } from '../src/lib/metrics';

// Обычное окно: панель под столом, меню в 6 px над нижней кромкой стола
const solo = startMenuFrame({ work: { x: 0, y: 0, w: 1366, h: 720 }, barInside: false, width: 400 });
assert.deepEqual(solo, { left: START_GAP_X, bottom: 720 - START_GAP_Y, width: 400 });

// Два монитора разной ширины и высоты: меню второго встаёт у его левого края
const second = startMenuFrame({ work: { x: 700, y: 0, w: 900, h: 700 }, barInside: true, width: 400 });
assert.equal(second.left, 700 + START_GAP_X, 'левый край второго монитора, а не стола');
assert.equal(second.bottom, 700 - BAR_H - START_GAP_Y, 'над панелью задач, лежащей внутри монитора');

// Вертикальное смещение монитора (второй выше или ниже первого)
const shifted = startMenuFrame({ work: { x: -1200, y: -300, w: 1200, h: 800 }, barInside: true, width: 400 });
assert.equal(shifted.left, -1200 + START_GAP_X);
assert.equal(shifted.bottom, -300 + 800 - BAR_H - START_GAP_Y);

// Узкий монитор: меню сжимается и не выходит за его правый край
const narrow = startMenuFrame({ work: { x: 1000, y: 0, w: 300, h: 600 }, barInside: true, width: 400 });
assert.equal(narrow.width, 300 - 2 * START_GAP_X);
assert.ok(narrow.left >= 1000 && narrow.left + narrow.width <= 1300);

// barInside различает режимы ровно на высоту панели
const base = { work: { x: 0, y: 0, w: 900, h: 700 }, width: 400 };
assert.equal(startMenuFrame({ ...base, barInside: false }).bottom - startMenuFrame({ ...base, barInside: true }).bottom, BAR_H);
console.log('start-monitor-frame: ok');
