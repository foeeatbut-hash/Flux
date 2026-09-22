/**
 * Реверси: правила доски.
 *
 * Проверяется то, на чём такие доски ломаются молча: ход переворачивает линии
 * во все восемь сторон, а не одну; ход, который ничего не переворачивает, —
 * не ход; когда ходить некому, ход ПЕРЕХОДИТ, и партия от этого не кончается;
 * кончается она, когда пропустили оба подряд.
 *
 * Запуск: npx tsx scripts/test-game-reversi.ts
 */

import { reversi, flipsOf, movesOf, countOf, SIZE, type Cell } from '../play/games/reversi';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

const SEATS = ['чёрный', 'белый'];
const at = (x: number, y: number) => y * SIZE + x;

/** Доска из рисунка: «.» пусто, «B» чёрные, «W» белые */
const boardOf = (rows: string[]): Cell[] =>
  rows.join('').split('').map((c) => (c === 'B' ? 1 : c === 'W' ? 2 : 0)) as Cell[];

const EMPTY = [
  '........', '........', '........', '........',
  '........', '........', '........', '........',
];

console.log('1. Начальная расстановка');
{
  const s = reversi.init('семя', SEATS);
  ok('на доске четыре фишки', countOf(s.board, 1) + countOf(s.board, 2) === 4, s.board.filter(Boolean).length);
  ok('чёрных и белых поровну', countOf(s.board, 1) === 2 && countOf(s.board, 2) === 2);
  ok('первым ходит первый севший', reversi.turnOf(s) === 'чёрный', reversi.turnOf(s));
  // Четыре законных хода у чёрных в начале — это свойство расстановки, а не
  // случайность: разойдись расстановка, эта строка упадёт первой
  ok('у чёрных четыре хода', movesOf(s.board, 1).length === 4, movesOf(s.board, 1));
  ok('партия идёт', !reversi.outcome(s).done);
}

console.log('\n2. Ход переворачивает линии, а не клетку');
{
  const s = reversi.init('семя', SEATS);
  const move = { cell: at(2, 3) };   // слева от белой в d4
  ok('ход законен', reversi.why(s, 'чёрный', move) === '', reversi.why(s, 'чёрный', move));
  const after = reversi.apply(s, 'чёрный', move);
  ok('фишка поставлена', after.board[move.cell] === 1);
  ok('чужая перевернулась', after.board[at(3, 3)] === 1, after.board[at(3, 3)]);
  ok('счёт стал 4 : 1', countOf(after.board, 1) === 4 && countOf(after.board, 2) === 1,
    [countOf(after.board, 1), countOf(after.board, 2)]);
  ok('ход перешёл', reversi.turnOf(after) === 'белый', reversi.turnOf(after));

  // Переворот сразу в двух направлениях: своя фишка по обе стороны от чужих
  const cross = boardOf([
    '........', '........', '........',
    '.BWW.WB.', '........', '........', '........', '........',
  ]);
  // Ставим чёрную так, чтобы линия замкнулась справа
  const flips = flipsOf(cross, at(4, 3), 1);
  ok('перевернутся обе стороны линии', flips.length === 3, flips.map((f) => f % SIZE));
}

console.log('\n3. Незаконные ходы называются словами');
{
  const s = reversi.init('семя', SEATS);
  ok('чужой ход отвергнут', reversi.why(s, 'белый', { cell: at(2, 3) }) === 'Сейчас не ваш ход');
  ok('занятая клетка названа занятой',
    /занята/.test(reversi.why(s, 'чёрный', { cell: at(3, 3) })), reversi.why(s, 'чёрный', { cell: at(3, 3) }));
  ok('пустая клетка без переворотов отвергнута с причиной',
    /не переворачивается/.test(reversi.why(s, 'чёрный', { cell: at(0, 0) })), reversi.why(s, 'чёрный', { cell: at(0, 0) }));
  ok('за доской — тоже отказ', reversi.why(s, 'чёрный', { cell: 999 }) !== '');
  ok('пропуск при наличии ходов запрещён',
    /пропускать нельзя/.test(reversi.why(s, 'чёрный', { cell: -1 })), reversi.why(s, 'чёрный', { cell: -1 }));
}

