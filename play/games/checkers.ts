/**
 * Русские шашки: правила доски.
 *
 * Русские, а не международные, и это не мелочь: здесь простая шашка бьёт и
 * назад, дамка ходит и бьёт на любое расстояние, а превращение в дамку
 * посреди цепочки взятий происходит СРАЗУ — и дальше бой продолжается уже
 * дамкой. Перепутав правила, получаешь игру, в которую никто из отдела играть
 * не станет: ходы будут «почти» законными.
 *
 * Главное, на чём такие доски ломаются, — **обязательное взятие**. Есть чем
 * бить, значит бьём: тихий ход при возможном бое незаконен. И бить надо до
 * конца — цепочка взятий это ОДИН ход, а не несколько: пока с нового поля есть
 * чем бить, ход не передаётся.
 *
 * Побитые шашки снимаются в конце цепочки, а не по дороге. Сняв сразу, можно
 * перепрыгнуть одну и ту же шашку дважды и «побить» её второй раз — доска при
 * этом выглядит правдоподобно, и заметит подлог только тот, кто считал.
 */

import { registerRules, type GameOutcome, type GameRules } from './kit.js';

export const SIDE = 8;

/** 0 — пусто, 1/2 — простая шашка игрока, 3/4 — его же дамка */
export type Cell = 0 | 1 | 2 | 3 | 4;

const OWNER: Record<number, 0 | 1 | 2> = { 0: 0, 1: 1, 2: 2, 3: 1, 4: 2 };
const isKing = (c: Cell) => c === 3 || c === 4;
const kingOf = (who: 1 | 2): Cell => (who === 1 ? 3 : 4);
export const ownerOf = (c: Cell): 0 | 1 | 2 => OWNER[c] ?? 0;

export interface CheckersState {
  board: Cell[];
  turn: 1 | 2;
  seats: string[];
  /** Ходов подряд без боя и без движения простой шашки — для ничьей */
  quiet: number;
  history: number[][];
}

/** Ход — путь по полям: откуда, куда, и дальше, если цепочка */
export interface CheckersMove { path: number[] }

const xy = (c: number): [number, number] => [c % SIDE, Math.floor(c / SIDE)];
const at = (x: number, y: number): number => y * SIDE + x;
const inside = (x: number, y: number) => x >= 0 && x < SIDE && y >= 0 && y < SIDE;

