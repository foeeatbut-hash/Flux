/**
 * «Кто сейчас в программе» — раздельчик в Сотрудниках.
 *
 * Раздел видит только администратор, и вопросов у него ровно два: кто здесь
 * прямо сейчас (можно ли писать и ждать ответа) и кто когда заходил в
 * последний раз (работает человек или учётку завели и забыли).
 *
 * Это разные вопросы, и отвечают на них разные данные. «В сети» приходит от
 * присутствия — оно живое и помнит неделю. «Заходил последний раз» — отметка
 * входа в профиле: она не стирается, и только по ней видно, что человек не
 * появлялся с весны.
 *
 * Скрывших присутствие тут нет вовсе, и это не пропуск: сервер не отдаёт ни их
 * присутствие, ни время их входа. Иначе переключатель «быть в сети» скрывал бы
 * человека везде, кроме того единственного места, где его специально ищут.
 */
import React from 'react';
import { Radio, Clock } from 'lucide-react';
import { usePresenceStore, presenceLabel } from '../../store/presenceStore';
import { lastLoginLabel } from '../../lib/presenceTime';

export interface PresencePerson {
  id: string;
  name: string;
  symbol?: string;
  isActive?: boolean;
  lastLoginAt?: string | null;
}

/** Столбец списка: заголовок, счётчик и строки */
function Column({ icon: Icon, tone, title, count, empty, children }: {
  icon: any; tone: string; title: string; count: number; empty: string; children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className={`w-3.5 h-3.5 shrink-0 ${tone}`} />
        <span className="text-2xs font-bold text-slate-400">{title}</span>
        <span className="text-2xs font-semibold text-slate-400">· {count}</span>
      </div>
      {count === 0
        ? <div className="text-xs text-slate-400 dark:text-slate-500 py-1">{empty}</div>
        : <ul className="space-y-1">{children}</ul>}
    </div>
  );
}

export default function PresencePanel({ people }: { people: PresencePerson[] }) {
  const onlineIds = usePresenceStore((s) => s.online);
  const seenAt = usePresenceStore((s) => s.seenAt);
  const now = Date.now();

  const online = people.filter((p) => onlineIds.includes(p.id));

  // Остальные — по времени последнего входа, свежие сверху. Не заходившие ни
  // разу уходят вниз: это отдельный случай, и он не должен вытеснять живых
  const away = people
    .filter((p) => !onlineIds.includes(p.id))
    .map((p) => ({ p, t: p.lastLoginAt ? Date.parse(String(p.lastLoginAt)) : 0 }))
    .sort((a, b) => (Number.isFinite(b.t) ? b.t : 0) - (Number.isFinite(a.t) ? a.t : 0))
    .slice(0, 8);

  return (
    <div className="grid grid-cols-1 @[720px]:grid-cols-2 gap-x-6 gap-y-3 px-3 py-2.5
                    border-x border-b border-slate-200 dark:border-dark-border
                    bg-white dark:bg-dark-surface">
      <Column icon={Radio} tone="text-emerald-500" title="Сейчас в программе" count={online.length}
        empty="Никого нет — все вышли или программа у них закрыта.">
        {online.map((p) => (
          <li key={p.id} className="flex items-center gap-2 min-w-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden />
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{p.name}</span>
            <span className="text-2xs text-slate-400 shrink-0">{presenceLabel(true, null, now)}</span>
          </li>
        ))}
      </Column>

      <Column icon={Clock} tone="text-slate-400" title="Заходили последними" count={away.length}
        empty="Все сотрудники сейчас в программе.">
        {away.map(({ p }) => (
          <li key={p.id} className="flex items-center gap-2 min-w-0">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-700 shrink-0" aria-hidden />
            <span className={`text-xs font-semibold truncate ${
              p.isActive === false ? 'text-slate-400 line-through' : 'text-slate-700 dark:text-slate-300'
            }`}>{p.name}</span>
            {/* Живое «был(а) 12 мин. назад» точнее отметки входа, пока
                присутствие о человеке помнит; дальше остаётся вход */}
            <span className="text-2xs text-slate-400 shrink-0 ml-auto">
              {seenAt(p.id) ? presenceLabel(false, seenAt(p.id), now) : lastLoginLabel(p.lastLoginAt, now)}
            </span>
          </li>
        ))}
      </Column>
    </div>
  );
}
