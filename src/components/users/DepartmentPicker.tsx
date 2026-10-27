import React, { useMemo } from 'react';
import CustomSelect from '../CustomSelect';
import { buildDepartmentTree, departmentLabel, subtreeIds, type DepartmentNode } from '../../../shared/departments';
import type { DepartmentRow } from '../../services/departmentService';

/** Плоский список для выбора в порядке дерева; вложенность — путём «Город / Отдел» (отступ пропал бы в закрытом списке). Архивные не предлагаются. */
export function departmentOptions(list: DepartmentRow[], opts: { exclude?: string; includeArchived?: boolean } = {}) {
  const hidden = opts.exclude ? subtreeIds(list, opts.exclude) : new Set<string>();
  const out: Array<{ value: string; label: string }> = [];
  const walk = (node: DepartmentNode<DepartmentRow>) => {
    const d = node.dept;
    if (hidden.has(d.id) || (d.archivedAt && !opts.includeArchived)) return;
    out.push({ value: d.id, label: departmentLabel(list, d.id) });
    node.children.forEach(walk);
  };
  buildDepartmentTree(list).forEach(walk);
  return out;
}

/**
 * Выбор подразделения из дерева в форме. `emptyLabel` добавляет первую строку
 * «без подразделения» (значение — пустая строка).
 */
export default function DepartmentPicker({ value, onChange, departments, emptyLabel, exclude, disabled, ariaLabel, placeholder }: {
  value: string; onChange: (id: string) => void; departments: DepartmentRow[];
  emptyLabel?: string; exclude?: string; disabled?: boolean; ariaLabel?: string; placeholder?: string;
}) {
  const options = useMemo(() => {
    const list = departmentOptions(departments, { exclude });
    return emptyLabel ? [{ value: '', label: emptyLabel }, ...list] : list;
  }, [departments, emptyLabel, exclude]);
  return <CustomSelect value={value} onChange={onChange} options={options} disabled={disabled} ariaLabel={ariaLabel} placeholder={placeholder || 'Выберите подразделение'} />;
}
