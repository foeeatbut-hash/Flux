/**
 * Выбор семейства: отбор по роду и назначению, поиск по коду и старым
 * обозначениям. Первый шаг мастера и замена семейства у готовой позиции.
 */
import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { Catalog, Family } from '../../../catalog/model';
import { textOf } from '../../../catalog/model';
import { Chip, StatusChip } from './ui';

export default function FamilyPicker({ catalog, classId, value, onPick, compact }: {
  catalog: Catalog; classId?: string; value?: string; onPick: (f: Family) => void; compact?: boolean;
}) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const cls = catalog.classes.find((c) => c.id === classId) || catalog.classes[0];
  const kinds = cls?.facts.find((f) => f.key === 'kind')?.values || [];
  const families = useMemo(() => {
    const low = q.trim().toLowerCase();
    return catalog.families
      .filter((f) => !cls || f.classId === cls.id)
      .filter((f) => !kind || f.kind === kind)
      .filter((f) => !low || [f.code, textOf(f.title), textOf(f.description), ...(f.aliases || [])].some((s) => s.toLowerCase().includes(low)))
      .sort((a, b) => (a.sort || 0) - (b.sort || 0));
  }, [catalog, cls, kind, q]);
  const mf = (id: string) => catalog.manufacturers.find((m) => m.id === id)?.shortName || '';

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 flex-1 min-w-[160px]">
          <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Код, название, старое обозначение…" className="flex-1 min-w-0 bg-transparent text-xs outline-none" />
        </label>
      </div>
      <div className="flex flex-wrap gap-1">
        <button type="button" onClick={() => setKind('')} className={`px-2 py-0.5 rounded-full text-2xs font-semibold border cursor-pointer ${!kind ? 'bg-emerald-600 text-white border-emerald-600' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}`}>все</button>
        {kinds.map((k) => (
          <button key={k.code} type="button" onClick={() => setKind(k.code === kind ? '' : k.code)}
            className={`px-2 py-0.5 rounded-full text-2xs font-semibold border cursor-pointer ${kind === k.code ? 'bg-emerald-600 text-white border-emerald-600' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-emerald-400'}`}>
            {textOf(k.label)}
          </button>
        ))}
      </div>
      <div className={`grid gap-1.5 ${compact ? 'grid-cols-1' : 'grid-cols-1 @[560px]:grid-cols-2 @[900px]:grid-cols-3'}`}>
        {families.map((f) => (
          <button key={f.id} type="button" onClick={() => onPick(f)} aria-pressed={value === f.id}
            className={`text-left rounded-lg border px-2.5 py-2 cursor-pointer min-w-0 ${value === f.id ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30' : 'border-slate-200 dark:border-slate-700 hover:border-emerald-400'}`}>
            <div className="flex items-center gap-1.5 min-w-0">
              <b className="font-mono text-xs text-slate-800 dark:text-slate-100">{f.code}</b>
              <span className="text-2xs text-slate-400">{mf(f.manufacturerId)}</span>
              <span className="flex-1" />
              {f.facts?.ei ? <Chip tone="sky">EI {String(f.facts.ei)}</Chip> : null}
              <StatusChip status={f.status} />
            </div>
            <div className="text-2xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{textOf(f.description) || textOf(f.title)}</div>
          </button>
        ))}
        {!families.length && <div className="text-xs text-slate-400 px-1 py-2">Ничего не найдено — снимите отбор или измените поиск.</div>}
      </div>
    </div>
  );
}
