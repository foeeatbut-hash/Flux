/**
 * Реверси: правила и ничего кроме.
 *
 * Игра выбрана первой не случайно — в ней есть всё, на чём ломаются доски:
 * ход меняет не одну клетку, а линии в восьми направлениях; ход, который
 * ничего не переворачивает, незаконен; а когда ходить некому, ход ПЕРЕХОДИТ, и
 * партия от этого не кончается — кончается она, когда пропустили оба подряд.
 *
 * Последнее и есть то, ради чего правила живут отдельно от окна: пропуск —
 * это состояние доски, а не сообщение на экране, и считать его должен тот же,
 * кто считает ходы.
 */

import { registerRules, type GameOutcome, type GameRules } from './kit.js';

export const SIZE = 8;

/** Клетка: 0 — пусто, 1 — первый игрок (чёрные), 2 — второй (белые) */
export type Cell = 0 | 1 | 2;

export interface ReversiState {
  board: Cell[];
  /** Чья очередь: 1 или 2 */
  turn: 1 | 2;
  seats: string[];
  /** Сколько раз подряд пропустили ход: двойка кончает партию */
  passes: number;
  /** Ходы партии — для разбора и для повтора */
  history: number[];
}

export interface ReversiMove {
  /** Номер клетки 0…63; -1 — «пропускаю», и это законно только без ходов */
  cell: number;
}

const DIRS = [-9, -8, -7, -1, 1, 7, 8, 9];

const at = (x: number, y: number) => y * SIZE + x;
export const xy = (cell: number): [number, number] => [cell % SIZE, Math.floor(cell / SIZE)];

/** Соседняя клетка в направлении, с учётом краёв доски. */
function step(cell: number, dir: number): number {
  const [x, y] = xy(cell);
  const dx = dir === -9 || dir === -1 || dir === 7 ? -1 : dir === -7 || dir === 1 || dir === 9 ? 1 : 0;
  const dy = dir <= -7 ? -1 : dir >= 7 ? 1 : 0;
  const nx = x + dx;
  const ny = y + dy;
  return nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE ? -1 : at(nx, ny);
}

/**
 * Что перевернётся, если сюда поставить.
 *
 * Пустой список означает «сюда нельзя»: ход, который ничего не переворачивает,
 * в реверси не ход. Здесь же и вся проверка законности — второй раз её писать
 * негде, и разойтись ей не с чем.
 */
export function flipsOf(board: Cell[], cell: number, who: 1 | 2): number[] {
  if (cell < 0 || cell >= SIZE * SIZE || board[cell] !== 0) return [];
  const foe = who === 1 ? 2 : 1;
  const out: number[] = [];
  for (const dir of DIRS) {
    const line: number[] = [];
    let at2 = step(cell, dir);
    while (at2 >= 0 && board[at2] === foe) { line.push(at2); at2 = step(at2, dir); }
    // Линия чужих засчитывается, только если упёрлась в своего
    if (at2 >= 0 && line.length && board[at2] === who) out.push(...line);
  }
  return out;
}

/** Все клетки, куда этот игрок может пойти. */
export const movesOf = (board: Cell[], who: 1 | 2): number[] =>
  board.map((_, i) => i).filter((i) => flipsOf(board, i, who).length > 0);

export const countOf = (board: Cell[], who: 1 | 2): number =>
  board.reduce((n, c) => n + (c === who ? 1 : 0), 0);

function startBoard(): Cell[] {
  const board: Cell[] = new Array(SIZE * SIZE).fill(0) as Cell[];
  board[at(3, 3)] = 2; board[at(4, 4)] = 2;
  board[at(3, 4)] = 1; board[at(4, 3)] = 1;
  return board;
}

export const reversi: GameRules<ReversiState, ReversiMove> = {
  id: 'reversi',

  init(_seed, seats) {
    return { board: startBoard(), turn: 1, seats: [...seats], passes: 0, history: [] };
  },

  turnOf(state) {
    return this.outcome(state).done ? '' : (state.seats[state.turn - 1] || '');
  },

  why(state, userId, move) {
    if (this.outcome(state).done) return 'Партия окончена';
    if (state.seats[state.turn - 1] !== userId) return 'Сейчас не ваш ход';
    const can = movesOf(state.board, state.turn);
    if (move?.cell === -1) {
      return can.length ? 'Ходить есть куда — пропускать нельзя' : '';
    }
    if (!can.includes(move?.cell ?? -2)) {
      return state.board[move?.cell ?? -1] !== 0
        ? 'Клетка занята'
        : 'Сюда нельзя: ни одна фишка не переворачивается';
    }
    return '';
  },

  apply(state, _userId, move) {
    const board = [...state.board];
    let passes = state.passes;
    if (move.cell === -1) {
      passes += 1;
    } else {
      board[move.cell] = state.turn;
      for (const f of flipsOf(state.board, move.cell, state.turn)) board[f] = state.turn;
      passes = 0;
    }
    return {
      ...state,
      board,
      turn: state.turn === 1 ? 2 : 1,
      passes,
      history: [...state.history, move.cell],
    };
  },

  outcome(state): GameOutcome {
    const black = countOf(state.board, 1);
    const white = countOf(state.board, 2);
    const full = black + white === SIZE * SIZE;
    // Партия кончается тремя способами: доска полна, пропустили оба подряд,
    // или у кого-то не осталось ни одной фишки
    const stuck = state.passes >= 2;
    const wiped = black === 0 || white === 0;
    if (!full && !stuck && !wiped) {
      return { done: false, winnerTeam: 0, details: { black, white }, why: '' };
    }
    const winnerTeam = black === white ? 0 : black > white ? 1 : 2;
    return {
      done: true, winnerTeam, details: { black, white },
      why: winnerTeam === 0 ? `Ничья ${black} : ${white}`
        : `${winnerTeam === 1 ? 'Чёрные' : 'Белые'} ${Math.max(black, white)} : ${Math.min(black, white)}`,
    };
  },

  /** Скрытых сведений в реверси нет: доска видна обоим целиком */
  viewOf(state) {
    return {
      board: state.board, turn: state.turn, passes: state.passes,
      black: countOf(state.board, 1), white: countOf(state.board, 2),
      moves: movesOf(state.board, state.turn),
    };
  },
};

registerRules(reversi as GameRules);
