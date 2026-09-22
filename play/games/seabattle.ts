/**
 * Морской бой: правила доски.
 *
 * Главная особенность этой игры среди всех встроенных — **скрытые сведения**.
 * У реверси и шашек доска одна на двоих, и показать её целиком можно обоим. У
 * морского боя половина состояния — чужая тайна, и прятать её обязан сервер:
 * спрятанное окном лежит в ответе сервера и достаётся любому, кто откроет
 * средства разработчика. Поэтому `viewOf` отдаёт каждому свою картину, а не
 * общую с пометкой «не показывать».
 *
 * Второе, на чём такие доски ломаются, — **касания**. «Корабли не соприкасаются»
 * значит и по диагонали тоже: расстановка, где четырёхпалубный стоит углом к
 * двухпалубному, законной не считается. Проверяется это здесь, а не в окне:
 * расстановка приходит с той стороны, где её удобно подделать.
 *
 * Третье — **потопленный корабль обводится промахами**. Это не украшение: по
 * правилам клетки вокруг убитого пусты, и стрелять туда бессмысленно. Не
 * отметив их, мы заставляем человека тратить ходы на заведомо пустое, а он
 * будет думать, что программа считает иначе.
 *
 * Попал — стреляешь снова, промахнулся — ход переходит. Русские правила.
 */

import { registerRules, pick, rngOf, type GameOutcome, type GameRules } from './kit.js';

export const SIDE = 10;
export const CELLS = SIDE * SIDE;

/** Флот: один четырёхпалубный, два трёх-, три двух-, четыре однопалубных */
export const FLEET: number[] = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
/** Сколько всего палуб — столько попаданий нужно для победы */
export const DECKS = FLEET.reduce((s, n) => s + n, 0);

/** Корабль — просто его клетки: длина и направление из них выводятся */
export type Ship = number[];

export interface SeaState {
  seats: string[];
  /** Расстановка по местам; пустой список — ещё не расставлено */
  fleets: Ship[][];
  /** Клетки, по которым стреляли ПО ЭТОМУ месту */
  shots: number[][];
  /** Чей ход в бою: 0 или 1 */
  turn: number;
  seed: string;
  moves: number;
}

export type SeaMove = { place: Ship[] } | { shot: number };

const xy = (c: number): [number, number] => [c % SIDE, Math.floor(c / SIDE)];
const at = (x: number, y: number): number => y * SIDE + x;
const inside = (x: number, y: number) => x >= 0 && x < SIDE && y >= 0 && y < SIDE;

/** Восемь соседей клетки — по ним и проверяется касание */
export function around(cell: number): number[] {
  const [cx, cy] = xy(cell);
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (inside(x, y)) out.push(at(x, y));
    }
  }
  return out;
}

/** Клетки корабля по началу, длине и направлению. Вышел за край — пусто. */
export function shipAt(head: number, size: number, vertical: boolean): Ship {
  const [x, y] = xy(head);
  const out: Ship = [];
  for (let i = 0; i < size; i++) {
    const cx = vertical ? x : x + i;
    const cy = vertical ? y + i : y;
    if (!inside(cx, cy)) return [];
    out.push(at(cx, cy));
  }
  return out;
}

/**
 * Почему расстановка незаконна. Пустая строка — законна.
 *
 * Отказ словами, а не `false`: «корабли соприкасаются» и «не хватает
 * трёхпалубного» — разные ошибки, и человек, расставлявший флот руками, должен
 * видеть, какую из них он сделал.
 */
