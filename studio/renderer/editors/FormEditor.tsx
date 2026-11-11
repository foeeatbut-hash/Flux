/**
 * Визуальный редактор формы: палитра, структура, свойства и предпросмотр.
 * Сам ничего не хранит: каждое действие превращается в новую форму и уходит наверх (onForm),
 * откуда она же попадает в текстовый редактор.
 */
import React, { useMemo, useRef, useState } from 'react';
import { addComponent, itemAt, removeSelected, selectionKey, updateSelected, type ComponentKind, type DragPayload, type Edit, type Selection } from './formModel';
import type { FormState } from './formStore';
import { parsePathString, selectionOfJsonPath } from './paths';
import { FormPalette } from './FormPalette';
import { FormTree } from './FormTree';
import { FormProps } from './FormProps';
import { FormPreview } from './FormPreview';
import type { ContractDraft, Finding, FormDef } from './types';

interface Props {
  state: FormState;
  contract: ContractDraft;
  data: Record<string, unknown>;
  findings: Finding[];
  onForm: (form: FormDef) => void;
  history: { canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void };
  /** Перейти на вкладку с текстом form.json (к ошибке) */
  onGoText: () => void;
}

/** Куда вставить новый компонент, чтобы он встал после выбранного, а не в конец */
function insertionIndex(kind: ComponentKind, selection: Selection): number | undefined {
  if (kind === 'group' && (selection.kind === 'group' || selection.kind === 'field')) return selection.g + 1;
  if (kind === 'table' && (selection.kind === 'table' || selection.kind === 'column')) return selection.t + 1;
  if ((kind === 'field' || kind === 'code-field') && selection.kind === 'field') return selection.f + 1;
  if (kind === 'column' && selection.kind === 'column') return selection.c + 1;
  return undefined;
}

export function FormEditor({ state, contract, data, findings, onForm, history, onGoText }: Props) {
  const { form } = state;
  const locked = !state.textValid;
  const [selection, setSelection] = useState<Selection>({ kind: 'form' });
  const paletteDrag = useRef<DragPayload | null>(null);

  // Выделение не должно указывать на то, чего уже нет (текст переписали или компонент удалили)
  const current = itemAt(form, selection) ? selection : { kind: 'form' as const };

  const apply = (edit: Edit) => { setSelection(edit.selection); onForm(edit.form); };
  const add = (kind: ComponentKind) => apply(addComponent(form, kind, current, insertionIndex(kind, current)));

  const flagged = useMemo(() => {
    const keys = new Set<string>();
    for (const problem of state.bindings) keys.add(selectionKey(selectionOfJsonPath(problem.path)));
    for (const finding of findings) keys.add(selectionKey(selectionOfJsonPath(parsePathString(finding.path))));
    return keys;
  }, [state.bindings, findings]);

  const key = selectionKey(current);
  const messages = state.bindings.filter(problem => selectionKey(selectionOfJsonPath(problem.path)) === key).map(problem => `Строка ${problem.line}: ${problem.message}`);
  const own = findings.filter(finding => selectionKey(selectionOfJsonPath(parsePathString(finding.path))) === key);

  return (
    <div className="ed-form" data-testid="form-editor" data-locked={locked || undefined}>
      {locked && (
        <div className="ed-lock" role="alert" data-testid="form-locked">
          <span>В form.json есть ошибка{state.problems[0] ? ` (строка ${state.problems[0].line})` : ''}. Пока она не исправлена, здесь только просмотр: любая правка стёрла бы ваш текст.</span>
          <button type="button" className="ed-btn" onClick={onGoText}>Исправить в тексте</button>
        </div>
      )}
      <div className="ed-col" inert={locked}>
        <FormPalette onAdd={add} onDragStart={kind => { paletteDrag.current = { new: kind }; }} onDragEnd={() => { paletteDrag.current = null; }} />
      </div>
      <div className="ed-col ed-center">
        <section className="ed-structure" aria-label="Структура формы" inert={locked}>
          <div className="ed-toolbar">
            <h3 className="ed-title">Структура</h3>
            <button type="button" className="ed-btn" onClick={() => setSelection({ kind: 'form' })} aria-label="Свойства формы">Свойства формы</button>
            <button type="button" className="ed-btn" onClick={history.undo} disabled={!history.canUndo || locked}>Отменить</button>
            <button type="button" className="ed-btn" onClick={history.redo} disabled={!history.canRedo || locked}>Повторить</button>
          </div>
          <FormTree form={form} selection={current} onSelect={setSelection} onEdit={apply} flagged={flagged} paletteDrag={paletteDrag} />
          <p className="ed-hint">Стрелки — перейти, Alt + стрелка — переставить, Delete — удалить, Ctrl + Z — отменить. Можно перетащить мышью.</p>
        </section>
        <section className="ed-previewbox">
          <FormPreview form={form} data={data} textValid={state.textValid} />
        </section>
      </div>
      <div className="ed-col" inert={locked}>
        <h3 className="ed-title">Свойства</h3>
        <FormProps form={form} selection={current} contract={contract} messages={messages} findings={own}
          patch={change => onForm(updateSelected(form, current, change))} />
        {current.kind !== 'form' && (
          <div className="ed-actions">
            <button type="button" className="ed-btn is-danger" onClick={() => apply(removeSelected(form, current))}>Удалить</button>
          </div>
        )}
      </div>
    </div>
  );
}
