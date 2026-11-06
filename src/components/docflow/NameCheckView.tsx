import React from 'react';
import { Check, CircleAlert, CircleHelp, X } from 'lucide-react';
import type { NameCheck } from '../../../shared/docflow/nameMask';

/** Результат проверки имени по полям (docs/docflow-program.md, 4.2): что совпало, что нет, что блокирует связь. */
export default function NameCheckView({ check }: { check: NameCheck }) {
  if (!check.fields.length) return null;
  return (
    <ul aria-label="Проверка имени файла" className="space-y-1 text-xs">
      {check.fields.map((f) => (
        <li key={`${f.field}:${f.text}`} data-check-state={f.state} className={`flex items-start gap-2 ${f.blocking ? 'text-rose-700 dark:text-rose-400' : f.state === 'match' || f.state === 'new' ? 'text-slate-600 dark:text-slate-300' : 'text-amber-700 dark:text-amber-400'}`}>
          <span className="mt-0.5 shrink-0" aria-hidden>
            {f.blocking ? <X size={13} /> : f.state === 'match' || f.state === 'new' ? <Check size={13} /> : f.state === 'unknown' ? <CircleHelp size={13} /> : <CircleAlert size={13} />}
          </span>
          <span><span className="font-medium">{f.label}</span>: {f.text}{f.blocking ? ' — связать нельзя' : ''}</span>
        </li>
      ))}
    </ul>
  );
}