export function whyFleet(fleet: Ship[]): string {
  if (!Array.isArray(fleet)) return 'Расстановка не прочитана';
  if (fleet.length !== FLEET.length) return `Кораблей должно быть ${FLEET.length}, а прислано ${fleet.length}`;

  const busy = new Set<number>();
  const sizes: number[] = [];

  for (const ship of fleet) {
    if (!Array.isArray(ship) || ship.length < 1) return 'Корабль без клеток';
    const cells = ship.map((c) => Number(c));
    if (cells.some((c) => !Number.isInteger(c) || c < 0 || c >= CELLS)) return 'Корабль за краем поля';
    if (new Set(cells).size !== cells.length) return 'Клетка корабля повторяется';

    // Корабль обязан быть прямым: клетки по возрастанию, шаг 1 по строке или
    // SIDE по столбцу. Буква «Г» кораблём не считается
    const sorted = [...cells].sort((a, b) => a - b);
    const step = sorted.length > 1 ? sorted[1] - sorted[0] : 1;
    if (sorted.length > 1 && step !== 1 && step !== SIDE) return 'Корабль должен стоять по прямой';
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] !== step) return 'Корабль должен стоять по прямой';
    }
    // Горизонтальный не имеет права переезжать на следующую строку
    if (step === 1 && sorted.length > 1 && Math.floor(sorted[0] / SIDE) !== Math.floor(sorted[sorted.length - 1] / SIDE)) {
      return 'Корабль должен стоять по прямой';
    }

    for (const c of sorted) {
      if (busy.has(c)) return 'Корабли накладываются друг на друга';
      busy.add(c);
    }
    sizes.push(sorted.length);
  }

  // Касание — включая диагональ: угол к углу тоже касание
  for (const ship of fleet) {
    for (const c of ship) {
      for (const n of around(c)) {
        if (busy.has(n) && !ship.includes(n)) return 'Корабли соприкасаются — между ними должна быть клетка';
      }
    }
  }

  const want = [...FLEET].sort((a, b) => b - a).join(',');
  const got = sizes.sort((a, b) => b - a).join(',');
  if (want !== got) return `Флот должен быть ${want.replace(/,/g, '+')}, а получился ${got.replace(/,/g, '+')}`;
  return '';
}

/**
 * Расстановка по семени.
 *
 * Нужна и окну (кнопка «Расставить за меня»), и проверкам. Жадно, с попытками:
 * корабли ставятся от длинного к короткому, потому что наоборот четырёхпалубному
 * к концу места не остаётся.
 */
export function autoFleet(seed: string, counter = 0): Ship[] {
  for (let attempt = 0; attempt < 40; attempt++) {
    const rnd = rngOf(seed, counter * 100 + attempt);
    const busy = new Set<number>();
    const fleet: Ship[] = [];
    let stuck = false;
    for (const size of FLEET) {
      let placed: Ship | null = null;
      for (let tries = 0; tries < 400 && !placed; tries++) {
        const vertical = rnd() < 0.5;
        const head = pick(rnd, CELLS);
        const ship = shipAt(head, size, vertical);
        if (!ship.length) continue;
        if (ship.some((c) => busy.has(c))) continue;
        if (ship.some((c) => around(c).some((n) => busy.has(n) && !ship.includes(n)))) continue;
        placed = ship;
      }
      if (!placed) { stuck = true; break; }
      for (const c of placed) busy.add(c);
      fleet.push(placed);
    }
    if (!stuck && !whyFleet(fleet)) return fleet;
  }
  // Сюда не доходит: сорок попыток по четыреста мест хватает с запасом. Но
  // молчаливый пустой флот прошёл бы дальше и сломался бы уже у человека
  throw new Error('Не удалось расставить корабли');
}

const sunk = (ship: Ship, shots: number[]): boolean => ship.every((c) => shots.includes(c));

/** Сколько палуб подбито у этого места */
const hitsOn = (state: SeaState, seat: number): number => {
  const shots = state.shots[seat] || [];
  return (state.fleets[seat] || []).reduce((s, ship) => s + ship.filter((c) => shots.includes(c)).length, 0);
};

const placedAll = (state: SeaState): boolean => state.fleets.every((f) => f && f.length > 0);

const beaten = (state: SeaState): number => {
  for (let i = 0; i < state.seats.length; i++) {
    if (state.fleets[i]?.length && hitsOn(state, i) >= DECKS) return i;
  }
  return -1;
};

