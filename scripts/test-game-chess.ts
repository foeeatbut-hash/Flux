/**
 * Шахматы: правила доски.
 *
 * Проверяется то, на чём доска выглядит рабочей и ею не является:
 *
 *   — **связка**: фигура, закрывающая короля, ходит «правильно» и всё равно
 *     не имеет права;
 *   — **шах закрывают**, а не игнорируют: при шахе законны только ходы,
 *     снимающие его;
 *   — **рокировка** во все стороны и все четыре случая, когда её нет;
 *   — **взятие на проходе** — единственное взятие, где побитая фигура стоит
 *     не там, куда пошли, и живёт оно ровно один полуход;
 *   — **превращение**: без указания фигуры ход не принимается;
 *   — **ничьи**: пат, пятьдесят ходов, троекратное повторение, нехватка
 *     материала. Не объявив их, программа оставляет двоих доигрывать вечность.
 *
 * Запуск: npx tsx scripts/test-game-chess.ts
 */

import {
  chess, boardOf, allLegal, legalFrom, attacked, inCheck, tooLittle, nameOf,
  type ChessState,
} from '../play/games/chess';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

const SEATS = ['белые', 'чёрные'];
const at = (x: number, y: number) => y * 8 + x;
/** Поле по имени: e4 → номер клетки */
const sq = (name: string) => at('abcdefgh'.indexOf(name[0]), 8 - Number(name[1]));

const state = (rows: string[], turn: 'w' | 'b' = 'w', extra: Partial<ChessState> = {}): ChessState => {
  const s: ChessState = {
    board: boardOf(rows), turn, seats: SEATS, castle: '', ep: -1, half: 0, full: 1,
    history: [], seed: 'семя', ...extra,
  };
  return s;
};
const EMPTY = ['........', '........', '........', '........', '........', '........', '........', '........'];
const движ = (s: ChessState, from: string, to: string, promo?: string) =>
  chess.apply(s, s.turn === 'w' ? SEATS[0] : SEATS[1], { from: sq(from), to: sq(to), ...(promo ? { promo } : {}) });
const почему = (s: ChessState, from: string, to: string, promo?: string) =>
  chess.why(s, s.turn === 'w' ? SEATS[0] : SEATS[1], { from: sq(from), to: sq(to), ...(promo ? { promo } : {}) });

console.log('1. Начальная позиция');
{
  const s = chess.init('семя', SEATS) as ChessState;
  ok('двадцать ходов у белых', allLegal(s).length === 20, allLegal(s).length);
  ok('ходят белые', chess.turnOf(s) === SEATS[0]);
  ok('не своя очередь — отказ', /ходит соперник/.test(chess.why({ ...s, turn: 'b' }, SEATS[0], { from: sq('e2'), to: sq('e4') })));
  ok('чёрными ходить нельзя', /соперника/.test(chess.why(s, SEATS[0], { from: sq('e7'), to: sq('e5') })));
  ok('конь с b1 ходит на a3 и c3', legalFrom(s, sq('b1')).map((m) => m.to).sort().join() === [sq('a3'), sq('c3')].sort().join());
  ok('имя поля читается', nameOf(sq('e4')) === 'e4' && nameOf(0) === 'a8' && nameOf(63) === 'h1');
  const after = движ(s, 'e2', 'e4');
  ok('после хода очередь чёрных', after.turn === 'b');
  ok('поле «на проходе» появилось', after.ep === sq('e3'));
  const next = движ(after, 'b8', 'c6');
  ok('поле «на проходе» живёт один полуход', next.ep === -1);
  ok('счётчик пятидесяти сброшен ходом пешки', after.half === 0);
}

console.log('2. Под боем и шах');
{
  const s = state(['....k...', '........', '........', '........', '....P...', '........', '........', '....K...']);
  ok('пешка бьёт по диагонали вперёд', attacked(s.board, sq('d5'), 'w') && attacked(s.board, sq('f5'), 'w'));
  ok('пешка не бьёт назад', !attacked(s.board, sq('d3'), 'w'));
  ok('пешка не бьёт прямо', !attacked(s.board, sq('e5'), 'w'));

  // Связка: белая ладья на e2 закрывает своего короля от чёрной ладьи
  const pin = state(['....r...', '........', '........', '........', '........', '........', '....R...', '....K...']);
  ok('связанная ладья вбок не ходит', legalFrom(pin, sq('e2')).every((m) => m.to % 8 === 4), legalFrom(pin, sq('e2')).map((m) => nameOf(m.to)));
  ok('связанная ладья по линии ходит', legalFrom(pin, sq('e2')).some((m) => m.to === sq('e4')));
  ok('отказ объясняет, что король под боем', /король под боем/.test(почему(pin, 'e2', 'a2')));

  // Шах: король под боем, и законны только ходы, его снимающие
  const check = state(['....r...', '........', '........', '........', '........', '........', '.......R', '....K...']);
  ok('король под шахом', inCheck(check.board, 'w'));
  const moves = allLegal(check);
  ok('все ходы снимают шах', moves.length > 0 && moves.every((m) => !inCheck(chess.apply(check, SEATS[0], m).board, 'w')));
  ok('ладья закрывает шах на e2', moves.some((m) => m.from === sq('h2') && m.to === sq('e2')));
  ok('отказ при шахе назван шахом', /шах/.test(почему(check, 'h2', 'h3')));
}

