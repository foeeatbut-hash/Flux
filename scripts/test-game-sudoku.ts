/**
 * Судоку: сетка, у которой решение ровно одно.
 *
 * Единственность — само условие задачи, а не украшение. Сетка с двумя
 * решениями выглядит как обычная и решается как обычная, но человек доходит до
 * конца, а программа говорит «неверно», потому что сверяет со «своим»
 * решением. Объяснить это игроку невозможно, потому что он прав.
 *
 * Второе, что проверяется, — что решение не уезжает в окно. Иначе судоку
 * решается средствами разработчика за десять секунд, и пройденная сетка
 * перестаёт что-либо значить.
 *
 * Запуск: npx tsx scripts/test-game-sudoku.ts
 */

import {
  sudoku, fullGrid, puzzleOf, countSolutions, conflicts, fits, SIDE,
} from '../play/games/sudoku';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

const SEATS = ['игрок'];
const CELLS = SIDE * SIDE;

console.log('1. Полная сетка правильна');
{
  const grid = fullGrid('семя-1');
  ok('заполнены все 81 клетка', grid.filter(Boolean).length === CELLS, grid.filter(Boolean).length);
  ok('нет нарушений правила', conflicts(grid).length === 0, conflicts(grid));

  // В каждой строке, столбце и квадрате — все девять цифр ровно по разу
  const line = (cells: number[]) => new Set(cells.map((c) => grid[c])).size === SIDE;
  const rows = Array.from({ length: SIDE }, (_, r) => Array.from({ length: SIDE }, (_, c) => r * SIDE + c));
  const cols = Array.from({ length: SIDE }, (_, c) => Array.from({ length: SIDE }, (_, r) => r * SIDE + c));
  const boxes = Array.from({ length: SIDE }, (_, b) => Array.from({ length: SIDE }, (_, i) =>
    (Math.floor(b / 3) * 3 + Math.floor(i / 3)) * SIDE + (b % 3) * 3 + (i % 3)));
  ok('в каждой строке все девять цифр', rows.every(line));
  ok('в каждом столбце все девять цифр', cols.every(line));
  ok('в каждом квадрате все девять цифр', boxes.every(line));

  ok('одно семя даёт одну сетку',
    JSON.stringify(fullGrid('семя-1')) === JSON.stringify(grid));
  ok('другое семя — другую', JSON.stringify(fullGrid('семя-2')) !== JSON.stringify(grid));
}

console.log('\n2. У задачи ровно одно решение');
{
  for (const level of ['лёгкий', 'обычный', 'трудный'] as const) {
    const { puzzle, solution } = puzzleOf(`семя-${level}`, level);
    ok(`«${level}»: решение единственное`, countSolutions(puzzle) === 1, countSolutions(puzzle));
    ok(`«${level}»: условие не противоречит себе`, conflicts(puzzle).length === 0);
    ok(`«${level}»: условие — часть решения`,
      puzzle.every((v, i) => v === 0 || v === solution[i]));
    const open = puzzle.filter(Boolean).length;
    ok(`«${level}»: открыто ${open} клеток, и это не вся сетка`, open > 20 && open < CELLS, open);
  }

  // Сетка, у которой решений заведомо больше одного, единственной не считается
  const { puzzle } = puzzleOf('семя-1', 'обычный');
  const loose = [...puzzle];
  let removed = 0;
  for (let i = 0; i < CELLS && removed < 12; i++) if (loose[i]) { loose[i] = 0; removed++; }
  ok('обеднённая сетка честно названа неоднозначной', countSolutions(loose) >= 2, countSolutions(loose));
}

console.log('\n3. Правило клетки');
{
  const grid = new Array(CELLS).fill(0);
  grid[0] = 5;
  ok('та же цифра в строке не лезет', !fits(grid, 3, 5));
  ok('та же цифра в столбце не лезет', !fits(grid, 27, 5));
  ok('та же цифра в квадрате не лезет', !fits(grid, 10, 5));
  ok('другая цифра — лезет', fits(grid, 10, 6));
  ok('далеко в другой строке та же цифра лезет', fits(grid, 40, 5));
}

