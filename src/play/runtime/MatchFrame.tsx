import React from 'react';
import { Flag, Loader2, RefreshCw } from 'lucide-react';
import * as api from '../../services/playService';
import { newKey } from '../../services/playService';
import { boardFor } from './boards';

/**
 * Рама матча встроенной игры: одна на все доски.
 *
 * Доска ничего не знает про сеть — она получает состояние и зовёт `onMove`.
 * Всё сетевое живёт здесь, и это не ради красоты: доска, сама ходящая в
 * сервер, рано или поздно обзавелась бы собственным «а давайте посчитаем ход
 * на месте, чтобы не мигало», и правила разошлись бы с серверными.
 *
 * Показывается только подтверждённое. Ход уезжает на сервер, оттуда приходит
 * новая доска — и только тогда она меняется. Нарисовать ход «наперёд» здесь
 * соблазнительно и нельзя: соперник мог успеть раньше, и человек увидел бы
 * свою фишку там, где её нет.
 */

export interface MatchState {
  sessionId: string;
  gameId: string;
  revision: number;
  turnUserId: string;
  yourTurn: boolean;
  view: any;
  done: boolean;
  winnerTeam: number;
  why: string;
  seats: string[];
}

interface Props {
  sessionId: string;
  meId: string;
  /** Имена игроков: кто сейчас ходит, человек должен видеть по имени */
  names: Record<string, string>;
  onLeave: () => void;
}

export default function MatchFrame({ sessionId, meId, names, onLeave }: Props) {
  const [match, setMatch] = React.useState<MatchState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState('');

  const load = React.useCallback(async () => {
    const res = await api.fetchMatch(sessionId);
    if (res.ok) setMatch((res.result || null) as MatchState | null);
    setLoading(false);
  }, [sessionId]);

  React.useEffect(() => { void load(); }, [load]);

  /**
   * Пока идёт чужой ход, доска перечитывается сама.
   *
   * Событие по сокету говорит только «поменялось», и на нём одном строить
   * нельзя: окно, которое в нужную секунду было без связи, так и осталось бы
   * с прежней доской. Две секунды — не нагрузка: доска маленькая, а ждать
   * соперника всё равно приходится.
   */
  React.useEffect(() => {
    if (!match || match.done || match.yourTurn) return;
    const t = setInterval(() => { void load(); }, 2000);
    return () => clearInterval(t);
  }, [match?.revision, match?.done, match?.yourTurn, load]);

  const move = async (m: unknown) => {
    if (!match || busy) return;
    setBusy(true);
    setFailure('');
    const res = await api.makeMove(sessionId, m, match.revision, newKey());
    setBusy(false);
    // Отказ показывается словами самой игры: «сюда нельзя, ничего не
    // переворачивается» человек понимает, а «ошибка хода» — нет
    if (!res.ok) setFailure(String(res.message || 'Ход не принят'));
    await load();
  };

  const giveUp = async () => {
    if (!match || busy) return;
    setBusy(true);
    await api.resignMatch(sessionId, newKey());
    setBusy(false);
    await load();
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
        <Loader2 className="w-4 h-4 animate-spin" /> Открываем доску…
      </div>
    );
  }
  if (!match) {
    return (
      <div className="blank">
        <div className="blank-title">Доски нет</div>
        <div className="blank-text">Матч не найден или уже закончился.</div>
      </div>
    );
  }

  const Board = boardFor(match.gameId);
  const solo = match.seats.length < 2;
  const turnName = match.turnUserId === meId ? 'ваш ход' : `ходит ${names[match.turnUserId] || 'соперник'}`;
  const mySeat = match.seats.indexOf(meId) + 1;

  return (
    <div className="p-3 @[720px]:p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-bold text-slate-800 dark:text-white">
          {match.done ? 'Партия окончена' : solo ? 'Партия' : turnName}
        </span>
        {match.done && match.why && (
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-lg ${
            match.winnerTeam === 0
              ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
              : match.winnerTeam === mySeat
                ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'
          }`}>
            {match.why}
          </span>
        )}
        <span className="flex-1" />
        <button type="button" onClick={() => void load()}
          className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-600 cursor-pointer" title="Обновить доску">
          <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
        </button>
        {!match.done && (
          <button type="button" onClick={() => void giveUp()} disabled={busy}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300 hover:text-rose-600 disabled:opacity-40 cursor-pointer">
            <Flag className="w-3.5 h-3.5" />{solo ? 'Бросить' : 'Сдаться'}
          </button>
        )}
        {match.done && (
          <button type="button" onClick={onLeave}
            className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer">
            К подготовке
          </button>
        )}
      </div>

      {failure && (
        <div className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded-lg px-3 py-2">
          {failure}
        </div>
      )}

      <Board
        view={match.view}
        yourTurn={match.yourTurn && !match.done}
        busy={busy}
        onMove={move}
      />
    </div>
  );
}
