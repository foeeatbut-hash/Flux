import { registerRules, shuffled, rngOf, type GameRules } from './kit.js';
import { canPlaceCue, simulateShot, TABLE, type PoolBall, type PoolFrame, type PoolShot, type ShotSimulation } from './billiardsPhysics.js';
export type PoolGroup = 'solids' | 'stripes';
export interface PoolState {
  seats: string[]; turn: number; balls: PoolBall[]; groups: Array<PoolGroup | null>;
  breaking: boolean; ballInHand: boolean; shots: number; done: boolean; winner: number;
  message: string; lastShot: { number: number; by: string; frames: PoolFrame[]; durationMs: number; pocketed: number[]; foul: string } | null;
  shotEndAt?: number;
}
export type PoolMove = PoolShot | { type: 'place'; x: number; y: number };
export const groupOfBall = (id: number): PoolGroup | null => id >= 1 && id <= 7 ? 'solids' : id >= 9 && id <= 15 ? 'stripes' : null;
export const remainingGroup = (state: PoolState, seat: number): number => state.balls.filter(b => !b.pocketed && groupOfBall(b.id) === state.groups[seat]).length;
export function initPool(seed: string, seats: string[]): PoolState {
  if (seats.length !== 2 || seats[0] === seats[1]) throw new Error('Для бильярда нужны два разных игрока');
  const rnd = rngOf(seed), rest = shuffled([1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15], rnd);
  const layout = [rest.shift()!, rest.shift()!, rest.shift()!, rest.shift()!, 8, rest.shift()!, ...rest];
  // В задних углах разные группы: это обязательная расстановка восьмёрки.
  const solid = layout.findIndex((id, i) => i >= 6 && groupOfBall(id) === 'solids');
  [layout[10], layout[solid]] = [layout[solid], layout[10]];
  const stripe = layout.findIndex((id, i) => i >= 6 && i !== 10 && groupOfBall(id) === 'stripes');
  [layout[14], layout[stripe]] = [layout[stripe], layout[14]];
  const balls: PoolBall[] = [{ id: 0, x: 240, y: 250, pocketed: false }];
  let n = 0;
  for (let row = 0; row < 5; row++) for (let col = 0; col <= row; col++) {
    balls.push({ id: layout[n++], x: 680 + row * (Math.sqrt(3) * TABLE.radius + 0.06), y: 250 + (col - row / 2) * (TABLE.radius * 2 + 0.06), pocketed: false });
  }
  return { seats, turn: 0, balls, groups: [null, null], breaking: true, ballInHand: false, shots: 0, done: false, winner: 0, message: 'Первый игрок разбивает пирамиду', lastShot: null };
}

/** Итог судится по положению ДО удара: восьмёрка не становится разрешённой вместе с последним своим шаром. */
export function resolvePoolShot(state: PoolState, simulation: ShotSimulation): PoolState {
  const next: PoolState = { ...state, balls: simulation.balls.map(b => ({ ...b })), groups: [...state.groups], shots: state.shots + 1, breaking: false };
  const mine = state.turn, other = 1 - mine, assigned = state.groups[mine];
  const wasOnEight = !!assigned && remainingGroup(state, mine) === 0;
  let foul = simulation.pocketed.includes(0) ? 'Биток в лузе' : simulation.firstHit === null ? 'Биток не коснулся прицельного шара' : '';
  if (!foul && !state.breaking) {
    if (wasOnEight && simulation.firstHit !== 8) foul = 'Первым нужно ударить восьмёрку';
    else if (!wasOnEight && assigned && groupOfBall(simulation.firstHit!) !== assigned) foul = 'Первым задет шар чужой группы';
    else if (!assigned && simulation.firstHit === 8) foul = 'На открытом столе нельзя первым ударять восьмёрку';
    else if (!simulation.railAfterHit && !simulation.pocketed.some(id => id !== 0)) foul = 'После столкновения ни один шар не дошёл до борта или лузы';
  }
  if (!foul && state.breaking && !simulation.pocketed.some(id => id !== 0) && simulation.rails.filter(id => id !== 0).length < 4) foul = 'При разбое нужны четыре шара у бортов или забитый шар';
  if (simulation.pocketed.includes(8)) {
    if (state.breaking) {
      const eight = next.balls.find(b => b.id === 8)!;
      eight.pocketed = false;
      let x = 680, y = 250;
      while (next.balls.some(b => b.id !== 8 && !b.pocketed && Math.hypot(b.x - x, b.y - y) < 25)) { x -= 25; if (x < 30) { x = 680; y += 25; } }
      eight.x = x; eight.y = y;
    } else {
      next.done = true; next.winner = wasOnEight && !foul ? mine + 1 : other + 1;
      next.message = next.winner === mine + 1 ? 'Восьмёрка забита: победа' : 'Восьмёрка забита раньше времени или с фолом: поражение';
    }
  }
  if (!next.done) {
    const pocketGroups = new Set(simulation.pocketed.map(groupOfBall).filter(Boolean));
    if (!foul && !state.breaking && !assigned && pocketGroups.size === 1) {
      next.groups[mine] = [...pocketGroups][0]!; next.groups[other] = next.groups[mine] === 'solids' ? 'stripes' : 'solids';
    }
    const keepsTurn = !foul && simulation.pocketed.some(id => id !== 0 && id !== 8 && (!next.groups[mine] || groupOfBall(id) === next.groups[mine]));
    next.turn = keepsTurn ? mine : other; next.ballInHand = !!foul;
    if (foul) {
      const cue = next.balls.find(b => b.id === 0)!; cue.pocketed = true;
      next.message = `${foul}. Соперник ставит биток в свободное место`;
    } else next.message = keepsTurn ? 'Шар забит, ход продолжается' : 'Ход переходит сопернику';
  }
  next.lastShot = { number: next.shots, by: state.seats[mine], frames: simulation.frames, durationMs: simulation.durationMs, pocketed: simulation.pocketed, foul };
  return next;
}
export const billiards: GameRules<PoolState, PoolMove> = {
  id: 'billiards', init: initPool,
  turnOf: state => state.done ? '' : state.seats[state.turn],
  why(state, userId, move) {
    if (state.done) return 'Партия окончена';
    if (state.seats[state.turn] !== userId) return 'Сейчас ход соперника';
    if (!move || typeof move !== 'object') return 'Выберите действие';
    if (move.type === 'place') return !state.ballInHand ? 'Биток можно переставлять только после фола' : canPlaceCue(state.balls, move.x, move.y) ? '' : 'Выберите свободное место внутри стола';
    if (move.type !== 'shot') return 'Неизвестное действие';
    if (state.ballInHand) return 'Сначала поставьте биток';
    if (!Number.isFinite(move.angle) || Math.abs(move.angle) > Math.PI * 2 || !Number.isFinite(move.power) || move.power < 0.02 || move.power > 1 || (move.spin !== undefined && (!Number.isFinite(move.spin) || Math.abs(move.spin) > 1))) return 'Недопустимые угол, сила или вращение';
    return '';
  },
  apply(state, _userId, move) {
    if (move.type === 'place') return { ...state, ballInHand: false, message: 'Биток установлен. Прицельтесь и ударьте', balls: state.balls.map(b => b.id === 0 ? { ...b, x: move.x, y: move.y, pocketed: false } : { ...b }) };
    return resolvePoolShot(state, simulateShot(state.balls, move));
  },
  outcome: state => ({ done: state.done, winnerTeam: state.winner, why: state.message, details: { shots: state.shots, groups: state.groups } }),
  viewOf: state => state,
};
registerRules(billiards);
