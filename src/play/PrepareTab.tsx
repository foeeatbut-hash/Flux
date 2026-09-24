/**
 * Экран подготовки: приглашения, лобби, готовность и главная кнопка.
 *
 * Группа и лобби показываются ОДНИМ экраном (ТЗ §13.1), а не двумя почти
 * одинаковыми, между которыми человека перебрасывает. Это не сокращение
 * работы: два экрана с одним и тем же составом — это одно состояние,
 * показанное дважды, и человек каждый раз заново ищет, где он сейчас.
 *
 * Приглашения стоят сверху и до всего остального: они со сроком, и
 * пропущенное приглашение — это несостоявшаяся игра. Результат прошлого матча
 * остаётся на экране до следующего: человек закрыл окно игры не потому, что
 * прочитал счёт.
 */
import React from 'react';
import { CheckCircle2, Clock, Mail, Swords, Trophy, Users, X } from 'lucide-react';
import { gameById } from '../../play/features';
import type { PlayActivity, PlayStatus } from '../../play/contracts';
import { Empty, Failure } from './states';
import type { ActionView } from './mainAction';

export interface Slot { userId: string; team: number; ready: boolean }

export default function PrepareTab({
  invites, names, lobby, party, meId, presence, action, actionBusy, actionFailure,
  result, onAction, onAccept, onDecline, onSeeLibrary,
}: {
  invites: any[];
  names: Record<string, string>;
  lobby: { id: string; gameId: string; state: string; slots: Slot[]; seats: number } | null;
  party: { id: string; leaderId: string; members: Array<{ userId: string }> } | null;
  meId: string;
  presence: Record<string, { status: PlayStatus; activity: PlayActivity }>;
  action: ActionView;
  actionBusy: boolean;
  actionFailure: string;
  result: Record<string, unknown> | null;
  onAction: () => void;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
  onSeeLibrary: () => void;
}) {
  const nameOf = (id: string) => names[id] || 'Сотрудник';
  const game = lobby ? gameById(lobby.gameId) : null;

  return (
    <div className="p-3 space-y-3">
      {/* Приглашения: со сроком, поэтому первыми */}
      {invites.map((inv) => (
        <section
          key={inv.id}
          className="rounded-xl border border-emerald-300 dark:border-emerald-800
                     bg-emerald-50/60 dark:bg-emerald-950/30 p-3"
        >
          <div className="flex items-start gap-2.5 flex-wrap">
            <Mail className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-slate-800 dark:text-white">
                {nameOf(inv.fromUserId)} зовёт в группу
              </p>
              <p className="mt-0.5 inline-flex items-center gap-1 text-2xs text-slate-500 dark:text-slate-400">
                <Clock className="w-3 h-3" />
                Приглашение живёт недолго — потом его придётся отправлять заново
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => onAccept(inv.id)}
                className="px-2.5 py-1 rounded-lg text-2xs font-bold bg-emerald-600 hover:bg-emerald-700
                           text-white cursor-pointer transition-colors"
              >
                Принять
              </button>
              <button
                type="button"
                onClick={() => onDecline(inv.id)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-2xs font-bold
                           bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300
                           border border-slate-200 dark:border-slate-800
                           hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer transition-colors"
              >
                <X className="w-3 h-3" />
                Отказаться
              </button>
            </div>
          </div>
        </section>
      ))}

      {/* Результат прошлого матча — до следующего */}
      {result && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
          <div className="flex items-center gap-2">
            <Trophy className="w-4 h-4 shrink-0 text-amber-500" />
            <h2 className="text-sm font-bold text-slate-800 dark:text-white">Матч закончен</h2>
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {Number(result.winnerTeam) > 0
              ? `Победила команда ${Number(result.winnerTeam)}`
              : 'Ничья'}
            {Number(result.durationSec) > 0 && ` · ${Math.round(Number(result.durationSec))} с`}
          </p>
          <p className="mt-1 text-2xs text-slate-400 dark:text-slate-500 leading-relaxed">
            Счёт пришёл от игрового сервера и подписан — игроки его не присылают.
          </p>
        </section>
      )}

      {/* Лобби: состав по командам и готовность */}
      {lobby ? (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <Swords className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <h2 className="text-sm font-bold text-slate-800 dark:text-white truncate">
                {game?.title || lobby.gameId}
              </h2>
            </div>
            <span className="text-2xs font-semibold text-slate-400 dark:text-slate-500 shrink-0">
              {lobby.slots.length} из {lobby.seats} мест
            </span>
          </div>

          <div className="mt-2.5 grid gap-2 @[560px]:grid-cols-2">
            {Array.from({ length: game?.teams || 2 }).map((_, i) => {
              const team = i + 1;
              const mates = lobby.slots.filter((s) => s.team === team);
              return (
                <div key={team} className="rounded-lg bg-slate-50 dark:bg-slate-950 p-2">
                  <h3 className="text-2xs font-bold text-slate-400 dark:text-slate-500">
                    Команда {team}
                  </h3>
                  <ul className="mt-1 space-y-1">
                    {!mates.length && (
                      <li className="text-2xs text-slate-400 dark:text-slate-500">пока никого</li>
                    )}
                    {mates.map((s) => (
                      <li key={s.userId} className="flex items-center gap-1.5">
                        {s.ready
                          ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                          : <Clock className="w-3.5 h-3.5 shrink-0 text-slate-300 dark:text-slate-600" />}
                        <span className={`text-2xs truncate ${
                          s.userId === meId
                            ? 'font-bold text-slate-800 dark:text-white'
                            : 'font-semibold text-slate-600 dark:text-slate-300'
                        }`}
                        >
                          {nameOf(s.userId)}
                        </span>
                        <span className="text-2xs text-slate-400 dark:text-slate-500 shrink-0">
                          {s.ready ? 'готов' : 'не готов'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      ) : (
        !party && !invites.length && (
          <Empty
            icon={<Users className="w-5 h-5" />}
            title="Группы нет"
            hint="Соберите группу из коллег или готовьтесь в одиночку — платформа не возражает."
            action={(
              <button
                type="button"
                onClick={onSeeLibrary}
                className="px-2.5 py-1 rounded-lg text-2xs font-bold bg-slate-100 dark:bg-slate-850
                           text-slate-700 dark:text-slate-150 hover:bg-slate-200 dark:hover:bg-slate-800
                           cursor-pointer transition-colors"
              >
                Посмотреть библиотеку
              </button>
            )}
          />
        )
      )}

      {/* Главное действие: одна кнопка, состояние выбрано за человека */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
        <button
          type="button"
          onClick={onAction}
          disabled={action.disabled || actionBusy}
          data-play-action={action.id}
          className={`w-full px-3 py-2 rounded-xl text-sm font-bold cursor-pointer transition-colors
                      disabled:cursor-default disabled:opacity-60 ${
            action.tone === 'primary'
              ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
              : action.tone === 'warn'
                ? 'bg-amber-500 hover:bg-amber-600 text-white'
                : 'bg-slate-100 dark:bg-slate-850 text-slate-700 dark:text-slate-150'
          }`}
        >
          {actionBusy ? 'Отправляем…' : action.label}
        </button>
        <p className="mt-1.5 text-2xs text-slate-400 dark:text-slate-500 leading-relaxed">{action.hint}</p>
      </section>

      {actionFailure && <Failure text={actionFailure} />}
    </div>
  );
}
