/**
 * Карточка выбранного узла (docs/e3-integration.md, 6.4): типовое решение и
 * ответы на признаки с источником, атрибуты изделия с «Да» и обозначение в E3.
 * Только чтение: ответы меняются в профиле и правилах, атрибуты — в справочнике.
 * Блок «Связь» заполнится, когда появятся выгрузки.
 */
import React from 'react';
import { attributesForClass, type E3AttributeBook } from '../../../e3/attributes';
import { NODE_STATES } from '../../../e3/nodeState';
import type { E3AnswerFrom, E3Feature } from '../../../e3/solutionTypes';
import { e3AttrValue } from '../../lib/e3Table';
import { classById } from '../../../equipment/classes';
import { solutionLine } from './e3SolutionText';
import type { SchemeNode } from './useSchemeData';

const FROM: Record<E3AnswerFrom, string> = { manual: 'вручную', ov: 'подбор ОВ', profile: 'профиль проекта', layout: 'раскладка листа' };
const muted = 'text-slate-500 dark:text-slate-400';

export default function E3SchemeCard({ node, features, attrs, problem }: { node: SchemeNode | null; features: E3Feature[]; attrs: E3AttributeBook; problem: boolean }) {
  if (!node) return <aside className={`w-64 shrink-0 border-l border-slate-200 p-3 text-sm dark:border-slate-800 ${muted}`} aria-label="Свойства выбранного">Выберите узел в списке или на холсте.</aside>;
  const title = (id: string) => (id === '@class' ? 'Основной класс' : features.find((f) => f.id === id)?.title || id);
  const { selection: sel, state } = node;
  const rows = attributesForClass(attrs.items, node.cls).filter((a) => a.fromFlux).map((a) => ({
    a, value: e3AttrValue(node.item, a, node.cls),
  }));
  return (
    <aside className="w-64 shrink-0 overflow-auto border-l border-slate-200 p-3 text-sm dark:border-slate-800" aria-label="Свойства выбранного">
      <div className="flex items-baseline gap-2"><span className="font-mono">{node.label || '—'}</span><span className={`min-w-0 flex-1 truncate ${muted}`}>{classById(node.cls).title}</span></div>
      <div className="mt-1 text-xs" title={NODE_STATES[state].hint}>{NODE_STATES[state].mark} {NODE_STATES[state].title}{problem ? ' · не помещается на листе' : ''}</div>

      <section className="mt-3">
        <div className="fx-label">Типовое решение</div>
        {sel.solution ? <>
          <p className="mt-1 break-words font-mono text-xs">{solutionLine(sel.solution)}</p>
          {sel.solution.description && <p className={`mt-1 text-xs ${muted}`}>{sel.solution.description}</p>}
        </> : <p className={`mt-1 text-xs ${muted}`}>{sel.status === 'many' ? `Подходят ${sel.candidates.length}${sel.missingFeature ? `: нужен ответ на «${title(sel.missingFeature)}»` : ''}` : 'Решения нет'}</p>}
      </section>

      <section className="mt-3">
        <div className="fx-label">Признаки · {sel.answers.length}</div>
        {!sel.answers.length ? <p className={`mt-1 text-xs ${muted}`}>Ответов пока нет.</p> : (
          <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 text-xs">
            {sel.answers.map((a) => <React.Fragment key={a.feature}><dt className="truncate" title={`${title(a.feature)} — ${FROM[a.from]}`}>{title(a.feature)}</dt><dd><span className="font-mono">{a.value}</span> <span className={muted}>{FROM[a.from]}</span></dd></React.Fragment>)}
          </dl>
        )}
      </section>

      <section className="mt-3">
        <div className="fx-label">Атрибуты E3 · {rows.length}</div>
        {!rows.length ? <p className={`mt-1 text-xs ${muted}`}>Для этого типа нет атрибутов с «Да».</p> : (
          <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 text-xs">
            {rows.map(({ a, value }) => <React.Fragment key={a.name}><dt className="truncate font-mono" title={a.title}>{a.name}</dt><dd className={value ? 'max-w-[110px] truncate' : muted} title={value}>{value || 'нет данных'}</dd></React.Fragment>)}
          </dl>
        )}
      </section>

      <section className="mt-3">
        <div className="fx-label">Обозначение в E3</div>
        <p className="mt-1 font-mono text-xs">{node.label || <span className={muted}>у позиции нет тега</span>}</p>
      </section>
      <section className="mt-3">
        <div className="fx-label">Связь</div>
        <p className={`mt-1 text-xs ${muted}`}>Выгрузок ещё не было.</p>
      </section>
    </aside>
  );
}
