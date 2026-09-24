import React, { useEffect } from 'react';
import { X, ArrowLeft, Link2, ShieldCheck, History } from 'lucide-react';
import { useInsightStore, type InsightMode } from '../../store/insightStore';
import WhereUsedView from './WhereUsedView';
import ProjectCheckView from './ProjectCheckView';
import ChangeListView from './ChangeListView';

/**
 * Выдвижная панель связей: одно окно на три вопроса о проекте.
 *
 * Почему поверх, а не отдельным разделом. Панель отвечает про то, что человек
 * сейчас видит: он стоит в реестре и спрашивает «где этот тег ещё есть». Уход в
 * отдельный раздел терял бы это место, и возвращаться пришлось бы руками.
 *
 * Ширина 660 px — столько нужно паре «было → стало» в листе изменений, чтобы
 * значения не переносились. На узком окне панель занимает всё и ведёт себя как
 * обычное окно.
 */

const HEAD: Record<InsightMode, { icon: React.ComponentType<{ className?: string }>; title: string; hint: string }> = {
  where: { icon: Link2, title: 'Карточка связей', hint: 'Вся вещь целиком: где встречается и с чем связана' },
  check: { icon: ShieldCheck, title: 'Проверка проекта', hint: 'Что стоит поправить до выпуска' },
  changes: { icon: History, title: 'Что изменилось', hint: 'Характеристики оборудования: было и стало' },
};

export default function InsightDrawer() {
  const { mode, target, back, close, goBack, openCheck, openChanges } = useInsightStore();

  // Esc закрывает панель, но только верхний слой: если поверх открыт общий
  // поиск, он закрывается первым — он и обрабатывает клавишу у себя
  useEffect(() => {
    if (!mode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !useInsightStore.getState().paletteOpen) {
        e.stopPropagation();
        back ? goBack() : close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, back]);

  if (!mode) return null;
  const { icon: Icon, title, hint } = HEAD[mode];

  return (
    <div className="fixed inset-0 z-[70] flex justify-end">
      {/* Затемнение: показывает, что программа ждёт ответа именно здесь */}
      <button
        type="button"
        aria-label="Закрыть панель"
        onClick={close}
        className="absolute inset-0 bg-slate-950/25 dark:bg-slate-950/50 cursor-default"
      />

      <aside className="relative h-full w-full max-w-[660px] bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col animate-[insight-in_180ms_ease-out]">
        <header className="shrink-0 flex items-center gap-2.5 px-3 py-3 border-b border-slate-200 dark:border-slate-800">
          {back && (
            <button type="button" onClick={goBack} title="Назад"
              className="fx-ibtn">
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <Icon className="w-4 h-4 text-slate-400 shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white truncate">
              {mode === 'where' ? 'Карточка связей' : title}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{hint}</p>
          </div>
          <button type="button" onClick={close} title="Закрыть (Esc)"
            className="fx-ibtn">
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Переход между режимами: вопросы соседние, и ходят между ними часто */}
        <nav className="fx-tabs shrink-0 h-10 px-2 border-b border-slate-200 dark:border-slate-800" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'check'} onClick={openCheck} className="fx-tab">
            Проверка проекта
          </button>
          <button type="button" role="tab" aria-selected={mode === 'changes'} onClick={openChanges} className="fx-tab">
            Что изменилось
          </button>
          {mode === 'where' && (
            <span role="tab" aria-selected="true" className="fx-tab">Связи объекта</span>
          )}
        </nav>

        <div className="flex-1 overflow-y-auto">
          {mode === 'where' && target && <WhereUsedView kind={target.kind} id={target.id} />}
          {mode === 'check' && <ProjectCheckView />}
          {mode === 'changes' && <ChangeListView />}
        </div>
      </aside>
    </div>
  );
}