export const seabattle: GameRules<SeaState, SeaMove> = {
  id: 'seabattle',

  init(seed, seats) {
    return { seats: [...seats], fleets: seats.map(() => []), shots: seats.map(() => []), turn: 0, seed, moves: 0 };
  },

  turnOf(state) {
    if (beaten(state) >= 0) return '';
    // Расстановка идёт по очереди только на вид: ходить разрешено обоим, но
    // «чей ход» платформа спрашивает одним именем, и им зовётся тот, кого ещё
    // ждут. Пока ждут двоих, названным будет первый
    if (!placedAll(state)) {
      const waiting = state.fleets.findIndex((f) => !f || !f.length);
      return state.seats[waiting] || '';
    }
    return state.seats[state.turn] || '';
  },

  why(state, userId, move) {
    const me = state.seats.indexOf(userId);
    if (me < 0) return 'Вы не за этой доской';
    if (beaten(state) >= 0) return 'Партия окончена';

    const setup = !placedAll(state);
    const place = (move as any)?.place;
    const shot = (move as any)?.shot;

    if (place !== undefined) {
      if (!setup) return 'Расстановка закончена — бой уже идёт';
      if (state.fleets[me]?.length) return 'Ваши корабли уже расставлены';
      return whyFleet(place);
    }

    if (shot === undefined) return 'Ход не прочитан';
    if (setup) {
      return state.fleets[me]?.length
        ? 'Соперник ещё расставляет корабли'
        : 'Сначала расставьте свои корабли';
    }
    if (state.seats[state.turn] !== userId) return 'Сейчас ходит соперник';

    const cell = Number(shot);
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) return 'Такой клетки на поле нет';
    const foe = me === 0 ? 1 : 0;
    if ((state.shots[foe] || []).includes(cell)) return 'Сюда уже стреляли';
    return '';
  },

  apply(state, userId, move) {
    const me = state.seats.indexOf(userId);
    const next: SeaState = {
      ...state,
      fleets: state.fleets.map((f) => f.map((s) => [...s])),
      shots: state.shots.map((s) => [...s]),
      moves: state.moves + 1,
    };

    const place = (move as any)?.place;
    if (place !== undefined) {
      next.fleets[me] = (place as Ship[]).map((s) => [...s].sort((a, b) => a - b));
      return next;
    }

    const cell = Number((move as any).shot);
    const foe = me === 0 ? 1 : 0;
    next.shots[foe] = [...next.shots[foe], cell];

    const ship = next.fleets[foe].find((s) => s.includes(cell));
    if (!ship) {
      // Промах — ход переходит. Попал — стреляешь снова: русские правила
      next.turn = foe;
      return next;
    }
    if (sunk(ship, next.shots[foe])) {
      // Убил — клетки вокруг пусты по правилам, и отмечаем их сами: иначе
      // человек тратит ходы на заведомо пустое
      for (const c of ship) {
        for (const n of around(c)) {
          if (!next.shots[foe].includes(n)) next.shots[foe].push(n);
        }
      }
    }
    return next;
  },

  outcome(state): GameOutcome {
    const lost = beaten(state);
    if (lost < 0) return { done: false, winnerTeam: 0, details: {}, why: '' };
    const winner = lost === 0 ? 1 : 0;
    return {
      done: true,
      winnerTeam: winner + 1,
      details: { moves: state.moves, shots: state.shots.map((s) => s.length) },
      why: 'Все корабли потоплены',
    };
  },

  viewOf(state, userId) {
    const me = state.seats.indexOf(userId);
    const done = beaten(state) >= 0;
    if (me < 0) {
      // Не за доской — и знать нечего: ни расстановки, ни выстрелов
      return { phase: done ? 'done' : 'battle', watcher: true };
    }
    const foe = me === 0 ? 1 : 0;
    const setup = !placedAll(state);

    /** Своё поле: корабли видны все, поверх них — чужие выстрелы */
    const mine = new Array(CELLS).fill(0);
    for (const ship of state.fleets[me] || []) {
      const dead = sunk(ship, state.shots[me] || []);
      for (const c of ship) mine[c] = dead ? 4 : (state.shots[me] || []).includes(c) ? 3 : 1;
    }
    for (const c of state.shots[me] || []) if (!mine[c]) mine[c] = 2;

    /**
     * Чужое поле: только то, что открыто выстрелами.
     *
     * Целые корабли соперника сюда не попадают ни в каком виде — ни числом, ни
     * пометкой. До конца партии; после конца показываем, где они стояли, иначе
     * разобрать сыгранное невозможно
     */
    const theirs = new Array(CELLS).fill(0);
    for (const c of state.shots[foe] || []) theirs[c] = 2;
    for (const ship of state.fleets[foe] || []) {
      const dead = sunk(ship, state.shots[foe] || []);
      for (const c of ship) {
        if ((state.shots[foe] || []).includes(c)) theirs[c] = dead ? 4 : 3;
        else if (done) theirs[c] = 1;
      }
    }

    return {
      phase: done ? 'done' : setup ? 'setup' : 'battle',
      you: me,
      mine,
      theirs,
      /** Расставились ли вы — по этому окно решает, показывать поле или бой */
      placed: (state.fleets[me] || []).length > 0,
      foePlaced: (state.fleets[foe] || []).length > 0,
      myDecks: DECKS - hitsOn(state, me),
      foeDecks: DECKS - hitsOn(state, foe),
      seed: state.seed,
      turn: state.seats[state.turn] || '',
    };
  },
};

registerRules(seabattle as GameRules);
