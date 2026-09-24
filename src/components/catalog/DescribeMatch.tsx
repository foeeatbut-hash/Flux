/**
 * Подбор по описанию: любой текст → признаки → кандидаты → изделие.
 *
 * Всё, на что подбор опирался, видно: приметы подсвечены в самом тексте, и
 * снять ошибочную можно щелчком — подбор пересчитается без неё. Так инженер
 * проверяет решение глазами, а не верит на слово (flux-data-safety, п. 8).
 */
import React, { useMemo, useState } from 'react';
import { Check, HelpCircle, X, Sparkles } from 'lucide-react';
import type { Catalog, ValveValues } from '../../../catalog/model';
import { textOf } from '../../../catalog/model';
import { describe, summarize, type Hit, type Description } from '../../../catalog/describe';
import { matchDescription, type Candidate, type Learned } from '../../../catalog/match';
import { detectorsFor } from '../../../catalog/seed';
import { splitTagCell } from '../../../catalog/tags';
import Configurator from './Configurator';
import { Area, Btn, Chip, Confidence, Empty, Input, SectionTitle } from './ui';

export interface Accepted {
  familyId: string;
  values: ValveValues;
  text: string;
  tags: string[];
  qty: number;
  candidate: Candidate;
  /** Человек выбрал не первого кандидата или поправил параметры — это стоит запомнить */
  corrected: boolean;
}

const HIT_TONE: Record<string, string> = {
  kind: 'bg-emerald-100 dark:bg-emerald-950/50', function: 'bg-emerald-100 dark:bg-emerald-950/50',
  ei: 'bg-rose-100 dark:bg-rose-950/40', ex: 'bg-amber-100 dark:bg-amber-950/40',
};

/** Текст с подсветкой примет: щелчок по примете снимает её */
function Highlighted({ text, hits, size, onToggle }: { text: string; hits: Hit[]; size?: { from: number; to: number }; onToggle: (i: number) => void }) {
  const marks = [...hits.map((h, i) => ({ from: h.from, to: h.to, i, h })), ...(size ? [{ from: size.from, to: size.to, i: -1, h: null as Hit | null }] : [])]
    .sort((a, b) => a.from - b.from);
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.from < at) continue;
    if (m.from > at) out.push(<span key={`t${at}`}>{text.slice(at, m.from)}</span>);
    out.push(m.h ? (
      <button key={`h${m.i}`} type="button" onClick={() => onToggle(m.i)} title={`${m.h.key} = ${String(m.h.value)}${m.h.off ? ' (снято)' : ' — щёлкните, чтобы снять'}`}
        className={`rounded px-0.5 cursor-pointer ${m.h.off ? 'line-through opacity-50' : HIT_TONE[m.h.key] || 'bg-sky-100 dark:bg-sky-950/40'}`}>
        {text.slice(m.from, m.to)}
      </button>
    ) : (
      <mark key="size" className="rounded px-0.5 bg-sky-200 dark:bg-sky-900/60 text-inherit" title="Размер">{text.slice(m.from, m.to)}</mark>
    ));
    at = m.to;
  }
  if (at < text.length) out.push(<span key="tail">{text.slice(at)}</span>);
  return <div className="text-xs leading-relaxed whitespace-pre-wrap break-words u-sel">{out}</div>;
}

