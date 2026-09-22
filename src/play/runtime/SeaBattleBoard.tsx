import React from 'react';
import type { BoardProps } from './boards';
import { FLEET, SIDE, autoFleet, shipAt, whyFleet, type Ship } from '../../../play/games/seabattle';

/**
 * Доска морского боя: своё поле и чужое.
 *
 * Расстановку окно собирает само и отправляет целиком, а законность её решает
 * сервер теми же правилами (`whyFleet`), которыми окно подсвечивает ошибку.
 * Показать ошибку заранее — вежливость; доверять этому показу — нет: флот
 * приходит с той стороны, где его удобно подделать.
 *
 * Чужое поле рисуется ровно из того, что прислал сервер. Целых кораблей
 * соперника в снимке нет вовсе, поэтому нарисовать их здесь нечем даже по
 * ошибке — и это единственная защита, которая держится.
 */

const CELLS = SIDE * SIDE;
const LETTERS = 'АБВГДЕЖЗИК';

/** Клетки, занятые флотом, и клетки вокруг них — чтобы не ставить впритык */
function busyOf(fleet: Ship[]): { taken: Set<number>; near: Set<number> } {
  const taken = new Set<number>();
  const near = new Set<number>();
  for (const ship of fleet) for (const c of ship) taken.add(c);
  for (const c of taken) {
    const x = c % SIDE;
    const y = Math.floor(c / SIDE);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < SIDE && ny >= 0 && ny < SIDE) near.add(ny * SIDE + nx);
      }
    }
  }
  return { taken, near };
}

function Grid({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-2xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
      <div className="grid gap-px p-px rounded-lg bg-sky-800 dark:bg-sky-950"
        style={{ gridTemplateColumns: `repeat(${SIDE}, minmax(0, 1fr))`, width: 'min(92vw, 20rem)' }}
        role="grid" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

const nameOf = (i: number) => `${LETTERS[i % SIDE]}${Math.floor(i / SIDE) + 1}`;

/** Как выглядит клетка по коду снимка: 0 пусто, 1 корабль, 2 мимо, 3 ранен, 4 убит */
const skin: Record<number, string> = {
  0: 'bg-sky-100 dark:bg-sky-900/60',
  1: 'bg-slate-500 dark:bg-slate-400',
  2: 'bg-sky-200 dark:bg-sky-900',
  3: 'bg-amber-400 dark:bg-amber-500',
  4: 'bg-rose-600 dark:bg-rose-700',
};

export default function SeaBattleBoard({ view, yourTurn, busy, onMove }: BoardProps) {
  const phase: string = view?.phase || 'setup';
  const placed: boolean = !!view?.placed;
  const [fleet, setFleet] = React.useState<Ship[]>([]);
  const [size, setSize] = React.useState(4);
  const [vertical, setVertical] = React.useState(false);
  const [failure, setFailure] = React.useState('');

  const left = React.useMemo(() => {
    const rest = [...FLEET];
    for (const ship of fleet) {
      const i = rest.indexOf(ship.length);
      if (i >= 0) rest.splice(i, 1);
    }
    return rest;
  }, [fleet]);

  React.useEffect(() => {
    if (!left.includes(size) && left.length) setSize(left[0]);
  }, [left, size]);

  // ── Расстановка ───────────────────────────────────────────────────────────
  if (phase === 'setup' && !placed) {
    const { taken, near } = busyOf(fleet);
    const put = (head: number) => {
      const ship = shipAt(head, size, vertical);
      if (!ship.length) { setFailure('Корабль не помещается'); return; }
      if (ship.some((c) => near.has(c))) { setFailure('Корабли не должны соприкасаться'); return; }
      setFailure('');
      setFleet([...fleet, ship]);
    };
    const drop = (cell: number) => setFleet(fleet.filter((s) => !s.includes(cell)));
    const ready = whyFleet(fleet);

    return (
      <div className="flex flex-col gap-2 items-start">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="font-bold text-slate-700 dark:text-slate-150">Расставьте корабли</span>
          {left.map((n, i) => (
            <button key={`${n}-${i}`} type="button" onClick={() => setSize(n)}
              className={`px-2 py-0.5 rounded-lg text-2xs font-bold cursor-pointer ${
                size === n ? 'bg-sky-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-150'}`}>
              {n}
            </button>
          ))}
          <button type="button" onClick={() => setVertical(!vertical)}
            className="px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-150 text-2xs font-bold cursor-pointer">
            {vertical ? 'Вниз' : 'Вправо'}
          </button>
          <button type="button" onClick={() => { setFleet(autoFleet(String(view?.seed || 'флот'), Date.now() % 1000)); setFailure(''); }}
            className="px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-150 text-2xs font-bold cursor-pointer">
            Расставить за меня
          </button>
          {fleet.length > 0 && (
            <button type="button" onClick={() => { setFleet([]); setFailure(''); }}
              className="px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-150 text-2xs font-bold cursor-pointer">
              Убрать всё
            </button>
          )}
        </div>

        <Grid label="Ваше поле">
          {Array.from({ length: CELLS }, (_, i) => (
            <button key={i} type="button" disabled={busy}
              onClick={() => (taken.has(i) ? drop(i) : put(i))}
              aria-label={nameOf(i)}
              className={`aspect-square ${taken.has(i) ? skin[1] : skin[0]} cursor-pointer hover:brightness-110 disabled:cursor-default`} />
          ))}
        </Grid>

        {(failure || (fleet.length === FLEET.length && ready)) && (
          <div className="text-2xs text-amber-700 dark:text-amber-400">{failure || ready}</div>
        )}
        <button type="button" disabled={busy || !!ready}
          onClick={() => void onMove({ place: fleet })}
          className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer disabled:opacity-40 disabled:cursor-default">
          Флот готов
        </button>
      </div>
    );
  }

  if (phase === 'setup') {
    return (
      <div className="text-xs text-slate-500 dark:text-slate-400">
        Флот расставлен. Соперник ещё расставляет свой.
      </div>
    );
  }

  // ── Бой ───────────────────────────────────────────────────────────────────
  const mine: number[] = view?.mine || [];
  const theirs: number[] = view?.theirs || [];
  const canShoot = yourTurn && !busy && phase === 'battle';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-xs font-semibold text-slate-700 dark:text-slate-150">
        <span>Ваши палубы: {view?.myDecks ?? 0}</span>
        <span>У соперника: {view?.foeDecks ?? 0}</span>
      </div>
      <div className="flex gap-4 flex-wrap">
        <Grid label="Поле соперника">
          {theirs.map((cell, i) => (
            <button key={i} type="button" disabled={!canShoot || cell !== 0}
              onClick={() => onMove({ shot: i })}
              aria-label={nameOf(i)}
              className={`aspect-square ${skin[cell] || skin[0]}
                          ${canShoot && cell === 0 ? 'cursor-pointer hover:brightness-110' : 'cursor-default'}`} />
          ))}
        </Grid>
        <Grid label="Ваше поле">
          {mine.map((cell, i) => (
            <div key={i} aria-label={nameOf(i)} className={`aspect-square ${skin[cell] || skin[0]}`} />
          ))}
        </Grid>
      </div>
    </div>
  );
}
