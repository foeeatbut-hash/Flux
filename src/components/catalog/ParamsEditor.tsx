/**
 * Редактор параметров и позиций обозначения семейства.
 *
 * Код параметра — то, что пишется в строку обозначения; подпись — то, что
 * видит человек; признаки — то, по чему подбор узнаёт код в описании;
 * синонимы — слова, которые инженер добавил, когда признаков не хватило.
 */
import React, { useState } from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown, ChevronDown, ChevronRight } from 'lucide-react';
import type { Family, ParamDef, ParamValue, Position, Facts, EquipmentClass } from '../../../catalog/model';
import { WIZARD_STEPS, textOf } from '../../../catalog/model';
import { Btn, Chip, Field, Input, Select, SectionTitle } from './ui';

function move<T>(list: T[], i: number, d: number): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Признаки строкой «ключ=значение; …» — короче, чем форма на каждый */
export function factsToText(f?: Facts): string {
  return Object.entries(f || {}).map(([k, v]) => `${k}=${String(v)}`).join('; ');
}
export function textToFacts(s: string): Facts {
  const out: Facts = {};
  for (const part of s.split(';')) {
    const [k, ...rest] = part.split('=');
    const key = k?.trim();
    if (!key) continue;
    const raw = rest.join('=').trim();
    out[key] = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && !Number.isNaN(Number(raw)) && !raw.includes('|') ? Number(raw) : raw;
  }
  return out;
}

