/**
 * Левая колонка «Схемы» (docs/e3-integration.md, 6.2): что выгружать. Вид «по
 * установкам» или «по типам», поиск, профиль одной строкой, знак состояния у
 * каждого узла и флажок «брать в выгрузку». Позиции без решения по природе не
 * перечисляются — они считаются одной строкой внизу.
 */
import React, { useMemo, useState } from 'react';
import { NODE_STATES } from '../../../e3/nodeState';
import type { E3Profile, E3SolutionBook } from '../../../e3/solutionTypes';
import { classById, classOrder } from '../../../equipment/classes';
import { Input, Seg } from '../ui';
import type { SchemeUnit } from './useSchemeData';

const muted = 'text-slate-500 dark:text-slate-400';

/** Профиль одной строкой: «Способ пуска ПЧИ · Концевые КП2» — только заданные ответы */
export function profileLine(book: E3SolutionBook, answers: E3Profile): string {
  const parts = book.features.filter((f) => f.kind === 'profile' && typeof answers[f.id] === 'string' && answers[f.id]).map((f) => `${f.title.toLocaleLowerCase('ru')} ${answers[f.id] as string}`);
  return parts.length ? parts.slice(0, 4).join(' · ') + (parts.length > 4 ? ` · ещё ${parts.length - 4}` : '') : 'Профиль не задан';
}

export default function E3SchemeList({ units, skipped, off, selected, profile, onSelect, onToggle, onOpenProfile }: {
  units: SchemeUnit[]; skipped: number; off: Record<string, true>; selected: string; profile: string;
  onSelect: (id: string) => void; onToggle: (ids: string[], on: boolean) => void; onOpenProfile: () => void;
}) {
  const [view, setView] = useState<'units' | 'types'>('units');
  const [q, setQ] = useState('');
  const low = q.trim().toLocaleLowerCase('ru');
  const groups = useMemo(() => {
    const match = (n: SchemeUnit['nodes'][number]) => !low || `${n.label} ${n.name} ${n.selection.solution?.name || ''}`.toLocaleLowerCase('ru').includes(low);
    if (view === 'units') return units.map((u) => ({ id: u.id, title: u.name, nodes: u.nodes.filter(match) })).filter((g) => g.nodes.length);
    const by = new Map<string, SchemeUnit['nodes']>();
    for (const n of units.flatMap((u) => u.nodes).filter(match)) by.set(n.cls, [...(by.get(n.cls) || []), n]);
    return [...by.entries()].sort((a, b) => classOrder(a[0]) - classOrder(b[0])).map(([cls, nodes]) => ({ id: cls, title: classById(cls).title, nodes }));
  }, [units, view, low]);

  return (
    <aside className="fx-side flex w-64 shrink-0 flex-col gap-2 overflow-hidden p-3" aria-label="Что выгружать">
      <div className="fx-field shrink-0"><Seg label="Вид списка" value={view} onChange={setView} options={[{ value: 'units', label: 'по установкам' }, { value: 'types', label: 'по типам' }]} /></div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Тег, название, решение" aria-label="Поиск в списке" className="shrink-0" />
      <button type="button" onClick={onOpenProfile} title="Профиль автоматизации проекта — на вкладке «Подбор по проекту»" className={`shrink-0 truncate text-left text-xs ${muted} hover:underline`}>{profile}</button>
      <div className="min-h-0 flex-1 overflow-auto">
        {!groups.length ? <p className={`py-2 text-xs ${muted}`}>{units.length ? 'Ничего не найдено.' : 'В проекте нет оборудования, для которого есть типовые решения.'}</p> : groups.map((g) => {
          const ids = g.nodes.map((n) => n.id);
          const all = ids.every((id) => !off[id]);
          return (
            <div key={g.id}>
              <label className="fx-gh"><input type="checkbox" className="accent-emerald-600" checked={all} onChange={() => onToggle(ids, !all)} aria-label={`Брать в выгрузку: ${g.title}`} /><span className="min-w-0 flex-1 truncate">{g.title}</span><span className="tabular-nums">{ids.length}</span></label>
              {g.nodes.map((n) => (
                <div key={n.id} className="fx-li" role="button" tabIndex={0} aria-current={selected === n.id} onClick={() => onSelect(n.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(n.id); } }} title={`${NODE_STATES[n.state].title}: ${NODE_STATES[n.state].hint}`}>
                  <input type="checkbox" className="accent-emerald-600" checked={!off[n.id]} onClick={(e) => e.stopPropagation()} onChange={() => onToggle([n.id], !!off[n.id])} aria-label={`Брать в выгрузку: ${n.label || n.name}`} />
                  <span className="min-w-0 flex-1 truncate"><span className="font-mono">{n.label || '—'}</span> <span className={muted}>{n.selection.solution?.name || (n.selection.status === 'many' ? 'нужен ответ' : 'нет решения')}</span></span>
                  <span className="fx-n !text-[13px]" aria-label={NODE_STATES[n.state].title}>{NODE_STATES[n.state].mark}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {skipped > 0 && <p className={`shrink-0 text-xs ${muted}`} title="Шумоглушитель, секция, двигатель внутри блока: типового решения у них нет и не нужно">не участвуют в схеме: {skipped}</p>}
    </aside>
  );
}
