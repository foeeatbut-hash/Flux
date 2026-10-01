import React, { useId } from 'react';
import type { IncidentEvidence } from '../../../diagnostics/incidents';
import { Copy, ShieldAlert } from 'lucide-react';

export interface FeedbackIncident {
  title: string;
  severity: string;
  count: number;
  routes: string[];
  codes: string[];
  traces: string[];
  frames?: string[];
  nextSteps: string[];
  evidence: IncidentEvidence[];
}

const SEVERITY: Record<string, { label: string; className: string }> = {
  critical: { label: 'Критично', className: 'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40' },
  error: { label: 'Ошибка', className: 'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40' },
  warning: { label: 'Проверить', className: 'text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40' },
  info: { label: 'Наблюдение', className: 'text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800' },
};

function CopyValue({ value, label }: { value: string; label: string }) {
  return (
    <button type="button" aria-label={`Скопировать ${label}`} title={`Скопировать ${label}`}
      onClick={() => { void navigator.clipboard?.writeText(value).catch(() => {}); }}
      className="inline-flex items-center justify-center rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-300">
      <Copy className="h-3 w-3" />
    </button>
  );
}

function Values({ title, values, copy = false }: { title: string; values: string[]; copy?: boolean }) {
  const safe = values.filter((value) => typeof value === 'string' && value.trim());
  if (!safe.length) return null;
  return (
    <div className="min-w-0">
      <div className="text-2xs text-slate-500 dark:text-slate-400">{title}</div>
      <ul className="mt-0.5 space-y-0.5">
        {safe.slice(0, 5).map((value, index) => (
          <li key={`${index}-${value}`} className="flex min-w-0 items-start gap-1 text-xs text-slate-700 dark:text-slate-300">
            <span className={`min-w-0 flex-1 break-words ${copy ? 'font-mono' : ''}`}>{value}</span>
            {copy && <CopyValue value={value} label={title.toLocaleLowerCase()} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function FeedbackIncidentSummary({ incidents }: { incidents: FeedbackIncident[] }) {
  const headingId = useId();
  const rows = Array.isArray(incidents) ? incidents.slice(0, 6) : [];
  if (!rows.length) return null;
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
        <ShieldAlert className="h-3.5 w-3.5 text-slate-400" /> Что проверить первым
      </h3>
      {rows.map((incident, index) => {
        const severity = SEVERITY[String(incident.severity || '').toLowerCase()] || {
          label: incident.severity || 'Событие', className: 'text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800',
        };
        return (
          <article key={`${incident.title}-${index}`} className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5 space-y-2">
            <div className="flex items-start gap-2">
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium ${severity.className}`}>{severity.label}</span>
              <h4 className="min-w-0 flex-1 text-xs font-medium text-slate-800 dark:text-slate-100">{incident.title}</h4>
              <span className="shrink-0 tabular-nums text-2xs text-slate-500 dark:text-slate-400">{incident.count}×</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Values title="Маршруты" values={incident.routes || []} />
              <Values title="Коды" values={incident.codes || []} copy />
              <Values title="Трассы" values={incident.traces || []} copy />
              <Values title="Участки стека" values={incident.frames || []} copy />
              <Values title="Что видно в записи" values={(incident.evidence || []).map(e => `${e.at} · ${e.source} · ${e.event}${e.code ? ` · ${e.code}` : ''}${e.route ? ` · ${e.route}` : ''}`)} copy />
            </div>
            {!!incident.nextSteps?.length && <div>
              <div className="text-2xs text-slate-500 dark:text-slate-400">Дальше проверить</div>
              <ul className="mt-0.5 list-disc pl-4 text-xs text-slate-700 dark:text-slate-300">
                {incident.nextSteps.slice(0, 4).map((step, stepIndex) => <li key={`${stepIndex}-${step}`}>{step}</li>)}
              </ul>
            </div>}
          </article>
        );
      })}
    </section>
  );
}
