/**
 * Вопросы плана выгрузки (docs/e3-integration.md, 9.3): спорное решает инженер,
 * пока он не ответил — действует умолчание таблицы. Для значения атрибута
 * показываются три стороны: «в E3 · отправляли · во Flux»; для замены решения по
 * новым правилам — что подобралось и что стоит в схеме.
 */
import React from 'react';
import type { Decisions, PlanQuestion } from '../../../e3/exportTypes';

const muted = 'text-slate-500 dark:text-slate-400';

export default function E3PlanQuestions({ questions, decisions, onChange }: { questions: PlanQuestion[]; decisions: Decisions; onChange: (id: string, value: string) => void }) {
  if (!questions.length) return null;
  return (
    <section className="mt-3" aria-label="Что решить">
      <div className="fx-label">Нужно решение · {questions.length}</div>
      <div className="mt-1 max-h-64 space-y-2 overflow-auto">
        {questions.map((q) => {
          const value = decisions[q.id] ?? q.default;
          return (
            <fieldset key={q.id} className="rounded border border-slate-200 px-2 py-1.5 dark:border-slate-700">
              <legend className="px-1 text-xs">{q.text}</legend>
              {q.values && (
                <dl className="mb-1 grid grid-cols-3 gap-2 text-xs tabular-nums">
                  <div><dt className={muted}>в E3</dt><dd className="font-mono">{q.values.e3}</dd></div>
                  <div><dt className={muted}>отправляли</dt><dd className="font-mono">{q.values.sent}</dd></div>
                  <div><dt className={muted}>во Flux</dt><dd className="font-mono">{q.values.flux}</dd></div>
                </dl>
              )}
              <div className="flex flex-col gap-0.5 text-sm">
                {q.options.map((o) => (
                  <label key={o.value} className="flex items-center gap-2">
                    <input type="radio" className="accent-emerald-600" name={q.id} checked={value === o.value} onChange={() => onChange(q.id, o.value)} />
                    {o.label}{q.default === o.value && <span className={`text-xs ${muted}`}>· по умолчанию</span>}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
    </section>
  );
}
