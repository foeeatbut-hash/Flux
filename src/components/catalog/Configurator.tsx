/**
 * Конструктор изделия: параметры семейства по шагам, живое обозначение,
 * проверка по правилам каталога.
 *
 * Один компонент на три места — карточка позиции в Конструкторе, «Попробовать»
 * в Каталоге и принятие кандидата подбора. Поэтому он ничего не сохраняет сам:
 * получает значения и отдаёт новые, а записывает тот, кто его открыл.
 */
import React, { useMemo, useRef, useState } from 'react';
import { AlertTriangle, CircleCheck, Info, RotateCcw, Wand2 } from 'lucide-react';
import type { Family, ParamDef, ValveValues, WizardStep } from '../../../catalog/model';
import { WIZARD_STEPS, textOf, withDefaults, num } from '../../../catalog/model';
import { optionsFor, checkConfig, sizeLimits, nearestSize } from '../../../catalog/rules';
import { buildDesignation, parseWithFamily } from '../../../catalog/designation';
import { DesignationView, Input, Chip, Btn, SectionTitle } from './ui';

export interface ConfiguratorProps {
  family: Family;
  values: ValveValues;
  onChange: (values: ValveValues) => void;
  /** Откуда взято значение: «из текста», «по умолчанию», «выучено» — подписью у параметра */
  sources?: Record<string, string>;
  sizeSep?: string;
  readOnly?: boolean;
  compact?: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  text: 'из описания', default: 'по умолчанию', rule: 'по правилу', learned: 'как в прошлый раз', designation: 'из обозначения', choice: 'выбрано',
};

function stepOf(p: ParamDef): WizardStep {
  if (p.size) return 'size';
  return p.step || 'options';
}

export default function Configurator({ family, values, onChange, sources = {}, sizeSep, readOnly, compact }: ConfiguratorProps) {
  const [active, setActive] = useState<string>('');
  const [raw, setRaw] = useState('');
  const [rawError, setRawError] = useState('');
  const stepRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const full = useMemo(() => withDefaults(family, values), [family, values]);
  const violations = useMemo(() => checkConfig(family, values), [family, values]);
  const limits = useMemo(() => sizeLimits(family, values), [family, values]);
  const designation = buildDesignation(family, values, { sizeSep }).text;
  const shape: 'rect' | 'round' = num(full.D) > 0 ? 'round' : num(full.W) > 0 || num(full.H) > 0 ? 'rect' : family.shapes[0];

  const set = (key: string, v: string | number | undefined) => {
    const next = { ...values };
    if (v === undefined || v === '') delete next[key]; else next[key] = v;
    onChange(next);
  };

  const setShape = (s: 'rect' | 'round') => {
    const next = { ...values };
    if (s === 'round') { delete next.W; delete next.H; } else delete next.D;
    onChange(next);
  };

  /** Позиция обозначения → шаг мастера, где выбирается её первый параметр */
  const pickPosition = (posKey: string) => {
    const pos = family.positions.find((p) => p.key === posKey);
    const param = pos?.formats.flatMap((f) => [...f.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1])).find((k) => k !== 'x');
    const p = param ? family.params.find((x) => x.key === param) : undefined;
    setActive(posKey);
    const el = stepRefs.current[p ? stepOf(p) : 'options'];
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const applyRaw = () => {
    const r = parseWithFamily(family, raw);
    if (!r.complete) { setRawError(`Строка разобрана до позиции «${r.stuckAt || '?'}»; дальше непонятно: ${r.rest || '—'}`); return; }
    setRawError('');
    onChange(r.values);
    setRaw('');
  };

  const steps = WIZARD_STEPS.map((s) => ({ ...s, params: family.params.filter((p) => stepOf(p) === s.id && !p.size) }))
    .filter((s) => s.id === 'size' || s.params.length);

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60 px-3 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-2xs font-bold uppercase tracking-wide text-slate-400">Обозначение</span>
          <span className="flex-1" />
          {violations.some((v) => v.level === 'error')
            ? <Chip tone="rose"><AlertTriangle className="w-3 h-3" /> {violations.filter((v) => v.level === 'error').length} ошиб.</Chip>
            : <Chip tone="emerald"><CircleCheck className="w-3 h-3" /> по каталогу</Chip>}
        </div>
        <div className="mt-1"><DesignationView family={family} values={values} onPick={readOnly ? undefined : pickPosition} active={active} sizeSep={sizeSep} /></div>
        {!readOnly && (
          <div className="mt-2 flex items-center gap-1.5">
            <Input value={raw} onChange={(e) => setRaw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applyRaw(); }}
              placeholder="Вставьте готовое обозначение — параметры заполнятся сами" className="font-mono" aria-label="Разобрать обозначение" />
            <Btn onClick={applyRaw} disabled={!raw.trim()} title="Разобрать строку в параметры"><Wand2 className="w-3.5 h-3.5" /> Разобрать</Btn>
          </div>
        )}
        {rawError && <div className="mt-1 text-2xs text-rose-600 dark:text-rose-400">{rawError}</div>}
        {designation && <div className="sr-only">{designation}</div>}
      </div>

      {violations.length > 0 && (
        <ul className="flex flex-col gap-1">
          {violations.map((v, i) => (
            <li key={v.ruleId + i} className={`flex items-start gap-1.5 text-2xs ${v.level === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-700 dark:text-amber-400'}`}>
              {v.level === 'error' ? <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> : <Info className="w-3 h-3 mt-0.5 shrink-0" />}
              <span>{v.message}{v.source ? <span className="text-slate-400"> · {v.source}</span> : null}</span>
            </li>
          ))}
        </ul>
      )}

      {steps.map((s) => (
        <div key={s.id} ref={(el) => { stepRefs.current[s.id] = el; }}>
          <SectionTitle>{textOf(s.title)}</SectionTitle>
          {s.id === 'size' && (
            <SizeStep family={family} full={full} shape={shape} limits={limits} readOnly={readOnly} set={set} setShape={setShape} sources={sources} />
          )}
          <div className={`grid gap-2 ${compact ? 'grid-cols-1' : 'grid-cols-1 @[640px]:grid-cols-2'}`}>
            {s.params.map((p) => (
              <ParamField key={p.key} family={family} p={p} values={values} full={full} set={set} readOnly={readOnly} source={sources[p.key]} highlight={active} />
            ))}
          </div>
        </div>
      ))}
      {!readOnly && Object.keys(values).some((k) => !k.startsWith('~')) && (
        <div className="pt-1"><Btn tone="ghost" onClick={() => onChange({})}><RotateCcw className="w-3.5 h-3.5" /> Сбросить параметры</Btn></div>
      )}
    </div>
  );
}

