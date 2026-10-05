import React from 'react';
import { ArrowDownToLine, ArrowLeftRight, Check, ChevronRight, Hand, RotateCcw, Shield } from 'lucide-react';
import type { BoardProps } from './boards';
import type { DurakView } from '../../../play/games/durak';

type DurakCardAction = { type: 'attack'; card: number } | { type: 'transfer'; card: number };
type DurakDefendAction = { type: 'defend'; card: number; target: number };
const SUITS = ['♣', '♦', '♥', '♠'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const durakCardLabel = (card: number) => `${RANKS[card % 13] || '?'}${SUITS[Math.floor(card / 13)] || '?'}`;
export const durakCardIsRed = (card: number) => Math.floor(card / 13) === 1 || Math.floor(card / 13) === 2;
export function durakActionsForCard(view: Pick<DurakView, 'allowed'>, card: number): Array<DurakCardAction | DurakDefendAction> {
  const allowed = view.allowed;
  return [
    ...(allowed.attack.includes(card) ? [{ type: 'attack' as const, card }] : []),
    ...(allowed.transfer.includes(card) ? [{ type: 'transfer' as const, card }] : []),
    ...allowed.defend.filter((move) => move.card === card).map(move => ({ ...move, type: 'defend' as const })),
  ];
}
/** Only the public card counts cross this helper; no opponent hand identities are read or returned. */
export function durakOpponentCounts(view: Pick<DurakView, 'seat' | 'handCounts'>): Array<{ seat: number; count: number }> {
  return view.handCounts.flatMap((count, seat) => seat !== view.seat ? [{ seat, count: Math.max(0, Number(count) || 0) }] : []);
}

function PlayingCard({ card, selected, onClick, disabled, label }: { card: number; selected?: boolean; onClick?: () => void; disabled?: boolean; label?: string }) {
  const Tag = onClick ? 'button' : 'div';
  return <Tag {...(onClick ? { type: 'button' as const, onClick, disabled, 'aria-pressed': !!selected } : {})}
    aria-label={label || durakCardLabel(card)}
    className={`relative grid h-[5.8rem] w-[4.05rem] shrink-0 select-none place-items-center rounded-xl border bg-white text-xl font-semibold shadow-md transition ${durakCardIsRed(card) ? 'text-amber-800' : 'text-slate-900'} ${selected ? '-translate-y-2 border-amber-400 ring-2 ring-amber-300' : 'border-slate-300'} ${onClick ? 'cursor-pointer hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-default disabled:opacity-55 disabled:hover:translate-y-0' : ''}`}>
    <span className="absolute left-1.5 top-1 text-xs leading-none">{durakCardLabel(card)}</span>
    <span aria-hidden="true" className="text-3xl">{SUITS[Math.floor(card / 13)] || '?'}</span>
  </Tag>;
}

function CardBack({ name, count, active, finished }: { name: string; count: number; active: boolean; finished: boolean }) {
  return <div className="flex min-w-0 max-w-44 flex-col items-center gap-1.5" aria-label={`${name}: ${count} карт`}>
    <span title={name} className={`max-w-full truncate rounded-full px-2.5 py-1 text-xs font-semibold ${active ? 'bg-amber-300 text-amber-950' : 'bg-white/15 text-white/80'}`}>{name}{finished ? ' · вышел' : ''}</span>
    <div className="flex items-center" aria-hidden="true">{Array.from({ length: Math.min(count, 8) }, (_, i) => <span key={i} className="-ml-5 first:ml-0 grid h-12 w-8 place-items-center rounded-md border border-sky-200 bg-gradient-to-br from-sky-800 to-slate-900 text-sky-100 shadow-sm">✦</span>)}</div>
    <span className="text-xs text-white/65">{count} {count === 1 ? 'карта' : count >= 2 && count <= 4 ? 'карты' : 'карт'}</span>
  </div>;
}

function actionText(action: DurakCardAction | DurakDefendAction, view: DurakView) {
  if (action.type === 'defend') return `Побить ${durakCardLabel(view.table[action.target]?.attack ?? -1)} картой ${durakCardLabel(action.card)}`;
  return action.type === 'transfer' ? `Перевести ${durakCardLabel(action.card)}` : `Подкинуть ${durakCardLabel(action.card)}`;
}

export default function DurakBoard({ view, yourTurn, busy, onMove, names = {} }: BoardProps) {
  const state = view as DurakView;
  const playerName = (seat: number) => names[state.seats[seat]] || `Игрок ${seat + 1}`;
  const lastAction = state.lastAction?.replace(/(?:Игрок|игроку|игрок) (\d+)/g, (text, seat) => names[state.seats[Number(seat) - 1]] || text);
  const [selected, setSelected] = React.useState<number | null>(null);
  const [target, setTarget] = React.useState<number | null>(null);
  const canConfigure = state.canConfigure && !busy;
  const allowed = state.allowed || { attack: [], defend: [], transfer: [], take: false, pass: false };
  const isCardAllowed = (card: number) => allowed.attack.includes(card) || allowed.transfer.includes(card) || allowed.defend.some((move) => move.card === card);
  React.useEffect(() => { setSelected(null); setTarget(null); }, [state.hand?.join(','), state.table?.map((pair) => `${pair.attack}:${pair.defense}`).join(',')]);
  const act = (move: unknown) => { setSelected(null); setTarget(null); void onMove(move); };
  const selectedActions = selected === null ? [] : durakActionsForCard(state, selected);
  const selectedDefenses = selectedActions.filter((move): move is DurakDefendAction => move.type === 'defend');
  const selectedAttack = selectedActions.some((move) => move.type === 'attack');
  const selectedTransfer = selectedActions.some((move) => move.type === 'transfer');
  const chosenDefense = selectedDefenses.find((move) => move.target === target) || (selectedDefenses.length === 1 ? selectedDefenses[0] : undefined);
  const currentSeat = (seat: number) => seat === state.attacker ? 'атакует' : seat === state.defender ? 'защищается' : '';
  const watcher = state.seat < 0;
  const canChoose = state.phase === 'playing' && !busy && (yourTurn || allowed.attack.length > 0 || allowed.defend.length > 0 || allowed.transfer.length > 0 || allowed.take || allowed.pass);
  const opponentCounts = durakOpponentCounts(state);

  return <section aria-label="Дурак" className="mx-auto flex w-full max-w-5xl flex-col gap-3 text-slate-900 dark:text-slate-100">
    {canConfigure && <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div><p className="font-semibold">Правила раздачи</p><p className="text-xs text-slate-500 dark:text-slate-400">Настройка доступна ведущему до первого хода.</p></div>
      <div className="flex flex-wrap gap-2">

        <label className="flex items-center gap-2 text-sm">Вариант<select aria-label="Вариант Дурака" value={state.variant} onChange={(event) => act({ type: 'configure', variant: event.target.value, deckSize: state.deckSize })} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 dark:border-dark-border dark:bg-dark-bg"><option value="throw-in">Подкидной</option><option value="transfer">Переводной</option></select></label>
      </div>
    </div>}

    <div className="relative overflow-hidden rounded-[1.75rem] border border-emerald-950/30 bg-[radial-gradient(ellipse_at_center,_#27774f,_#145338_72%,_#103f31)] p-3 shadow-md sm:p-5">
      <div className="pointer-events-none absolute inset-2 rounded-[1.3rem] border border-white/10" />
      <div className="relative flex flex-wrap items-center justify-between gap-2 rounded-xl bg-black/15 px-3 py-2 text-xs text-white/85">
        <span className="font-semibold text-white">{state.variant === 'transfer' ? 'Переводной' : 'Подкидной'} Дурак · {state.deckSize} карт</span>
        <span className="max-w-full break-words">Раунд {state.round} · {state.phase === 'done' ? (state.loser === null ? 'Победителей нет' : `Дурак: ${playerName(state.loser)}`) : currentSeat(state.attacker) || 'Игра идёт'}</span>
        <span className="max-w-full break-words">{lastAction || 'Карты розданы'}</span>
      </div>

      <div className="relative mt-4 flex flex-wrap justify-center gap-x-5 gap-y-3" aria-label="Карты соперников">
        {opponentCounts.map(({ seat, count }) => <CardBack key={seat} name={playerName(seat)} count={count} active={seat === state.attacker || seat === state.defender} finished={state.finished.includes(seat) || state.quitters.includes(seat)} />)}
        {watcher && <p className="basis-full text-center text-xs text-white/70">Вы наблюдаете за партией. Карты игроков скрыты.</p>}
      </div>

      <div className="relative my-4 flex min-h-40 flex-wrap items-center justify-center gap-3 rounded-2xl border border-dashed border-white/20 bg-black/10 px-3 py-4" aria-label="Стол, пары атаки и защиты">
        {state.table.length === 0 ? <span className="text-sm text-white/55">Стол свободен</span> : state.table.map((pair, index) => <div key={`${pair.attack}:${index}`} className={`flex items-center gap-1 rounded-xl p-1 ${target === index ? 'ring-2 ring-amber-300' : ''}`}>
          <button type="button" aria-label={`Атакующая карта ${durakCardLabel(pair.attack)}${pair.defense === null ? ', не побита' : ''}`} aria-pressed={target === index} onClick={() => setTarget(index)} className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"><PlayingCard card={pair.attack} /></button>
          {pair.defense === null ? <div className="grid h-20 w-14 place-items-center rounded-lg border border-dashed border-white/35 text-white/50"><ChevronRight size={20} /></div> : <div className="-ml-8 -mt-5 rotate-6"><PlayingCard card={pair.defense} /></div>}
        </div>)}
      </div>

      <div className="relative flex flex-wrap items-center justify-center gap-4 text-white">
        <div className="flex flex-col items-center gap-1"><div className="relative grid h-16 w-12 place-items-center rounded-lg border-2 border-white/70 bg-gradient-to-br from-sky-800 to-slate-900 shadow-md" aria-label={`Колода: ${state.deckCount} карт`}><span className="text-xl text-sky-100">✦</span><span className="absolute -right-2 -top-2 rounded-full bg-white px-1.5 text-xs font-semibold text-slate-900">{state.deckCount}</span></div><span className="text-xs text-white/70">Колода</span></div>
        <div className="flex flex-col items-center gap-1"><PlayingCard card={state.trumpCard} label={`Козырь: ${durakCardLabel(state.trumpCard)}`} /><span className="text-xs text-white/70">Козырь</span></div>
        <div className="min-w-0 max-w-44 rounded-xl bg-black/15 px-3 py-2 text-center text-xs"><div>Атакующий</div><b className="block truncate" title={playerName(state.attacker)}>{playerName(state.attacker)}</b><div className="mt-1">Защищается</div><b className="block truncate" title={playerName(state.defender)}>{playerName(state.defender)}</b></div>
      </div>
    </div>

    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold">{watcher ? 'Рука скрыта для наблюдателя' : `Ваши карты · ${state.hand.length}`}</h2><p className="text-xs text-slate-500 dark:text-slate-400">{watcher ? 'Наблюдатели видят только число карт у каждого игрока.' : 'Выберите карту, затем выберите разрешённое действие.'}</p></div>{!watcher && <span className="text-xs text-slate-500 dark:text-slate-400">{state.seat === state.attacker ? 'Вы атакующий' : state.seat === state.defender ? 'Вы защищаетесь' : ''}</span>}</div>
      {!watcher && <div role="group" aria-label="Ваши карты" className="flex min-h-[7.2rem] flex-wrap justify-center gap-1.5 overflow-x-auto py-2">
        {state.hand.map((card, index) => <PlayingCard key={`${card}:${index}`} card={card} label={`Ваша карта ${durakCardLabel(card)}`} selected={selected === card} disabled={!canChoose || !isCardAllowed(card)} onClick={() => setSelected((old) => old === card ? null : card)} />)}
      </div>}
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        {selectedAttack && <button type="button" disabled={busy} onClick={() => act({ type: 'attack', card: selected! })} className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-amber-950 shadow hover:bg-amber-400 disabled:opacity-50"><ArrowDownToLine size={16} />Атаковать {durakCardLabel(selected!)}</button>}
        {selectedTransfer && <button type="button" disabled={busy} onClick={() => act({ type: 'transfer', card: selected! })} className="inline-flex items-center gap-2 rounded-xl bg-sky-700 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-sky-600 disabled:opacity-50"><ArrowLeftRight size={16} />Перевести {durakCardLabel(selected!)}</button>}
        {selectedDefenses.length > 0 && <div className="flex flex-wrap items-center justify-center gap-2">
          {selectedDefenses.length > 1 && <label className="flex items-center gap-2 text-sm">Побить<select aria-label="Цель защиты" value={target ?? ''} onChange={(event) => setTarget(Number(event.target.value))} className="rounded-lg border border-slate-300 bg-white px-2 py-2 dark:border-slate-600 dark:bg-slate-800"><option value="" disabled>Выберите карту</option>{selectedDefenses.map((move) => <option key={move.target} value={move.target}>{durakCardLabel(state.table[move.target]?.attack ?? -1)}</option>)}</select></label>}
          {chosenDefense && <button type="button" disabled={busy} onClick={() => act(chosenDefense)} className="inline-flex items-center gap-2 rounded-xl bg-sky-700 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-sky-600 disabled:opacity-50"><Shield size={16} />{actionText(chosenDefense, state)}</button>}
        </div>}
        {allowed.take && <button type="button" disabled={busy} onClick={() => act({ type: 'take' })} className="inline-flex items-center gap-2 rounded-xl bg-amber-700 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-amber-600 disabled:opacity-50"><Hand size={16} />Взять карты</button>}
        {allowed.pass && <button type="button" disabled={busy} onClick={() => act({ type: 'pass' })} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800 disabled:opacity-50"><Check size={16} />{state.taking ? 'Не подкидывать · закончить кон' : 'Бито · закончить ход'}</button>}
        {selected !== null && !isCardAllowed(selected) && <span className="self-center text-xs text-slate-500">Эту карту сейчас нельзя разыграть.</span>}
        {state.phase === 'playing' && !watcher && !canChoose && <span className="self-center text-xs text-slate-500">Ожидайте хода. Доступные действия появятся по правилам стола.</span>}
        {state.phase === 'done' && <span className="inline-flex items-center gap-2 rounded-xl bg-emerald-100 px-4 py-2 text-sm font-semibold text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200"><RotateCcw size={16} />Партия завершена</span>}
      </div>
    </div>
  </section>;
}