function ValueRow({ v, onChange, onDelete, onUp, onDown, readOnly }: { v: ParamValue; onChange: (v: ParamValue) => void; onDelete: () => void; onUp: () => void; onDown: () => void; readOnly?: boolean }) {
  return (
    <tr className="border-t border-slate-100 dark:border-slate-850 align-top">
      <td className="p-1 w-24"><Input value={v.code} onChange={(e) => onChange({ ...v, code: e.target.value })} className="font-mono" disabled={readOnly} aria-label="Код" /></td>
      <td className="p-1"><Input value={v.label.ru} onChange={(e) => onChange({ ...v, label: { ...v.label, ru: e.target.value } })} disabled={readOnly} aria-label="Подпись" /></td>
      <td className="p-1 hidden @[900px]:table-cell"><Input value={v.label.en || ''} onChange={(e) => onChange({ ...v, label: { ...v.label, en: e.target.value } })} disabled={readOnly} aria-label="Подпись англ." /></td>
      <td className="p-1"><Input value={(v.synonyms || []).join(', ')} placeholder="НО, normally open" onChange={(e) => onChange({ ...v, synonyms: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} disabled={readOnly} aria-label="Синонимы" /></td>
      <td className="p-1 hidden @[1100px]:table-cell"><Input value={factsToText(v.facts)} placeholder="ex=true; voltage=24" onChange={(e) => onChange({ ...v, facts: textToFacts(e.target.value) })} className="font-mono" disabled={readOnly} aria-label="Признаки" /></td>
      <td className="p-1 whitespace-nowrap">
        <label className="inline-flex items-center gap-1 text-2xs text-slate-400 cursor-pointer" title="Старый код: разбирается, но не предлагается">
          <input type="checkbox" checked={!!v.deprecated} onChange={(e) => onChange({ ...v, deprecated: e.target.checked })} disabled={readOnly} /> старый
        </label>
        {!readOnly && (
          <span className="inline-flex">
            <Btn tone="ghost" onClick={onUp} aria-label="Выше"><ArrowUp className="w-3 h-3" /></Btn>
            <Btn tone="ghost" onClick={onDown} aria-label="Ниже"><ArrowDown className="w-3 h-3" /></Btn>
            <Btn tone="ghost" onClick={onDelete} aria-label="Удалить код"><Trash2 className="w-3 h-3" /></Btn>
          </span>
        )}
      </td>
    </tr>
  );
}

function ParamBlock({ p, onChange, onDelete, readOnly }: { p: ParamDef; onChange: (p: ParamDef) => void; onDelete: () => void; readOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const values = p.values || [];
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-xs cursor-pointer min-w-0 flex-1 text-left">
          {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
          <b className="font-mono">{p.key}</b>
          <span className="text-slate-500 dark:text-slate-400 truncate">{textOf(p.label)}</span>
        </button>
        <Chip>{p.kind === 'choice' ? `${values.length} код.` : p.kind === 'number' ? 'число' : 'текст'}</Chip>
        {p.default !== undefined && <Chip tone="sky">по умолч. {String(p.default) || '(нет)'}</Chip>}
        {!readOnly && <Btn tone="ghost" onClick={onDelete} aria-label="Удалить параметр"><Trash2 className="w-3 h-3" /></Btn>}
      </div>
      {open && (
        <div className="px-2 pb-2 flex flex-col gap-2">
          <div className="grid grid-cols-2 @[700px]:grid-cols-5 gap-2">
            <Field label="Ключ"><Input value={p.key} onChange={(e) => onChange({ ...p, key: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} className="font-mono" disabled={readOnly} /></Field>
            <Field label="Подпись"><Input value={p.label.ru} onChange={(e) => onChange({ ...p, label: { ...p.label, ru: e.target.value } })} disabled={readOnly} /></Field>
            <Field label="Подпись (EN)"><Input value={p.label.en || ''} onChange={(e) => onChange({ ...p, label: { ...p.label, en: e.target.value } })} disabled={readOnly} /></Field>
            <Field label="Шаг мастера">
              <Select value={p.step || 'options'} onChange={(v) => onChange({ ...p, step: v as any })} disabled={readOnly} options={WIZARD_STEPS.map((s) => ({ value: s.id, label: textOf(s.title) }))} />
            </Field>
            <Field label="По умолчанию">
              {p.kind === 'choice'
                ? <Select value={p.default === undefined ? '__none' : String(p.default)} disabled={readOnly} onChange={(v) => onChange({ ...p, default: v === '__none' ? undefined : v })}
                    options={[{ value: '__none', label: '— спросить —' }, ...values.map((x) => ({ value: x.code, label: x.code || '(пусто)' }))]} />
                : <Input value={p.default === undefined ? '' : String(p.default)} disabled={readOnly} onChange={(e) => onChange({ ...p, default: e.target.value === '' ? undefined : p.kind === 'number' ? Number(e.target.value) : e.target.value })} />}
            </Field>
          </div>
          {p.kind === 'choice' && (
            <div className="overflow-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-2xs uppercase tracking-wide text-slate-400">
                  <th className="p-1">Код</th><th className="p-1">Подпись</th><th className="p-1 hidden @[900px]:table-cell">EN</th><th className="p-1">Синонимы</th><th className="p-1 hidden @[1100px]:table-cell">Признаки</th><th className="p-1"></th>
                </tr></thead>
                <tbody>
                  {values.map((v, i) => (
                    <ValueRow key={i} v={v} readOnly={readOnly}
                      onChange={(nv) => onChange({ ...p, values: values.map((x, j) => (j === i ? nv : x)) })}
                      onDelete={() => onChange({ ...p, values: values.filter((_, j) => j !== i) })}
                      onUp={() => onChange({ ...p, values: move(values, i, -1) })}
                      onDown={() => onChange({ ...p, values: move(values, i, 1) })} />
                  ))}
                </tbody>
              </table>
              {!readOnly && <Btn onClick={() => onChange({ ...p, values: [...values, { code: '', label: { ru: '' } }] })}><Plus className="w-3 h-3" /> Код</Btn>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ParamsEditor({ family, onChange, readOnly }: { family: Family; onChange: (f: Family) => void; readOnly?: boolean }) {
  const params = family.params;
  return (
    <div className="flex flex-col gap-1.5">
      {params.map((p, i) => (
        <ParamBlock key={i} p={p} readOnly={readOnly}
          onChange={(np) => onChange({ ...family, params: params.map((x, j) => (j === i ? np : x)) })}
          onDelete={() => onChange({ ...family, params: params.filter((_, j) => j !== i) })} />
      ))}
      {!readOnly && (
        <div className="flex gap-1.5">
          <Btn onClick={() => onChange({ ...family, params: [...params, { key: `p${params.length + 1}`, label: { ru: 'Новый параметр' }, kind: 'choice', values: [], step: 'options' }] })}><Plus className="w-3 h-3" /> Параметр с кодами</Btn>
          <Btn onClick={() => onChange({ ...family, params: [...params, { key: `n${params.length + 1}`, label: { ru: 'Число' }, kind: 'number', step: 'options' }] })}><Plus className="w-3 h-3" /> Числовой</Btn>
          <Btn onClick={() => onChange({ ...family, params: [...params, { key: `t${params.length + 1}`, label: { ru: 'Текст' }, kind: 'text', step: 'options' }] })}><Plus className="w-3 h-3" /> Текстовый</Btn>
        </div>
      )}
    </div>
  );
}

/**
 * Позиции обозначения: в каком порядке и как пишутся параметры. Формат — это
 * шаблон: `{purpose}`, `{W}{x}{H}` (x — знак размера), `{driveCount}*{drive}`.
 * Несколько записей одной позиции — через «|».
 */
export function PositionsEditor({ family, onChange, readOnly }: { family: Family; onChange: (f: Family) => void; readOnly?: boolean }) {
  const list = family.positions;
  const set = (i: number, p: Position) => onChange({ ...family, positions: list.map((x, j) => (j === i ? p : x)) });
  const keys = new Set(family.params.map((p) => p.key));
  return (
    <div className="flex flex-col gap-1">
      <div className="text-2xs text-slate-400">Позиции пишутся через дефис по порядку. В формате: {'{параметр}'}, {'{x}'} — знак размера, остальное — как есть. Несколько вариантов записи — через «|».</div>
      {list.map((p, i) => {
        const unknown = p.formats.flatMap((f) => [...f.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1])).filter((k) => k !== 'x' && !keys.has(k));
        return (
          <div key={i} className="grid grid-cols-[28px_minmax(0,120px)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-1.5 items-center">
            <span className="text-2xs text-slate-400 tabular-nums text-right">{i + 1}</span>
            <Input value={p.key} onChange={(e) => set(i, { ...p, key: e.target.value })} className="font-mono" disabled={readOnly} aria-label="Ключ позиции" />
            <Input value={p.label.ru} onChange={(e) => set(i, { ...p, label: { ...p.label, ru: e.target.value } })} disabled={readOnly} aria-label="Подпись позиции" />
            <div className="flex flex-col">
              <Input value={p.formats.join(' | ')} onChange={(e) => set(i, { ...p, formats: e.target.value.split('|').map((s) => s.trim()).filter(Boolean) })} className="font-mono" disabled={readOnly} aria-label="Формат" />
              {unknown.length > 0 && <span className="text-2xs text-rose-600 dark:text-rose-400">нет параметра: {unknown.join(', ')}</span>}
            </div>
            <span className="inline-flex items-center">
              <label className="inline-flex items-center gap-1 text-2xs text-slate-400 cursor-pointer mr-1" title="Позиция может отсутствовать в строке"><input type="checkbox" checked={!!p.optional} onChange={(e) => set(i, { ...p, optional: e.target.checked })} disabled={readOnly} /> необяз.</label>
              {!readOnly && (<>
                <Btn tone="ghost" onClick={() => onChange({ ...family, positions: move(list, i, -1) })} aria-label="Выше"><ArrowUp className="w-3 h-3" /></Btn>
                <Btn tone="ghost" onClick={() => onChange({ ...family, positions: move(list, i, 1) })} aria-label="Ниже"><ArrowDown className="w-3 h-3" /></Btn>
                <Btn tone="ghost" onClick={() => onChange({ ...family, positions: list.filter((_, j) => j !== i) })} aria-label="Удалить позицию"><Trash2 className="w-3 h-3" /></Btn>
              </>)}
            </span>
          </div>
        );
      })}
      {!readOnly && <div><Btn onClick={() => onChange({ ...family, positions: [...list, { key: `pos${list.length + 1}`, label: { ru: 'Позиция' }, formats: ['{…}'] }] })}><Plus className="w-3 h-3" /> Позиция</Btn></div>}
    </div>
  );
}

/** Профиль подбора: по чему семейство отличают от соседей */
export function MatchEditor({ family, cls, onChange, readOnly }: { family: Family; cls?: EquipmentClass; onChange: (f: Family) => void; readOnly?: boolean }) {
  const m = family.match;
  const list = (v?: string[]) => (v || []).join(', ');
  const parse = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const kinds = cls?.facts.find((f) => f.key === 'kind')?.values || [];
  const fns = cls?.facts.find((f) => f.key === 'function')?.values || [];
  return (
    <div className="grid grid-cols-1 @[700px]:grid-cols-2 gap-2">
      <Field label="Род (какие описания семейство обслуживает)" hint={kinds.map((k) => `${k.code} — ${textOf(k.label)}`).join('; ')}>
        <Input value={list(m.kinds)} onChange={(e) => onChange({ ...family, match: { ...m, kinds: parse(e.target.value) } })} className="font-mono" disabled={readOnly} />
      </Field>
      <Field label="Назначения" hint={fns.map((k) => `${k.code} — ${textOf(k.label)}`).join('; ')}>
        <Input value={list(m.functions)} onChange={(e) => onChange({ ...family, match: { ...m, functions: parse(e.target.value) } })} className="font-mono" disabled={readOnly} />
      </Field>
      <Field label="Коды типа в теге" hint="DF, DS, DV…">
        <Input value={list(m.tagTypes)} onChange={(e) => onChange({ ...family, match: { ...m, tagTypes: parse(e.target.value).map((x) => x.toUpperCase()) } })} className="font-mono" disabled={readOnly} />
      </Field>
      <Field label="Префиксы кода продукции MTO" hint="VVFIP, VFLA1…">
        <Input value={list(m.productPrefixes)} onChange={(e) => onChange({ ...family, match: { ...m, productPrefixes: parse(e.target.value) } })} className="font-mono" disabled={readOnly} />
      </Field>
      <Field label="Ключевые слова" hint="слово в описании прямо указывает на семейство">
        <Input value={list(m.keywords)} onChange={(e) => onChange({ ...family, match: { ...m, keywords: parse(e.target.value) } })} disabled={readOnly} />
      </Field>
      <Field label="Поправка веса" hint="отрицательная — у «запасного» семейства, чтобы узкое побеждало">
        <Input type="number" step="0.5" value={m.bias ?? 0} onChange={(e) => onChange({ ...family, match: { ...m, bias: Number(e.target.value) || 0 } })} disabled={readOnly} />
      </Field>
      <Field label="Обязательно в описании" hint="признаки: blade=petal; heating=true">
        <Input value={factsToText(m.require)} onChange={(e) => onChange({ ...family, match: { ...m, require: textToFacts(e.target.value) } })} className="font-mono" disabled={readOnly} />
      </Field>
      <Field label="Исключает семейство" hint="ex=true — не бывает взрывозащищённым">
        <Input value={factsToText(m.exclude)} onChange={(e) => onChange({ ...family, match: { ...m, exclude: textToFacts(e.target.value) } })} className="font-mono" disabled={readOnly} />
      </Field>
      <Field label="Признаки семейства в целом" hint="ei=90; pressure=2000">
        <Input value={factsToText(family.facts)} onChange={(e) => onChange({ ...family, facts: textToFacts(e.target.value) })} className="font-mono" disabled={readOnly} />
      </Field>
      <Field label="Старые обозначения" hint="через запятую: как семейство называли раньше">
        <Input value={list(family.aliases)} onChange={(e) => onChange({ ...family, aliases: parse(e.target.value) })} disabled={readOnly} />
      </Field>
      <SectionTitle>Признаки класса</SectionTitle>
      <div className="@[700px]:col-span-2 flex flex-wrap gap-1">
        {(cls?.facts || []).map((f) => <Chip key={f.key} title={f.values?.map((v) => `${v.code} — ${textOf(v.label)}`).join('\n')}>{f.key} · {textOf(f.label)}</Chip>)}
      </div>
    </div>
  );
}
