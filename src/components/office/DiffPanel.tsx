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
import { X, ArrowRight, AlertTriangle, Plus, Minus } from 'lucide-react';
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

  return (
    <aside className="w-80 shrink-0 border-l border-slate-200 dark:border-dark-border bg-white
                      dark:bg-dark-surface flex flex-col" aria-label="Расхождения с проектом">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-dark-border">
        <AlertTriangle className="w-4 h-4 text-amber-500" />
        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">Расхождения</span>
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label="Закрыть"
          className="w-6 h-6 rounded flex items-center justify-center cursor-pointer text-slate-400
                     hover:bg-slate-100 dark:hover:bg-slate-850">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {nothing ? (
        <p className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
          Всё сходится с проектом.
        </p>
      ) : (
        <>
          <div className="px-3 py-2 border-b border-slate-200 dark:border-dark-border text-2xs
                          text-slate-600 dark:text-slate-400">
            {diff.safe > 0 && <div>Изменилось в проекте: {diff.safe}</div>}
            {diff.asks > 0 && <div>Требуют решения: {diff.asks}</div>}
            {diff.added.length > 0 && <div>Появилось строк: {diff.added.length}</div>}
            {diff.gone.length > 0 && <div>Пропало строк: {diff.gone.length}</div>}
          </div>

          <div className="flex-1 overflow-auto scrollbar-thin">
            {diff.cells.map((c, i) => (
              <div key={`${c.key}-${c.col}-${i}`}
                className="px-3 py-2 border-b border-slate-100 dark:border-slate-850">
                <div className="flex items-baseline gap-2">
                  <span className="text-2xs font-semibold text-slate-700 dark:text-slate-300 truncate">
                    {c.colTitle}
                  </span>
                  <span className={`text-2xs shrink-0 ${TONE[c.state] || ''}`}>
                    {STATE_NAMES[c.state]}
                  </span>
                </div>
                {/* Было и станет рядом: по одному значению понять, что поменялось,
                    нельзя, а листать между двумя таблицами — не работа */}
                <div className="mt-0.5 flex items-center gap-1.5 text-2xs">
                  <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-900
                                   text-slate-600 dark:text-slate-400 truncate max-w-[45%]">
                    {c.current || '—'}
                  </span>
                  <ArrowRight className="w-3 h-3 text-slate-400 shrink-0" />
                  <span className="px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950
                                   text-emerald-800 dark:text-emerald-200 truncate max-w-[45%]">
                    {c.fresh || '—'}
                  </span>
                </div>
                {c.state === 'conflict' && (
                  <p className="mt-0.5 text-2xs text-slate-500 dark:text-slate-400">
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
