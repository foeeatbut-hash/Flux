/**
 * Загрузка «Списка атрибутов» из Excel: чтение файла и окно плана.
 *
 * Сервер ничего не пишет, пока человек не увидел план (flux-data-safety):
 * сколько новых и изменённых, что именно меняется в каждом, и главное —
 * что делать с атрибутами, которых в файле нет. По умолчанию они остаются:
 * файл могли прислать неполным, а снятый атрибут пропадает из выгрузок.
 */
import React, { useState } from 'react';
import { parseAttributeSheet, type E3Attribute, type E3Plan } from '../../../e3/attributes';
import { Btn } from './ui';
import { Dialog } from '../ui';
import { FILE_FIELD_TITLES, fieldValueText } from './e3AttributeText';

/** Лист «Список атрибутов» или первый: владелец может переименовать лист, а файл с одним листом всё равно его */
export async function readAttributeFile(file: File): Promise<{ items: E3Attribute[]; issues: string[] }> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const wanted = wb.SheetNames.find((n) => n.trim().toLowerCase() === 'список атрибутов') || wb.SheetNames[0];
  if (!wanted) return { items: [], issues: ['В файле нет листов'] };
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wanted], { header: 1, defval: '', blankrows: true });
  const parsed = parseAttributeSheet(rows);
  return wb.SheetNames.length > 1 && wanted !== 'Список атрибутов'
    ? { items: parsed.items, issues: [`Листа «Список атрибутов» нет — прочитан лист «${wanted}»`, ...parsed.issues] }
    : parsed;
}

const Names = ({ names, label }: { names: string[]; label: string }) => (
  <details className="mt-1">
    <summary className="cursor-pointer text-xs text-slate-500 dark:text-slate-400">{label}</summary>
    <div className="mt-1 max-h-28 overflow-auto font-mono text-xs break-words">{names.join(', ')}</div>
  </details>
);

export default function E3ImportDialog({ plan, parseIssues, busy, error, onApply, onClose }: {
  plan: E3Plan; parseIssues: string[]; busy: boolean; error: string; onApply: (missing: 'keep' | 'remove') => void; onClose: () => void;
}) {
  const [missing, setMissing] = useState<'keep' | 'remove'>('keep');
  const issues = [...parseIssues, ...plan.issues];
  const changes = plan.added.length + plan.changed.length;
  const willRemove = missing === 'remove' ? plan.missing.length : 0;
  const nothing = changes === 0 && willRemove === 0;

  return (
    <Dialog title="Загрузка списка атрибутов" onClose={onClose} busy={busy} width="max-w-2xl" scrollBody label="План загрузки атрибутов E3"
      footer={<><Btn onClick={onClose} disabled={busy}>Отмена</Btn><Btn tone="primary" disabled={busy || nothing} onClick={() => onApply(missing)} title={nothing ? 'Файл ничего не меняет' : undefined}>Записать</Btn></>}>
      <p className="text-sm tabular-nums">
        Новых: <b className="font-semibold">{plan.added.length}</b> · изменённых: <b className="font-semibold">{plan.changed.length}</b> · без изменений: <b className="font-semibold">{plan.same}</b>
      </p>
      {plan.added.length > 0 && <Names names={plan.added.map((a) => a.name)} label="Новые атрибуты" />}

      {issues.length > 0 && <section className="mt-3">
        <div className="fx-label">Замечания к файлу · {issues.length}</div>
        <ul className="mt-1 max-h-32 list-disc space-y-0.5 overflow-auto pl-4 text-xs text-amber-700 dark:text-amber-400">{issues.map((t, i) => <li key={i}>{t}</li>)}</ul>
      </section>}

      {plan.changed.length > 0 && <section className="mt-3">
        <div className="fx-label">Что изменится</div>
        <div className="mt-1 max-h-56 overflow-auto rounded border border-slate-200 dark:border-slate-700">
          {plan.changed.map((c) => (
            <div key={c.name} className="border-b border-slate-100 px-2 py-1 last:border-b-0 dark:border-slate-800">
              <div className="font-mono text-xs">{c.name}</div>
              {c.fields.map((f) => f === 'removed'
                ? <div key={f} className="text-xs text-slate-600 dark:text-slate-400">Снят: да → нет (вернётся в справочник)</div>
                : <div key={f} className="text-xs text-slate-600 dark:text-slate-400">{FILE_FIELD_TITLES[f] || f}: {fieldValueText((c.before as any)[f])} → <span className="text-slate-900 dark:text-slate-100">{fieldValueText((c.after as any)[f])}</span></div>)}
            </div>
          ))}
        </div>
      </section>}

      {plan.editedKept.length > 0 && <section className="mt-3">
        <div className="fx-label">Правлено в каталоге — файл не применён · {plan.editedKept.length}</div>
        <p className="text-xs text-slate-500 dark:text-slate-400">Эти атрибуты правили вручную, поэтому значения из файла для них не записываются.</p>
        <Names names={plan.editedKept} label="Какие атрибуты" />
      </section>}

      {plan.missing.length > 0 && <section className="mt-3">
        <div className="fx-label">Нет в файле · {plan.missing.length}</div>
        <div className="mt-1 flex flex-col gap-1 text-sm">
          <label className="flex items-center gap-2"><input type="radio" name="e3-missing" className="accent-emerald-600" checked={missing === 'keep'} onChange={() => setMissing('keep')} />Оставить в справочнике</label>
          <label className="flex items-center gap-2"><input type="radio" name="e3-missing" className="accent-emerald-600" checked={missing === 'remove'} onChange={() => setMissing('remove')} />Снять — в выгрузках их больше не будет</label>
        </div>
        <Names names={plan.missing} label="Какие атрибуты" />
      </section>}
      {error && <p role="alert" className="fx-error mt-3">{error}</p>}
    </Dialog>
  );
}
