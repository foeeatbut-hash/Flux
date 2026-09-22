/**
 * 2048: правила одиночной доски.
 *
 * Игра одиночная, но правила всё равно живут на сервере, и это не
 * перестраховка. Счёт в 2048 — единственное, что от партии остаётся, а окно,
 * само считающее счёт, рано или поздно пришлёт тот, который нравится игроку.
 * Поэтому ход сюда приходит как направление, а доску двигает сервер.
 *
 * Отсюда же и семя: новая плитка подсевается случайно, но случайность должна
 * получаться одинаковой у сервера и у окна — иначе доска разъедется на первом
 * ходу. Поток берётся из семени партии и номера хода, и оба хранятся в
 * состоянии.
 *
 * Два правила, на которых ломаются почти все доски 2048:
 *   1. **Плитка сливается за ход ровно один раз.** Ряд `2 2 4` при сдвиге
 *      влево даёт `4 4`, а не `8`: свежая четвёрка во втором слиянии не
 *      участвует.
 *   2. **Порядок слияний — от края, к которому двигают.** Ряд `2 2 2` влево
 *      даёт `4 2`, а не `2 4`.
 */

import { pick, registerRules, rngOf, type GameOutcome, type GameRules } from './kit.js';

export const SIDE = 4;

export type Dir = 'up' | 'down' | 'left' | 'right';

export interface G2048State {
  /** Доска построчно; 0 — пусто */
  board: number[];
  score: number;
  seed: string;
  /** Номер хода: он же счётчик потока случайности */
  moves: number;
  seats: string[];
  /** Лучшая плитка за партию — её и показывают в итоге */
  best: number;
}

export interface G2048Move { dir: Dir }

const DIRS: Dir[] = ['up', 'down', 'left', 'right'];

/** Номера клеток одной линии в порядке движения: первым — тот, к чему жмём. */
function lineOf(dir: Dir, index: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < SIDE; i++) {
    out.push(
      dir === 'left' ? index * SIDE + i
        : dir === 'right' ? index * SIDE + (SIDE - 1 - i)
          : dir === 'up' ? i * SIDE + index
            : (SIDE - 1 - i) * SIDE + index,
    );
  }
  return out;
}

/**
 * Сдвинуть и слить одну линию. Возвращает новые значения и набранные очки.
 *
 * Плитка, только что получившаяся слиянием, во втором слиянии за этот ход не
 * участвует — за это отвечает `merged`.
 */
export function slideLine(values: number[]): { values: number[]; score: number } {
  const tight = values.filter((v) => v !== 0);
  const out: number[] = [];
  let score = 0;
  for (let i = 0; i < tight.length; i++) {
    if (i + 1 < tight.length && tight[i] === tight[i + 1]) {
      const sum = tight[i] * 2;
      out.push(sum);
      score += sum;
      i++;                     // вторая плитка пары израсходована
    } else {
      out.push(tight[i]);
    }
  }
  while (out.length < values.length) out.push(0);
  return { values: out, score };
}

/** Доска после сдвига — без подсева. */
export function slide(board: number[], dir: Dir): { board: number[]; score: number; moved: boolean } {
  const next = [...board];
  let score = 0;
  let moved = false;
  for (let index = 0; index < SIDE; index++) {
    const cells = lineOf(dir, index);
    const values = cells.map((c) => board[c]);
    const done = slideLine(values);
    score += done.score;
    cells.forEach((c, i) => {
      if (next[c] !== done.values[i]) moved = true;
      next[c] = done.values[i];
    });
  }
  return { board: next, score, moved };
}

/** Есть ли ход хоть в одну сторону. */
export const canMove = (board: number[]): boolean =>
  DIRS.some((d) => slide(board, d).moved);

/**
 * Подсеять плитку.
 *
 * Четвёрка выпадает в одном случае из десяти — так в этой игре принято, и
 * менять это без нужды не стоит: игроки знают её темп на ощупь.
 */
export function spawn(board: number[], seed: string, counter: number): number[] {
  const free = board.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
  if (!free.length) return board;
  const rnd = rngOf(seed, counter);
  const cell = free[pick(rnd, free.length)];
  const value = rnd() < 0.1 ? 4 : 2;
  const out = [...board];
  out[cell] = value;
  return out;
}

export const g2048: GameRules<G2048State, G2048Move> = {
  id: 'g2048',

  init(seed, seats) {
    // Две стартовые плитки — два разных шага потока, иначе обе лягут в одну клетку
    let board = new Array(SIDE * SIDE).fill(0);
    board = spawn(board, seed, 0);
    board = spawn(board, seed, 1);
    return { board, score: 0, seed, moves: 0, seats: [...seats], best: Math.max(...board) };
  },

  turnOf(state) {
    return canMove(state.board) ? (state.seats[0] || '') : '';
  },

  why(state, userId, move) {
    if (!canMove(state.board)) return 'Ходов больше нет — партия окончена';
    if (state.seats[0] !== userId) return 'Это чужая партия';
    if (!DIRS.includes(move?.dir as Dir)) return 'Непонятное направление';
    if (!slide(state.board, move.dir).moved) return 'В эту сторону ничего не двигается';
    return '';
  },

  apply(state, _userId, move) {
    const done = slide(state.board, move.dir);
    // Счётчик потока сдвинут на две стартовые плитки — иначе первый же подсев
    // повторил бы стартовый и лёг бы в занятую клетку
    const board = spawn(done.board, state.seed, state.moves + 2);
    return {
      ...state,
      board,
      score: state.score + done.score,
      moves: state.moves + 1,
      best: Math.max(state.best, ...board),
    };
  },

  outcome(state): GameOutcome {
    if (canMove(state.board)) {
      return { done: false, winnerTeam: 0, details: { score: state.score }, why: '' };
    }
    return {
      done: true,
      // Игра одиночная: дошёл до конца — считается победой, это его результат
      winnerTeam: 1,
      details: { score: state.score, best: state.best, moves: state.moves },
      why: `Счёт ${state.score}, лучшая плитка ${state.best}, ходов ${state.moves}`,
    };
  },

  /** Скрывать нечего: доска своя, и видит её один человек */
  viewOf(state) {
    return {
      board: state.board, score: state.score, best: state.best, moves: state.moves,
      dirs: DIRS.filter((d) => slide(state.board, d).moved),
    };
  },
};

registerRules(g2048 as GameRules);
