/**
 * Судоку: сетка, у которой решение ровно одно.
 *
 * Единственность решения — не украшение, а само условие задачи. Сетка с двумя
 * решениями выглядит как обычная, решается как обычная, и человек честно
 * доходит до конца — а программа говорит «неверно», потому что сверяет с тем
 * решением, которое выбрала сама. Объяснить это игроку невозможно, потому что
 * он прав. Поэтому клетка убирается только тогда, когда решение остаётся
 * единственным, и проверяется это перебором с ранней остановкой на втором.
 *
 * Правила живут на сервере по той же причине, что и в 2048: сетка выдаётся
 * оттуда же, и решение в окно не уезжает. Подсказка открывает ОДНУ клетку и
 * помечает её — иначе «подсказка» становится кнопкой «решить за меня», а
 * пройденная так партия ничего не значит.
 */

import { pick, registerRules, rngOf, shuffled, type GameOutcome, type GameRules } from './kit.js';

export const SIDE = 9;
const CELLS = SIDE * SIDE;

export type Level = 'лёгкий' | 'обычный' | 'трудный';

/** Сколько клеток оставить открытыми. Меньше — труднее. */
const GIVENS: Record<Level, number> = { 'лёгкий': 42, 'обычный': 34, 'трудный': 28 };

export interface SudokuState {
  /** Выданная сетка: 0 — пусто. Эти клетки менять нельзя */
  puzzle: number[];
  /** Что вписал игрок: 0 — пусто */
  filled: number[];
  /** Клетки, открытые подсказкой: их не засчитывают игроку */
  hinted: number[];
  /** Решение. В окно НЕ уезжает — см. `viewOf` */
  solution: number[];
  level: Level;
  seats: string[];
  /** Сколько раз ошибся: для итога, а не для наказания */
  mistakes: number;
  hints: number;
  done: boolean;
}

export type SudokuMove =
  | { kind: 'set'; cell: number; value: number }
  | { kind: 'clear'; cell: number }
  | { kind: 'hint' };

const rowOf = (c: number) => Math.floor(c / SIDE);
const colOf = (c: number) => c % SIDE;
const boxOf = (c: number) => Math.floor(rowOf(c) / 3) * 3 + Math.floor(colOf(c) / 3);

/** Можно ли поставить цифру, не нарушив строку, столбец и квадрат. */
export function fits(grid: number[], cell: number, value: number): boolean {
  for (let i = 0; i < CELLS; i++) {
    if (i === cell || grid[i] !== value) continue;
    if (rowOf(i) === rowOf(cell) || colOf(i) === colOf(cell) || boxOf(i) === boxOf(cell)) return false;
  }
  return true;
}

/**
 * Сколько решений у сетки — но не больше `limit`.
 *
 * Считать все решения незачем и дорого: для проверки единственности хватает
 * ответа «одно» или «больше одного», и перебор останавливается на втором.
 */
export function countSolutions(grid: number[], limit = 2): number {
  const work = [...grid];
  let found = 0;

  const solve = (): void => {
    if (found >= limit) return;
    // Клетка с наименьшим выбором — иначе перебор уходит в лес
    let best = -1;
    let bestOptions: number[] = [];
    for (let c = 0; c < CELLS; c++) {
      if (work[c] !== 0) continue;
      const options: number[] = [];
      for (let v = 1; v <= SIDE; v++) if (fits(work, c, v)) options.push(v);
      if (!options.length) return;                 // тупик
      if (best < 0 || options.length < bestOptions.length) { best = c; bestOptions = options; }
      if (options.length === 1) break;
    }
    if (best < 0) { found++; return; }             // пустых нет — решение
    for (const v of bestOptions) {
      work[best] = v;
      solve();
      work[best] = 0;
      if (found >= limit) return;
    }
  };

  solve();
  return found;
}

/** Полная правильная сетка из семени. */
export function fullGrid(seed: string): number[] {
  const grid = new Array(CELLS).fill(0);
  let step = 0;

  const fill = (cell: number): boolean => {
    if (cell >= CELLS) return true;
    const rnd = rngOf(seed, step++);
    for (const v of shuffled([1, 2, 3, 4, 5, 6, 7, 8, 9], rnd)) {
      if (!fits(grid, cell, v)) continue;
      grid[cell] = v;
      if (fill(cell + 1)) return true;
      grid[cell] = 0;
    }
    return false;
  };

  fill(0);
  return grid;
}

/**
 * Сетка задачи: убираем клетки, пока решение остаётся единственным.
 *
 * Порядок обхода случаен по семени, но повторяем: одна и та же партия у
 * сервера и у окна получается одинаковой.
 */
