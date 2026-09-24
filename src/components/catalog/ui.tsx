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

type BtnTone = 'primary' | 'ghost' | 'danger' | 'plain';

export function Btn({ tone = 'plain', className = '', ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: BtnTone }) {
  const tones: Record<BtnTone, string> = {
    primary: 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600',
    ghost: 'border-transparent text-slate-500 dark:text-slate-400 hover:text-emerald-700 dark:hover:text-emerald-400 hover:bg-slate-100 dark:hover:bg-slate-800',
    danger: 'border-rose-200 dark:border-rose-900 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30',
    plain: 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-100 hover:border-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-400 bg-white dark:bg-slate-900',
  };
  return (
    <button type="button" {...p}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap ${tones[tone]} ${className}`} />
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: NoInfer<T>; label: string; hint?: string }>; onChange: (v: NoInfer<T>) => void; label: string }) {
  return (
    <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" title={o.hint} onClick={() => onChange(o.value)} aria-pressed={value === o.value}
          className={`px-2 py-1 text-2xs font-bold rounded-md cursor-pointer whitespace-nowrap ${value === o.value ? 'bg-emerald-600 text-white' : 'text-slate-500 dark:text-slate-400 hover:text-emerald-600'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 min-w-0 ${className}`}>
      <span className="text-2xs font-bold uppercase tracking-wide text-slate-400">{label}</span>
      {children}
      {hint && <span className="text-2xs text-slate-400">{hint}</span>}
    </label>
  );
}

export const inputCls = 'w-full min-w-0 px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs text-slate-800 dark:text-slate-100 outline-none focus:border-emerald-500';

export function Input(p: React.InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  return <input {...p} className={`${inputCls} ${p.className || ''}`} />;
}

export function Area(p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={`${inputCls} resize-y ${p.className || ''}`} />;
}

export function Select({ value, onChange, options, className = '', ...rest }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string; disabled?: boolean; title?: string }>; className?: string } & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'>) {
  return (
    <select {...rest} value={value} onChange={(e) => onChange(e.target.value)} className={`${inputCls} cursor-pointer ${className}`}>
      {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled} title={o.title}>{o.label}</option>)}
    </select>
  );
}

export function Chip({ children, tone = 'slate', onClick, title, off }: { children: React.ReactNode; tone?: 'slate' | 'emerald' | 'amber' | 'rose' | 'sky'; onClick?: () => void; title?: string; off?: boolean }) {
  const tones = {
    slate: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300',
    emerald: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400',
    amber: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400',
    rose: 'border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400',
    sky: 'border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-400',
  } as const;
  const El: any = onClick ? 'button' : 'span';
  return (
    <El type={onClick ? 'button' : undefined} onClick={onClick} title={title}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-2xs font-semibold ${tones[tone]} ${off ? 'line-through opacity-50' : ''} ${onClick ? 'cursor-pointer hover:opacity-80' : ''}`}>
      {children}
    </El>
  );
}

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

export function Empty({ title, text, children }: { title: string; text?: string; children?: React.ReactNode }) {
  return (
    <div className="blank">
      <div className="blank-title">{title}</div>
      {text && <div className="blank-text">{text}</div>}
      {children}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mt-3 mb-1.5">
      <b className="text-2xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">{children}</b>
      <span className="flex-1 h-px bg-slate-100 dark:bg-slate-800" />
      {right}
    </div>
  );
}

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
