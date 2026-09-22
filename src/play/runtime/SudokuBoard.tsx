import React from 'react';
import { Eraser, Lightbulb } from 'lucide-react';
import type { BoardProps } from './boards';

/**
 * Доска судоку.
 *
 * Решение в окно не приходит — и правильно: иначе судоку решается средствами
 * разработчика за десять секунд. Окну хватает условия, того, что вписано, и
 * списка клеток, нарушающих правило; последний считает сервер.
 *
 * Поэтому здесь нет ни слова про «верно» и «неверно»: подсвечивается
 * нарушение правила (две одинаковые цифры в строке), а не расхождение с
 * ответом. Так судоку и решают на бумаге.
 */
export default function SudokuBoard({ view, yourTurn, busy, onMove }: BoardProps) {
  const puzzle: number[] = view?.puzzle || [];
  const filled: number[] = view?.filled || [];
  const hinted: number[] = view?.hinted || [];
  const bad: number[] = view?.conflicts || [];
  const [at, setAt] = React.useState<number>(-1);
  const can = yourTurn && !busy;

  const put = (value: number) => {
    if (!can || at < 0) return;
    void onMove(value ? { kind: 'set', cell: at, value } : { kind: 'clear', cell: at });
  };

  React.useEffect(() => {
    if (!can) return;
    const onKey = (e: KeyboardEvent) => {
      if (at < 0) return;
      if (e.key >= '1' && e.key <= '9') { e.preventDefault(); put(Number(e.key)); return; }
      if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') { e.preventDefault(); put(0); return; }
      // Стрелками ходят по сетке: мышью девять цифр подряд вводить мучительно
      const move: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -9, ArrowDown: 9 };
      if (move[e.key] !== undefined) {
        e.preventDefault();
        setAt((c) => Math.max(0, Math.min(80, c + move[e.key])));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [can, at, onMove]);

  return (
    <div className="flex flex-col gap-2 items-start">
      <div className="flex items-center gap-3 text-xs font-semibold text-slate-700 dark:text-slate-150">
        <span>Осталось <b>{view?.left ?? 0}</b></span>
        {(view?.mistakes ?? 0) > 0 && <span className="text-amber-600 dark:text-amber-400">ошибок {view.mistakes}</span>}
        {(view?.hints ?? 0) > 0 && <span className="text-slate-400">подсказок {view.hints}</span>}
      </div>

      <div
        className="grid rounded-lg overflow-hidden border-2 border-slate-400 dark:border-slate-600"
        style={{ gridTemplateColumns: 'repeat(9, minmax(0, 1fr))', width: 'min(92vw, 27rem)' }}
        role="grid"
        aria-label="Сетка судоку"
      >
        {puzzle.map((given, i) => {
          const value = given || filled[i] || 0;
          const isHint = hinted.includes(i);
          const wrong = bad.includes(i);
          const x = i % 9;
          const y = Math.floor(i / 9);
          // Толстые линии между квадратами: без них сетка читается как 81
          // отдельная клетка, и квадрат глазом не выделяется
          const edges = `${x % 3 === 2 && x !== 8 ? 'border-r-2 border-r-slate-400 dark:border-r-slate-600 ' : ''}`
            + `${y % 3 === 2 && y !== 8 ? 'border-b-2 border-b-slate-400 dark:border-b-slate-600 ' : ''}`;
          return (
            <button
              key={i}
              type="button"
              onClick={() => setAt(i)}
              aria-label={`Клетка ${x + 1}, ${y + 1}`}
              className={`aspect-square border border-slate-200 dark:border-slate-800 ${edges}
                          flex items-center justify-center text-base font-semibold cursor-pointer
                          ${at === i ? 'bg-emerald-100 dark:bg-emerald-950/60' : 'bg-white dark:bg-slate-900'}
                          ${wrong ? 'text-rose-600 dark:text-rose-400' : given
                            ? 'text-slate-800 dark:text-slate-100'
                            : isHint ? 'text-sky-600 dark:text-sky-400' : 'text-emerald-700 dark:text-emerald-300'}`}
            >
              {value || ''}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-1 items-center">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <button key={n} type="button" disabled={!can || at < 0} onClick={() => put(n)}
            className="w-9 h-9 rounded-lg border border-slate-200 dark:border-slate-800 font-bold
                       text-slate-700 dark:text-slate-150 hover:border-emerald-400 hover:text-emerald-600
                       disabled:opacity-30 disabled:cursor-default cursor-pointer">
            {n}
          </button>
        ))}
        <button type="button" disabled={!can || at < 0} onClick={() => put(0)} title="Стереть"
          className="w-9 h-9 rounded-lg border border-slate-200 dark:border-slate-800 flex items-center justify-center
                     text-slate-500 hover:text-rose-600 disabled:opacity-30 disabled:cursor-default cursor-pointer">
          <Eraser className="w-4 h-4" />
        </button>
        {/* Подсказка открывает ОДНУ клетку: кнопкой «решить за меня» она быть
            не должна, иначе пройденная сетка ничего не значит */}
        <button type="button" disabled={!can} onClick={() => onMove({ kind: 'hint' })} title="Открыть одну клетку"
          className="h-9 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 inline-flex items-center gap-1.5
                     text-xs font-bold text-slate-600 dark:text-slate-300 hover:text-amber-600
                     disabled:opacity-30 disabled:cursor-default cursor-pointer">
          <Lightbulb className="w-3.5 h-3.5" />Подсказка
        </button>
      </div>
    </div>
  );
}
