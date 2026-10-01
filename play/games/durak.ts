import { registerRules, type GameOutcome, type GameRules } from './kit.js';
import { secureDeck } from './secureDeck.js';

export type DurakVariant = 'throw-in' | 'transfer';
export type DurakMove =
  | { type: 'configure'; variant: DurakVariant; deckSize: 36 | 52 }
  | { type: 'attack'; card: number }
  | { type: 'defend'; card: number; target: number }
  | { type: 'transfer'; card: number }
  | { type: 'take' | 'pass' | 'resign' };
export interface DurakPair { attack: number; defense: number | null }
export interface DurakState {
  seats: string[]; seed: string; variant: DurakVariant; deckSize: 36 | 52;
  deck: number[]; hands: number[][]; discard: number[]; trumpCard: number; trumpSuit: number;
  table: DurakPair[]; attacker: number; roundAttacker: number; defender: number; attackLimit: number; taking: boolean;
  passed: number[]; finished: number[]; quitters: number[]; loser: number | null; done: boolean; started: boolean;
  round: number; lastAction: string;
}
export interface DurakAllowed {
  attack: number[]; defend: { card: number; target: number }[]; transfer: number[]; take: boolean; pass: boolean;
}
export interface DurakView {
  phase: 'playing' | 'done'; seats: string[]; seat: number; hand: number[]; handCounts: number[];
  variant: DurakVariant; deckSize: 36 | 52; deckCount: number; trumpCard: number; trumpSuit: number;
  table: DurakPair[]; attacker: number; defender: number; attackLimit: number; taking: boolean;
  passed: number[]; finished: number[]; quitters: number[]; loser: number | null; lastAction: string; round: number;
  canConfigure: boolean; allowed: DurakAllowed;
}
export const durakRank = (card: number) => card % 13 + 2;
export const durakSuit = (card: number) => Math.floor(card / 13);
export function canBeatDurak(attack: number, defense: number, trumpSuit: number): boolean {
  return durakSuit(attack) === durakSuit(defense) ? durakRank(defense) > durakRank(attack)
    : durakSuit(defense) === trumpSuit && durakSuit(attack) !== trumpSuit;
}
const copy = (s: DurakState): DurakState => ({ ...s, seats: [...s.seats], deck: [...s.deck], hands: s.hands.map(hand => [...hand]), discard: [...s.discard], table: s.table.map(pair => ({ ...pair })), passed: [...s.passed], finished: [...s.finished], quitters: [...s.quitters] });
const unbeaten = (s: DurakState) => s.table.some(pair => pair.defense === null);
const active = (s: DurakState, seat: number) => !s.finished.includes(seat) && !s.quitters.includes(seat);
function nextSeat(s: DurakState, after: number): number {
  for (let offset = 1; offset <= s.seats.length; offset++) { const seat = (after + offset) % s.seats.length; if (active(s, seat)) return seat; }
  return -1;
}
function attackers(s: DurakState): number[] {
  return Array.from({ length: s.seats.length }, (_, offset) => (s.attacker + offset) % s.seats.length)
    .filter(seat => seat !== s.defender && active(s, seat));
}
const tableRanks = (s: DurakState) => new Set(s.table.flatMap(pair => pair.defense === null ? [durakRank(pair.attack)] : [durakRank(pair.attack), durakRank(pair.defense)]));
function removeCard(s: DurakState, seat: number, card: number) { s.hands[seat].splice(s.hands[seat].indexOf(card), 1); }
function attackPossible(s: DurakState, seat: number, card: number): boolean {
  if (seat === s.defender || !active(s, seat) || !s.hands[seat].includes(card) || s.table.length >= s.attackLimit) return false;
  return s.table.length ? tableRanks(s).has(durakRank(card)) : seat === s.attacker;
}
function transferPossible(s: DurakState, seat: number, card: number): boolean {
  if (s.variant !== 'transfer' || seat !== s.defender || s.taking || !s.table.length || s.table.some(pair => pair.defense !== null) || !s.hands[seat].includes(card)) return false;
  if (!s.table.every(pair => durakRank(pair.attack) === durakRank(card))) return false;
  const target = nextSeat(s, s.defender);
  return target >= 0 && target !== s.defender && s.table.length + 1 <= Math.min(6, s.hands[target].length);
}
function allowed(s: DurakState, seat: number): DurakAllowed {
  const result: DurakAllowed = { attack: [], defend: [], transfer: [], take: false, pass: false };
  if (s.done || seat < 0 || !active(s, seat)) return result;
  result.attack = s.hands[seat].filter(card => attackPossible(s, seat, card));
  if (seat === s.defender && !s.taking) {
    for (let target = 0; target < s.table.length; target++) if (s.table[target].defense === null) {
      for (const card of s.hands[seat]) if (canBeatDurak(s.table[target].attack, card, s.trumpSuit)) result.defend.push({ card, target });
    }
    result.transfer = s.hands[seat].filter(card => transferPossible(s, seat, card));
    result.take = unbeaten(s);
  }
  result.pass = seat !== s.defender && !!s.table.length && (s.taking || !unbeaten(s)) && !s.passed.includes(seat);
  return result;
}
export function initDurak(seed: string, seats: string[], settings: { variant?: DurakVariant; deckSize?: 36 | 52 } = {}): DurakState {
  const deckSize = settings.deckSize || (seats.length > 6 ? 52 : 36);
  if (seats.length < 2 || seats.length > (deckSize === 36 ? 6 : 8) || new Set(seats).size !== seats.length || seats.some(seat => typeof seat !== 'string' || !seat)) throw new Error(`Дурак: колода ${deckSize} карт рассчитана на 2–${deckSize === 36 ? 6 : 8} игроков`);
  if (deckSize !== 36 && deckSize !== 52 || settings.variant && !['throw-in', 'transfer'].includes(settings.variant)) throw new Error('Неизвестные правила Дурака');
  const cards = secureDeck(seed).filter(card => deckSize === 52 || durakRank(card) >= 6);
  const trumpCard = cards.at(-1)!;
  const hands = seats.map(() => [] as number[]);
  for (let deal = 0; deal < 6; deal++) for (const hand of hands) hand.push(cards.shift()!);
  let attacker = 0; let lowest = Infinity;
  for (let seat = 0; seat < hands.length; seat++) for (const card of hands[seat]) if (durakSuit(card) === durakSuit(trumpCard) && durakRank(card) < lowest) { attacker = seat; lowest = durakRank(card); }
  const defender = (attacker + 1) % seats.length;
  return { seats: [...seats], seed, variant: settings.variant || 'throw-in', deckSize, deck: cards, hands, discard: [], trumpCard, trumpSuit: durakSuit(trumpCard), table: [], attacker, roundAttacker: attacker, defender, attackLimit: 6, taking: false, passed: [], finished: [], quitters: [], loser: null, done: false, started: false, round: 1, lastAction: 'Первым ходит игрок с младшим козырем' };
}
function finishRound(s: DurakState): void {
  const oldAttacker = s.roundAttacker; const oldDefender = s.defender; const took = s.taking;
  const tableCards = s.table.flatMap(pair => pair.defense === null ? [pair.attack] : [pair.attack, pair.defense]);
  if (took && active(s, oldDefender)) s.hands[oldDefender].push(...tableCards); else s.discard.push(...tableCards);
  // Добор: первоначальный атакующий, остальные по кругу, защищавшийся последним.
  const drawOrder = Array.from({ length: s.seats.length }, (_, offset) => (oldAttacker + offset) % s.seats.length).filter(seat => seat !== oldDefender && active(s, seat));
  if (active(s, oldDefender)) drawOrder.push(oldDefender);
  for (const seat of drawOrder) while (s.hands[seat].length < 6 && s.deck.length) s.hands[seat].push(s.deck.shift()!);
  if (!s.deck.length) for (const seat of drawOrder) if (!s.hands[seat].length && !s.finished.includes(seat)) s.finished.push(seat);
  s.table = []; s.passed = []; s.taking = false;
  const remaining = s.seats.map((_, index) => index).filter(seat => active(s, seat));
  if (remaining.length <= 1) {
    s.done = true; s.loser = remaining[0] ?? null;
    s.lastAction = s.loser === null ? 'Ничья: последние игроки одновременно избавились от карт' : `Игрок ${s.loser + 1} остался дураком`;
    return;
  }
  s.attacker = took || !active(s, oldDefender) ? nextSeat(s, oldDefender) : oldDefender;
  s.roundAttacker = s.attacker; s.defender = nextSeat(s, s.attacker); s.attackLimit = Math.min(6, s.hands[s.defender].length); s.round++;
  s.lastAction = took ? `Игрок ${oldDefender + 1} забрал карты; его ход пропущен` : 'Бито. Защитившийся начинает следующий кон';
}
function settleIfReady(s: DurakState): void {
  if (!s.table.length || !s.taking && unbeaten(s)) return;
  if (s.table.length >= s.attackLimit || attackers(s).every(seat => !s.hands[seat].length || s.passed.includes(seat))) finishRound(s);
}
export const durak: GameRules<DurakState, DurakMove> = {
  id: 'cards',
  init: (seed, seats) => initDurak(seed, seats),
  turnOf(s) {
    if (s.done) return '';
    if (!s.table.length) return s.seats[s.attacker];
    if (!s.taking && unbeaten(s)) return s.seats[s.defender];
    const seat = attackers(s).find(index => s.hands[index].length && !s.passed.includes(index));
    return seat === undefined ? '' : s.seats[seat];
  },
  why(s, userId, move) {
    const seat = s.seats.indexOf(userId);
    if (seat < 0) return 'Вы не участвуете в этой партии';
    if (s.done) return 'Партия Дурака закончена';
    if (!move || typeof move !== 'object') return 'Выберите действие с картами';
    if (move.type === 'configure') {
      if (seat !== 0 || s.started) return 'Правила меняет создатель стола до первого хода';
      if (!['throw-in', 'transfer'].includes(move.variant) || ![36, 52].includes(move.deckSize)) return 'Выберите подкидного или переводного Дурака и колоду 36 или 52 карты';
      if (s.seats.length > (move.deckSize === 36 ? 6 : 8)) return 'Для этой группы нужна колода 52 карты: колода 36 рассчитана максимум на 6 игроков';
      return '';
    }
    if (!active(s, seat)) return 'Вы уже вышли из партии';
    if (move.type === 'resign') return '';
    if (move.type === 'attack' || move.type === 'defend' || move.type === 'transfer') {
      if (!Number.isInteger(move.card) || !s.hands[seat].includes(move.card)) return 'Выберите карту из своей руки';
    }
    const permitted = allowed(s, seat);
    if (move.type === 'attack') return permitted.attack.includes(move.card) ? '' : !s.table.length ? 'Первую карту кладёт атакующий' : s.table.length >= s.attackLimit ? 'Нельзя подкинуть больше карт, чем было у защитника в начале кона, и больше шести' : 'Подкидывать можно только номиналы, уже лежащие на столе';
    if (move.type === 'defend') return permitted.defend.some(item => item.card === move.card && item.target === move.target) ? '' : seat !== s.defender ? 'Сейчас защищается другой игрок' : s.taking ? 'После «Беру» отбивать карты нельзя' : 'Карту бьёт старшая той же масти или козырь; козырь — только старший козырь';
    if (move.type === 'transfer') return permitted.transfer.includes(move.card) ? '' : 'Перевод возможен до первой защиты картой того же номинала, если следующему игроку хватает карт';
    if (move.type === 'take') return permitted.take ? '' : 'Забирать карты может защитник, пока есть неотбитые карты';
    if (move.type === 'pass') return permitted.pass ? '' : 'Завершить подкидывание можно после защиты или объявления «Беру»';
    return 'Такого действия в Дураке нет';
  },
  apply(s, userId, move) {
    const why = this.why(s, userId, move);
    if (why) throw new Error(why);
    if (move.type === 'configure') return initDurak(s.seed, s.seats, move);
    const next = copy(s); const seat = s.seats.indexOf(userId); next.started = true;
    if (move.type === 'resign') {
      next.quitters.push(seat); next.discard.push(...next.hands[seat]); next.hands[seat] = [];
      const remaining = next.seats.map((_, index) => index).filter(index => active(next, index));
      if (remaining.length <= 1) {
        next.discard.push(...next.table.flatMap(pair => pair.defense === null ? [pair.attack] : [pair.attack, pair.defense])); next.table = [];
        next.done = true; next.loser = seat; next.lastAction = `Игрок ${seat + 1} сдался; партия окончена`;
      } else if (seat === next.defender && next.table.length) { next.taking = true; finishRound(next); }
      else if (!next.table.length) {
        if (seat === next.attacker) next.attacker = nextSeat(next, seat);
        next.defender = nextSeat(next, next.attacker); next.attackLimit = Math.min(6, next.hands[next.defender].length);
      }
      if (!next.done) next.lastAction = `Игрок ${seat + 1} покинул партию; остальные продолжают`;
      settleIfReady(next); return next;
    }
    if (move.type === 'attack') {
      removeCard(next, seat, move.card); next.table.push({ attack: move.card, defense: null }); next.passed = [];
      next.lastAction = `Игрок ${seat + 1} ${next.table.length === 1 ? 'атаковал' : 'подкинул карту'}`;
    } else if (move.type === 'defend') {
      removeCard(next, seat, move.card); next.table[move.target].defense = move.card; next.passed = [];
      next.lastAction = `Игрок ${seat + 1} отбил карту`;
    } else if (move.type === 'transfer') {
      removeCard(next, seat, move.card); next.table.push({ attack: move.card, defense: null }); next.attacker = seat;
      next.defender = nextSeat(next, seat); next.attackLimit = Math.min(6, next.hands[next.defender].length); next.passed = [];
      next.lastAction = `Игрок ${seat + 1} перевёл атаку игроку ${next.defender + 1}`;
    } else if (move.type === 'take') { next.taking = true; next.passed = []; next.lastAction = `Игрок ${seat + 1} берёт; остальные могут подкинуть или завершить кон`; }
    else { next.passed.push(seat); next.lastAction = `Игрок ${seat + 1} больше не подкидывает`; }
    settleIfReady(next); return next;
  },
  outcome(s): GameOutcome {
    const winners = s.done && s.loser !== null ? s.seats.filter((_, index) => index !== s.loser && !s.quitters.includes(index)) : [];
    const firstWinner = s.done && s.loser !== null ? s.seats.findIndex(user => winners.includes(user)) : -1;
    return { done: s.done, winnerTeam: firstWinner < 0 ? 0 : firstWinner + 1,
      details: { loser: s.loser === null ? null : s.seats[s.loser], winners, finished: s.finished.map(index => s.seats[index]), quitters: s.quitters.map(index => s.seats[index]), deckSize: s.deckSize, variant: s.variant, rounds: s.round }, why: s.done ? s.lastAction : '' };
  },
  viewOf(s, userId): DurakView {
    const seat = s.seats.indexOf(userId);
    return { phase: s.done ? 'done' : 'playing', seats: [...s.seats], seat, hand: seat < 0 ? [] : [...s.hands[seat]], handCounts: s.hands.map(hand => hand.length),
      variant: s.variant, deckSize: s.deckSize, deckCount: s.deck.length, trumpCard: s.trumpCard, trumpSuit: s.trumpSuit, table: s.table.map(pair => ({ ...pair })),
      attacker: s.attacker, defender: s.defender, attackLimit: s.attackLimit, taking: s.taking, passed: [...s.passed], finished: [...s.finished], quitters: [...s.quitters], loser: s.loser,
      lastAction: s.lastAction, round: s.round, canConfigure: seat === 0 && !s.started && !s.done, allowed: allowed(s, seat) };
  },
};
registerRules(durak);