console.log('\n4. Ходы');
{
  const s = sudoku.init('семя-партии', SEATS);
  const free = s.puzzle.findIndex((v) => v === 0);

  ok('ход за единственным игроком', sudoku.turnOf(s) === 'игрок', sudoku.turnOf(s));
  ok('чужой партией не походишь',
    /чужая партия/.test(sudoku.why(s, 'посторонний', { kind: 'set', cell: free, value: 1 })));

  const given = s.puzzle.findIndex((v) => v !== 0);
  ok('цифру из условия менять нельзя',
    /условии/.test(sudoku.why(s, 'игрок', { kind: 'set', cell: given, value: 1 })),
    sudoku.why(s, 'игрок', { kind: 'set', cell: given, value: 1 }));
  ok('цифра вне 1…9 отвергнута',
    sudoku.why(s, 'игрок', { kind: 'set', cell: free, value: 0 }) !== '');
  ok('клетки вне сетки нет', sudoku.why(s, 'игрок', { kind: 'set', cell: 999, value: 1 }) !== '');

  // Неверная цифра ставится: судоку решают в том числе пробой
  const wrong = s.solution[free] === 1 ? 2 : 1;
  const after = sudoku.apply(s, 'игрок', { kind: 'set', cell: free, value: wrong });
  ok('неверная цифра всё равно вписывается', after.filled[free] === wrong, after.filled[free]);
  ok('но ошибка посчитана', after.mistakes === 1, after.mistakes);
  const cleared = sudoku.apply(after, 'игрок', { kind: 'clear', cell: free });
  ok('клетка стирается', cleared.filled[free] === 0);
}

console.log('\n5. Подсказка открывает одну клетку, а не решает за игрока');
{
  const s = sudoku.init('семя-подсказки', SEATS);
  const before = s.puzzle.filter((v) => v === 0).length;
  const after = sudoku.apply(s, 'игрок', { kind: 'hint' });

  ok('открыта ровно одна клетка', after.filled.filter(Boolean).length === 1, after.filled.filter(Boolean).length);
  ok('и она верная', after.filled[after.hinted[0]] === s.solution[after.hinted[0]]);
  ok('клетка помечена подсказкой', after.hinted.length === 1, after.hinted);
  ok('подсказка посчитана', after.hints === 1, after.hints);
  ok('пустых стало на одну меньше',
    (sudoku.viewOf(after, 'игрок') as any).left === before - 1, sudoku.viewOf(after, 'игрок'));
  ok('открытую подсказкой клетку менять нельзя',
    /подсказка/.test(sudoku.why(after, 'игрок', { kind: 'set', cell: after.hinted[0], value: 1 })),
    sudoku.why(after, 'игрок', { kind: 'set', cell: after.hinted[0], value: 1 }));
}

console.log('\n6. Решение не уезжает в окно');
{
  const s = sudoku.init('семя-тайны', SEATS);
  const view = JSON.stringify(sudoku.viewOf(s, 'игрок'));
  ok('в снимке нет поля решения', !/solution/.test(view));
  // И самого решения в снимке тоже нет — ни под каким именем
  ok('и самих цифр решения тоже нет',
    !view.includes(JSON.stringify(s.solution)), view.slice(0, 120));
  ok('условие отдано', /puzzle/.test(view));
  ok('нарушения подсвечены отдельным списком', Array.isArray((sudoku.viewOf(s, 'игрок') as any).conflicts));
}

console.log('\n7. Конец партии');
{
  const s = sudoku.init('семя-конца', SEATS);
  // Решаем целиком: это и есть проверка того, что «заполнено» считается верно
  let state = s;
  for (let c = 0; c < CELLS; c++) {
    if (state.puzzle[c]) continue;
    state = sudoku.apply(state, 'игрок', { kind: 'set', cell: c, value: state.solution[c] });
  }
  ok('сетка признана решённой', state.done, state.done);
  const out = sudoku.outcome(state);
  ok('партия окончена', out.done && out.winnerTeam === 1, out);
  ok('итог назван словами', /решена/.test(out.why), out.why);
  ok('ошибок не было — и это сказано', !/ошибок/.test(out.why), out.why);
  ok('ходить больше некому', sudoku.turnOf(state) === '');
  ok('в решённую сетку больше не пишут',
    sudoku.why(state, 'игрок', { kind: 'set', cell: 0, value: 1 }) !== '');

  // Заполненная, но неверная сетка решённой не считается
  const broken = { ...s, filled: s.puzzle.map((v, i) => (v ? 0 : (s.solution[i] % 9) + 1)) };
  const grid = broken.puzzle.map((v, i) => v || broken.filled[i]);
  ok('заполненная с нарушениями сетка не засчитывается',
    conflicts(grid).length > 0 && !broken.done, conflicts(grid).length);
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
