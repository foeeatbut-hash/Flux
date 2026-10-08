/**
 * Загрузка «Классификатора типовых решений» из Excel: чтение файла и окно плана.
 *
 * Сервер ничего не пишет, пока человек не увидел план (flux-data-safety):
 * сколько новых и изменённых, что именно меняется, какие решения правили
 * руками (файл их не перезапишет) и что делать с решениями, которых в файле
 * нет. По умолчанию они остаются: файл могли прислать неполным.
 */
import React, { useState } from 'react';
import { parseDictionarySheet, parseIoSheet, parseSolutionSheet, IO_SHEET } from '../../../e3/solutions';
import { CLASSIFIER_SHEET, DICTIONARY_SHEET } from '../../../e3/solutionWorkbook';
import type { E3Dictionary, E3IoRow, E3Solution, E3SolutionBook, E3SolutionPlan } from '../../../e3/solutionTypes';
import { Btn, Dialog } from '../ui';
import { SOLUTION_FIELD_TITLES, fieldText } from './e3SolutionText';

export interface ParsedFile { items: E3Solution[]; dictionary: E3Dictionary; ioTable: E3IoRow[]; issues: string[] }

/**
 * Лист классификатора по имени или первый: владелец может его переименовать.
 * Листы «Обозначения» и «Таблица IO» необязательны и читаются по имени.
 */
export async function readSolutionFile(file: File, book: Pick<E3SolutionBook, 'features' | 'dictionary'>): Promise<ParsedFile> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const rowsOf = (name: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: '', blankrows: true });
  const find = (title: string) => wb.SheetNames.find((n) => n.trim().toLowerCase() === title.toLowerCase());
  const dictSheet = find(DICTIONARY_SHEET);
  const ioSheet = find(IO_SHEET);
  // Без листа классификатора первым берётся не служебный лист: «Таблица IO» не должна читаться как классификатор
  const main = find(CLASSIFIER_SHEET) || wb.SheetNames.find((n) => n !== dictSheet && n !== ioSheet) || (ioSheet ? undefined : wb.SheetNames[0]);
  if (!main && !ioSheet) return { items: [], dictionary: {}, ioTable: [], issues: ['В файле нет листов'] };
  const dict = dictSheet ? parseDictionarySheet(rowsOf(dictSheet)) : { dictionary: {}, issues: [] as string[] };
  const io = ioSheet ? parseIoSheet(rowsOf(ioSheet)) : { rows: [] as E3IoRow[], issues: [] as string[] };
  // Словарь файла нужен и разбору названий: новые коды в нём помогают понять признаки
  const parsed = main ? parseSolutionSheet(rowsOf(main), { features: book.features, dictionary: { ...dict.dictionary, ...book.dictionary } }) : { items: [] as E3Solution[], issues: [] as string[] };
  const note = main && main !== find(CLASSIFIER_SHEET) ? [`Листа «${CLASSIFIER_SHEET}» нет — прочитан лист «${main}»`] : [];
  return { items: parsed.items, dictionary: dict.dictionary, ioTable: io.rows, issues: [...note, ...parsed.issues, ...(dictSheet ? dict.issues : []), ...io.issues] };
}

const Names = ({ names, label }: { names: string[]; label: string }) => (
  <details className="mt-1">
    <summary className="cursor-pointer text-xs text-slate-500 dark:text-slate-400">{label}</summary>
    <div className="mt-1 max-h-28 overflow-auto font-mono text-xs break-words">{names.join(', ')}</div>
  </details>
);

