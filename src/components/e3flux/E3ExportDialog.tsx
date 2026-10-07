/**
 * Окно плана выгрузки (docs/e3-integration.md, 8.1): сначала план, а не запись.
 * Ошибки блокируют выгрузку, предупреждения — нет; под ними сводка «поставить N,
 * обновить M, заменить K, удалить L». Во время записи — ход по шагам, после —
 * итог: что сделано, а если оборвалось — почему и что дальше.
 */
import React from 'react';
import { summaryText } from '../../../e3/exportPlan';
import type { PlanIssue } from '../../../e3/exportTypes';
import { Btn, Dialog } from '../ui';
import type { Prepared } from './useE3Export';

export interface RunView { phase: 'plan' | 'running' | 'done'; done: number; total: number; text: string; state?: 'DONE' | 'INTERRUPTED'; error?: string }

const Issues = ({ list, tone, title }: { list: PlanIssue[]; tone: string; title: string }) => !list.length ? null : (
  <section className="mt-3">
    <div className="fx-label">{title} · {list.length}</div>
    <ul className={`mt-1 max-h-36 list-disc space-y-0.5 overflow-auto pl-4 text-xs ${tone}`}>{list.map((x, i) => <li key={i}>{x.text}</li>)}</ul>
  </section>
);

export default function E3ExportDialog({ prepared, view, error, onRun, onClose }: { prepared: Prepared; view: RunView; error: string; onRun: () => void; onClose: () => void }) {
  const { plan } = prepared;
  const running = view.phase === 'running';
  return (
    <Dialog title="Выгрузка в E3.series" onClose={onClose} busy={running} width="max-w-xl" scrollBody label="План выгрузки в E3"
      footer={view.phase === 'plan' ? <><Btn onClick={onClose}>Отмена</Btn><Btn tone="primary" disabled={plan.errors.length > 0} title={plan.errors.length ? 'Сначала устраните ошибки' : undefined} onClick={onRun}>Выгрузить</Btn></>
        : <Btn onClick={onClose} disabled={running}>Закрыть</Btn>}>
      {view.phase === 'plan' && <>
        <p className="text-sm tabular-nums">{plan.errors.length ? 'Выгрузка невозможна.' : `Будет сделано: ${summaryText(plan.summary)}`}{plan.summary.skipped ? ` · пропущено ${plan.summary.skipped}` : ''}</p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Шагов в плане: {plan.steps.length}. Связи пишутся последними: оборванная выгрузка продолжается без дублей.</p>
        <Issues list={plan.errors} tone="text-rose-700 dark:text-rose-400" title="Ошибки — выгрузку блокируют" />
        <Issues list={plan.warnings} tone="text-amber-700 dark:text-amber-400" title="Предупреждения" />
      </>}
      {running && <div role="status"><p className="text-sm tabular-nums">Сделано {view.done} из {view.total}</p><div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-200 dark:bg-slate-700"><div className="h-full bg-emerald-600" style={{ width: `${view.total ? (100 * view.done) / view.total : 0}%` }} /></div><p className="mt-2 truncate text-xs text-slate-500 dark:text-slate-400">{view.text}</p></div>}
      {view.phase === 'done' && (view.state === 'DONE'
        ? <p className="text-sm">Выгрузка завершена: {summaryText(plan.summary)}. После неё запустите свои скрипты E3 (ФСА, подвал, таблица TAGов).</p>
        : <><p className="text-sm text-rose-700 dark:text-rose-400">Выгрузка прервана: сделано {view.done} из {view.total}.</p><p className="mt-1 text-xs">{view.error}</p><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">На вкладке «Схема» можно продолжить или убрать сделанное.</p></>)}
      {error && <p role="alert" className="fx-error mt-3">{error}</p>}
    </Dialog>
  );
}
