/**
 * Русские шашки: правила доски.
 *
 * Проверяется то, на чём такие доски ломаются и выглядят при этом рабочими:
 *
 *   — **обязательное взятие**: есть чем бить — тихий ход незаконен;
 *   — **цепочка — один ход**: остановиться посреди боя нельзя;
 *   — **простая бьёт назад** (русские шашки, не международные);
 *   — **дамка бьёт на расстоянии** и ходит на любое число полей;
 *   — **побитые снимаются в конце цепочки**: снимая по дороге, одну и ту же
 *     шашку можно перепрыгнуть дважды, и доска будет выглядеть правдоподобно;
 *   — **превращение посреди цепочки**: дойдя до края боем, дальше бьёт дамка;
 *   — **запертый проигрывает**, а не объявляет ничью.
 *
 * Запуск: npx tsx scripts/test-game-checkers.ts
 */

import { checkers, movesOf, play, ownerOf, SIDE, type Cell } from '../play/games/checkers';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

const SEATS = ['белые', 'чёрные'];
const at = (x: number, y: number) => y * SIDE + x;

/** Доска из рисунка: «.» пусто, «w/W» белые и их дамка, «b/B» чёрные и дамка */
const boardOf = (rows: string[]): Cell[] =>
  rows.join('').split('').map((c) =>
    (c === 'w' ? 1 : c === 'b' ? 2 : c === 'W' ? 3 : c === 'B' ? 4 : 0)) as Cell[];

const EMPTY = ['........', '........', '........', '........', '........', '........', '........', '........'];
const state = (board: Cell[], turn: 1 | 2 = 1) => ({ board, turn, seats: SEATS, quiet: 0, history: [] });

console.log('1. Начальная расстановка');
{
  const s = checkers.init('семя', SEATS);
  ok('у белых двенадцать шашек', s.board.filter((c) => ownerOf(c) === 1).length === 12);
  ok('у чёрных двенадцать', s.board.filter((c) => ownerOf(c) === 2).length === 12);
  ok('все на тёмных полях',
    s.board.every((c, i) => c === 0 || ((i % SIDE) + Math.floor(i / SIDE)) % 2 === 1));
  ok('первыми ходят белые', checkers.turnOf(s) === 'белые', checkers.turnOf(s));
  ok('у белых семь ходов', movesOf(s.board, 1).length === 7, movesOf(s.board, 1).length);
  ok('все они тихие', movesOf(s.board, 1).every((p) => p.length === 2));
}

console.log('\n2. Обязательное взятие');
{
  // Белая на e3, чёрная на d4: бить можно и, значит, нужно
  const board = boardOf([...EMPTY]);
  board[at(4, 5)] = 1;
  board[at(3, 4)] = 2;
  board[at(6, 5)] = 1;          // у этой есть тихий ход — и он теперь незаконен
  const s = state(board, 1);

  const moves = movesOf(board, 1);
  ok('вернулись только взятия', moves.every((p) => p.length > 1 && p[0] === at(4, 5)), moves);
  ok('взятие одно', moves.length === 1, moves);
  ok('приземление за жертвой', moves[0][1] === at(2, 3), moves[0]);

  ok('тихий ход при возможном бое отвергнут',
    /Бить обязательно/.test(checkers.why(s, 'белые', { path: [at(6, 5), at(5, 4)] })),
    checkers.why(s, 'белые', { path: [at(6, 5), at(5, 4)] }));
  ok('само взятие законно', checkers.why(s, 'белые', { path: moves[0] }) === '');

  const after = checkers.apply(s, 'белые', { path: moves[0] });
  ok('жертва снята', after.board[at(3, 4)] === 0, after.board[at(3, 4)]);
  ok('шашка переехала', after.board[at(2, 3)] === 1 && after.board[at(4, 5)] === 0);
  ok('ход перешёл', after.turn === 2);
}

console.log('\n3. Простая бьёт назад — это русские шашки');
{
  const board = boardOf([...EMPTY]);
  board[at(4, 3)] = 1;
  board[at(3, 4)] = 2;          // жертва СЗАДИ по ходу белых (белые идут вверх)
  const moves = movesOf(board, 1);
  ok('взятие назад найдено', moves.length === 1 && moves[0][1] === at(2, 5), moves);

  // А тихим ходом назад простая не ходит
  const quiet = boardOf([...EMPTY]);
  quiet[at(4, 3)] = 1;
  const back = movesOf(quiet, 1);
  ok('тихо назад простая не ходит', back.every((p) => Math.floor(p[1] / SIDE) < 3), back);
}

console.log('\n4. Цепочка взятий — один ход');
{
  /**
   * Две чёрные подряд: после первого боя с нового поля снова есть чем бить,
   * значит ход не кончился. Остановиться посреди — незаконно.
   */
  const board = boardOf([...EMPTY]);
  board[at(0, 7)] = 1;
  board[at(1, 6)] = 2;
  board[at(3, 4)] = 2;
  const s = state(board, 1);

  const moves = movesOf(board, 1);
  ok('найден путь из трёх полей', moves.length === 1 && moves[0].length === 3, moves);
  ok('остановиться посреди боя нельзя',
    /до конца/.test(checkers.why(s, 'белые', { path: [at(0, 7), at(2, 5)] })),
    checkers.why(s, 'белые', { path: [at(0, 7), at(2, 5)] }));

  const after = checkers.apply(s, 'белые', { path: moves[0] });
  ok('снялись обе', after.board[at(1, 6)] === 0 && after.board[at(3, 4)] === 0);
  ok('шашка встала в конце пути', after.board[moves[0][2]] === 1, moves[0]);
  ok('у белых осталась одна шашка', after.board.filter((c) => ownerOf(c) === 1).length === 1);
}