console.log('3. Рокировка');
{
  const rows = ['....k...', '........', '........', '........', '........', '........', '........', 'R...K..R'];
  const s = state(rows, 'w', { castle: 'KQ' });
  const king = legalFrom(s, sq('e1')).map((m) => nameOf(m.to));
  ok('короткая есть', king.includes('g1'), king);
  ok('длинная есть', king.includes('c1'), king);

  const after = движ(s, 'e1', 'g1');
  ok('ладья переехала с h1 на f1', after.board[sq('f1')] === 'R' && after.board[sq('h1')] === '');
  ok('права рокировки потеряны', after.castle === '');

  const long = движ(s, 'e1', 'c1');
  ok('длинная: ладья с a1 на d1', long.board[sq('d1')] === 'R' && long.board[sq('a1')] === '');

  const blocked = state(['....k...', '........', '........', '........', '........', '........', '........', 'R...KN.R'], 'w', { castle: 'KQ' });
  ok('через свою фигуру не рокируют', !legalFrom(blocked, sq('e1')).some((m) => m.to === sq('g1')));

  const through = state(['....kr..', '........', '........', '........', '........', '........', '........', 'R...K..R'], 'w', { castle: 'KQ' });
  ok('через битое поле не рокируют', !legalFrom(through, sq('e1')).some((m) => m.to === sq('g1')));
  ok('в другую сторону при этом можно', legalFrom(through, sq('e1')).some((m) => m.to === sq('c1')));

  const underCheck = state(['....k...', '........', '........', '........', '........', '........', '........', 'R...K..R'], 'w', { castle: 'KQ' });
  underCheck.board[sq('e5')] = 'r';
  ok('из-под шаха не рокируют', !legalFrom(underCheck, sq('e1')).some((m) => Math.abs(m.to - sq('e1')) === 2));

  const moved = движ(движ(движ(s, 'a1', 'a2'), 'e8', 'd8'), 'a2', 'a1');
  ok('ход ладьёй отнимает длинную навсегда', !moved.castle.includes('Q') && moved.castle.includes('K'), moved.castle);

  // Взятие ладьи на её поле тоже отнимает право — забывают чаще всего
  const grab = state(['r...k..r', '........', '........', '........', '........', '........', '........', 'R...K..R'], 'w', { castle: 'KQkq' });
  grab.board[sq('a3')] = 'R';
  const taken = движ(grab, 'a3', 'a8');
  ok('взятие ладьи отнимает право у соперника', !taken.castle.includes('q') && taken.castle.includes('k'), taken.castle);
}

console.log('4. Взятие на проходе');
{
  const s = state(['....k...', '...p....', '........', '....P...', '........', '........', '........', '....K...'], 'b');
  const after = движ(s, 'd7', 'd5');
  ok('поле прохода — d6', after.ep === sq('d6'));
  ok('взятие на проходе законно', почему(after, 'e5', 'd6') === '', почему(after, 'e5', 'd6'));
  const done = движ(after, 'e5', 'd6');
  ok('побитая пешка снята не с поля хода', done.board[sq('d5')] === '' && done.board[sq('d6')] === 'P');

  // Не взяли сразу — больше нельзя: право живёт один полуход
  const late = движ(движ(after, 'e1', 'e2'), 'e8', 'e7');
  ok('через ход взять на проходе нельзя', почему(late, 'e5', 'd6') !== '');
}

console.log('5. Превращение');
{
  const s = state(['.......k', 'P.......', '........', '........', '........', '........', '........', 'K.......']);
  ok('без указания фигуры не принимается', /укажите/i.test(почему(s, 'a7', 'a8')), почему(s, 'a7', 'a8'));
  ok('в ферзя можно', почему(s, 'a7', 'a8', 'Q') === '');
  ok('в коня можно', почему(s, 'a7', 'a8', 'N') === '');
  ok('в короля нельзя', почему(s, 'a7', 'a8', 'K') !== '');
  const q = движ(s, 'a7', 'a8', 'Q');
  ok('на доске белый ферзь', q.board[sq('a8')] === 'Q');
  const n = движ(s, 'a7', 'a8', 'N');
  ok('конь тоже ставится', n.board[sq('a8')] === 'N');
}

