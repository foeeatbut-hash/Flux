/**
 * 2048: сдвиг, слияния и подсев.
 *
 * Проверяются два правила, на которых ломаются почти все доски этой игры:
 * плитка сливается за ход ровно один раз (`2 2 4` влево даёт `4 4`, а не `8`),
 * и порядок слияний идёт от того края, к которому жмут (`2 2 2` влево — это
 * `4 2`, а не `2 4`).
 *
 * Третье — подсев. Он случайный, но обязан получаться одинаковым у сервера и у
 * окна: разойдись он, доска разъедется на первом же ходу, и виноват будет не
 * тот, кто это сделал.
 *
 * Запуск: npx tsx scripts/test-game-2048.ts
 */

import { g2048, slide, slideLine, canMove, spawn, SIDE } from '../play/games/g2048';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

const SEATS = ['игрок'];
const rows = (r: number[][]) => r.flat();
const rowOf = (board: number[], y: number) => board.slice(y * SIDE, y * SIDE + SIDE);

console.log('1. Слияние одной линии');
{
  ok('пустое остаётся пустым', JSON.stringify(slideLine([0, 0, 0, 0]).values) === '[0,0,0,0]');
  ok('плитки сдвигаются без дыр',
    JSON.stringify(slideLine([0, 2, 0, 4]).values) === '[2,4,0,0]', slideLine([0, 2, 0, 4]).values);
  ok('равные сливаются', JSON.stringify(slideLine([2, 2, 0, 0]).values) === '[4,0,0,0]');
  ok('за слияние начисляется сумма', slideLine([2, 2, 0, 0]).score === 4, slideLine([2, 2, 0, 0]).score);

  // Главное правило: свежая плитка во втором слиянии не участвует
  ok('свежая плитка второй раз не сливается',
    JSON.stringify(slideLine([2, 2, 4, 0]).values) === '[4,4,0,0]', slideLine([2, 2, 4, 0]).values);
  ok('и очки начислены один раз', slideLine([2, 2, 4, 0]).score === 4, slideLine([2, 2, 4, 0]).score);

  // Второе правило: порядок слияний — от края, к которому жмут
  ok('тройка сливается парой у края',
    JSON.stringify(slideLine([2, 2, 2, 0]).values) === '[4,2,0,0]', slideLine([2, 2, 2, 0]).values);
  ok('четвёрка одинаковых даёт две пары',
    JSON.stringify(slideLine([2, 2, 2, 2]).values) === '[4,4,0,0]', slideLine([2, 2, 2, 2]).values);
  ok('и очки за обе пары', slideLine([2, 2, 2, 2]).score === 8, slideLine([2, 2, 2, 2]).score);
  ok('разные не сливаются', JSON.stringify(slideLine([2, 4, 8, 16]).values) === '[2,4,8,16]');
}

console.log('\n2. Сдвиг доски во все четыре стороны');
{
  const board = rows([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  ok('влево — к левому краю', JSON.stringify(rowOf(slide(board, 'left').board, 0)) === '[4,0,0,0]',
    rowOf(slide(board, 'left').board, 0));
  ok('вправо — к правому краю', JSON.stringify(rowOf(slide(board, 'right').board, 0)) === '[0,0,0,4]',
    rowOf(slide(board, 'right').board, 0));

  const column = rows([
    [2, 0, 0, 0],
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  ok('вверх — к верхнему краю', slide(column, 'up').board[0] === 4, slide(column, 'up').board.slice(0, 4));
  ok('вниз — к нижнему краю', slide(column, 'down').board[12] === 4, slide(column, 'down').board.slice(12));

  // Сдвиг, который ничего не меняет, ходом не является
  const packed = rows([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ]);
  ok('сдвиг без изменений не считается ходом', !slide(packed, 'left').moved);
  ok('и ходов на такой доске нет вовсе', !canMove(packed));
}

console.log('\n3. Подсев по семени: сервер и окно видят одно');
{
  const first = spawn(new Array(16).fill(0), 'семя-1', 7);
  const again = spawn(new Array(16).fill(0), 'семя-1', 7);
  ok('одно семя и шаг дают одну доску', JSON.stringify(first) === JSON.stringify(again), [first, again]);

  const other = spawn(new Array(16).fill(0), 'семя-2', 7);
  ok('другое семя даёт другую', JSON.stringify(first) !== JSON.stringify(other));

  const values = first.filter(Boolean);
  ok('подсеяна ровно одна плитка', values.length === 1, values);
  ok('и это двойка или четвёрка', values[0] === 2 || values[0] === 4, values[0]);

  // Полную доску подсевать некуда — и подсев её не портит
  const full = new Array(16).fill(2);
  ok('на полной доске ничего не подсевается', JSON.stringify(spawn(full, 'семя', 0)) === JSON.stringify(full));
}

console.log('\n4. Партия');
{
  const s = g2048.init('семя-партии', SEATS);
  ok('на старте две плитки', s.board.filter(Boolean).length === 2, s.board);
  ok('стартовые плитки в разных клетках',
    new Set(s.board.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)).size === 2, s.board);
  ok('счёт нулевой', s.score === 0);
  ok('ход за единственным игроком', g2048.turnOf(s) === 'игрок', g2048.turnOf(s));

  ok('чужой партией не походишь',
    /чужая партия/.test(g2048.why(s, 'посторонний', { dir: 'left' })), g2048.why(s, 'посторонний', { dir: 'left' }));
  ok('непонятное направление отвергнуто', g2048.why(s, 'игрок', { dir: 'вбок' as any }) !== '');

  // Ход, который ничего не двигает, отвергается словами, а не молча
  const packed = { ...s, board: rows([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]) };
  ok('глухой сдвиг отвергнут с причиной',
    /ничего не двигается|партия окончена/.test(g2048.why(packed, 'игрок', { dir: 'left' })),
    g2048.why(packed, 'игрок', { dir: 'left' }));

  // Настоящий ход: доска меняется, подсевается ещё плитка
  const board = rows([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  const live = { ...s, board, score: 0, moves: 0 };
  const after = g2048.apply(live, 'игрок', { dir: 'left' });
  ok('счёт вырос на сумму слияния', after.score === 4, after.score);
  ok('после хода на доске стало на плитку больше',
    after.board.filter(Boolean).length === 2, after.board);
  ok('ход посчитан', after.moves === 1, after.moves);
  ok('лучшая плитка запомнена', after.best >= 4, after.best);

  // Повтор того же хода из того же состояния даёт ту же доску: это и значит
  // «сервер и окно не разойдутся»
  const twice = g2048.apply(live, 'игрок', { dir: 'left' });
  ok('один и тот же ход даёт одну и ту же доску',
    JSON.stringify(after.board) === JSON.stringify(twice.board), [after.board, twice.board]);
}

console.log('\n5. Конец партии');
{
  const packed = rows([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]);
  const done = g2048.outcome({ board: packed, score: 1234, seed: 'с', moves: 99, seats: SEATS, best: 512 });
  ok('партия окончена', done.done);
  ok('результат засчитан игроку', done.winnerTeam === 1, done);
  ok('счёт и лучшая плитка названы словами',
    /1234/.test(done.why) && /512/.test(done.why), done.why);
  ok('ходить больше некому',
    g2048.turnOf({ board: packed, score: 0, seed: 'с', moves: 0, seats: SEATS, best: 4 }) === '');
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
