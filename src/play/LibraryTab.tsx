/**
 * «Библиотека»: игры, открытые этому сотруднику.
 *
 * Список приходит не с сервера, а из политики доступа: игра, право на которую
 * не выдано, не попадает сюда в принципе — ни строкой, ни серой карточкой «нет
 * доступа». Серая карточка и есть утечка: по ней видно, что игра существует.
 *
 * Главное действие у карточки одно — кнопка с состояниями (ТЗ §13.2). Пока
 * локального менеджера игр нет, она честно говорит, чего не хватает, а не
 * притворяется, что установит.
 */
import React from 'react';
import { Gamepad2, Users } from 'lucide-react';
import type { PlayGameDef } from '../../play/features';
import { Empty } from './states';

function GameCard({ game }: { game: PlayGameDef }) {
  const seats = game.teams * game.teamSize;
  return (
    <article className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
      <div className="flex items-start gap-2.5">
        <div className="w-10 h-10 shrink-0 rounded-xl bg-slate-100 dark:bg-slate-850 flex items-center justify-center">
          <Gamepad2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold text-slate-800 dark:text-white truncate">{game.title}</h3>
          <p className="mt-0.5 text-2xs text-slate-500 dark:text-slate-400 leading-relaxed">{game.desc}</p>
          <p className="mt-1.5 inline-flex items-center gap-1 text-2xs font-semibold text-slate-400 dark:text-slate-500">
            <Users className="w-3 h-3" />
            {game.teams} × {game.teamSize} — {seats} мест
          </p>
        </div>
      </div>
      <p className="mt-2.5 text-2xs text-slate-400 dark:text-slate-500 leading-relaxed">
        {game.installable
          ? 'Сборка ещё не опубликована — установить нечего. Как только администратор выложит её в канал, здесь появится «Установить».'
          : 'Служебная игра платформы: идёт вместе с программой, устанавливать нечего.'}
      </p>
    </article>
  );
}

export default function LibraryTab({ games }: { games: PlayGameDef[] }) {
  if (!games.length) {
    return (
      <Empty
        icon={<Gamepad2 className="w-5 h-5" />}
        title="Библиотека пуста"
        hint="Игры выдаются по одной. Пока ни одна не выдана, показывать здесь нечего."
      />
    );
  }
  return (
    <div className="p-3 grid gap-2.5 @[720px]:grid-cols-2 @[1100px]:grid-cols-3">
      {games.map((g) => <GameCard key={g.id} game={g} />)}
    </div>
  );
}
