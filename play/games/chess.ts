/**
 * Шахматы: правила доски.
 *
 * Самая длинная из встроенных игр, и длинная она не от сложности фигур, а от
 * трёх исключений, которые пишутся отдельно от всего остального: рокировка,
 * взятие на проходе и превращение. Доска, где их нет, выглядит рабочей ровно
 * до той партии, в которой они понадобились.
 *
 * Главное решение здесь — **законность хода проверяется применением**. Ход,
 * после которого собственный король остаётся под боем, незаконен, и никакими
 * списками направлений это не выражается: связанная фигура ходит «правильно»
 * и всё равно не имеет права. Поэтому каждый псевдоход делается на копии
 * доски, и если после него король под боем — ход отбрасывается. Дороже, чем
 * хитрый расчёт связок, и ровно настолько же надёжнее.
 *
 * Второе — **ничья тоже конец партии**. Пат, пятьдесят ходов без взятий и
 * движения пешки, троекратное повторение позиции, нехватка материала: не
 * объявив их, программа оставляет двух людей доигрывать вечную ничью и делает
 * вид, что так и надо.
 *
 * Фигуры — буквами: белые прописными (`KQRBNP`), чёрные строчными. Читается
 * глазами в проверках, кладётся в JSON без переводов.
 */

import { registerRules, type GameOutcome, type GameRules } from './kit.js';

export const SIDE = 8;
export const CELLS = 64;

export type Side = 'w' | 'b';

export interface ChessState {
  /** 64 клетки: 0 — a8, 63 — h1. Пусто — пустая строка */
  board: string[];
  turn: Side;
  seats: string[];
  /** Права рокировки, что осталось из «KQkq» */
  castle: string;
  /** Поле, через которое только что прошла пешка; -1 — нет такого */
  ep: number;
  /** Полуходов без взятия и без хода пешкой — для ничьей по пятидесяти */
  half: number;
  full: number;
  /** Позиции, которые уже были, — для ничьей по троекратному повторению */
  history: string[];
  seed: string;
}

export interface ChessMove { from: number; to: number; promo?: string }

const fx = (c: number) => c % SIDE;
const fy = (c: number) => Math.floor(c / SIDE);
const at = (x: number, y: number) => y * SIDE + x;
const inside = (x: number, y: number) => x >= 0 && x < SIDE && y >= 0 && y < SIDE;

export const sideOf = (p: string): Side | '' => (!p ? '' : p === p.toUpperCase() ? 'w' : 'b');
const foeOf = (s: Side): Side => (s === 'w' ? 'b' : 'w');
const kindOf = (p: string) => p.toUpperCase();

/** Имя поля по-шахматному: e4, a8. Нужно и людям, и записи партии */
export const nameOf = (c: number): string => `${'abcdefgh'[fx(c)]}${SIDE - fy(c)}`;

const START = [
  'rnbqkbnr',
  'pppppppp',
  '........',
  '........',
  '........',
  '........',
  'PPPPPPPP',
  'RNBQKBNR',
].join('').split('').map((c) => (c === '.' ? '' : c));

/** Доска из рисунка восьми строк: точка — пусто. Для проверок и задач */
export const boardOf = (rows: string[]): string[] =>
  rows.join('').split('').map((c) => (c === '.' ? '' : c));

const RAYS: Record<string, Array<[number, number]>> = {
  R: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  B: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  Q: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]],
};
const JUMPS: Record<string, Array<[number, number]>> = {
  N: [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]],
  K: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]],
};

/**
 * Куда фигура бьёт с этого поля.
 *
 * Отдельно от «куда ходит» ради пешки: она ходит вперёд, а бьёт по диагонали,
 * и проверять «под боем ли король» её ходом вперёд — классическая ошибка,
 * из-за которой король «не может» встать на поле перед чужой пешкой.
 * Рокировка сюда не входит: рокировкой не бьют.
 */
