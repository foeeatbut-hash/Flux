/**
 * Подбор по одной позиции: на какие признаки есть ответ и откуда он, что
 * осталось выбрать, а у подобранного решения — состав блока: изделия E3, их
 * сигналы и итог DI/DO/AI/AO (docs/e3-integration.md, 5.4). Только чтение —
 * ответы меняются в профиле проекта и в правилах каталога, а состав — в
 * таблице IO и в карточке решения, а не в этом окне.
 */
import React from 'react';
import { IO_KEYS, IO_TITLES, signalsText } from '../../../e3/ioTable';
import type { E3AnswerFrom, E3Feature, E3Recipe, E3Selection } from '../../../e3/solutionTypes';
import { classTitle } from '../../../equipment/classes';
import { Btn, Dialog } from '../ui';
import { solutionLine } from './e3SolutionText';

const FROM: Record<E3AnswerFrom, string> = { manual: 'вручную', ov: 'подбор ОВ', profile: 'профиль проекта', layout: 'раскладка листа' };

export default function E3SelectionDialog({ label, cls, selection, features, recipe, onClose }: {
  label: string; cls: string; selection: E3Selection; features: E3Feature[]; recipe?: E3Recipe; onClose: () => void;
}) {
  const title = (id: string) => (id === '@class' ? 'Основной класс' : features.find((f) => f.id === id)?.title || id);
  const { status, answers, candidates, nearest, missingFeature, solution } = selection;
  return (
    <Dialog title={<><span className="font-mono">{label || '—'}</span> <span className="font-normal text-slate-500 dark:text-slate-400">· {classTitle(cls)}</span></>}
      onClose={onClose} width="max-w-xl" scrollBody label={`Подбор решения: ${label}`} footer={<Btn onClick={onClose}>Закрыть</Btn>}>
      {status === 'one' && solution && <p className="text-sm">Подобрано: <span className="font-mono">{solutionLine(solution)}</span></p>}
      {status === 'many' && <p className="text-sm">Подходят {candidates.length} решений.{missingFeature ? <> Чтобы выбрать одно, нужен ответ на признак «<b className="font-semibold">{title(missingFeature)}</b>».</> : ''}</p>}
      {status === 'none' && <p className="text-sm">{nearest.length ? 'Ни одно решение не подходит под ответы. Ближайшие — ниже.' : 'Для этого типа в каталоге нет решений: проверьте связь типов с классами.'}</p>}

      <section className="mt-3">
        <div className="fx-label">Ответы на признаки · {answers.length}</div>
        {!answers.length ? <p className="text-xs text-slate-500 dark:text-slate-400">Ни на один признак ответа пока нет.</p> : (
          <dl className="mt-1 grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-0.5 text-sm">
            {answers.map((a) => <React.Fragment key={a.feature}><dt className="truncate">{title(a.feature)}</dt><dd className="font-mono">{a.value}</dd><dd className="text-xs text-slate-500 dark:text-slate-400">{FROM[a.from]}</dd></React.Fragment>)}
          </dl>
        )}
      </section>

      {status === 'one' && recipe && <section className="mt-3" aria-label="Состав блока">
        <div className="fx-label">Состав блока · {recipe.items.length}</div>
        {recipe.items.length > 0 && (
          <table className="fx-table mt-1 text-left">
            <thead><tr><th>Изделие</th><th>Роль</th>{IO_KEYS.map((k) => <th key={k} className="text-right">{IO_TITLES[k]}</th>)}</tr></thead>
            <tbody>{recipe.items.map((it, i) => (
              <tr key={i} title={it.why}>
                <td className={`max-w-[220px] truncate font-mono ${it.component ? '' : 'text-slate-500 dark:text-slate-400'}`}>{it.component || 'имя не задано'}</td>
                <td className="whitespace-nowrap">{it.role}{it.fromPosition ? <span className="text-slate-500 dark:text-slate-400"> · {it.fromPosition.role} {it.fromPosition.index + 1}</span> : null}</td>
                {IO_KEYS.map((k) => <td key={k} className={`text-right tabular-nums ${it.signals[k] ? '' : 'text-slate-500 dark:text-slate-400'}`}>{it.signals[k] || '—'}</td>)}
              </tr>
            ))}
            <tr className="font-medium"><td colSpan={2}>Итого</td>{IO_KEYS.map((k) => <td key={k} className="text-right tabular-nums">{recipe.total[k]}</td>)}</tr>
            </tbody>
          </table>
        )}
        {recipe.items.length > 0 && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{signalsText(recipe.total)}. Почему изделие в блоке — в подсказке строки.</p>}
        {recipe.issues.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-amber-700 dark:text-amber-400" aria-label="Замечания к составу">{recipe.issues.map((t, i) => <li key={i}>{t}</li>)}</ul>}
      </section>}

      {status === 'many' && <section className="mt-3">
        <div className="fx-label">Кандидаты</div>
        <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto font-mono text-xs">{candidates.slice(0, 30).map((s) => <li key={s.id}>{solutionLine(s)}</li>)}</ul>
        {candidates.length > 30 && <p className="text-xs text-slate-500 dark:text-slate-400">Показано 30 из {candidates.length}.</p>}
      </section>}

      {status === 'none' && nearest.length > 0 && <section className="mt-3">
        <div className="fx-label">Ближайшие решения</div>
        <div className="mt-1 max-h-56 overflow-auto rounded border border-slate-200 dark:border-slate-700">
          {nearest.map((n) => (
            <div key={n.solution.id} className="border-b border-slate-100 px-2 py-1 last:border-b-0 dark:border-slate-800">
              <div className="font-mono text-xs">{solutionLine(n.solution)}</div>
              {n.diff.map((d) => <div key={d.feature} className="text-xs text-slate-600 dark:text-slate-400">{title(d.feature)}: нужно «{d.want}», в решении «{d.have || '—'}»</div>)}
            </div>
          ))}
        </div>
      </section>}
    </Dialog>
  );
}
