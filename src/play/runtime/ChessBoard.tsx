import React from 'react';
import type { BoardProps } from './boards';

/**
 * Шахматная доска.
 *
 * Законные ходы приходят от сервера списком — окно их не выводит. Соблазн
 * посчитать самому здесь больше, чем в любой другой игре (правила рядом, в
 * `play/games/chess.ts`), и поддаться ему нельзя по той же причине: два
 * расчёта расходятся не на обычном ходу, а на рокировке и взятии на проходе,
 * то есть ровно там, где партию потом и переигрывают.
 *
 * Превращение спрашивается, а не подставляется ферзём молча: недоигранная
 * партия с лишним ферзём вместо коня — это проигрыш, а не мелочь.
 */

const GLYPH: Record<string, string> = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};
const PROMO: Array<[string, string]> = [['Q', 'Ферзь'], ['R', 'Ладья'], ['B', 'Слон'], ['N', 'Конь']];

interface Move { from: number; to: number; promo?: string }

const nameOf = (c: number) => `${'abcdefgh'[c % 8]}${8 - Math.floor(c / 8)}`;

export default function ChessBoard({ view, yourTurn, busy, onMove }: BoardProps) {
  const board: string[] = view?.board || [];
  const moves: Move[] = view?.moves || [];
  const you: string = view?.you || 'w';
  const canMove = yourTurn && !busy;
  const [from, setFrom] = React.useState(-1);
  const [ask, setAsk] = React.useState<Move | null>(null);

  React.useEffect(() => { setFrom(-1); setAsk(null); }, [view?.board?.join?.('')]);

  const targets = React.useMemo(
    () => new Set(moves.filter((m) => m.from === from).map((m) => m.to)),
    [moves, from],
  );
  const sources = React.useMemo(() => new Set(moves.map((m) => m.from)), [moves]);

  const click = (cell: number) => {
    if (!canMove) return;
    if (from < 0 || !targets.has(cell)) {
      setFrom(sources.has(cell) ? cell : -1);
      return;
    }
    const here = moves.filter((m) => m.from === from && m.to === cell);
    // Превращение спрашиваем: четыре разных хода отличаются только фигурой
    if (here.length > 1 && here[0].promo) { setAsk({ from, to: cell }); return; }
    setFrom(-1);
    void onMove(here[0]);
  };

  // Чёрные смотрят на доску со своей стороны — иначе играть невозможно
  const order = React.useMemo(() => {
    const cells = Array.from({ length: 64 }, (_, i) => i);
    return you === 'b' ? cells.reverse() : cells;
  }, [you]);

  return (
    <div className="flex flex-col gap-2 items-start">
      <div className="flex items-center gap-3 text-xs font-semibold text-slate-700 dark:text-slate-150">
        <span>Ход {view?.full ?? 1}</span>
        <span>{view?.turn === 'w' ? 'Белые' : 'Чёрные'}</span>
        {view?.check && <span className="text-rose-600 dark:text-rose-400">Шах</span>}
        {from >= 0 && <span className="text-slate-400">{nameOf(from)}</span>}
      </div>

      <div
        className="grid gap-0 p-px rounded-lg bg-amber-900 dark:bg-amber-950"
        style={{ gridTemplateColumns: 'repeat(8, minmax(0, 1fr))', width: 'min(92vw, 28rem)' }}
        role="grid"
        aria-label="Шахматная доска"
      >
        {order.map((i) => {
          const light = ((i % 8) + Math.floor(i / 8)) % 2 === 0;
          const hint = canMove && targets.has(i);
          const piece = board[i] || '';
          return (
            <button
              key={i}
              type="button"
              disabled={!canMove}
              onClick={() => click(i)}
              aria-label={`${nameOf(i)}${piece ? ` ${piece}` : ''}`}
              className={`relative aspect-square flex items-center justify-center leading-none select-none
                          ${light ? 'bg-amber-100 dark:bg-amber-200/80' : 'bg-amber-700 dark:bg-amber-900'}
                          ${i === from ? 'ring-2 ring-inset ring-sky-500' : ''}
                          ${canMove ? 'cursor-pointer' : 'cursor-default'}`}
              style={{ fontSize: 'min(7vw, 2rem)' }}
            >
              <span className={piece && piece === piece.toUpperCase() ? 'text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]' : 'text-slate-900'}>
                {GLYPH[piece] || ''}
              </span>
              {/* Подсказка — точка поверх пустого поля и кольцо поверх фигуры */}
              {hint && !piece && <span className="absolute w-[22%] h-[22%] rounded-full bg-sky-500/70" />}
              {hint && piece && <span className="absolute inset-[6%] rounded-full ring-2 ring-rose-500/80" />}
            </button>
          );
        })}
      </div>

      {ask && (
        <div className="flex items-center gap-2 text-xs">
          <span className="font-bold text-slate-700 dark:text-slate-150">Пешка дошла — в кого превращаем?</span>
          {PROMO.map(([code, title]) => (
            <button key={code} type="button" disabled={busy}
              onClick={() => { const m = { ...ask, promo: code }; setAsk(null); setFrom(-1); void onMove(m); }}
              className="px-2 py-0.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-2xs font-bold cursor-pointer disabled:opacity-40">
              {title}
            </button>
          ))}
          <button type="button" onClick={() => setAsk(null)}
            className="px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-150 text-2xs font-bold cursor-pointer">
            Отмена
          </button>
        </div>
      )}
    </div>
  );
}
