import React from 'react';
import type { BoardProps } from './boards';

/**
 * Доска русских шашек.
 *
 * Ход здесь — не «откуда-куда», а ПУТЬ: цепочка взятий это один ход, и
 * обрывать её на середине нельзя. Поэтому окно набирает путь по клеткам и
 * отправляет его целиком, а подсказывает только то, что прислал сервер:
 * `view.moves` — готовые законные пути. Своего расчёта здесь нет намеренно —
 * посчитай окно обязательное взятие само, и разойтись с сервером оно сможет
 * ровно на том редком случае, из-за которого партию и переиграют.
 *
 * Пока набранный путь совпадает с началом нескольких путей, ход не
 * отправляется: игрок ещё выбирает, куда прыгать дальше.
 */
export default function CheckersBoard({ view, yourTurn, busy, onMove }: BoardProps) {
  const board: number[] = view?.board || [];
  const paths: number[][] = view?.moves || [];
  const canMove = yourTurn && !busy;
  const [path, setPath] = React.useState<number[]>([]);

  // Чужой ход прошёл — набранное больше ни к чему не относится
  React.useEffect(() => { setPath([]); }, [view?.turn, paths.length]);

  const starts = (p: number[]) => path.every((c, i) => p[i] === c);
  const live = canMove ? paths.filter(starts) : [];
  /** Куда можно ступить следующим шагом */
  const next = new Set(live.filter((p) => p.length > path.length).map((p) => p[path.length]));

  const click = (cell: number) => {
    if (!canMove || !next.has(cell)) return;
    const grown = [...path, cell];
    const fits = paths.filter((p) => grown.every((c, i) => p[i] === c));
    // Путь набран до конца и продолжений нет — только тогда это ход
    const done = fits.find((p) => p.length === grown.length);
    if (done && !fits.some((p) => p.length > grown.length)) {
      setPath([]);
      void onMove({ path: grown });
      return;
    }
    setPath(grown);
  };

  const dark = (i: number) => ((i % 8) + Math.floor(i / 8)) % 2 === 1;

  return (
    <div className="flex flex-col gap-2 items-start">
      <div className="flex items-center gap-3 text-xs font-semibold">
        <span className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-150">
          <span className="w-3 h-3 rounded-full bg-white border border-slate-400" />
          {view?.white ?? 0}
        </span>
        <span className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-150">
          <span className="w-3 h-3 rounded-full bg-slate-800 dark:bg-slate-950 border border-slate-500" />
          {view?.black ?? 0}
        </span>
        {path.length > 0 && (
          <button type="button" onClick={() => setPath([])}
            className="px-2 py-0.5 rounded-lg bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-150 text-2xs font-bold cursor-pointer">
            Начать ход заново
          </button>
        )}
        {canMove && paths.length === 0 && (
          <span className="text-rose-600 dark:text-rose-400 text-2xs">Ходов нет — партия окончена</span>
        )}
      </div>

      <div
        className="grid gap-px p-px rounded-lg bg-amber-900 dark:bg-amber-950"
        style={{ gridTemplateColumns: 'repeat(8, minmax(0, 1fr))', width: 'min(92vw, 28rem)' }}
        role="grid"
        aria-label="Доска шашек"
      >
        {board.map((cell, i) => {
          const hint = next.has(i);
          const taken = path.includes(i);
          const owner = cell === 1 || cell === 3 ? 1 : cell === 2 || cell === 4 ? 2 : 0;
          const king = cell === 3 || cell === 4;
          return (
            <button
              key={i}
              type="button"
              disabled={!hint}
              onClick={() => click(i)}
              aria-label={`Поле ${String.fromCharCode(97 + (i % 8))}${8 - Math.floor(i / 8)}`}
              className={`aspect-square flex items-center justify-center
                          ${dark(i) ? 'bg-amber-700 dark:bg-amber-900' : 'bg-amber-100 dark:bg-amber-200/80'}
                          ${taken ? 'ring-2 ring-inset ring-sky-400' : hint ? 'ring-1 ring-inset ring-sky-300' : ''}
                          ${hint ? 'cursor-pointer hover:brightness-110' : 'cursor-default'}`}
            >
              {owner === 1 && (
                <span className="w-[76%] h-[76%] rounded-full bg-white border-2 border-slate-400 shadow flex items-center justify-center">
                  {king && <span className="text-2xs font-black text-slate-600">Д</span>}
                </span>
              )}
              {owner === 2 && (
                <span className="w-[76%] h-[76%] rounded-full bg-slate-900 border-2 border-slate-700 shadow flex items-center justify-center">
                  {king && <span className="text-2xs font-black text-slate-150">Д</span>}
                </span>
              )}
              {/* Подсказка — точка, а не шашка: её принимают за свою */}
              {owner === 0 && hint && <span className="w-[26%] h-[26%] rounded-full bg-sky-400/70" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
