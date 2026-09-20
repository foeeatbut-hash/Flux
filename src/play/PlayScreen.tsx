/**
 * Flux Play — рама раздела.
 *
 * Рама отделена от содержимого вкладок сознательно: вкладок будет четыре, у
 * каждой свои запросы и своё состояние, и один файл на всё это вырос бы до
 * размеров, при которых правку делают вслепую.
 *
 * Две вещи, заданные здесь и не обсуждаемые дальше:
 *
 *   1. **Ничто из платформы не накрывает оболочку.** Панель группы, меню и
 *      подсказки живут внутри тела окна: панель задач и часы должны остаться
 *      видимыми в любом состоянии матча. Это то же правило, по которому
 *      переделывали панель проекта и правую колонку.
 *   2. **Узкое окно ничего не теряет.** Ниже 720 точек вкладки схлопываются
 *      в один выбор, но ни одно действие не пропадает: окно программы
 *      сжимается до 420×260, и раздел обязан это пережить, а не «поддерживать
 *      разрешение от 900×600» на словах.
 */
import React from 'react';
import { Gamepad2, Home, Library } from 'lucide-react';
import { useAppContext } from '../store/policyStore';
import { visibleGames } from '../lib/appPolicy';
import HomeTab from './HomeTab';
import LibraryTab from './LibraryTab';

type TabId = 'home' | 'library';

interface TabDef {
  id: TabId;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
}

const TABS: TabDef[] = [
  { id: 'home', title: 'Главная', icon: Home },
  { id: 'library', title: 'Библиотека', icon: Library },
];

export default function PlayScreen() {
  const ctx = useAppContext();
  const [tab, setTab] = React.useState<TabId>('home');
  const games = React.useMemo(() => visibleGames(ctx), [ctx]);

  return (
    <div className="h-full flex flex-col bg-slate-50 dark:bg-slate-950 select-none">
      <header className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <Gamepad2 className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="shrink-0 text-sm font-bold text-slate-800 dark:text-white">Flux Play</span>

        {/* Широкое окно: вкладки полосой */}
        <nav className="hidden @[720px]:flex items-center gap-1 ml-3" aria-label="Разделы платформы">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold cursor-pointer transition-colors ${
                tab === t.id
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850'
              }`}
            >
              <t.icon className="w-3.5 h-3.5" />
              {t.title}
            </button>
          ))}
        </nav>

        {/* Узкое окно: тот же выбор одной строкой — ни одна вкладка не пропала */}
        <label className="@[720px]:hidden ml-auto flex items-center gap-1.5">
          <span className="sr-only">Раздел платформы</span>
          <select
            value={tab}
            onChange={(e) => setTab(e.target.value as TabId)}
            className="px-2 py-1 rounded-lg text-xs font-bold cursor-pointer
                       bg-slate-100 dark:bg-slate-850 text-slate-700 dark:text-slate-150
                       border border-slate-200 dark:border-slate-800"
          >
            {TABS.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </label>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {tab === 'home' && <HomeTab games={games} onOpenLibrary={() => setTab('library')} />}
        {tab === 'library' && <LibraryTab games={games} />}
      </div>
    </div>
  );
}
