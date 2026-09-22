/**
 * Панель группы: кто с вами и что сейчас происходит.
 *
 * Живёт ВНУТРИ окна раздела, прижатая к его низу, и это не мелочь оформления.
 * Всё, что платформа показывает поверх оболочки, закрывает панель задач и
 * часы — то есть отнимает у человека выход из программы ровно тогда, когда он
 * в игре и особенно не хочет в ней застрять. Ту же ошибку уже разбирали с
 * панелью проекта и правой колонкой; повторять её не будем.
 *
 * Панель показывает подтверждённое состояние. Ожидание показывается
 * ожиданием: «Отправляем…» — и только ответ сервера превращает его в
 * «Приглашение отправлено».
 */
import React from 'react';
import { Crown, LogOut, UserMinus, UserPlus, Users } from 'lucide-react';
import { PLAY_ACTIVITY_TEXT, PLAY_STATUS_TEXT, type PlayActivity, type PlayStatus } from '../../play/contracts';

export interface Person {
  userId: string;
  name: string;
  role: string;
}

/** Точка присутствия: цвет говорит то же, что подпись, — для тех, кто спешит. */
function Dot({ status }: { status: PlayStatus }) {
  const tone = status === 'ONLINE'
    ? 'bg-emerald-500'
    : status === 'AWAY'
      ? 'bg-amber-500'
      : 'bg-slate-300 dark:bg-slate-700';
  return <span className={`w-2 h-2 rounded-full shrink-0 ${tone}`} aria-hidden="true" />;
}

export default function PartyBar({
  members, leaderId, meId, presence, busy, onInvite, onKick, onLeave,
}: {
  members: Person[];
  leaderId: string;
  meId: string;
  presence: Record<string, { status: PlayStatus; activity: PlayActivity }>;
  busy: boolean;
  onInvite: () => void;
  onKick: (userId: string) => void;
  onLeave: () => void;
}) {
  const iLead = leaderId === meId;

  return (
    <section
      /* Внутри тела окна: глобальные слои не трогаем, панель задач остаётся
         видимой в любом состоянии матча */
      className="shrink-0 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
      aria-label="Группа"
    >
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        <Users className="w-4 h-4 shrink-0 text-slate-400 dark:text-slate-500" />
        <span className="text-2xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 shrink-0">
          Группа
        </span>

        <div className="flex items-center gap-1.5 flex-wrap min-w-0 flex-1">
          {members.map((m) => {
            const p = presence[m.userId];
            return (
              <span
                key={m.userId}
                title={p ? `${PLAY_STATUS_TEXT[p.status]}, ${PLAY_ACTIVITY_TEXT[p.activity]}` : 'не в сети'}
                className="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-lg
                           bg-slate-100 dark:bg-slate-850 text-slate-700 dark:text-slate-150 max-w-[14rem]"
              >
                <Dot status={p?.status || 'OFFLINE'} />
                {m.userId === leaderId && (
                  <Crown className="w-3 h-3 shrink-0 text-amber-500" aria-label="ведущий" />
                )}
                <span className="text-2xs font-semibold truncate">{m.name}</span>
                {iLead && m.userId !== meId && (
                  <button
                    type="button"
                    onClick={() => onKick(m.userId)}
                    disabled={busy}
                    title={`Убрать из группы: ${m.name}`}
                    className="shrink-0 p-0.5 rounded text-slate-400 hover:text-rose-600 dark:hover:text-rose-400
                               disabled:opacity-40 cursor-pointer transition-colors"
                  >
                    <UserMinus className="w-3 h-3" />
                  </button>
                )}
              </span>
            );
          })}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {iLead && (
            <button
              type="button"
              onClick={onInvite}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-2xs font-bold
                         bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50
                         cursor-pointer transition-colors"
            >
              <UserPlus className="w-3 h-3" />
              Позвать
            </button>
          )}
          <button
            type="button"
            onClick={onLeave}
            disabled={busy}
            title="Выйти из группы"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-2xs font-bold
                       bg-slate-100 dark:bg-slate-850 text-slate-600 dark:text-slate-300
                       hover:bg-slate-200 dark:hover:bg-slate-800 disabled:opacity-50
                       cursor-pointer transition-colors"
          >
            <LogOut className="w-3 h-3" />
            Выйти
          </button>
        </div>
      </div>
    </section>
  );
}
