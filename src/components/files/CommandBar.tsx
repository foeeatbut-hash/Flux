import React from 'react';
import { ArrowDownUp, Check, ChevronDown, Clipboard, Copy, Eye, Info, MoreHorizontal, Redo2, Scissors, Share2, TextCursorInput, Trash2, Undo2 } from 'lucide-react';
import ContextMenu from '../ContextMenu';
import { X as T } from './explorerTheme';
import { VIEW_LABELS, type FolderView } from './viewModel';

export default function CommandBar({ view, onView, selected, busy, canPaste, onCut, onCopy, onPaste, onRename, onDelete, onShare, onUndo, onRedo, undo, redo, pane, onPane, onProperties }: {
  view: FolderView; onView: (view: FolderView) => void; selected: number; busy: boolean; canPaste: boolean;
  onCut: () => void; onCopy: () => void; onPaste: () => void; onRename: () => void; onDelete: () => void; onShare?: () => void;
  onUndo: () => void; onRedo: () => void; undo?: string; redo?: string; pane: 'none' | 'details' | 'preview'; onPane: (pane: 'none' | 'details' | 'preview') => void; onProperties: () => void;
}) {
  const [menu, setMenu] = React.useState<{ kind: 'sort' | 'view' | 'more'; x: number; y: number } | null>(null);
  const toggle = (kind: 'sort' | 'view' | 'more', event: React.MouseEvent<HTMLButtonElement>) => { const r = event.currentTarget.getBoundingClientRect(); setMenu({ kind, x: r.left, y: r.bottom }); };
  const icon = (label: string, Icon: React.ElementType, onClick: () => void, disabled: boolean) => <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled || busy} className={`h-8 w-11 shrink-0 rounded flex items-center justify-center ${T.iconButton} disabled:opacity-35`}><Icon size={16} strokeWidth={1.3} /></button>;
  const mark = (yes: boolean) => yes ? <Check size={14} /> : undefined;
  const sortLabels = { name: 'Имя', modified: 'Дата изменения', type: 'Тип', size: 'Размер', project: 'Проект', tags: 'Теги' };
  const groupLabels = { none: '(Нет)', name: 'Имя', type: 'Тип', date: 'Дата изменения', size: 'Размер', project: 'Проект', tags: 'Теги' };
  return <div data-explorer-commands className={`flex h-[46px] shrink-0 items-center gap-1 border-y px-2 ${T.pane} ${T.line} ${T.text}`}>
    <div className="flex overflow-x-auto items-center min-w-0 flex-1">
      {icon('Вырезать', Scissors, onCut, !selected)}{icon('Копировать', Copy, onCopy, !selected)}{icon('Вставить', Clipboard, onPaste, !canPaste)}{icon('Переименовать', TextCursorInput, onRename, selected !== 1)}{icon('Общий доступ', Share2, () => onShare?.(), !onShare || selected !== 1)}{icon('Удалить', Trash2, onDelete, !selected)}
      <span className={`mx-2 h-6 border-l ${T.line}`} />
      <button type="button" onClick={(e) => toggle('sort', e)} className={`flex h-8 shrink-0 items-center gap-2 rounded px-2 text-xs ${T.iconButton}`}><ArrowDownUp size={16} strokeWidth={1.3} />Сортировать<ChevronDown size={10} /></button>
      <button type="button" onClick={(e) => toggle('view', e)} className={`flex h-8 shrink-0 items-center gap-2 rounded px-2 text-xs ${T.iconButton}`}><Eye size={16} strokeWidth={1.3} />Просмотреть<ChevronDown size={10} /></button>
      <span className={`mx-2 h-6 border-l ${T.line}`} /><button type="button" aria-label="Дополнительно" onClick={(e) => toggle('more', e)} className={`h-8 w-10 shrink-0 rounded flex items-center justify-center ${T.iconButton}`}><MoreHorizontal size={20} /></button>
    </div>
    <button type="button" aria-pressed={pane === 'details'} onClick={() => onPane(pane === 'details' ? 'none' : 'details')} className={`flex h-8 items-center gap-2 rounded px-2 text-xs ${T.iconButton}`}><Info size={16} strokeWidth={1.3} />Сведения</button>
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menu.kind === 'sort' ? [
      ...Object.entries(sortLabels).map(([sort, label]) => ({ label, icon: mark(view.sort === sort), onClick: () => onView({ ...view, sort: sort as FolderView['sort'] }) })),
      { label: 'По возрастанию', separated: true, icon: mark(!view.descending), onClick: () => onView({ ...view, descending: false }) },
      { label: 'По убыванию', icon: mark(view.descending), onClick: () => onView({ ...view, descending: true }) },
      { label: 'Группировать', separated: true, items: Object.entries(groupLabels).map(([group, label]) => ({ label, icon: mark(view.group === group), onClick: () => onView({ ...view, group: group as FolderView['group'] }) })) },
    ] : menu.kind === 'view' ? [
      ...Object.entries(VIEW_LABELS).map(([layout, label]) => ({ label, icon: mark(view.layout === layout), onClick: () => onView({ ...view, layout: layout as FolderView['layout'] }) })),
      { label: 'Область предварительного просмотра', separated: true, icon: mark(pane === 'preview'), onClick: () => onPane(pane === 'preview' ? 'none' : 'preview') },
      { label: 'Область сведений', icon: mark(pane === 'details'), onClick: () => onPane(pane === 'details' ? 'none' : 'details') },
      { label: 'Показать', separated: true, items: [
        { label: 'Флажки элементов', icon: mark(view.checkboxes), onClick: () => onView({ ...view, checkboxes: !view.checkboxes }) },
        { label: 'Расширения имён файлов', icon: mark(view.extensions), onClick: () => onView({ ...view, extensions: !view.extensions }) },
        { label: 'Скрытые элементы', icon: mark(view.hidden), onClick: () => onView({ ...view, hidden: !view.hidden }) },
      ] },
    ] : [
      { label: undo ? `Отменить: ${undo}` : 'Отменить', icon: <Undo2 size={14} />, disabled: !undo || busy, onClick: onUndo },
      { label: redo ? `Повторить: ${redo}` : 'Повторить', icon: <Redo2 size={14} />, disabled: !redo || busy, onClick: onRedo },
      { label: 'Свойства', separated: true, disabled: selected !== 1, onClick: onProperties },
    ]} />}
  </div>;
}