function strikes(board: string[], from: number): number[] {
  const piece = board[from];
  const side = sideOf(piece);
  if (!side) return [];
  const kind = kindOf(piece);
  const out: number[] = [];
  const x = fx(from);
  const y = fy(from);

  if (kind === 'P') {
    const dy = side === 'w' ? -1 : 1;
    for (const dx of [-1, 1]) if (inside(x + dx, y + dy)) out.push(at(x + dx, y + dy));
    return out;
  }
  if (JUMPS[kind]) {
    for (const [dx, dy] of JUMPS[kind]) if (inside(x + dx, y + dy)) out.push(at(x + dx, y + dy));
    return out;
  }
  for (const [dx, dy] of RAYS[kind] || []) {
    let nx = x + dx;
    let ny = y + dy;
    while (inside(nx, ny)) {
      const cell = at(nx, ny);
      out.push(cell);
      if (board[cell]) break;          // луч упирается в первую же фигуру
      nx += dx; ny += dy;
    }
  }
  return out;
}

/** Бьёт ли сторона `by` это поле. Своя фигура на поле помехой не считается */
export function attacked(board: string[], cell: number, by: Side): boolean {
  for (let i = 0; i < CELLS; i++) {
    if (sideOf(board[i]) !== by) continue;
    if (strikes(board, i).includes(cell)) return true;
  }
  return false;
}

const kingOf = (board: string[], side: Side): number =>
  board.findIndex((p) => p === (side === 'w' ? 'K' : 'k'));

/** Под шахом ли король этой стороны. Нет короля — считаем, что нет шаха */
export function inCheck(board: string[], side: Side): boolean {
  const king = kingOf(board, side);
  return king >= 0 && attacked(board, king, foeOf(side));
}

/**
 * Псевдоходы фигуры: правильные по её движению, но, возможно, оставляющие
 * своего короля под боем. Отсев — в `legalFrom`.
 */
function pseudoFrom(state: ChessState, from: number): ChessMove[] {
  const board = state.board;
  const piece = board[from];
  const side = sideOf(piece);
  if (!side) return [];
  const kind = kindOf(piece);
  const out: ChessMove[] = [];
  const x = fx(from);
  const y = fy(from);
  const add = (to: number) => { if (sideOf(board[to]) !== side) out.push({ from, to }); };

  if (kind === 'P') {
    const dy = side === 'w' ? -1 : 1;
    const start = side === 'w' ? 6 : 1;
    const last = side === 'w' ? 0 : 7;
    const push = (to: number) => {
      if (fy(to) === last) for (const promo of ['Q', 'R', 'B', 'N']) out.push({ from, to, promo });
      else out.push({ from, to });
    };
    if (inside(x, y + dy) && !board[at(x, y + dy)]) {
      push(at(x, y + dy));
      // Через две клетки — только с начального поля и только по пустому
      if (y === start && !board[at(x, y + 2 * dy)]) out.push({ from, to: at(x, y + 2 * dy) });
    }
    for (const dx of [-1, 1]) {
      if (!inside(x + dx, y + dy)) continue;
      const to = at(x + dx, y + dy);
      // Взятие на проходе: бьём поле, на котором фигуры нет
      if (sideOf(board[to]) === foeOf(side) || to === state.ep) push(to);
    }
    return out;
  }

  if (JUMPS[kind]) {
    for (const [dx, dy] of JUMPS[kind]) if (inside(x + dx, y + dy)) add(at(x + dx, y + dy));
  } else {
    for (const [dx, dy] of RAYS[kind] || []) {
      let nx = x + dx;
      let ny = y + dy;
      while (inside(nx, ny)) {
        const to = at(nx, ny);
        if (board[to]) { add(to); break; }
        out.push({ from, to });
        nx += dx; ny += dy;
      }
    }
  }

  if (kind === 'K') {
    /**
     * Рокировка — четыре условия, и каждое из них где-нибудь да забывают:
     * право не потеряно, между королём и ладьёй пусто, король не под шахом и
     * не проходит через битое поле. Поле, на которое встаёт ЛАДЬЯ, битым быть
     * может — это не ошибка, это правило.
     */
    const home = side === 'w' ? 60 : 4;
    if (from === home && !inCheck(board, side)) {
      const rights = side === 'w' ? ['K', 'Q'] : ['k', 'q'];
      for (const right of rights) {
        if (!state.castle.includes(right)) continue;
        const short = right.toUpperCase() === 'K';
        const rook = short ? home + 3 : home - 4;
        if (kindOf(board[rook] || '') !== 'R' || sideOf(board[rook]) !== side) continue;
        const path = short ? [home + 1, home + 2] : [home - 1, home - 2, home - 3];
        if (path.some((c) => board[c])) continue;
        const walk = short ? [home + 1, home + 2] : [home - 1, home - 2];
        if (walk.some((c) => attacked(board, c, foeOf(side)))) continue;
        out.push({ from, to: short ? home + 2 : home - 2 });
      }
    }
  }
  return out;
}

