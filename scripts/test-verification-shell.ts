/** Изолированные контракты геометрии оболочки и главного действия Flux Play. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { moveRect } from '../src/lib/windows';
import { placeContextMenu } from '../src/lib/contextMenu';

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/verification-shell.json'), 'utf8'));
let checks = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  assert.deepEqual(actual, expected, label);
  checks++;
};

const window = fixture.window;
check('Перетаскивание окна за правый и нижний край оставляет заголовок доступным',
  moveRect(window.rect, window.delta.x, window.delta.y, window.area), window.expected);

const menu = fixture.menu;
check('Контекстное меню целиком сдвигается в рабочую область монитора',
  placeContextMenu(menu.point.x, menu.point.y, menu.size.w, menu.size.h, menu.workArea), menu.expected);

console.log(`\n${checks} изолированных проверок оболочки пройдено`);