const DIAG: Array<[number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

/** Поля между двумя клетками по диагонали. Не диагональ — пусто. */
function between(from: number, to: number): number[] {
  const [fx, fy] = xy(from);
  const [tx, ty] = xy(to);
  const dx = Math.sign(tx - fx);
  const dy = Math.sign(ty - fy);
  if (!dx || !dy || Math.abs(tx - fx) !== Math.abs(ty - fy)) return [];
  const out: number[] = [];
  for (let x = fx + dx, y = fy + dy; x !== tx || y !== ty; x += dx, y += dy) out.push(at(x, y));
  return out;
}

/**
 * Взятия из клетки одним прыжком.
 *
 * `taken` — уже побитые в этой цепочке: через них прыгать можно (шашки ещё
 * стоят на доске), а бить второй раз нельзя.
 */
function jumpsFrom(board: Cell[], from: number, who: 1 | 2, taken: number[]): Array<{ to: number; over: number }> {
  const piece = board[from];
  const out: Array<{ to: number; over: number }> = [];
  const foe = who === 1 ? 2 : 1;

  for (const [dx, dy] of DIAG) {
    let [x, y] = xy(from);
    // Дамка ищет жертву на любом расстоянии, простая — только через соседнюю
    const reach = isKing(piece) ? SIDE : 2;
    let over = -1;
    for (let step = 1; step < reach + 1; step++) {
      x += dx; y += dy;
      if (!inside(x, y)) break;
      const cell = at(x, y);
      const val = board[cell];
      if (val === 0) {
        // Пустое поле за жертвой — сюда можно приземлиться
        if (over >= 0) out.push({ to: cell, over });
        if (!isKing(piece) && over < 0 && step >= 1) break;   // простая через пустое не тянется
        continue;
      }
      if (over >= 0) break;                       // вторая фигура подряд — прыжка нет
      if (ownerOf(val) !== foe) break;            // своя фигура запирает диагональ
      if (taken.includes(cell)) break;            // эту уже побили в этой цепочке
      over = cell;
      if (!isKing(piece) && step > 1) break;      // простая бьёт только соседнюю
    }
  }
  return out;
}

/** Тихие ходы из клетки — только когда бить нечем. */
function quietFrom(board: Cell[], from: number, who: 1 | 2): number[] {
  const piece = board[from];
  const out: number[] = [];
  // Простая ходит вперёд: первый игрок снизу вверх, второй сверху вниз
  const forward = who === 1 ? -1 : 1;
  for (const [dx, dy] of DIAG) {
    if (!isKing(piece) && dy !== forward) continue;
    let [x, y] = xy(from);
    const reach = isKing(piece) ? SIDE : 1;
    for (let step = 1; step <= reach; step++) {
      x += dx; y += dy;
      if (!inside(x, y)) break;
      const cell = at(x, y);
      if (board[cell] !== 0) break;
      out.push(cell);
    }
  }
  return out;
}

/**
 * Все законные ходы игрока путями.
 *
 * Есть взятия — тихие ходы не возвращаются вовсе: обязательное взятие держится
 * здесь, а не проверкой где-то ещё, и обойти его нечем.
 */
export function movesOf(board: Cell[], who: 1 | 2): number[][] {
  const mine = board.map((c, i) => (ownerOf(c) === who ? i : -1)).filter((i) => i >= 0);

  const chains: number[][] = [];
  const walk = (path: number[], work: Cell[], taken: number[]): void => {
    const from = path[path.length - 1];
    const next = jumpsFrom(work, from, who, taken);
    if (!next.length) {
      if (path.length > 1) chains.push([...path]);
      return;
    }
    for (const j of next) {
      const after = [...work];
      const piece = after[from];
      after[from] = 0;
      // Превращение посреди цепочки: дальше бьёт уже дамка
      const [, ty] = xy(j.to);
      const crowned = !isKing(piece) && ((who === 1 && ty === 0) || (who === 2 && ty === SIDE - 1));
      after[j.to] = crowned ? kingOf(who) : piece;
      walk([...path, j.to], after, [...taken, j.over]);
    }
  };
  for (const from of mine) walk([from], board, []);
  if (chains.length) return chains;

  const quiet: number[][] = [];
  for (const from of mine) for (const to of quietFrom(board, from, who)) quiet.push([from, to]);
  return quiet;
}

/** Применить путь: снять побитых, передвинуть, при нужде короновать. */
export function play(board: Cell[], path: number[], who: 1 | 2): Cell[] {
  const out = [...board];
  let piece = out[path[0]];
  out[path[0]] = 0;
  const taken: number[] = [];

  for (let i = 1; i < path.length; i++) {
    for (const cell of between(path[i - 1], path[i])) {
      if (out[cell] !== 0 && ownerOf(out[cell]) !== who) taken.push(cell);
    }
    const [, ty] = xy(path[i]);
    if (!isKing(piece) && ((who === 1 && ty === 0) || (who === 2 && ty === SIDE - 1))) piece = kingOf(who);
  }
  // Побитые снимаются в конце: сняв по дороге, одну и ту же шашку можно
  // перепрыгнуть дважды, и доска будет выглядеть правдоподобно
  for (const cell of taken) out[cell] = 0;
  out[path[path.length - 1]] = piece;
  return out;
}

function startBoard(): Cell[] {
  const board: Cell[] = new Array(SIDE * SIDE).fill(0) as Cell[];
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      if ((x + y) % 2 === 0) continue;         // играют по тёмным полям
      if (y < 3) board[at(x, y)] = 2;
      if (y > SIDE - 4) board[at(x, y)] = 1;
    }
  }
  return board;
}

