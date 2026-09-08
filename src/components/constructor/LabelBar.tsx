/**
 * Панель меток — пристыкованная справа, а не полосой над листом.
 *
 * Полосой она отбирала у листа третью строку обвязки: над ней уже стояли
 * заголовок окна, полоса вкладок и лента. Метки при этом ставят не потоком, а
 * по одной, разглядывая, что подставится, — для такого дела нужна колонка, а
 * не полоса во всю ширину. Закрытая панель не занимает ничего.
 *
 * Кнопка = метка. Нажал «Дата прописью» — в активной ячейке появилась метка,
 * при обновлении данных она станет реальной датой. Так шаблон собирается
 * мышью, без запоминания синтаксиса вида {{дата.прописью}}.
 *
 * На кнопке показано не только название метки, но и то, что подставится прямо
 * сейчас: человек видит данные своей программы и сразу замечает, если чего-то
 * не хватает — не задан код проекта, нет номера документа. Раньше это
 * выяснялось только после заполнения, по пустому месту в готовом документе.
 */
import React from 'react';
import { RefreshCw, X } from 'lucide-react';
import { PLACEHOLDERS, placeholderToken } from '../../lib/docPlaceholders';

const GROUPS = ['Документ', 'Проект', 'Дата', 'Сотрудник'] as const;

export default function LabelBar({ preview, unfilled, onInsert, onFill, onClose }: {
  /** Что подставится сейчас, по ключу метки */
  preview: Record<string, string>;
  /** Сколько меток в книге ещё не заполнено */
  unfilled: number;
  onInsert: (key: string) => void;
  onFill: () => void;
  onClose: () => void;
}) {
  return (
    <div className="shrink-0 w-72 @[900px]:w-80 h-full flex flex-col overflow-hidden
                    bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-slate-200 dark:border-slate-800">
        <span className="text-sm font-bold text-slate-800 dark:text-white">Метки</span>
        <button type="button" onClick={onClose} aria-label="Закрыть"
          className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-3 py-2 flex flex-col gap-3">
        {GROUPS.map((group) => (
          <div key={group} className="min-w-0">
            <div className="text-2xs font-mono uppercase tracking-wider text-slate-400 mb-1">{group}</div>
            <div className="flex items-center gap-1 flex-wrap">
              {PLACEHOLDERS.filter(ph => ph.group === group).map((ph) => {
                const value = preview[ph.key] || '';
                const empty = !value;
                return (
                  <button
                    key={ph.key}
                    type="button"
                    onClick={() => onInsert(ph.key)}
                    title={empty
                      ? `${ph.hint}. Сейчас данных нет — метка ${placeholderToken(ph.key)} останется пустой до заполнения`
                      : `${ph.hint}. Сейчас подставится: ${value}`}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border bg-white dark:bg-slate-900 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 text-xs font-semibold text-slate-700 dark:text-slate-300 transition-ui cursor-pointer ${
                      empty
                        ? 'border-amber-300 dark:border-amber-800 hover:border-amber-500'
                        : 'border-slate-200 dark:border-slate-800 hover:border-emerald-600 dark:hover:border-emerald-400'}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-sm shrink-0 ${empty ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                    <span className="min-w-0 text-left">
                      {ph.label}
                      <span className={`block text-2xs font-normal truncate ${empty ? 'text-amber-600 dark:text-amber-500' : 'text-slate-400'}`}>
                        {empty ? 'нет данных' : value}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

      </div>
      <div className="shrink-0 border-t border-slate-200 dark:border-slate-800 px-3 py-2 space-y-2">
        <p className="text-2xs text-slate-400 leading-snug">
          Кнопка вставляет метку в выбранную ячейку. Когда шаблон готов — «Заполнить метки».
        </p>
        {unfilled > 0 && (
          <span className="block text-2xs font-semibold text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-2 py-1 rounded-lg">
            незаполненных меток: {unfilled}
          </span>
        )}
        <button type="button" onClick={onFill}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 transition-ui cursor-pointer">
          <RefreshCw className="w-3.5 h-3.5" /> Заполнить метки
        </button>
      </div>
    </div>
  );
}
