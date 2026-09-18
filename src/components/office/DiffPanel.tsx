/**
 * Расхождения с проектом: что было и что станет.
 *
 * Показывается, когда повторная сборка нашла разницу. Молча не пишем ничего:
 * лист мог быть поправлен руками, и обновление, затирающее чужую работу, —
 * самая дорогая ошибка в этой части программы.
 *
 * Разница разложена на четыре разговора, а не на «сошлось / не сошлось».
 * Правила счёта — в lib/tableLayout и проверяются скриптом; здесь только показ
 * и три кнопки решения.
 */

import React from 'react';
import { X, ArrowRight, AlertTriangle, CheckCircle2, Plus, Minus } from 'lucide-react';
import { STATE_NAMES, type LayoutDiff } from '../../lib/tableLayout';

/** Цвет состояния: янтарный — предупреждение, розовый — конфликт. */
const TONE: Record<string, string> = {
  changed: 'text-sky-700 dark:text-sky-300',
  manual: 'text-amber-700 dark:text-amber-300',
  conflict: 'text-rose-700 dark:text-rose-300',
  same: 'text-slate-500',
};

export default function DiffPanel({ diff, busy, onApplyFresh, onKeepMine, onClose }: {
  diff: LayoutDiff;
  busy: boolean;
  onApplyFresh: () => void;
  onKeepMine: () => void;
  onClose: () => void;
}) {
  const nothing = !diff.cells.length && !diff.gone.length && !diff.added.length;
  const total = diff.cells.length + diff.added.length + diff.gone.length;

  return (
    <aside className="w-80 shrink-0 border-l border-slate-200 dark:border-dark-border bg-white
                      dark:bg-dark-surface flex flex-col" aria-label="Расхождения с проектом">
      <div className="flex items-center gap-2 px-3 h-11 border-b border-slate-200 dark:border-dark-border">
        {/* Значок должен говорить то же, что текст: жёлтый треугольник над
            словами «всё сходится» человек читает как поломку */}
        {nothing
          ? <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          : <AlertTriangle className={`w-4 h-4 ${diff.asks > 0 ? 'text-rose-500' : 'text-amber-500'}`} />}
        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">Расхождения</span>
        {/* Счёт в заголовке: на ленте значка у кнопки нет, а знать, сколько их,
            надо до того, как человек начнёт листать список */}
        {total > 0 && (
          <span className="px-1.5 rounded-full bg-slate-100 dark:bg-slate-900 text-2xs font-bold
                           text-slate-600 dark:text-slate-300 tabular-nums">
            {total}
          </span>
        )}
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label="Закрыть"
          className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer text-slate-400
                     hover:bg-slate-100 dark:hover:bg-slate-850 hover:text-slate-600">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {nothing ? (
        <p className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
          Всё сходится с проектом.
        </p>
      ) : (
        <>
          {/* Плитками, а не списком строк: четыре числа надо схватить одним
              взглядом, и «требуют решения» не должно теряться среди прочих */}
          <div className="px-3 py-2 border-b border-slate-200 dark:border-dark-border grid grid-cols-2 gap-1.5">
            {([
              [diff.safe, 'изменилось в проекте', 'bg-sky-50 dark:bg-sky-950 text-sky-800 dark:text-sky-200'],
              [diff.asks, 'требуют решения', 'bg-rose-50 dark:bg-rose-950 text-rose-800 dark:text-rose-200'],
              [diff.added.length, 'появилось строк', 'bg-emerald-50 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-200'],
              [diff.gone.length, 'пропало строк', 'bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-300'],
            ] as [number, string, string][])
              .filter(([n]) => n > 0)
              .map(([n, label, tone]) => (
                <div key={label} className={`px-2 py-1.5 rounded-lg ${tone}`}>
                  <div className="text-sm font-bold tabular-nums leading-none">{n}</div>
                  <div className="mt-0.5 text-2xs opacity-80">{label}</div>
                </div>
              ))}
          </div>

          <div className="flex-1 overflow-auto scrollbar-thin">
            {diff.cells.map((c, i) => (
              <div key={`${c.key}-${c.col}-${i}`}
                className="px-3 py-2 border-b border-slate-100 dark:border-slate-850">
                <div className="flex items-baseline gap-2">
                  <span className="text-2xs font-semibold text-slate-700 dark:text-slate-300 truncate">
                    {c.colTitle}
                  </span>
                  <span className="flex-1" />
                  <span className={`text-2xs shrink-0 ${TONE[c.state] || ''}`}>
                    {STATE_NAMES[c.state]}
                  </span>
                </div>
                {/* Было и станет рядом: по одному значению понять, что поменялось,
                    нельзя, а листать между двумя таблицами — не работа. Сетка, а
                    не поток: иначе стрелка гуляет по строке вслед за длиной
                    значения, и глазу не за что зацепиться */}
                <div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-center gap-1.5 text-2xs">
                  <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-900
                                   text-slate-600 dark:text-slate-400 truncate" title={c.current}>
                    {c.current || '—'}
                  </span>
                  <ArrowRight className="w-3 h-3 text-slate-400 shrink-0" />
                  <span className="px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950
                                   text-emerald-800 dark:text-emerald-200 truncate" title={c.fresh}>
                    {c.fresh || '—'}
                  </span>
                </div>
                {c.state === 'conflict' && (
                  <p className="mt-1 text-2xs text-slate-500 dark:text-slate-400 truncate">
                    При прошлой сборке было «{c.written}»
                  </p>
                )}
              </div>
            ))}

            {diff.added.map((r) => (
              <div key={`add-${r.key}`} className="px-3 py-1.5 flex items-center gap-1.5
                                                   border-b border-slate-100 dark:border-slate-850">
                <Plus className="w-3 h-3 text-emerald-600 shrink-0" />
                <span className="text-2xs text-slate-700 dark:text-slate-300 truncate">{r.title}</span>
                <span className="text-2xs text-slate-400">появилось в проекте</span>
              </div>
            ))}
            {diff.gone.map((r) => (
              <div key={`gone-${r.key}`} className="px-3 py-1.5 flex items-center gap-1.5
                                                    border-b border-slate-100 dark:border-slate-850">
                <Minus className="w-3 h-3 text-rose-600 shrink-0" />
                <span className="text-2xs text-slate-700 dark:text-slate-300 truncate">{r.title}</span>
                <span className="text-2xs text-slate-400">больше нет в проекте</span>
              </div>
            ))}
          </div>

          <div className="p-3 border-t border-slate-200 dark:border-dark-border space-y-1.5">
            <button type="button" onClick={onApplyFresh} disabled={busy}
              className="w-full px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer bg-emerald-600
                         text-white hover:bg-emerald-700 disabled:opacity-50">
              Принять данные проекта
            </button>
            <button type="button" onClick={onKeepMine} disabled={busy}
              className="w-full px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer
                         bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-300
                         hover:bg-slate-200 dark:hover:bg-slate-800 disabled:opacity-50">
              Оставить как есть
            </button>
            <p className="text-2xs text-slate-500 dark:text-slate-400">
              «Принять» перезапишет и то, что правили руками.
            </p>
          </div>
        </>
      )}
    </aside>
  );
}
