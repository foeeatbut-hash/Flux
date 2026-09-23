import React from 'react';
import type { BoardProps } from './boards';

const RANKS = '23456789TJQKA';
const SUITS = ['♣', '♦', '♥', '♠'];
const cardText = (card: number) => `${RANKS[card % 13]}${SUITS[Math.floor(card / 13)]}`;

export default function DrawPokerBoard({ view, yourTurn, busy, onMove }: BoardProps) {
  const hand: number[] = view?.hand || [];
  const opponent: number[] | null = view?.opponentHand || null;
  const [selected, setSelected] = React.useState<number[]>([]);
  const phase = String(view?.phase || 'opening');
  const canAct = yourTurn && !busy && phase !== 'done';
  const seat = Number(view?.seat || 1) - 1;
  const due = Math.max(0, Number(view?.currentBet || 0) - Number(view?.put?.[seat] || 0));
  const canRaise = Number(view?.currentBet || 0) + 10 <= Math.min(
    Number(view?.stacks?.[0] || 0) + Number(view?.put?.[0] || 0),
    Number(view?.stacks?.[1] || 0) + Number(view?.put?.[1] || 0),
  );

  const toggle = (index: number) => setSelected(current => current.includes(index)
    ? current.filter(i => i !== index) : current.length < 3 ? [...current, index] : current);
  const act = (action: string) => { setSelected([]); void onMove({ action }); };

  return (
    <div className="flex flex-col gap-3 items-start max-w-xl">
      <div className="text-xs text-slate-600 dark:text-slate-300">
        Одна раздача на двоих · фишки только игровые · банк: <b className="tabular-nums">{view?.pot || 0}</b>
      </div>
      <div className="text-xs text-slate-500 dark:text-slate-400">
        Ваши фишки: <b className="tabular-nums">{view?.stacks?.[seat] ?? 0}</b> ·
        у соперника: <b className="tabular-nums">{view?.stacks?.[1 - seat] ?? 0}</b>
      </div>
      <div className="flex gap-1.5" aria-label="Карты соперника">
        {(opponent || Array(5).fill(-1)).map((card, i) => (
          <span key={i} className="w-10 h-14 rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-sm font-bold text-slate-700 dark:text-slate-150">
            {card < 0 ? '◆' : cardText(card)}
          </span>
        ))}
      </div>
      <div className="text-2xs text-slate-500 dark:text-slate-400">{view?.lastAction || 'Раздача началась'}</div>
      <div className="flex gap-1.5" aria-label="Ваши карты">
        {hand.map((card, i) => (
          <button key={i} type="button" disabled={!canAct || phase !== 'draw'}
            onClick={() => toggle(i)} aria-label={`Карта ${i + 1}: ${cardText(card)}`}
            aria-pressed={selected.includes(i)}
            className={`w-10 h-14 rounded-lg border flex items-center justify-center text-sm font-bold
              ${Math.floor(card / 13) === 1 || Math.floor(card / 13) === 2 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100'}
              ${selected.includes(i) ? 'border-emerald-600 dark:border-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 -translate-y-1' : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900'}
              ${canAct && phase === 'draw' ? 'cursor-pointer hover:-translate-y-1' : 'cursor-default'}`}>
            {cardText(card)}
          </button>
        ))}
      </div>
      {phase === 'draw' ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-slate-600 dark:text-slate-300">Выберите до трёх карт для обмена. Можно оставить все.</span>
          <button type="button" disabled={!canAct} onClick={() => { void onMove({ action: 'draw', cards: selected }); setSelected([]); }}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold disabled:opacity-40 cursor-pointer">
            {selected.length ? `Обменять ${selected.length}` : 'Оставить карты'}
          </button>
        </div>
      ) : phase !== 'done' ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!canAct} onClick={() => act(due ? 'call' : 'check')}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold disabled:opacity-40 cursor-pointer">
            {due ? `Уравнять ${due}` : 'Чек'}
          </button>
          <button type="button" disabled={!canAct || !canRaise} onClick={() => act('raise')}
            className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-150 text-xs font-bold disabled:opacity-40 cursor-pointer">
            {view?.currentBet ? 'Повысить на 10' : 'Поставить 10'}
          </button>
          <button type="button" disabled={!canAct} onClick={() => act('fold')}
            className="px-3 py-1.5 rounded-lg border border-rose-300 dark:border-rose-700 text-rose-600 dark:text-rose-400 text-xs font-bold disabled:opacity-40 cursor-pointer">
            Сбросить карты
          </button>
        </div>
      ) : null}
    </div>
  );
}