const countOf = (board: Cell[], who: 1 | 2) => board.filter((c) => ownerOf(c) === who).length;

const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export const checkers: GameRules<CheckersState, CheckersMove> = {
  id: 'checkers',

  init(_seed, seats) {
    return { board: startBoard(), turn: 1, seats: [...seats], quiet: 0, history: [] };
  },

  turnOf(state) {
    return this.outcome(state).done ? '' : (state.seats[state.turn - 1] || '');
  },

  why(state, userId, move) {
    if (this.outcome(state).done) return 'Партия окончена';
    if (state.seats[state.turn - 1] !== userId) return 'Сейчас не ваш ход';
    const path = Array.isArray(move?.path) ? move.path : [];
    if (path.length < 2) return 'Ход — это откуда и куда';

    const all = movesOf(state.board, state.turn);
    if (all.some((p) => same(p, path))) return '';

    /**
     * Отказ называется по существу.
     *
     * «Бить обязательно», «бить надо до конца» и «так эта шашка не ходит» —
     * три разные ошибки, и человек должен видеть, какую он сделал. Порядок
     * проверок важен: остановившийся посреди боя ТОЖЕ бил, и сказать ему
     * «бить обязательно» значит сбить его с толку.
     */
    const startsWith = (p: number[]) => path.every((c, i) => p[i] === c);
    if (all.some((p) => p.length > path.length && startsWith(p))) {
      return 'Бить надо до конца: цепочка взятий — это один ход';
    }
    const mustJump = all.some((p) => between(p[0], p[1]).some((c) => state.board[c] !== 0));
    if (mustJump) return 'Бить обязательно — тихий ход при возможном бое не считается';
    if (ownerOf(state.board[path[0]]) !== state.turn) return 'Это не ваша шашка';
    return 'Так эта шашка не ходит';
  },

  apply(state, _userId, move) {
    const board = play(state.board, move.path, state.turn);
    const jumped = move.path.length > 2
      || between(move.path[0], move.path[1]).some((c) => state.board[c] !== 0);
    const simple = !isKing(state.board[move.path[0]]);
    return {
      ...state,
      board,
      turn: state.turn === 1 ? 2 : 1,
      // Счётчик ничьей: бой и ход простой шашкой его обнуляют — после них
      // позиция уже не повторится
      quiet: jumped || simple ? 0 : state.quiet + 1,
      history: [...state.history, move.path],
    };
  },

  outcome(state): GameOutcome {
    const mine = countOf(state.board, 1);
    const theirs = countOf(state.board, 2);
    const stuck = movesOf(state.board, state.turn).length === 0;

    if (!mine || !theirs || stuck) {
      // Проиграл тот, кому нечем или некем ходить. Это и есть правило: в
      // шашках запертый проигрывает, а не объявляет ничью
      const winnerTeam = !mine ? 2 : !theirs ? 1 : (state.turn === 1 ? 2 : 1);
      return {
        done: true, winnerTeam, details: { white: mine, black: theirs },
        why: !mine || !theirs
          ? `${winnerTeam === 1 ? 'Белые' : 'Чёрные'} забрали все шашки`
          : `${winnerTeam === 1 ? 'Белые' : 'Чёрные'} победили: сопернику нечем ходить`,
      };
    }
    // Тридцать тихих ходов дамками подряд — ничья: дальше ничего не случится
    if (state.quiet >= 30) {
      return { done: true, winnerTeam: 0, details: { white: mine, black: theirs }, why: 'Ничья: тридцать ходов без боя' };
    }
    return { done: false, winnerTeam: 0, details: { white: mine, black: theirs }, why: '' };
  },

  /** Скрытого в шашках нет: доска видна обоим */
  viewOf(state) {
    return {
      board: state.board, turn: state.turn,
      white: countOf(state.board, 1), black: countOf(state.board, 2),
      moves: movesOf(state.board, state.turn),
    };
  },
};

registerRules(checkers as GameRules);
