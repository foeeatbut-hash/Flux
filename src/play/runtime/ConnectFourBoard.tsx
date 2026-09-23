import type { BoardProps } from './boards';

export default function ConnectFourBoard({ view, yourTurn, busy, onMove }: BoardProps) {
  const board: number[] = view?.board || [];
  const valid: number[] = view?.valid || [];
  const seat = Number(view?.seat || 0);
  if (!board.length) return null;

  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-xs text-slate-600 dark:text-slate-300">
        Вы играете {seat === 1 ? 'жёлтыми' : 'красными'}. Нажмите на столбец, чтобы опустить фишку.
      </p>
      <div className="grid grid-cols-7 gap-1 p-2 rounded-xl bg-sky-800 dark:bg-sky-950"
        style={{ width: 'min(92vw, 29rem)' }} role="grid" aria-label="Поле четыре в ряд">
        {board.map((stone, i) => {
          const column = i % 7;
          const active = yourTurn && !busy && valid.includes(column);
          return (
            <button key={i} type="button" disabled={!active}
              onClick={() => onMove({ column })}
              aria-label={`Столбец ${column + 1}, строка ${Math.floor(i / 7) + 1}`}
              className={`aspect-square rounded-full border-2 border-sky-950/30 dark:border-sky-700/50
                ${stone === 1 ? 'bg-amber-400 dark:bg-amber-300' : stone === 2 ? 'bg-rose-500 dark:bg-rose-400' : 'bg-white dark:bg-slate-800'}
                ${active ? 'cursor-pointer hover:ring-2 hover:ring-emerald-400' : 'cursor-default'}
                ${view?.last === i ? 'ring-2 ring-emerald-400 dark:ring-emerald-300' : ''}`} />
          );
        })}
      </div>
    </div>
  );
}
