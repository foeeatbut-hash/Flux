import type React from 'react';
import type { BoardProps } from './boards';

/**
 * Доска 2048.
 *
 * Ход — направление, а не новое состояние: двигает сервер. Поэтому здесь
 * только клавиши, кнопки для узкого окна и раскраска плиток.
 *
 * Цвет плитки берётся из палитры программы ступенями, а не выдуманными
 * оттенками: раздел игр — часть Flux, и выглядеть он должен как Flux.
 */

const TINT: Record<number, string> = {
  2: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-150',
  4: 'bg-slate-150 dark:bg-slate-750 text-slate-700 dark:text-slate-150',
  8: 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-200',
  16: 'bg-emerald-200 dark:bg-emerald-900 text-emerald-900 dark:text-emerald-100',
  32: 'bg-emerald-300 dark:bg-emerald-800 text-emerald-950 dark:text-white',
  64: 'bg-emerald-400 dark:bg-emerald-700 text-white',
  128: 'bg-amber-200 dark:bg-amber-900 text-amber-900 dark:text-amber-100',
  256: 'bg-amber-300 dark:bg-amber-800 text-amber-950 dark:text-white',
  512: 'bg-amber-400 dark:bg-amber-700 text-white',
  1024: 'bg-rose-300 dark:bg-rose-800 text-rose-950 dark:text-white',
  2048: 'bg-rose-400 dark:bg-rose-700 text-white',
};
const tintOf = (v: number) => TINT[v] || 'bg-rose-500 dark:bg-rose-600 text-white';

const KEYS: Record<string, string> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
  ц: 'up', ы: 'down', ф: 'left', в: 'right',
};

export default function G2048Board({ view, yourTurn, busy, onMove }: BoardProps) {
  const board: number[] = view?.board || [];
  const dirs: string[] = view?.dirs || [];

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dir = KEYS[e.key];
    if (!yourTurn || busy || !dir || !dirs.includes(dir)) return;
    // Раздел может оставаться смонтированным, когда сотрудник пишет в другом
    // окне. Ходить вправе только сфокусированная доска, не всё приложение.
    e.preventDefault();
    void onMove({ dir });
  };

  return (
    <div className="flex flex-col gap-2 items-start">
      <div className="flex items-center gap-3 text-xs font-semibold text-slate-700 dark:text-slate-150">
        <span>Счёт <b>{view?.score ?? 0}</b></span>
        <span className="text-slate-500 dark:text-slate-400">лучшая {view?.best ?? 0}</span>
        <span className="text-slate-400">ходов {view?.moves ?? 0}</span>
      </div>

      <div
        className="grid gap-1.5 p-1.5 rounded-xl bg-slate-200 dark:bg-slate-850"
        style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', width: 'min(92vw, 22rem)' }}
        role="grid"
        tabIndex={0}
        onKeyDown={onKey}
        aria-label="Доска 2048. Выберите поле и используйте стрелки или WASD"
      >
        {board.map((v, i) => (
          <div key={i}
            className={`aspect-square rounded-lg flex items-center justify-center font-bold
                        ${v ? tintOf(v) : 'bg-slate-100 dark:bg-slate-800'}
                        ${v >= 1024 ? 'text-base' : v >= 128 ? 'text-lg' : 'text-xl'}`}>
            {v || ''}
          </div>
        ))}
      </div>

      <span className="text-2xs text-slate-500 dark:text-slate-400">Выберите поле для управления клавишами или используйте кнопки.</span>

      {/* Кнопки для узкого окна и для тех, кому клавиши неудобны */}
      <div className="grid grid-cols-3 gap-1 w-36" aria-label="Куда двигать">
        <span />
        <Arrow dir="up" label="вверх" dirs={dirs} busy={busy || !yourTurn} onMove={onMove} />
        <span />
        <Arrow dir="left" label="влево" dirs={dirs} busy={busy || !yourTurn} onMove={onMove} />
        <Arrow dir="down" label="вниз" dirs={dirs} busy={busy || !yourTurn} onMove={onMove} />
        <Arrow dir="right" label="вправо" dirs={dirs} busy={busy || !yourTurn} onMove={onMove} />
      </div>
    </div>
  );
}

function Arrow(
  { dir, label, dirs, busy, onMove }:
  { dir: string; label: string; dirs: string[]; busy: boolean; onMove: BoardProps['onMove'] },
) {
  const can = dirs.includes(dir) && !busy;
  return (
    <button type="button" disabled={!can} onClick={() => onMove({ dir })} aria-label={label}
      className="h-10 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600
                 dark:text-slate-300 font-bold disabled:opacity-30 cursor-pointer
                 hover:border-emerald-400 hover:text-emerald-600 disabled:cursor-default">
      {dir === 'up' ? '↑' : dir === 'down' ? '↓' : dir === 'left' ? '←' : '→'}
    </button>
  );
}
