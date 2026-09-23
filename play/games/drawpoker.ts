/** Одна раздача пятикарточного покера на двоих. Фишки только игровые. */
import { registerRules, type GameOutcome, type GameRules } from './kit.js';
import { secureDeck } from './secureDeck.js';

type Phase = 'opening' | 'draw' | 'final' | 'done';
type BetMove = { action: 'check' | 'call' | 'raise' | 'fold' };
type DrawMove = { action: 'draw'; cards: number[] };
export type PokerMove = BetMove | DrawMove;

export interface PokerState {
  seats: string[];
  deck: number[];
  hands: number[][];
  stacks: number[];
  pot: number;
  put: number[];
  acted: boolean[];
  phase: Phase;
  turn: number;
  drawn: boolean[];
  winner: number;
  reason: string;
  lastAction: string;
}

const NAMES = ['Старшая карта', 'Пара', 'Две пары', 'Тройка', 'Стрит', 'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш'];
export const cardRank = (card: number): number => card % 13 + 2;
export const cardSuit = (card: number): number => Math.floor(card / 13);

/** Категория и кикеры образуют сравнимый лексикографически ключ. */
export function handValue(cards: number[]): number[] {
  if (cards.length !== 5 || new Set(cards).size !== 5 || cards.some(c => !Number.isInteger(c) || c < 0 || c >= 52)) {
    throw new Error('Для сравнения нужны пять разных карт');
  }
  const ranks = cards.map(cardRank).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every(c => cardSuit(c) === cardSuit(cards[0]));
  const unique = [...new Set(ranks)];
  const straight = unique.length === 5
    ? (unique[0] - unique[4] === 4 ? unique[0] : unique.join(',') === '14,5,4,3,2' ? 5 : 0)
    : 0;
  if (straight && flush) return [8, straight];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...ranks];
  if (straight) return [4, straight];
  if (groups[0][1] === 3) return [3, groups[0][0], ...groups.slice(1).map(g => g[0]).sort((a, b) => b - a)];
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    return [2, Math.max(groups[0][0], groups[1][0]), Math.min(groups[0][0], groups[1][0]), groups[2][0]];
  }
  if (groups[0][1] === 2) return [1, groups[0][0], ...groups.slice(1).map(g => g[0]).sort((a, b) => b - a)];
  return [0, ...ranks];
}

