/**
 * Тот же стол, только списком и с колонками проекта.
 *
 * Значки отвечают на «где лежит», список — на «что с этим». Когда на столе
 * два десятка документов и надо понять, что из них ещё черновик и чья ревизия
 * свежее, значки заставляют наводить мышь на каждый по очереди. Поэтому у стола
 * два вида, и переключаются они одним пунктом меню.
 *
 * Колонки — те же, что в Проводнике: тег, статус, ревизия, кто менял, когда.
 * Другой набор означал бы, что один документ описан в двух местах по-разному.
 */
import React from 'react';
import { Users } from 'lucide-react';
import { StatusChip } from '../explorer/FileItems';
import { isSystemKind, sortItems, type DeskItem, type SortBy } from '../../lib/desktop';
import { titleOf } from './DeskIcon';

const when = (v: DeskItem['updatedAt']): string => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
};

const COLS: { key: SortBy | null; title: string; cls: string }[] = [
  { key: 'name', title: 'Имя', cls: 'text-left' },
  { key: null, title: 'Тег', cls: 'text-left' },
  { key: 'status', title: 'Стадия', cls: 'text-left' },
  { key: null, title: 'Ред.', cls: 'text-right' },
  { key: null, title: 'Менял', cls: 'text-left' },
  { key: 'date', title: 'Изменён', cls: 'text-right' },
];

export default function DeskList({
  items, selected, sortBy, onSort, onSelect, onOpen, onMenu,
}: {
  items: DeskItem[];
  selected: string[];
  sortBy: SortBy;
  onSort: (by: SortBy) => void;
  onSelect: (ids: string[]) => void;
  onOpen: (item: DeskItem) => void;
  onMenu: (e: React.MouseEvent, item: DeskItem) => void;
}) {
  const rows = React.useMemo(() => sortItems(items, sortBy), [items, sortBy]);

  return (
    <div className="absolute inset-0 overflow-auto p-2">
      <table className="w-full text-sm border-separate border-spacing-0">
        <thead className="sticky top-0 z-10">
          <tr>
            {COLS.map((c) => (
              <th
                key={c.title}
                onClick={() => c.key && onSort(c.key)}
                className={`${c.cls} px-2.5 py-1.5 text-2xs font-bold whitespace-nowrap
                            bg-slate-100/95 dark:bg-dark-bg/95 backdrop-blur
                            border-b border-slate-200 dark:border-dark-border
                            ${c.key ? 'cursor-pointer text-slate-500 hover:text-slate-800 dark:hover:text-white' : 'text-slate-400'}`}
              >
                {c.title}{c.key && sortBy === c.key ? ' ↓' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const sys = isSystemKind(item.kind);
            const isSel = selected.includes(item.id);
            return (
              <tr
                key={item.id}
                onPointerDown={() => onSelect([item.id])}
                onDoubleClick={() => onOpen(item)}
                onContextMenu={(e) => onMenu(e, item)}
                className={`cursor-default ${
                  isSel ? 'bg-emerald-100 dark:bg-emerald-950/30' : 'hover:bg-slate-200/60 dark:hover:bg-dark-surface/60'
                }`}
              >
                <td className="px-2.5 py-1.5 border-b border-slate-200/70 dark:border-dark-border/70">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="truncate text-slate-800 dark:text-slate-150">{titleOf(item)}</span>
                    {item.shared && !sys && (
                      <Users aria-label="Лежит на общем столе" className="w-3 h-3 shrink-0 text-sky-600" />
                    )}
                  </span>
                </td>
                <td className="px-2.5 py-1.5 border-b border-slate-200/70 dark:border-dark-border/70 font-mono text-2xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                  {sys ? '' : (item.tag || '—')}
                </td>
                <td className="px-2.5 py-1.5 border-b border-slate-200/70 dark:border-dark-border/70 whitespace-nowrap">
                  {sys || item.kind === 'folder' ? <span className="text-slate-400">—</span> : <StatusChip code={item.status} />}
                </td>
                <td className="px-2.5 py-1.5 border-b border-slate-200/70 dark:border-dark-border/70 text-right font-mono tabular-nums text-2xs text-slate-500 dark:text-slate-400">
                  {sys || item.kind === 'folder' ? '' : item.revision || '1'}
                </td>
                <td className="px-2.5 py-1.5 border-b border-slate-200/70 dark:border-dark-border/70 text-2xs text-slate-500 dark:text-slate-400 truncate max-w-[180px]">
                  {item.updatedBy || (sys ? '' : '—')}
                </td>
                <td className="px-2.5 py-1.5 border-b border-slate-200/70 dark:border-dark-border/70 text-right text-2xs tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                  {sys ? '' : when(item.updatedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