export default function E3SolutionsImport({ plan, parseIssues, solutionsInFile, busy, error, onApply, onClose }: {
  plan: E3SolutionPlan; parseIssues: string[]; solutionsInFile: boolean; busy: boolean; error: string; onApply: (missing: 'keep' | 'remove') => void; onClose: () => void;
}) {
  const [missing, setMissing] = useState<'keep' | 'remove'>('keep');
  const issues = [...parseIssues, ...plan.issues];
  const dictChanges = plan.dictionaryAdded.length;
  const io = plan.io;
  // В файле без классификатора (только «Таблица IO») решений «нет в файле» не бывает: файл о них молчит
  const missingSolutions = solutionsInFile ? plan.missing : [];
  const nothing = plan.added.length + plan.changed.length + dictChanges + (io ? io.added + io.changed.length : 0) === 0 && (missing === 'keep' || missingSolutions.length === 0);

  return (
    <Dialog title="Загрузка классификатора типовых решений" onClose={onClose} busy={busy} width="max-w-2xl" scrollBody label="План загрузки типовых решений E3"
      footer={<><Btn onClick={onClose} disabled={busy}>Отмена</Btn><Btn tone="primary" disabled={busy || nothing} onClick={() => onApply(missing)} title={nothing ? 'Файл ничего не меняет' : undefined}>Записать</Btn></>}>
      {solutionsInFile && <p className="text-sm tabular-nums">
        Новых: <b className="font-semibold">{plan.added.length}</b> · изменённых: <b className="font-semibold">{plan.changed.length}</b> · без изменений: <b className="font-semibold">{plan.same}</b>
      </p>}
      {io && <p className="mt-1 text-sm tabular-nums">
        Таблица IO: новых <b className="font-semibold">{io.added}</b> · изменённых <b className="font-semibold">{io.changed.length}</b> · без изменений <b className="font-semibold">{io.same}</b>
        {io.editedKept.length > 0 && <span className="text-slate-500 dark:text-slate-400"> · правлено в каталоге, файл не применён: {io.editedKept.length}</span>}
        {io.missing.length > 0 && <span className="text-slate-500 dark:text-slate-400"> · нет в файле, остаются: {io.missing.length}</span>}
      </p>}
      {plan.added.length > 0 && <Names names={plan.added.map((s) => s.id)} label="Новые решения" />}
      {(dictChanges > 0 || plan.dictionaryDiffers.length > 0) && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Обозначения: новых кодов {dictChanges}{plan.dictionaryDiffers.length > 0 && `, с другим описанием в файле ${plan.dictionaryDiffers.length} — в каталоге оставлено своё`}.
      </p>}

      {issues.length > 0 && <section className="mt-3">
        <div className="fx-label">Замечания к файлу · {issues.length}</div>
        <ul className="mt-1 max-h-32 list-disc space-y-0.5 overflow-auto pl-4 text-xs text-amber-700 dark:text-amber-400">{issues.map((t, i) => <li key={i}>{t}</li>)}</ul>
      </section>}

      {plan.changed.length > 0 && <section className="mt-3">
        <div className="fx-label">Что изменится</div>
        <div className="mt-1 max-h-56 overflow-auto rounded border border-slate-200 dark:border-slate-700">
          {plan.changed.map((c) => (
            <div key={c.id} className="border-b border-slate-100 px-2 py-1 last:border-b-0 dark:border-slate-800">
              <div className="font-mono text-xs">{c.id}</div>
              {c.fields.map((f) => f === 'removed'
                ? <div key={f} className="text-xs text-slate-600 dark:text-slate-400">Снято: да → нет (вернётся в каталог)</div>
                : <div key={f} className="text-xs text-slate-600 dark:text-slate-400">{SOLUTION_FIELD_TITLES[f] || f}: {fieldText((c.before as any)[f])} → <span className="text-slate-900 dark:text-slate-100">{fieldText((c.after as any)[f])}</span></div>)}
            </div>
          ))}
        </div>
      </section>}

      {plan.editedKept.length > 0 && <section className="mt-3">
        <div className="fx-label">Правлено в каталоге — файл не применён · {plan.editedKept.length}</div>
        <p className="text-xs text-slate-500 dark:text-slate-400">Эти решения правили вручную, поэтому значения из файла для них не записываются.</p>
        <Names names={plan.editedKept} label="Какие решения" />
      </section>}

      {missingSolutions.length > 0 && <section className="mt-3">
        <div className="fx-label">Нет в файле · {missingSolutions.length}</div>
        <div className="mt-1 flex flex-col gap-1 text-sm">
          <label className="flex items-center gap-2"><input type="radio" name="e3s-missing" className="accent-emerald-600" checked={missing === 'keep'} onChange={() => setMissing('keep')} />Оставить в каталоге</label>
          <label className="flex items-center gap-2"><input type="radio" name="e3s-missing" className="accent-emerald-600" checked={missing === 'remove'} onChange={() => setMissing('remove')} />Снять — подбор их больше не предлагает</label>
        </div>
        <Names names={missingSolutions} label="Какие решения" />
      </section>}
      {error && <p role="alert" className="fx-error mt-3">{error}</p>}
    </Dialog>
  );
}
