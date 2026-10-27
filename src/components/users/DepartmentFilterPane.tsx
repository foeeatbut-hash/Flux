import React from 'react';
import { Users, UserX } from 'lucide-react';
import DepartmentTree from './DepartmentTree';
import type { DepartmentRow } from '../../services/departmentService';
import { subtreeIds } from '../../../shared/departments';

/**
 * Фильтр-дерево слева от списка сотрудников. Значение: '' — все, 'none' — без
 * подразделения, иначе номер подразделения (выбирает и всё, что внутри него).
 */
export type DepartmentFilter = '' | 'none' | string;

export function matchesDepartmentFilter(filter: DepartmentFilter, departmentId: string | null | undefined, departments: DepartmentRow[]): boolean {
  if (!filter) return true;
  if (filter === 'none') return !departmentId;
  return !!departmentId && subtreeIds(departments, filter).has(departmentId);
}

export default function DepartmentFilterPane({ departments, value, onChange, total, unassigned }: {
  departments: DepartmentRow[]; value: DepartmentFilter; onChange: (v: DepartmentFilter) => void; total: number; unassigned: number;
}) {
  const live = departments.filter((d) => !d.archivedAt);
  return <aside className="fx-side min-h-0 w-[232px] shrink-0 overflow-auto p-2" aria-label="Фильтр по подразделению">
    <DepartmentTree departments={live} selectedId={value && value !== 'none' ? value : null} onSelect={(id) => onChange(id === value ? '' : id)}
      label="Подразделения" head={<>
        <div role="treeitem" tabIndex={0} aria-selected={!value} className="fx-li" onClick={() => onChange('')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(''); } }}>
          <Users /><span className="truncate">Все сотрудники</span><span className="fx-n">{total}</span>
        </div>
        <div role="treeitem" tabIndex={0} aria-selected={value === 'none'} className="fx-li" onClick={() => onChange(value === 'none' ? '' : 'none')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(value === 'none' ? '' : 'none'); } }}>
          <UserX /><span className="truncate">Без подразделения</span><span className="fx-n">{unassigned}</span>
        </div>
        <div className="fx-gh mt-2">Подразделения</div>
      </>} />
  </aside>;
}