export function compareHands(a: number[], b: number[]): number {
  const x = handValue(a);
  const y = handValue(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
}

const clone = (s: PokerState): PokerState => ({
  ...s, deck: [...s.deck], hands: s.hands.map(h => [...h]), stacks: [...s.stacks],
  put: [...s.put], acted: [...s.acted], drawn: [...s.drawn],
});

function settle(s: PokerState, folded = -1): void {
  const cmp = folded < 0 ? compareHands(s.hands[0], s.hands[1]) : folded === 0 ? -1 : 1;
  s.winner = cmp > 0 ? 1 : cmp < 0 ? 2 : 0;
  if (s.winner) s.stacks[s.winner - 1] += s.pot;
  else { s.stacks[0] += s.pot / 2; s.stacks[1] += s.pot / 2; }
  s.reason = folded >= 0
    ? `Игрок ${s.winner} выиграл: соперник сбросил карты`
    : cmp === 0 ? 'Равные комбинации — банк поделен'
      : `${NAMES[handValue(s.hands[s.winner - 1])[0]]} — победил игрок ${s.winner}`;
  s.phase = 'done';
}

function nextBetPhase(s: PokerState): void {
  if (!s.acted.every(Boolean) || s.put[0] !== s.put[1]) return;
  if (s.phase === 'opening') {
    s.phase = 'draw';
    s.drawn = [false, false];
    s.turn = 0;
  } else settle(s);
}

export const drawpoker: GameRules<PokerState, PokerMove> = {
  id: 'drawpoker',
  init(seed, seats) {
    // Общий 32-битный генератор досок не годится для закрытой колоды: игрок
    // мог бы восстановить его по своим картам. Здесь нужен ключ 256 бит.
    const cards = secureDeck(seed);
    // Колода и семя остаются только в записи матча. Снимок игрока их не содержит.
    return {
      seats: [...seats], deck: cards.slice(10), hands: [cards.slice(0, 5), cards.slice(5, 10)],
      stacks: [95, 95], pot: 10, put: [0, 0], acted: [false, false],
      phase: 'opening', turn: 0, drawn: [false, false], winner: 0, reason: '', lastAction: 'Оба внесли по 5 фишек',
    };
  },
  turnOf(s) { return s.phase === 'done' ? '' : s.seats[s.turn] || ''; },
  why(s, userId, move) {
    const me = s.seats.indexOf(userId);
    if (me < 0) return 'Вы не участвуете в раздаче';
    if (s.phase === 'done') return 'Раздача окончена';
    if (me !== s.turn) return 'Сейчас ход соперника';
    const action = (move as PokerMove)?.action;
    if (s.phase === 'draw') {
      if (action !== 'draw') return 'Сейчас нужно обменять карты';
      const cards = (move as DrawMove).cards;
      if (!Array.isArray(cards) || cards.length > 3 || new Set(cards).size !== cards.length ||
          cards.some(c => !Number.isInteger(c) || c < 0 || c > 4)) return 'Выберите от нуля до трёх разных карт';
      return '';
    }
    if (action === 'fold') return '';
    const due = Math.max(...s.put) - s.put[me];
    if (action === 'check') return due ? 'Нужно уравнять ставку или сбросить карты' : '';
    if (action === 'call') return due ? '' : 'Уравнивать нечего';
    if (action === 'raise') {
      const target = Math.max(...s.put) + 10;
      if (target > Math.min(s.stacks[0] + s.put[0], s.stacks[1] + s.put[1])) return 'Для повышения не хватает фишек';
      return '';
    }
    return 'Такого действия в покере нет';
  },
  apply(s, userId, move) {
    const next = clone(s);
    const me = next.seats.indexOf(userId);
    if (move.action === 'draw') {
      for (const index of move.cards) next.hands[me][index] = next.deck.shift()!;
      next.drawn[me] = true;
      next.lastAction = `Игрок ${me + 1} обменял ${move.cards.length} карт`;
      if (next.drawn.every(Boolean)) {
        next.phase = 'final'; next.put = [0, 0]; next.acted = [false, false]; next.turn = 0;
      } else next.turn = 1 - me;
      return next;
    }
    if (move.action === 'fold') {
      settle(next, me);
      return next;
    }
    if (move.action === 'call' || move.action === 'raise') {
      const target = Math.max(...next.put) + (move.action === 'raise' ? 10 : 0);
      const amount = target - next.put[me];
      next.stacks[me] -= amount;
      next.put[me] = target;
      next.pot += amount;
      if (move.action === 'raise') next.acted = [false, false];
      next.lastAction = `Игрок ${me + 1}: ${move.action === 'raise' ? 'ставка +10' : 'уравнял'}`;
    } else next.lastAction = `Игрок ${me + 1}: чек`;
    next.acted[me] = true;
    next.turn = 1 - me;
    nextBetPhase(next);
    return next;
  },
  outcome(s): GameOutcome {
    return { done: s.phase === 'done', winnerTeam: s.winner, details: { pot: s.pot, stacks: s.stacks }, why: s.reason };
  },
  viewOf(s, userId) {
    const me = s.seats.indexOf(userId);
    if (me < 0) return { watcher: true };
    return {
      phase: s.phase, seat: me + 1, hand: [...s.hands[me]],
      opponentHand: s.phase === 'done' ? [...s.hands[1 - me]] : null,
      stacks: [...s.stacks], pot: s.pot, put: [...s.put],
      currentBet: Math.max(...s.put), lastAction: s.lastAction,
    };
  },
};

registerRules(drawpoker);
