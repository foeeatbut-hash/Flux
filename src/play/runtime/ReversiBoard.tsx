import React from 'react';
import type { BoardProps } from './boards';

/**
 * Доска реверси.
 *
 * Разрешённые ходы приходят от сервера списком — окно их не вычисляет.
 * Соблазн посчитать самому велик (правила рядом, в `play/games/reversi.ts`), и
 * поддаться ему нельзя: два расчёта одного и того же расходятся не сразу, а на
 * редком случае, и разбираться с этим будет тот, кто ходил.
 *
 * Клетка — кнопка, а не `div` с обработчиком: по доске ходят и с клавиатуры.
 */
export default function ReversiBoard({ view, yourTurn, busy, onMove }: BoardProps) {
  const board: number[] = view?.board || [];
  const moves: number[] = view?.moves || [];
  const canMove = yourTurn && !busy;

  return (
    <div className="flex flex-col gap-2 items-start">
      <div className="flex items-center gap-3 text-xs font-semibold">
        <span className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-150">
          <span className="w-3 h-3 rounded-full bg-slate-800 dark:bg-slate-950 border border-slate-500" />
          {view?.black ?? 0}
        </span>
        <span className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-150">
          <span className="w-3 h-3 rounded-full bg-white border border-slate-400" />
          {view?.white ?? 0}
        </span>
        {yourTurn && moves.length === 0 && (
          <button type="button" onClick={() => onMove({ cell: -1 })} disabled={busy}
            className="px-2 py-0.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-2xs font-bold cursor-pointer disabled:opacity-40">
            Ходить некуда — пропустить
          </button>
        )}
      </div>

      <div
        className="grid gap-px p-px rounded-lg bg-emerald-800 dark:bg-emerald-950"
        style={{ gridTemplateColumns: 'repeat(8, minmax(0, 1fr))', width: 'min(92vw, 28rem)' }}
        role="grid"
        aria-label="Доска реверси"
      >
        {board.map((cell, i) => {
          const hint = canMove && moves.includes(i);
          return (
            <button
              key={i}
              type="button"
              disabled={!hint}
              onClick={() => onMove({ cell: i })}
              aria-label={`Клетка ${String.fromCharCode(97 + (i % 8))}${8 - Math.floor(i / 8)}`}
              className={`aspect-square flex items-center justify-center bg-emerald-700 dark:bg-emerald-900
                          ${hint ? 'cursor-pointer hover:bg-emerald-600 dark:hover:bg-emerald-800' : 'cursor-default'}`}
            >
              {cell === 1 && <span className="w-[78%] h-[78%] rounded-full bg-slate-900 shadow-inner" />}
              {cell === 2 && <span className="w-[78%] h-[78%] rounded-full bg-white shadow" />}
              {/* Подсказка — точка, а не фишка: иначе её принимают за свою */}
              {cell === 0 && hint && <span className="w-[26%] h-[26%] rounded-full bg-emerald-300/70" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