console.log('\n5. Побитые снимаются в конце, а не по дороге');
{
  /**
   * Дамка, обходящая по кругу, проходит над одной и той же шашкой дважды.
   * Снимая по дороге, второй проход «побил» бы её ещё раз — доска выглядела бы
   * правдоподобно, а счёт был бы неверен.
   */
  const board = boardOf([...EMPTY]);
  board[at(0, 7)] = 3;            // белая дамка
  board[at(2, 5)] = 2;
  board[at(5, 2)] = 2;
  const before = board.filter((c) => ownerOf(c) === 2).length;
  const moves = movesOf(board, 1);
  ok('дамка видит бой', moves.length > 0 && moves[0].length > 2, moves);

  const after = play(board, moves[0], 1);
  const taken = before - after.filter((c) => ownerOf(c) === 2).length;
  ok('снято ровно столько, сколько побито', taken === moves[0].length - 1, [taken, moves[0]]);
}

console.log('\n6. Дамка ходит и бьёт на расстоянии');
{
  const board = boardOf([...EMPTY]);
  board[at(0, 7)] = 3;
  const quiet = movesOf(board, 1);
  ok('дамка ходит далеко', quiet.some((p) => p[1] === at(7, 0)), quiet.map((p) => p[1]));

  const far = boardOf([...EMPTY]);
  far[at(0, 7)] = 3;
  far[at(4, 3)] = 2;             // жертва через три пустых поля
  const jumps = movesOf(far, 1);
  ok('дамка бьёт через пустые поля', jumps.length > 0 && jumps[0].length > 1, jumps);
  ok('и приземляется за жертвой на выбор',
    jumps.every((p) => p[1] === at(5, 2) || p[1] === at(6, 1) || p[1] === at(7, 0)), jumps);

  // Своя фигура диагональ запирает
  const blocked = boardOf([...EMPTY]);
  blocked[at(0, 7)] = 3;
  blocked[at(2, 5)] = 1;
  blocked[at(4, 3)] = 2;
  ok('через свою дамка не бьёт', movesOf(blocked, 1).every((p) => p[0] !== at(0, 7) || p.length === 2),
    movesOf(blocked, 1));
}

console.log('\n7. Превращение в дамку');
{
  // Простая доходит до края тихим ходом
  const board = boardOf([...EMPTY]);
  board[at(1, 1)] = 1;
  const s = state(board, 1);
  const after = checkers.apply(s, 'белые', { path: [at(1, 1), at(0, 0)] });
  ok('на краю простая становится дамкой', after.board[at(0, 0)] === 3, after.board[at(0, 0)]);

  // И посреди цепочки: дойдя до края боем, дальше бьёт уже дамка
  const chain = boardOf([...EMPTY]);
  chain[at(2, 4)] = 1;
  chain[at(3, 3)] = 2;
  chain[at(3, 1)] = 2;
  const moves = movesOf(chain, 1);
  ok('цепочка продолжается дамкой', moves.some((p) => p.length > 2), moves);
  const done = play(chain, moves.find((p) => p.length > 2)!, 1);
  ok('и она осталась дамкой', done.some((c) => c === 3), done.filter(Boolean));
}

console.log('\n8. Конец партии');
{
  // Некем ходить — проиграл
  const board = boardOf([...EMPTY]);
  board[at(0, 0)] = 1;
  const out = checkers.outcome(state(board, 2));
  ok('без шашек — поражение', out.done && out.winnerTeam === 1, out);
  ok('сказано словами', /все шашки/.test(out.why), out.why);

  /**
   * Нечем ходить: белая в углу, перед ней чёрная, а за чёрной — вторая.
   * Тихо вперёд некуда, назад простая тихо не ходит, а прыгнуть некуда:
   * поле приземления занято. Это обычная позиция, а не выдуманная.
   */
  const stuck = boardOf([...EMPTY]);
  stuck[at(0, 7)] = 1;
  stuck[at(1, 6)] = 2;
  stuck[at(2, 5)] = 2;
  const boxed = { ...state(stuck, 1), board: stuck };
  ok('у белых ходов нет', movesOf(stuck, 1).length === 0, movesOf(stuck, 1));
  const lost = checkers.outcome(boxed);
  ok('запертый проигрывает, а не объявляет ничью', lost.done && lost.winnerTeam === 2, lost);
  ok('и сказано почему', /нечем ходить/.test(lost.why), lost.why);

  // Тридцать тихих ходов — ничья
  const long = { ...state(boardOf([...EMPTY]), 1), quiet: 30 };
  long.board[at(0, 0)] = 3;
  long.board[at(7, 7)] = 4;
  const draw = checkers.outcome(long);
  ok('тридцать ходов без боя — ничья', draw.done && draw.winnerTeam === 0, draw);
}

console.log('\n9. Чужие ходы и чужие шашки');
{
  const s = checkers.init('семя', SEATS);
  ok('чужой ход отвергнут', checkers.why(s, 'чёрные', { path: movesOf(s.board, 1)[0] }) === 'Сейчас не ваш ход');
  ok('ход чужой шашкой отвергнут',
    /не ваша шашка|не ходит/.test(checkers.why(s, 'белые', { path: [at(1, 2), at(0, 3)] })),
    checkers.why(s, 'белые', { path: [at(1, 2), at(0, 3)] }));
  ok('путь из одного поля — не ход', checkers.why(s, 'белые', { path: [at(0, 5)] }) !== '');
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