console.log('6. Мат, пат и сдача материала');
{
  // Детский мат в четыре полухода: f3 e5 g4 Ф:h4
  let s = chess.init('семя', SEATS) as ChessState;
  s = движ(s, 'f2', 'f3');
  s = движ(s, 'e7', 'e5');
  s = движ(s, 'g2', 'g4');
  ok('до мата партия идёт', chess.outcome(s).done === false);
  s = движ(s, 'd8', 'h4');
  const mate = chess.outcome(s);
  ok('мат объявлен', mate.done === true, mate);
  ok('выиграли чёрные', mate.winnerTeam === 2, mate);
  ok('после мата очереди нет', chess.turnOf(s) === '');
  ok('после мата ходить нельзя', /окончена/.test(почему(s, 'e1', 'e2')));

  const pat = state(['k.......', '..Q.....', '........', '........', '........', '........', '........', '....K...'], 'b');
  ok('пат: ходов нет', allLegal(pat).length === 0);
  ok('пат: шаха нет', !inCheck(pat.board, 'b'));
  const out = chess.outcome(pat);
  ok('пат объявлен ничьёй', out.done && out.winnerTeam === 0, out);

  const back = state(['R.....k.', '.....ppp', '........', '........', '........', '........', '........', '....K...'], 'b');
  ok('мат по последней горизонтали', chess.outcome(back).done && chess.outcome(back).winnerTeam === 1);
}

console.log('7. Ничьи, которые забывают объявить');
{
  const fifty = state(['....k...', '........', '........', '........', '........', '........', '....R...', '....K...'], 'w', { half: 99 });
  ok('на девяносто девятом полуходе партия идёт', !chess.outcome(fifty).done);
  const done = движ(fifty, 'e2', 'd2');
  ok('пятьдесят ходов — ничья', chess.outcome(done).done && /пятьдесят/.test(chess.outcome(done).why), chess.outcome(done).why);

  let s = chess.init('семя', SEATS) as ChessState;
  const dance = () => {
    s = движ(s, 'b1', 'c3'); s = движ(s, 'b8', 'c6');
    s = движ(s, 'c3', 'b1'); s = движ(s, 'c6', 'b8');
  };
  dance();
  ok('после первого возврата ничьей нет', !chess.outcome(s).done);
  dance();
  const rep = chess.outcome(s);
  ok('троекратное повторение — ничья', rep.done && /повтор/.test(rep.why), rep.why);

  ok('король против короля — ничья', tooLittle(boardOf(['....k...', '........', '........', '........', '........', '........', '........', '....K...'])));
  ok('король с конём — ничья', tooLittle(boardOf(['....k...', '........', '........', '........', '........', '........', '.....N..', '....K...'])));
  ok('король с ладьёй — не ничья', !tooLittle(boardOf(['....k...', '........', '........', '........', '........', '........', '.....R..', '....K...'])));
  ok('пешка на доске — не ничья', !tooLittle(boardOf(['....k...', '........', '........', '........', '........', '........', '.....P..', '....K...'])));
  const material = state(['....k...', '........', '........', '........', '........', '........', '.....N..', '....K...'], 'b');
  ok('нехватка материала объявляется', chess.outcome(material).done && /матовать нечем/.test(chess.outcome(material).why));
}

console.log('8. Отказы словами');
{
  const s = chess.init('семя', SEATS) as ChessState;
  ok('пустое поле названо пустым', /пусто/.test(почему(s, 'e4', 'e5')));
  ok('чужая фигура названа чужой', /фигура соперника/.test(почему(s, 'e7', 'e5')));
  ok('невозможный ход назван невозможным', /так не ходят/.test(почему(s, 'b1', 'b3')));
  ok('запертой фигуре нечем ходить', /ходить нечем/.test(почему(s, 'c1', 'e3')));
  ok('посторонний не за доской', chess.why(s, 'третий', { from: 0, to: 1 }) !== '');
  ok('ход не прочитан', /не прочитан/.test(chess.why(s, SEATS[0], { from: -5, to: 900 })));
  const view: any = chess.viewOf(s, SEATS[0]);
  ok('снимок отдаёт ходы тому, чья очередь', view.moves.length === 20);
  ok('сопернику ходов не отдают', (chess.viewOf(s, SEATS[1]) as any).moves.length === 0);
  ok('снимок не прячет доску', view.board.filter((p: string) => p).length === 32);
}

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