/** Доска после хода — без проверок: зовётся только на своих же псевдоходах */
function boardAfter(state: ChessState, move: ChessMove): string[] {
  const board = [...state.board];
  const piece = board[move.from];
  const side = sideOf(piece) as Side;
  const kind = kindOf(piece);

  board[move.from] = '';
  board[move.to] = move.promo
    ? (side === 'w' ? move.promo.toUpperCase() : move.promo.toLowerCase())
    : piece;

  // Взятие на проходе: побитая пешка стоит не там, куда пошли
  if (kind === 'P' && move.to === state.ep && state.ep >= 0) {
    board[at(fx(move.to), fy(move.from))] = '';
  }
  // Рокировка: ладья переезжает вместе с королём
  if (kind === 'K' && Math.abs(fx(move.to) - fx(move.from)) === 2) {
    const short = fx(move.to) > fx(move.from);
    const rook = short ? move.from + 3 : move.from - 4;
    board[short ? move.from + 1 : move.from - 1] = board[rook];
    board[rook] = '';
  }
  return board;
}

/** Законные ходы фигуры: псевдоходы минус те, после которых король под боем */
export function legalFrom(state: ChessState, from: number): ChessMove[] {
  const side = sideOf(state.board[from]);
  if (!side || side !== state.turn) return [];
  return pseudoFrom(state, from).filter((m) => !inCheck(boardAfter(state, m), side));
}

/** Все законные ходы стороны, которая ходит. Пустой список — мат или пат */
export function allLegal(state: ChessState): ChessMove[] {
  const out: ChessMove[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (sideOf(state.board[i]) === state.turn) out.push(...legalFrom(state, i));
  }
  return out;
}

/** Ключ позиции для повторения: доска, очередь, права рокировки и проход */
export const posKey = (state: ChessState): string =>
  `${state.board.map((p) => p || '.').join('')}|${state.turn}|${state.castle || '-'}|${state.ep}`;

/**
 * Нехватка материала.
 *
 * Король против короля, король со слоном или конём против короля и два
 * одноцветных слона: заматовать нечем, и партию надо кончать, а не оставлять
 * двоих двигать королей до вечера.
 */
export function tooLittle(board: string[]): boolean {
  const rest: Array<{ kind: string; light: boolean }> = [];
  for (let i = 0; i < CELLS; i++) {
    const p = board[i];
    if (!p || kindOf(p) === 'K') continue;
    if ('PRQ'.includes(kindOf(p))) return false;   // пешка, ладья, ферзь — хватает
    rest.push({ kind: kindOf(p), light: (fx(i) + fy(i)) % 2 === 0 });
  }
  if (rest.length <= 1) return true;
  if (rest.length === 2 && rest.every((r) => r.kind === 'B') && rest[0].light === rest[1].light) return true;
  return false;
}

const sameMove = (a: ChessMove, b: ChessMove) =>
  a.from === b.from && a.to === b.to && (a.promo || '') === (b.promo || '');

