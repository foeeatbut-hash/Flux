/**
 * Профиль автоматизации проекта (docs/e3-integration.md, 5.6): ответы на
 * признаки «из профиля» — способ пуска, концевые выключатели, коробки. Один
 * раз на проект вместо ответа в каждой позиции. Порог («до 7,5 кВт — ПП, выше —
 * ПЧИ») здесь только читается и при записи сохраняется как есть: его задаёт
 * тот, кто настраивает проект.
 */
import React from 'react';
import type { E3Feature, E3Profile } from '../../../e3/solutionTypes';
import { ruleSourceText } from './e3SolutionText';
import { Btn, Select } from '../ui';

export default function E3ProfileForm({ features, answers, dirty, busy, error, canSave, onChange, onSave }: {
  features: E3Feature[]; answers: E3Profile; dirty: boolean; busy: boolean; error: string; canSave: boolean;
  onChange: (id: string, value: string) => void; onSave: () => void;
}) {
  const mine = features.filter((f) => f.kind === 'profile');
  return (
    <section aria-label="Профиль проекта" className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="fx-label shrink-0">Профиль проекта</div>
      {!mine.length ? <p className="text-xs text-slate-500 dark:text-slate-400">В каталоге нет признаков «из профиля».</p> : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
          {mine.map((f) => {
            const a = answers[f.id];
            return (
              <label key={f.id} className="fx-field" title={f.hint || undefined}>
                <span className="fx-label truncate">{f.title} · {f.mainClass}</span>
                {a !== undefined && typeof a !== 'string'
                  ? <span className="text-xs text-slate-500 dark:text-slate-400">порог по «{ruleSourceText(a.source)}»: {a.steps.map((s) => `до ${s.upTo} — ${s.answer}`).join(', ')}, выше — {a.above}</span>
                  : <Select value={typeof a === 'string' ? a : ''} disabled={!canSave || busy} aria-label={`${f.title} (${f.mainClass})`} onChange={(v) => onChange(f.id, v)}
                    options={[{ value: '', label: 'не задано' }, ...f.values.map((v) => ({ value: v, label: v }))]} />}
              </label>
            );
          })}
        </div>
      )}
      {error && <p role="alert" className="fx-error shrink-0">{error}</p>}
      <Btn tone="primary" className="shrink-0" disabled={!canSave || !dirty || busy} onClick={onSave} title={canSave ? undefined : 'Профиль правит участник проекта'}>Сохранить профиль</Btn>
    </section>
  );
}
