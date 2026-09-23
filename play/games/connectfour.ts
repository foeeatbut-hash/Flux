import { registerRules, type GameRules, type GameOutcome } from './kit.js';

export const WIDTH = 7;
export const HEIGHT = 6;

export interface FourState {
  seats: string[];
  board: number[];
  turn: number;
  last: number;
  moves: number;
}

export interface FourMove { column: number }

const winner = (s: FourState): number => {
  if (s.last < 0) return 0;
  const x = s.last % WIDTH;
  const y = Math.floor(s.last / WIDTH);
  const stone = s.board[s.last];
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let count = 1;
    for (const sign of [-1, 1]) {
      let cx = x + dx * sign;
      let cy = y + dy * sign;
      while (cx >= 0 && cx < WIDTH && cy >= 0 && cy < HEIGHT && s.board[cy * WIDTH + cx] === stone) {
        count++;
        cx += dx * sign;
        cy += dy * sign;
      }
    }
    if (count >= 4) return stone;
  }
  return 0;
};

export const connectfour: GameRules<FourState, FourMove> = {
  id: 'connectfour',
  init(_seed, seats) {
    return { seats: [...seats], board: Array(WIDTH * HEIGHT).fill(0), turn: 0, last: -1, moves: 0 };
  },
  turnOf(s) { return this.outcome(s).done ? '' : s.seats[s.turn] || ''; },
  why(s, userId, move) {
    if (!s.seats.includes(userId)) return 'Вы не участвуете в партии';
    if (this.outcome(s).done) return 'Партия окончена';
    if (s.seats[s.turn] !== userId) return 'Сейчас ход соперника';
    const column = (move as FourMove)?.column;
    if (!Number.isInteger(column) || column < 0 || column >= WIDTH) return 'Выберите столбец от 1 до 7';
    if (s.board[column] !== 0) return 'Столбец уже заполнен';
    return '';
  },
  apply(s, _userId, move) {
    const board = [...s.board];
    const column = move.column;
    let last = -1;
    for (let y = HEIGHT - 1; y >= 0; y--) {
      const cell = y * WIDTH + column;
      if (board[cell] === 0) { board[cell] = s.turn + 1; last = cell; break; }
    }
    return { ...s, board, last, moves: s.moves + 1, turn: 1 - s.turn };
  },
  outcome(s): GameOutcome {
    const win = winner(s);
    if (win) return { done: true, winnerTeam: win, details: { moves: s.moves }, why: `Четыре в ряд — победил игрок ${win}` };
    if (s.moves === WIDTH * HEIGHT) return { done: true, winnerTeam: 0, details: { moves: s.moves }, why: 'Поле заполнено — ничья' };
    return { done: false, winnerTeam: 0, details: {}, why: '' };
  },
  viewOf(s, userId) {
    if (!s.seats.includes(userId)) return { watcher: true };
    return { board: [...s.board], last: s.last, valid: Array.from({ length: WIDTH }, (_, i) => i).filter(i => s.board[i] === 0), seat: s.seats.indexOf(userId) + 1 };
  },
};

registerRules(connectfour);