export function puzzleOf(seed: string, level: Level): { puzzle: number[]; solution: number[] } {
  const solution = fullGrid(seed);
  const puzzle = [...solution];
  const rnd = rngOf(seed, 1000);
  let open = CELLS;
  const want = GIVENS[level] ?? GIVENS['обычный'];

  for (const cell of shuffled(Array.from({ length: CELLS }, (_, i) => i), rnd)) {
    if (open <= want) break;
    const kept = puzzle[cell];
    puzzle[cell] = 0;
    // Убрали — и решений стало больше одного: клетку возвращаем
    if (countSolutions(puzzle) !== 1) puzzle[cell] = kept;
    else open--;
  }
  return { puzzle, solution };
}

/** Клетки, которые сейчас нарушают правило: их и подсвечивает окно. */
export function conflicts(grid: number[]): number[] {
  const out: number[] = [];
  for (let c = 0; c < CELLS; c++) {
    const v = grid[c];
    if (!v) continue;
    if (!fits(grid, c, v)) out.push(c);
  }
  return out;
}

const merged = (state: SudokuState): number[] =>
  state.puzzle.map((v, i) => (v || state.filled[i] || 0));

export const sudoku: GameRules<SudokuState, SudokuMove> = {
  id: 'sudoku',

  init(seed, seats) {
    const level: Level = 'обычный';
    const { puzzle, solution } = puzzleOf(seed, level);
    return {
      puzzle, solution, level, seats: [...seats],
      filled: new Array(CELLS).fill(0), hinted: [],
      mistakes: 0, hints: 0, done: false,
    };
  },

  turnOf(state) {
    return state.done ? '' : (state.seats[0] || '');
  },

  why(state, userId, move) {
    if (state.done) return 'Сетка уже заполнена';
    if (state.seats[0] !== userId) return 'Это чужая партия';
    if (move?.kind === 'hint') {
      return merged(state).some((v) => v === 0) ? '' : 'Открывать больше нечего';
    }
    const cell = (move as any)?.cell;
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) return 'Нет такой клетки';
    if (state.puzzle[cell]) return 'Эта цифра была в условии — её не меняют';
    if (move.kind === 'clear') return '';
    const value = (move as any).value;
    if (!Number.isInteger(value) || value < 1 || value > SIDE) return 'Цифра бывает от 1 до 9';
    if (state.hinted.includes(cell)) return 'Клетку открыла подсказка — её не меняют';
    return '';
  },

  apply(state, _userId, move) {
    const filled = [...state.filled];
    const hinted = [...state.hinted];
    let { mistakes, hints } = state;

    if (move.kind === 'hint') {
      // Открывается ОДНА клетка, и она помечается: подсказка не должна
      // превращаться в кнопку «решить за меня»
      const free = merged(state).map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
      const rnd = rngOf(`${state.level}`, hints);
      const cell = free[pick(rnd, free.length)];
      filled[cell] = state.solution[cell];
      hinted.push(cell);
      hints++;
    } else if (move.kind === 'clear') {
      filled[move.cell] = 0;
    } else {
      filled[move.cell] = move.value;
      // Ошибка считается, но ход не отвергается: судоку решают в том числе
      // и пробой, и мешать этому программа не должна
      if (move.value !== state.solution[move.cell]) mistakes++;
    }

    const next = { ...state, filled, hinted, mistakes, hints };
    const grid = merged(next);
    const full = grid.every((v) => v !== 0);
    return { ...next, done: full && conflicts(grid).length === 0 };
  },

  outcome(state): GameOutcome {
    if (!state.done) {
      return { done: false, winnerTeam: 0, details: { mistakes: state.mistakes }, why: '' };
    }
    return {
      done: true,
      winnerTeam: 1,
      details: { level: state.level, mistakes: state.mistakes, hints: state.hints },
      why: `Сетка «${state.level}» решена`
        + (state.hints ? `, подсказок ${state.hints}` : ', без подсказок')
        + (state.mistakes ? `, ошибок ${state.mistakes}` : ''),
    };
  },

  /**
   * Решение в окно НЕ уезжает.
   *
   * Иначе «судоку» решается средствами разработчика за десять секунд, и
   * пройденная сетка перестаёт что-либо значить. Окну хватает условия, того,
   * что вписано, и списка клеток, нарушающих правило.
   */
  viewOf(state) {
    const grid = merged(state);
    return {
      puzzle: state.puzzle,
      filled: state.filled,
      hinted: state.hinted,
      level: state.level,
      mistakes: state.mistakes,
      hints: state.hints,
      conflicts: conflicts(grid),
      left: grid.filter((v) => v === 0).length,
      done: state.done,
    };
  },
};

registerRules(sudoku as GameRules);