export const chess: GameRules<ChessState, ChessMove> = {
  id: 'chess',

  init(seed, seats) {
    const state: ChessState = {
      board: [...START], turn: 'w', seats: [...seats],
      castle: 'KQkq', ep: -1, half: 0, full: 1, history: [], seed,
    };
    state.history = [posKey(state)];
    return state;
  },

  turnOf(state) {
    if (chess.outcome(state).done) return '';
    return state.seats[state.turn === 'w' ? 0 : 1] || '';
  },

  why(state, userId, move) {
    const me = state.seats.indexOf(userId);
    if (me < 0) return 'Вы не за этой доской';
    if (chess.outcome(state).done) return 'Партия окончена';
    const mySide: Side = me === 0 ? 'w' : 'b';
    if (mySide !== state.turn) return 'Сейчас ходит соперник';

    const from = Number(move?.from);
    const to = Number(move?.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= CELLS || to >= CELLS) {
      return 'Ход не прочитан';
    }
    const piece = state.board[from];
    if (!piece) return `На ${nameOf(from)} пусто`;
    if (sideOf(piece) !== mySide) return 'Это фигура соперника';

    const legal = legalFrom(state, from);
    if (!legal.length) return `${nameOf(from)}: этой фигуре ходить нечем`;
    const here = legal.filter((m) => m.to === to);
    if (!here.length) {
      // Различаем «так не ходят» и «король останется под боем»: для человека
      // это совершенно разные отказы
      const pseudo = pseudoFrom(state, from).some((m) => m.to === to);
      if (pseudo) return inCheck(state.board, mySide) ? 'Королю шах — ход должен его закрыть' : 'После этого хода ваш король под боем';
      return `${nameOf(from)}—${nameOf(to)}: так не ходят`;
    }
    if (here[0].promo && !move.promo) return 'Пешка дошла до края — укажите, в кого она превращается';
    if (move.promo && !here.some((m) => sameMove(m, { from, to, promo: move.promo }))) {
      return 'В такую фигуру превратиться нельзя';
    }
    return '';
  },

  apply(state, _userId, move) {
    const from = Number(move.from);
    const to = Number(move.to);
    const piece = state.board[from];
    const kind = kindOf(piece);
    const side = sideOf(piece) as Side;
    const taken = !!state.board[to] || (kind === 'P' && to === state.ep);

    const board = boardAfter(state, move);

    // Права рокировки теряются навсегда: ходом короля, ходом своей ладьи и
    // взятием чужой ладьи на её начальном поле — последнее забывают чаще всего
    let castle = state.castle;
    const drop = (ch: string) => { castle = castle.replace(ch, ''); };
    if (kind === 'K') { if (side === 'w') { drop('K'); drop('Q'); } else { drop('k'); drop('q'); } }
    for (const [cell, right] of [[63, 'K'], [56, 'Q'], [7, 'k'], [0, 'q']] as Array<[number, string]>) {
      if (from === cell || to === cell) drop(right);
    }

    const next: ChessState = {
      ...state,
      board,
      turn: foeOf(side),
      castle,
      // Поле «на проходе» живёт ровно один полуход
      ep: kind === 'P' && Math.abs(fy(to) - fy(from)) === 2 ? at(fx(from), (fy(from) + fy(to)) / 2) : -1,
      half: kind === 'P' || taken ? 0 : state.half + 1,
      full: side === 'b' ? state.full + 1 : state.full,
      history: [...state.history],
    };
    next.history.push(posKey(next));
    return next;
  },

  outcome(state): GameOutcome {
    const side = state.turn;
    const moves = allLegal(state);
    const check = inCheck(state.board, side);
    const loser = side === 'w' ? 1 : 2;

    if (!moves.length) {
      if (check) {
        return {
          done: true, winnerTeam: loser === 1 ? 2 : 1,
          details: { reason: 'mate', moves: state.full },
          why: side === 'w' ? 'Мат белым' : 'Мат чёрным',
        };
      }
      return { done: true, winnerTeam: 0, details: { reason: 'stalemate' }, why: 'Пат — ничья' };
    }
    if (state.half >= 100) {
      return { done: true, winnerTeam: 0, details: { reason: 'fifty' }, why: 'Ничья: пятьдесят ходов без взятий и без пешек' };
    }
    const key = posKey(state);
    if (state.history.filter((k) => k === key).length >= 3) {
      return { done: true, winnerTeam: 0, details: { reason: 'repetition' }, why: 'Ничья: позиция повторилась трижды' };
    }
    if (tooLittle(state.board)) {
      return { done: true, winnerTeam: 0, details: { reason: 'material' }, why: 'Ничья: матовать нечем' };
    }
    return { done: false, winnerTeam: 0, details: {}, why: '' };
  },

  viewOf(state, userId) {
    const me = state.seats.indexOf(userId);
    const mySide: Side | '' = me === 0 ? 'w' : me === 1 ? 'b' : '';
    // Скрывать в шахматах нечего: доска одна и видна обоим. Ходы отдаются
    // только тому, чья очередь, — чтобы окно не подсвечивало чужие
    const moves = mySide && mySide === state.turn ? allLegal(state) : [];
    return {
      board: state.board,
      turn: state.turn,
      you: mySide,
      moves,
      check: inCheck(state.board, state.turn),
      castle: state.castle,
      ep: state.ep,
      half: state.half,
      full: state.full,
    };
  },
};

registerRules(chess as GameRules);
