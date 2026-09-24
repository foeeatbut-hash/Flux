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

/**
 * Полоса над таблицей, а не два столбца: раньше блок «кто в сети / кто
 * заходил» стоял между счётчиками и поиском и сдвигал список на треть окна.
 * Первый вопрос — «кто здесь сейчас» — виден строкой сразу; второй — «кто
 * когда заходил» — раскрывается списком по нажатию.
 */
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
    <div className="fx-tools text-xs">
      <Radio className="w-3.5 h-3.5 shrink-0 text-emerald-500" aria-hidden />
      <span className="text-slate-500 dark:text-slate-400 shrink-0">Сейчас в программе · {online.length}</span>
      <span className="min-w-0 flex-1 truncate text-slate-800 dark:text-slate-100" title={online.map((p) => p.name).join(', ')}>
        {online.length ? online.map((p) => p.name).join(', ') : 'никого нет'}
      </span>
      <details className="relative shrink-0">
        <summary className="fx-btn fx-btn-quiet fx-btn-sm list-none cursor-pointer"><Clock />Заходили последними</summary>
        <ul className="fx-pop absolute right-0 top-full mt-1 z-20 w-80 py-1">
          {away.length === 0 && <li className="px-3 py-1.5 text-slate-400">Все сотрудники сейчас в программе.</li>}
          {away.map(({ p }) => (
            <li key={p.id} className="flex items-center gap-2 px-3 h-8 min-w-0">
              <span className={`truncate ${p.isActive === false ? 'text-slate-400 line-through' : 'text-slate-700 dark:text-slate-300'}`}>{p.name}</span>
              {/* Живое «был(а) 12 мин. назад» точнее отметки входа, пока
                  присутствие о человеке помнит; дальше остаётся вход */}
              <span className="text-slate-400 shrink-0 ml-auto">
                {seenAt(p.id) ? presenceLabel(false, seenAt(p.id), now) : lastLoginLabel(p.lastLoginAt, now)}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
