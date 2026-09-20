/**
 * «Главная» платформы: с чего человек начинает.
 *
 * Пока группы, приглашения и матчи не заведены (они приходят следующими
 * этапами), вкладка показывает ровно то, что уже правда: какие игры человеку
 * открыты и что он может сделать прямо сейчас. Обещаний того, чего ещё нет,
 * здесь нет — пустой экран с надписью «скоро» хуже отсутствующего раздела.
 */
import React from 'react';
import { Gamepad2, Users } from 'lucide-react';
import type { PlayGameDef } from '../../play/features';
import { Empty } from './states';

export default function HomeTab({ games, onOpenLibrary }: {
  games: PlayGameDef[];
  onOpenLibrary: () => void;
}) {
  if (!games.length) {
    return (
      <Empty
        icon={<Gamepad2 className="w-5 h-5" />}
        title="Игр пока не выдано"
        hint="Доступ к каждой игре выдаётся отдельно. За ним — к администратору: он отмечает игры в карточке сотрудника."
      />
    );
  }

  return (
    <div className="p-3 space-y-3">
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Открыто вам</h2>
        <p className="mt-0.5 text-2xs text-slate-400 dark:text-slate-500 leading-snug">
          {games.length === 1 ? 'Одна игра' : `Игр: ${games.length}`}. Полный список — на вкладке «Библиотека».
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {games.map((g) => (
            <span
              key={g.id}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-2xs font-bold
                         bg-slate-100 dark:bg-slate-850 text-slate-700 dark:text-slate-150"
            >
              <Gamepad2 className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
              {g.title}
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={onOpenLibrary}
          className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-2xs font-bold
                     bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer transition-colors"
        >
          Открыть библиотеку
        </button>
      </section>

      <Empty
        icon={<Users className="w-5 h-5" />}
        title="Группы нет"
        hint="Группа собирается из сотрудников и живёт до конца матча. Приглашения, лобби и матчи включаются следующим обновлением платформы."
      />
    </div>
  );
}
