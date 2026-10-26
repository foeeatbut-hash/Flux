/** Навигация читателя: типы оборудования с подтипами и изготовители. Выбор меняет список справа, и никогда наоборот. */
import React from 'react';
import { Boxes, Factory, Fan, Gauge, LayoutGrid } from 'lucide-react';
import type { Catalog } from '../../../../catalog/model';
import { textOf } from '../../../../catalog/model';
import type { Filters, NavCounts } from './readerModel';

const CLASS_ICON: Record<string, React.ComponentType<{ className?: string }>> = { valve: Gauge, fan: Fan };
const iconOf = (code: string) => CLASS_ICON[code] || Boxes;

export default function CatalogNav({ catalog, filters, counts, total, onChange }: {
  catalog: Catalog; filters: Filters; counts: NavCounts; total: number; onChange: (patch: Partial<Filters>) => void;
}) {
  const makers = [...counts.makers.entries()].sort((a, b) => a[1].title.localeCompare(b[1].title, 'ru'));
  const anyPicked = !!(filters.classId || filters.kindId || filters.makerKey);
  return <nav aria-label="Навигация по каталогу" className="flex min-h-0 flex-col gap-1 overflow-auto p-2">
    <button type="button" className="fx-li" aria-current={!anyPicked} onClick={() => onChange({ classId: '', kindId: '', makerKey: '' })}>
      <LayoutGrid /><span className="truncate">Всё оборудование</span><span className="fx-n">{total}</span>
    </button>
    <div className="fx-gh mt-2">Типы оборудования</div>
    {catalog.classes.map((cls) => {
      const Icon = iconOf(cls.code);
      const picked = filters.classId === cls.id;
      const kinds = (cls.facts.find((f) => f.key === 'kind')?.values || []).filter((v) => counts.kinds.has(v.code));
      return <div key={cls.id}>
        <button type="button" className="fx-li" aria-current={picked && !filters.kindId} aria-expanded={picked && kinds.length > 1}
          onClick={() => onChange({ classId: picked && !filters.kindId ? '' : cls.id, kindId: '' })}>
          <Icon /><span className="truncate">{textOf(cls.title)}</span><span className="fx-n">{counts.classes.get(cls.id) || 0}</span>
        </button>
        {/* Подтипы раскрываются под выбранным типом; высота — единственное, что здесь анимируется */}
        <div className="cat-collapse" data-open={picked && kinds.length > 1}>
          <div role="group" aria-label={`Подтипы: ${textOf(cls.title)}`} inert={!(picked && kinds.length > 1)} className="ml-4 border-l border-[var(--flux-line)] pl-1">
            {kinds.map((v) => <button key={v.code} type="button" className="fx-li" aria-current={filters.kindId === v.code} onClick={() => onChange({ classId: cls.id, kindId: filters.kindId === v.code ? '' : v.code })}>
              <span className="truncate">{textOf(v.label)}</span><span className="fx-n">{counts.kinds.get(v.code) || 0}</span>
            </button>)}
          </div>
        </div>
      </div>;
    })}
    <div className="fx-gh mt-2">Изготовители</div>
    {makers.map(([key, m]) => <button key={key} type="button" className="fx-li" aria-current={filters.makerKey === key} onClick={() => onChange({ makerKey: filters.makerKey === key ? '' : key })}>
      <Factory /><span className="truncate">{m.title}</span><span className="fx-n">{m.count}</span>
    </button>)}
    {!makers.length && <p className="px-2 text-xs text-[var(--flux-text-muted)]">Изготовителей в этой выборке нет.</p>}
  </nav>;
}
