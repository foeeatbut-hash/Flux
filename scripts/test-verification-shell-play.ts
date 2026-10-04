/** Изолированные контракты геометрии оболочки и главного действия Flux Play. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { moveRect } from '../src/lib/windows';
import { placeContextMenu } from '../src/lib/contextMenu';
import { mainAction, type ActionInput } from '../src/play/mainAction';
import { PLAY_GAMES } from '../play/features';

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/verification-shell-play.json'), 'utf8'));
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

const play = fixture.play as ActionInput & { expected: Record<string, unknown> };
const { expected: playExpected, ...actionInput } = play;
const action = mainAction(actionInput);
check('Устаревшее готовое лобби не разрешает запуск даже ведущему', {
  id: action.id, label: action.label, disabled: action.disabled, hint: action.hint,
}, playExpected);
check('Встроенный каталог содержит только Дурака и Бильярд',
  PLAY_GAMES.map(game => game.id).sort(), ['billiards', 'cards']);

console.log(`\n${checks} изолированных проверок оболочки и Flux Play пройдено`);
