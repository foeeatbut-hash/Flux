import React, { useMemo, useRef, useState } from 'react';
import { Archive, Building2, ChevronRight, MapPin, Network, Users } from 'lucide-react';
import { buildDepartmentTree, canNest, subtreeIds, type DepartmentNode } from '../../../shared/departments';
import type { DepartmentRow } from '../../services/departmentService';

/**
 * Дерево подразделений: город → отдел → группа, число людей справа.
 *
 * Одно дерево на вкладку «Подразделения» и на панель-фильтр в списке. Пункт —
 * `fx-li` (32 px, одна строка), отступ уровня 16 px, как велит словарь
 * компонентов. Свёртывается стрелкой или клавишами ←/→, переносится
 * перетаскиванием (если передан onDrop). Запретное место — кольцо или
 * неверная вложенность — перетаскивание просто не принимает.
 */

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  company: Building2, branch: MapPin, division: Network, group: Users,
};

interface Props {
  departments: DepartmentRow[];
  /** Выбранное подразделение; null — ничего (выбрана строка «Все» или «Без подразделения») */
  selectedId: string | null;
  onSelect: (id: string) => void;
  label: string;
  /** Что показывать справа: люди прямо здесь или во всём поддереве */
  count?: 'people' | 'total';
  /** Перенос перетаскиванием; без него дерево только для выбора */
  onDrop?: (sourceId: string, targetId: string) => void;
  /** Строки до дерева («Все», «Без подразделения») */
  head?: React.ReactNode;
}

export default function DepartmentTree({ departments, selectedId, onSelect, label, count = 'total', onDrop, head }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const tree = useMemo(() => buildDepartmentTree(departments), [departments]);
  const byId = useMemo(() => new Map(departments.map((d) => [d.id, d])), [departments]);
  const blocked = useMemo(() => (dragId ? subtreeIds(departments, dragId) : new Set<string>()), [departments, dragId]);

  const toggle = (id: string, open: boolean) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (open) next.delete(id); else next.add(id);
    return next;
  });

  /** Можно ли уронить переносимое сюда: не в себя и не в своё вложенное, вид подходит, цель не в архиве */
  const accepts = (target: DepartmentRow): boolean => {
    const src = dragId ? byId.get(dragId) : undefined;
    if (!src || target.archivedAt || blocked.has(target.id) || src.parentId === target.id) return false;
    return canNest(target.kind, src.kind);
  };

  const move = (current: HTMLElement, step: 1 | -1) => {
    const rows = Array.from(box.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') || []);
    rows[rows.indexOf(current) + step]?.focus();
  };

  const renderNode = (node: DepartmentNode<DepartmentRow>): React.ReactNode => {
    const d = node.dept;
    const Icon = d.archivedAt ? Archive : (KIND_ICON[d.kind] || Network);
    const hasKids = node.children.length > 0;
    const open = !collapsed.has(d.id);
    return (
      <React.Fragment key={d.id}>
        <div
          role="treeitem" tabIndex={0} aria-level={node.depth + 1} aria-selected={selectedId === d.id}
          aria-expanded={hasKids ? open : undefined}
          className={`fx-li ${overId === d.id ? 'is-drop' : ''} ${d.archivedAt ? 'opacity-60' : ''}`}
          style={{ paddingLeft: 8 + node.depth * 16 }}
          title={d.archivedAt ? `${d.name} — в архиве` : d.name}
          draggable={!!onDrop && d.kind !== 'company' && !d.archivedAt}
          onClick={() => onSelect(d.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(d.id); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); move(e.currentTarget, 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(e.currentTarget, -1); }
            else if (e.key === 'ArrowRight' && hasKids && !open) { e.preventDefault(); toggle(d.id, true); }
            else if (e.key === 'ArrowLeft' && hasKids && open) { e.preventDefault(); toggle(d.id, false); }
          }}
          onDragStart={(e) => { setDragId(d.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', d.id); }}
          onDragEnd={() => { setDragId(null); setOverId(null); }}
          onDragOver={(e) => { if (dragId && accepts(d)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (overId !== d.id) setOverId(d.id); } }}
          onDragLeave={() => { if (overId === d.id) setOverId(null); }}
          onDrop={(e) => { e.preventDefault(); const src = dragId; setDragId(null); setOverId(null); if (src && accepts(d)) onDrop?.(src, d.id); }}
        >
          {hasKids
            ? <span role="presentation" className="inline-flex h-4 w-4 shrink-0 items-center justify-center" onClick={(e) => { e.stopPropagation(); toggle(d.id, !open); }}>
                <ChevronRight className={`!h-3.5 !w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
              </span>
            : <span className="inline-block h-4 w-4 shrink-0" />}
          <Icon />
          <span className="truncate">{d.name}</span>
          <span className="fx-n">{count === 'total' ? d.total : d.people}</span>
        </div>
        {hasKids && open && node.children.map(renderNode)}
      </React.Fragment>
    );
  };

  return (
    <div ref={box} role="tree" aria-label={label} className="flex flex-col gap-0.5">
      {head}
      {tree.map(renderNode)}
    </div>
  );
}
