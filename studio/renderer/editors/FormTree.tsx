/**
 * Структура формы: группы с полями, таблицы с колонками.
 *
 * Строки двигаются перетаскиванием и клавишами: стрелки — переход между строками,
 * Alt + стрелка вверх или вниз — перестановка, Delete — удаление. Мышь и клавиши вызывают одни и
 * те же операции из formModel.ts, поэтому результат одинаков.
 */
import React, { useEffect, useRef, useState } from 'react';
import { applyDrop, moveSelected, removeSelected, selectionKey, type DragPayload, type Edit, type Selection } from './formModel';
import { sameSelection } from './paths';
import type { FormDef } from './types';

interface Row { sel: Selection; depth: 0 | 1; kind: string; name: string; bind: string }

export function rowsOf(form: FormDef): Row[] {
  const rows: Row[] = [];
  form.groups.forEach((group, g) => {
    rows.push({ sel: { kind: 'group', g }, depth: 0, kind: 'Группа', name: group.title || 'Без названия', bind: '' });
    group.fields.forEach((field, f) => rows.push({ sel: { kind: 'field', g, f }, depth: 1, kind: field.kind === 'code' ? 'Код' : 'Поле', name: field.label || 'Без подписи', bind: field.bind }));
  });
  form.tables.forEach((table, t) => {
    rows.push({ sel: { kind: 'table', t }, depth: 0, kind: 'Таблица', name: table.title || 'Без названия', bind: table.bind });
    table.columns.forEach((column, c) => rows.push({ sel: { kind: 'column', t, c }, depth: 1, kind: 'Колонка', name: column.label || 'Без подписи', bind: column.key }));
  });
  return rows;
}

interface Props {
  form: FormDef;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onEdit: (edit: Edit) => void;
  /** Ключи выделений, у которых есть замечания: у строки появляется красная точка */
  flagged: Set<string>;
  /** Что тащат из палитры (иначе тащат строку структуры) */
  paletteDrag: React.MutableRefObject<DragPayload | null>;
}

export function FormTree({ form, selection, onSelect, onEdit, flagged, paletteDrag }: Props) {
  const rows = rowsOf(form);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const [mark, setMark] = useState<{ key: string; pos: 'before' | 'after' | 'into' } | null>(null);

  useEffect(() => {
    if (!pendingFocus.current) return;
    refs.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  });

  const commit = (edit: Edit | null) => {
    if (!edit) return;
    pendingFocus.current = selectionKey(edit.selection);
    onEdit(edit);
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const row = rows[index];
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      commit(moveSelected(form, row.sel, event.key === 'ArrowUp' ? -1 : 1));
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) { pendingFocus.current = selectionKey(next.sel); onSelect(next.sel); }
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      const edit = removeSelected(form, row.sel);
      const neighbour = rows[index + 1] ?? rows[index - 1];
      pendingFocus.current = neighbour ? selectionKey(neighbour.sel) : null;
      onEdit(edit);
    }
  };

  const payloadFor = (): DragPayload | null => paletteDrag.current;
  const place = (event: React.DragEvent, target: Selection, row?: HTMLElement) => {
    const payload = payloadFor();
    if (!payload) return null;
    const box = (row ?? (event.currentTarget as HTMLElement)).getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    return applyDrop(form, payload, target, after) ? { payload, after } : null;
  };

  return (
    <div role="tree" aria-label="Структура формы" data-testid="tree" className="ed-tree"
      onDragOver={event => { if (place(event, { kind: 'form' }, event.currentTarget as HTMLElement)) { event.preventDefault(); setMark({ key: 'form', pos: 'into' }); } }}
      onDragLeave={event => { if (event.currentTarget === event.target) setMark(null); }}
      onDrop={event => { const hit = place(event, { kind: 'form' }); setMark(null); if (hit) { event.preventDefault(); commit(applyDrop(form, hit.payload, { kind: 'form' }, false)); paletteDrag.current = null; } }}>
      {rows.length === 0 && <div className={`ed-empty${mark?.key === 'form' ? ' drop-into' : ''}`}>Форма пуста. Добавьте компонент из палитры кнопкой или перетащите сюда.</div>}
      {rows.map((row, index) => {
        const key = selectionKey(row.sel);
        const selected = sameSelection(row.sel, selection);
        const cls = ['ed-row', row.depth ? 'is-child' : '', mark?.key === key ? `drop-${mark.pos}` : ''].filter(Boolean).join(' ');
        return (
          <button key={key} type="button" role="treeitem" aria-selected={selected} aria-level={row.depth + 1} className={cls} data-key={key} data-kind={row.sel.kind}
            tabIndex={selected || (!rows.some(r => sameSelection(r.sel, selection)) && index === 0) ? 0 : -1}
            ref={node => { if (node) refs.current.set(key, node); else refs.current.delete(key); }}
            draggable onClick={() => onSelect(row.sel)} onKeyDown={event => onKeyDown(event, index)}
            onDragStart={event => { paletteDrag.current = { move: row.sel }; event.dataTransfer.setData('text/plain', key); event.dataTransfer.effectAllowed = 'move'; onSelect(row.sel); }}
            onDragEnd={() => { paletteDrag.current = null; setMark(null); }}
            onDragOver={event => {
              const hit = place(event, row.sel);
              event.stopPropagation();
              if (!hit) return;
              event.preventDefault();
              const into = (row.sel.kind === 'group' || row.sel.kind === 'table') && !('move' in hit.payload && hit.payload.move.kind === row.sel.kind) && !('new' in hit.payload && (hit.payload.new === row.sel.kind));
              setMark({ key, pos: into ? 'into' : hit.after ? 'after' : 'before' });
            }}
            onDrop={event => {
              const hit = place(event, row.sel);
              setMark(null);
              event.stopPropagation();
              if (!hit) return;
              event.preventDefault();
              commit(applyDrop(form, hit.payload, row.sel, hit.after));
              paletteDrag.current = null;
            }}>
            <span className="ed-kind">{row.kind}</span>
            <span className="ed-name">{row.name}</span>
            {row.bind && <span className="ed-bind">{row.bind}</span>}
            {flagged.has(key) && <span className="ed-dot" role="img" aria-label="Есть замечания" />}
          </button>
        );
      })}
    </div>
  );
}
