/**
 * Бесконечная сетка таблицы: правило роста по краю видимой области.
 * Сам редактор здесь не поднимается — проверяется только решение «расти ли и до скольки».
 */
import assert from 'node:assert/strict';
import { MAX_GRID_COLUMNS, MAX_GRID_ROWS, nextGridSize } from '../tools/genoffice/inject/sheets-grid-grow';

// Видимый край далеко от края сетки — расти не надо
assert.equal(nextGridSize(10, 26, 6, 26, MAX_GRID_COLUMNS), null);
// Дошли до запаса у края (последний столбец Z = 25 при 26) — не меньше шага в 26 столбцов, дальше AA, AB…
for (const end of [20, 24, 25]) assert.ok(nextGridSize(end, 26, 6, 26, MAX_GRID_COLUMNS)! >= 52, `рост от края ${end}`);
// Сильное уменьшение масштаба: видимый край ушёл за сетку — растём сразу до него с запасом
const far = nextGridSize(120, 26, 6, 26, MAX_GRID_COLUMNS)!;
assert.ok(far >= 120 + 6, `рост до видимого края: ${far}`);
// Пределы Excel не превышаются и на них рост останавливается
assert.equal(nextGridSize(16383, 16380, 6, 26, MAX_GRID_COLUMNS), MAX_GRID_COLUMNS);
assert.equal(nextGridSize(16383, MAX_GRID_COLUMNS, 6, 26, MAX_GRID_COLUMNS), null);
assert.equal(nextGridSize(1_048_570, 1_048_000, 20, 200, MAX_GRID_ROWS), MAX_GRID_ROWS);
// Мусор от редактора не растит сетку
assert.equal(nextGridSize(NaN, 26, 6, 26, MAX_GRID_COLUMNS), null);
console.log('7 проверок роста сетки пройдено');