export default function DescribeMatch({ catalog, classId, learned, onAccept, acceptLabel = 'Добавить в ведомость', initialText = '' }: {
  catalog: Catalog; classId: string; learned?: Learned[]; onAccept: (a: Accepted) => void; acceptLabel?: string; initialText?: string;
}) {
  const cls = catalog.classes.find((c) => c.id === classId);
  const [text, setText] = useState(initialText);
  const [off, setOff] = useState<Set<number>>(new Set());
  const [pick, setPick] = useState(0);
  const [edited, setEdited] = useState<ValveValues | null>(null);
  const [tagsText, setTagsText] = useState('');
  const [qty, setQty] = useState<number | ''>('');

  const base: Description | null = useMemo(() => (text.trim() ? describe(text, detectorsFor(cls?.code || 'valve')) : null), [text, cls]);
  const d = useMemo(() => {
    if (!base) return null;
    const hits = base.hits.map((h, i) => ({ ...h, off: off.has(i) }));
    const tags = tagsText.trim() ? splitTagCell(tagsText).tags : base.tags;
    return summarize(base.text, hits, base.sizes, tags, base.productCode);
  }, [base, off, tagsText]);
  const candidates = useMemo(() => (d ? matchDescription(catalog, d, { classId, learned, limit: 6 }) : []), [catalog, d, classId, learned]);
  const cand = candidates[pick];
  const fam = cand ? catalog.families.find((f) => f.id === cand.familyId) : undefined;
  const values = edited || cand?.values || {};

  const reset = (t: string) => { setText(t); setOff(new Set()); setPick(0); setEdited(null); };
  const accept = () => {
    if (!cand || !fam || !d) return;
    const tags = d.tags;
    onAccept({
      familyId: fam.id, values, text: d.text, tags, qty: Number(qty) || tags.length || 1, candidate: cand,
      corrected: pick !== 0 || edited !== null,
    });
    reset(''); setTagsText(''); setQty('');
  };

  return (
    <div className="grid grid-cols-1 @[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4 min-w-0">
      <div className="flex flex-col gap-2 min-w-0">
        <Area rows={6} value={text} onChange={(e) => reset(e.target.value)} aria-label="Описание изделия"
          placeholder={'Вставьте описание в любом виде — строку MTO, письмо, ТЗ, по-русски или по-английски.\nНапример: «Клапан противопожарный НО, EI 60, 900x400, взрывозащищённый, привод с пружиной 24 В»'} />
        <div className="grid grid-cols-[minmax(0,1fr)_90px] gap-2">
          <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder={d?.tags.length ? `теги из текста: ${d.tags.join(', ')}` : 'Теги (через запятую или пробел)'} className="font-mono" aria-label="Теги" />
          <Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value ? Number(e.target.value) : '')} placeholder={`кол-во${d?.tags.length ? `: ${d.tags.length}` : ''}`} className="tabular-nums" aria-label="Количество" />
        </div>
        {d && base && (
          <>
            <SectionTitle>Что нашлось в тексте</SectionTitle>
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-2 max-h-56 overflow-auto">
              <Highlighted text={base.text} hits={d.hits} size={d.size} onToggle={(i) => { const n = new Set(off); n.has(i) ? n.delete(i) : n.add(i); setOff(n); setEdited(null); }} />
            </div>
            <div className="flex flex-wrap gap-1">
              {d.size && <Chip tone="sky">{d.size.D ? `Ø${d.size.D}` : `${d.size.W}×${d.size.H}`}</Chip>}
              {Object.entries(d.facts).filter(([k]) => k !== 'shape').map(([k, v]) => {
                const def = cls?.facts.find((f) => f.key === k);
                const named = def?.values?.find((x) => x.code === String(v));
                return <Chip key={k} tone="emerald">{def ? textOf(def.label) : k}: {named ? textOf(named.label) : typeof v === 'boolean' ? (v ? 'да' : 'нет') : String(v)}</Chip>;
              })}
              {d.tagTypes.map((t) => <Chip key={t}>тег {t}</Chip>)}
              {d.productCode && <Chip>{d.productCode}</Chip>}
            </div>
            {d.conflicts.length > 0 && (
              <div className="text-2xs text-amber-700 dark:text-amber-400">
                Текст противоречит сам себе: {d.conflicts.map((c) => `${c.key} — ${c.values.join(' / ')}`).join('; ')}. Снимите лишнюю примету щелчком.
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col gap-2 min-w-0">
        {!d && <Empty title="Кандидаты появятся здесь" text="Подбор сравнивает признаки описания с каждым семейством Каталога и объясняет выбор." />}
        {d && candidates.length > 0 && (
          <>
            <SectionTitle>Кандидаты</SectionTitle>
            <div className="flex flex-col gap-1">
              {candidates.map((c, i) => {
                const f = catalog.families.find((x) => x.id === c.familyId)!;
                return (
                  <button key={c.familyId} type="button" onClick={() => { setPick(i); setEdited(null); }} aria-pressed={pick === i}
                    className={`text-left rounded-lg border px-2.5 py-1.5 cursor-pointer ${pick === i ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30' : 'border-slate-200 dark:border-slate-700 hover:border-emerald-400'} ${c.rejected ? 'opacity-60' : ''}`}>
                    <div className="flex items-center gap-2 min-w-0">
                      <b className="font-mono text-xs text-slate-800 dark:text-slate-100">{f.code}</b>
                      <Confidence value={c.confidence} />
                      {c.rejected && <Chip tone="rose">противоречит</Chip>}
                      <span className="flex-1" />
                      <span className="text-2xs text-slate-400 tabular-nums">{c.score.toFixed(1)}</span>
                    </div>
                    <div className="font-mono text-2xs text-slate-500 dark:text-slate-400 break-all mt-0.5">{c.designation}</div>
                  </button>
                );
              })}
            </div>
            {cand && fam && (
              <>
                <SectionTitle>Почему {fam.code}</SectionTitle>
                <ul className="flex flex-col gap-0.5">
                  {cand.reasons.map((r, i) => (
                    <li key={i} className={`flex items-start gap-1.5 text-2xs ${r.status === 'mismatch' ? 'text-rose-600 dark:text-rose-400' : r.status === 'unknown' ? 'text-slate-400' : r.status === 'learned' ? 'text-sky-600 dark:text-sky-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
                      {r.status === 'mismatch' ? <X className="w-3 h-3 mt-0.5 shrink-0" /> : r.status === 'unknown' ? <HelpCircle className="w-3 h-3 mt-0.5 shrink-0" /> : r.status === 'learned' ? <Sparkles className="w-3 h-3 mt-0.5 shrink-0" /> : <Check className="w-3 h-3 mt-0.5 shrink-0" />}
                      <span>{r.text}</span>
                    </li>
                  ))}
                </ul>
                {cand.questions.length > 0 && (
                  <div className="text-2xs text-amber-700 dark:text-amber-400">В описании не сказано: {cand.questions.map((q) => q.label).join(', ')} — выберите ниже.</div>
                )}
                <SectionTitle right={<Btn tone="primary" onClick={accept}><Check className="w-3.5 h-3.5" /> {acceptLabel}</Btn>}>Изделие</SectionTitle>
                <Configurator family={fam} values={values} onChange={setEdited} sources={edited ? {} : cand.sources} compact />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