console.log('\n4. Пропуск хода: ход переходит, партия — нет');
{
  /**
   * Доска, на которой белым ходить некуда, а чёрным есть куда.
   *
   * Белые заперты у края: чёрные за ними тянутся до самого борта, и пустой
   * клетки, из которой линия чёрных упиралась бы в белую, на доске нет. Это не
   * выдуманный случай — в реверси он обычный, и именно на нём доски «зависают»,
   * если пропуск не предусмотрен.
   */
  const board = boardOf([
    '.WWBBBBB', '........', '........',
    '........', '........', '........', '........', '........',
  ]);
  const s = { board, turn: 2 as const, seats: SEATS, passes: 0, history: [] };
  ok('белым ходить некуда', movesOf(board, 2).length === 0, movesOf(board, 2));
  ok('пропуск разрешён', reversi.why(s, 'белый', { cell: -1 }) === '', reversi.why(s, 'белый', { cell: -1 }));

  const after = reversi.apply(s, 'белый', { cell: -1 });
  ok('ход перешёл чёрным', reversi.turnOf(after) === 'чёрный', reversi.turnOf(after));
  ok('партия не кончилась', !reversi.outcome(after).done, reversi.outcome(after));
  ok('пропуск засчитан', after.passes === 1, after.passes);

  // Чёрные тоже пропускают — вот теперь партия кончилась
  const both = reversi.apply(after, 'чёрный', { cell: -1 });
  ok('после двух пропусков подряд партия окончена', reversi.outcome(both).done, reversi.outcome(both));
  ok('ходить больше не у кого', reversi.turnOf(both) === '', reversi.turnOf(both));
  ok('победа у того, кого больше', reversi.outcome(both).winnerTeam === 1, reversi.outcome(both));

  // А один пропуск, за которым следует ход, счётчик обнуляет
  const moved = reversi.apply({ ...after, board: reversi.init('с', SEATS).board, turn: 1 }, 'чёрный', { cell: at(2, 3) });
  ok('ход обнуляет счётчик пропусков', moved.passes === 0, moved.passes);
}

console.log('\n5. Конец партии и счёт');
{
  // Доска заполнена целиком
  const full = boardOf([
    'BBBBBBBB', 'BBBBBBBB', 'BBBBBBBB', 'BBBBWWWW',
    'WWWWWWWW', 'WWWWWWWW', 'WWWWWWWW', 'WWWWWWWW',
  ]);
  const out = reversi.outcome({ board: full, turn: 1, seats: SEATS, passes: 0, history: [] });
  ok('полная доска кончает партию', out.done);
  ok('победили белые', out.winnerTeam === 2, out);
  ok('счёт назван словами', /36/.test(out.why) && /28/.test(out.why), out.why);

  // Ничья — это ноль, а не «первый победил»
  const half = boardOf([
    'BBBBBBBB', 'BBBBBBBB', 'BBBBBBBB', 'BBBBBBBB',
    'WWWWWWWW', 'WWWWWWWW', 'WWWWWWWW', 'WWWWWWWW',
  ]);
  const draw = reversi.outcome({ board: half, turn: 1, seats: SEATS, passes: 0, history: [] });
  ok('ничья — нулевая команда', draw.done && draw.winnerTeam === 0, draw);
  ok('и названа ничьёй', /Ничья/.test(draw.why), draw.why);

  // Все фишки одного цвета — партия кончена, даже если доска не полна
  const wiped = boardOf([...EMPTY]);
  wiped[at(0, 0)] = 1;
  const alone = reversi.outcome({ board: wiped, turn: 2, seats: SEATS, passes: 0, history: [] });
  ok('без единой фишки соперника партия окончена', alone.done && alone.winnerTeam === 1, alone);
}

console.log('\n6. Что видит игрок');
{
  const s = reversi.init('семя', SEATS);
  const view = reversi.viewOf(s, 'чёрный') as any;
  ok('доска отдана целиком', Array.isArray(view.board) && view.board.length === 64);
  ok('подсказаны законные ходы', Array.isArray(view.moves) && view.moves.length === 4, view.moves);
  ok('счёт посчитан', view.black === 2 && view.white === 2, view);
  // Скрывать в реверси нечего — и оба видят одно и то же
  ok('оба видят одно и то же',
    JSON.stringify(reversi.viewOf(s, 'белый')) === JSON.stringify(view));
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
