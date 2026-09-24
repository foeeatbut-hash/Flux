/**
 * Мелкие части интерфейса Каталога и Конструктора.
 *
 * Две программы показывают одно и то же — семейство, код, обозначение,
 * уверенность подбора, — и должны показывать одинаково: инженер переходит из
 * одной в другую и не должен заново учиться читать метки.
 */
import React from 'react';
import type { Family } from '../../../catalog/model';
import { textOf } from '../../../catalog/model';
import { buildDesignation } from '../../../catalog/designation';
import { confidenceLevel } from '../../../catalog/match';
import { useModalStore, type ConfirmOptions } from '../../store/modalStore';

/** Спросить подтверждение общим окном программы */
export const confirmAsk = (title: string, message?: string, opts?: ConfirmOptions) => useModalStore.getState().openConfirm(title, message, opts);
/** Спросить строку общим окном программы; `value` — что подставить заранее */
export const promptAsk = (title: string, message?: string, value?: string) => useModalStore.getState().openPrompt(title, message, '', value);
export const selectAsk = (title: string, message: string, options: Array<{ value: string; label: string }>, value?: string) =>
  useModalStore.getState().openSelect(title, message, options, value);

// Общие элементы переехали в components/ui: ими теперь пользуется вся
// программа. Каталог и Конструктор берут их через этот файл, как и раньше
export { Btn, Seg, Field, inputCls, Input, Area, Select, Chip } from '../ui';
import { Chip } from '../ui';

/** Уверенность подбора: цвет и слово, одинаково в ведомости, подборе и импорте */
export function Confidence({ value }: { value?: number }) {
  if (value === undefined) return <Chip>не подбиралось</Chip>;
  const lvl = confidenceLevel(value);
  const tone = lvl === 'high' ? 'emerald' : lvl === 'medium' ? 'amber' : 'rose';
  const word = lvl === 'high' ? 'уверенно' : lvl === 'medium' ? 'проверить' : 'сомнительно';
  return <Chip tone={tone} title={`Уверенность подбора ${Math.round(value * 100)}%`}>{word} <span className="tabular-nums opacity-70">{Math.round(value * 100)}%</span></Chip>;
}

export function StatusChip({ status }: { status: 'full' | 'partial' | 'draft' }) {
  if (status === 'full') return <Chip tone="emerald" title="Сверено с каталогом">сверено</Chip>;
  if (status === 'partial') return <Chip tone="amber" title="Часть данных снята распознаванием — сверить со страницей каталога">сверить</Chip>;
  return <Chip tone="slate" title="Черновик">черновик</Chip>;
}

export { Empty, SectionTitle } from '../ui';

/**
 * Обозначение с подсветкой позиций: наведение показывает, что значит кусок
 * строки, щелчок ведёт к шагу, где он выбирается. Недостающая позиция — «?»
 * янтарным: видно, чего не хватает, ещё до проверки.
 */
export function DesignationView({ family, values, onPick, active, sizeSep }: {
  family: Family; values: Record<string, string | number>; onPick?: (position: string) => void; active?: string; sizeSep?: string;
}) {
  const res = buildDesignation(family, values, { sizeSep });
  const parts: React.ReactNode[] = [];
  let at = 0;
  res.spans.forEach((sp, i) => {
    if (sp.from > at) parts.push(<span key={`s${i}`} className="text-slate-400">{res.text.slice(at, sp.from)}</span>);
    const pos = family.positions.find((p) => p.key === sp.position);
    const missing = res.missing.some((m) => m.position === sp.position);
    parts.push(
      <button key={sp.position + i} type="button" onClick={onPick ? () => onPick(sp.position) : undefined} title={pos ? textOf(pos.label) : sp.position}
        className={`px-0.5 rounded ${onPick ? 'cursor-pointer hover:bg-emerald-100 dark:hover:bg-emerald-950/40' : 'cursor-default'} ${missing ? 'text-amber-600 dark:text-amber-400 font-bold' : ''} ${active === sp.position ? 'bg-emerald-100 dark:bg-emerald-950/50' : ''}`}>
        {res.text.slice(sp.from, sp.to)}
      </button>,
    );
    at = sp.to;
  });
  if (at < res.text.length) parts.push(<span key="tail" className="text-slate-400">{res.text.slice(at)}</span>);
  return <span className="font-mono text-xs break-all u-sel">{parts}</span>;
}

export { plural } from '../../lib/plural';