function SizeStep({ family, full, shape, limits, readOnly, set, setShape, sources }: {
  family: Family; full: ValveValues; shape: 'rect' | 'round'; limits: ReturnType<typeof sizeLimits>;
  readOnly?: boolean; set: (k: string, v: number | undefined) => void; setShape: (s: 'rect' | 'round') => void; sources: Record<string, string>;
}) {
  const hint = (k: 'W' | 'H' | 'D') => {
    const l = limits[k];
    if (l.series?.length) return `ряд: ${l.series.join(', ')}`;
    if (l.min === undefined && l.max === undefined) return '';
    return `${l.min ?? '…'}–${l.max === Infinity || l.max === undefined ? '…' : l.max} мм${l.step ? `, шаг ${l.step}` : ''}`;
  };
  const numField = (k: 'W' | 'H' | 'D', label: string) => {
    const v = num(full[k]);
    const l = limits[k];
    const near = v ? nearestSize(l, v) : 0;
    const off = !!v && near !== v;
    return (
      <label className="flex flex-col gap-1 min-w-0">
        <span className="text-2xs font-bold uppercase tracking-wide text-slate-400">{label}{sources[k] ? <span className="normal-case font-semibold text-sky-600 dark:text-sky-400"> · {SOURCE_LABEL[sources[k]] || sources[k]}</span> : null}</span>
        <Input type="number" min={0} value={v || ''} disabled={readOnly} onChange={(e) => set(k, e.target.value ? Number(e.target.value) : undefined)} className="tabular-nums" />
        <span className="text-2xs text-slate-400">{hint(k)}</span>
        {off && !readOnly && (
          <button type="button" onClick={() => set(k, near)} className="text-left text-2xs text-amber-700 dark:text-amber-400 hover:underline cursor-pointer">
            Вне каталога — взять {near}?
          </button>
        )}
      </label>
    );
  };
  return (
    <div className="flex flex-col gap-2 mb-2">
      {family.shapes.length > 1 && !readOnly && (
        <div className="inline-flex gap-1">
          {(['rect', 'round'] as const).filter((s) => family.shapes.includes(s)).map((s) => (
            <Btn key={s} tone={shape === s ? 'primary' : 'plain'} onClick={() => setShape(s)}>{s === 'rect' ? 'Прямоугольный' : 'Круглый'}</Btn>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 @[520px]:grid-cols-3 gap-2">
        {shape === 'round' ? numField('D', 'Диаметр D') : (<>{numField('W', 'Ширина')}{numField('H', 'Высота')}</>)}
      </div>
    </div>
  );
}

function ParamField({ family, p, values, full, set, readOnly, source, highlight }: {
  family: Family; p: ParamDef; values: ValveValues; full: ValveValues; set: (k: string, v: string | number | undefined) => void;
  readOnly?: boolean; source?: string; highlight?: string;
}) {
  const head = (
    <span className="text-2xs font-bold uppercase tracking-wide text-slate-400">
      {textOf(p.label)}
      {source ? <span className="normal-case font-semibold text-sky-600 dark:text-sky-400"> · {SOURCE_LABEL[source] || source}</span> : null}
    </span>
  );
  const inPosition = family.positions.find((pos) => pos.key === highlight)?.formats.some((f) => f.includes(`{${p.key}}`));
  const ring = inPosition ? 'ring-2 ring-emerald-400/60 rounded-lg' : '';
  if (p.kind !== 'choice') {
    return (
      <label className={`flex flex-col gap-1 min-w-0 p-1 ${ring}`}>
        {head}
        <Input type={p.kind === 'number' ? 'number' : 'text'} value={values[p.key] ?? ''} placeholder={p.default !== undefined ? String(p.default) : p.hint}
          disabled={readOnly} onChange={(e) => set(p.key, p.kind === 'number' ? (e.target.value ? Number(e.target.value) : undefined) : e.target.value)} className={p.kind === 'number' ? 'tabular-nums' : ''} />
        {p.hint && <span className="text-2xs text-slate-400">{p.hint}</span>}
      </label>
    );
  }
  const opts = optionsFor(family, p.key, values);
  const cur = String(full[p.key] ?? '');
  // Длинный ряд кодов (приводы воздушных клапанов — семь десятков) кнопками не
  // выбирается: список с поиском по коду и подписи
  if (opts.length > 12) {
    return (
      <label className={`flex flex-col gap-1 min-w-0 p-1 ${ring}`}>
        {head}
        <select value={cur} disabled={readOnly} onChange={(e) => set(p.key, e.target.value)}
          className="w-full min-w-0 px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-mono cursor-pointer">
          {!cur && <option value="">— выберите —</option>}
          {opts.map((o) => (
            <option key={o.value.code} value={o.value.code} disabled={!o.allowed} title={o.reason}>
              {o.value.code || '(нет)'} — {textOf(o.value.label)}{o.allowed ? '' : ' ⊘'}
            </option>
          ))}
        </select>
        {opts.find((o) => o.value.code === cur && !o.allowed) && <span className="text-2xs text-rose-600 dark:text-rose-400">{opts.find((o) => o.value.code === cur)!.reason}</span>}
      </label>
    );
  }
  return (
    <div className={`flex flex-col gap-1 min-w-0 p-1 ${ring}`}>
      {head}
      <div className="flex flex-wrap gap-1">
        {opts.map((o) => {
          const on = cur === o.value.code;
          return (
            <button key={o.value.code} type="button" disabled={readOnly} onClick={() => set(p.key, o.value.code)}
              title={o.allowed ? textOf(o.value.label) : `Нельзя: ${o.reason}`} aria-pressed={on}
              className={`px-2 py-1 rounded-md border text-2xs cursor-pointer text-left ${on
                ? o.allowed ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-rose-600 border-rose-600 text-white'
                : o.allowed ? 'border-slate-200 dark:border-slate-700 hover:border-emerald-400 text-slate-700 dark:text-slate-100' : 'border-dashed border-slate-200 dark:border-slate-700 text-slate-400 line-through'}`}>
              <b className="font-mono">{o.value.code || '—'}</b> <span className={on ? 'opacity-90' : 'text-slate-400'}>{textOf(o.value.label)}</span>
            </button>
          );
        })}
      </div>
      {opts.find((o) => o.value.code === cur && !o.allowed) && <span className="text-2xs text-rose-600 dark:text-rose-400">{opts.find((o) => o.value.code === cur)!.reason}</span>}
    </div>
  );
}

