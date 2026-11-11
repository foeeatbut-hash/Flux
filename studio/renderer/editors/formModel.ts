/**
 * Операции над описанием формы: добавить, переставить, удалить, изменить.
 *
 * Все операции чистые: возвращают новую форму и новое выделение. Перетаскивание мышью и
 * клавиши вызывают одни и те же операции, поэтому ведут себя одинаково.
 */
import type { FormColumn, FormDef, FormField, FormGroup, FormTable } from './types';

export type Selection =
  | { kind: 'form' }
  | { kind: 'group'; g: number }
  | { kind: 'field'; g: number; f: number }
  | { kind: 'table'; t: number }
  | { kind: 'column'; t: number; c: number };

export type ComponentKind = 'group' | 'field' | 'code-field' | 'table' | 'column';
export interface Edit { form: FormDef; selection: Selection }

export const emptyForm = (): FormDef => ({ version: 1, groups: [], tables: [] });

const FIELD_ORDER: Array<keyof FormField> = ['label', 'bind', 'kind', 'unit', 'allowed', 'min', 'max', 'required', 'placeholder', 'hint', 'visibleIf'];
const ordered = <T extends object>(value: T, order: string[]): T => {
  const out: Record<string, unknown> = {};
  for (const key of order) if (key in value && (value as any)[key] !== undefined) out[key] = (value as any)[key];
  return out as T;
};

/** Единый вид form.json: порядок полей и отступы не зависят от того, как форму правили */
export function serializeForm(form: FormDef): string {
  const view = {
    version: form.version,
    ...(form.onDataChanged ? { onDataChanged: form.onDataChanged } : {}),
    groups: form.groups.map(group => ({
      ...ordered(group, ['title', 'visibleIf', 'fields']),
      fields: group.fields.map(field => ordered(field, FIELD_ORDER as string[])),
    })),
    tables: form.tables.map(table => ({
      ...ordered(table, ['title', 'bind', 'visibleIf', 'columns']),
      columns: table.columns.map(column => ordered(column, ['label', 'key', 'align', 'unit'])),
    })),
  };
  return `${JSON.stringify(view, null, 2)}\n`;
}

const clone = <T>(value: T): T => structuredClone(value);
const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length));

function insert<T>(list: T[], item: T, index?: number): number {
  const at = index === undefined ? list.length : clamp(index, list.length);
  list.splice(at, 0, item);
  return at;
}
function relocate<T>(list: T[], from: number, to: number): number {
  if (from < 0 || from >= list.length) return from;
  const [item] = list.splice(from, 1);
  const at = clamp(to, list.length);
  list.splice(at, 0, item);
  return at;
}

export function newComponent(kind: ComponentKind): FormGroup | FormField | FormTable | FormColumn {
  switch (kind) {
    case 'group': return { title: 'Новая группа', fields: [] };
    case 'field': return { label: 'Новое поле', bind: '' };
    case 'code-field': return { label: 'Код', bind: '', kind: 'code' };
    case 'table': return { title: 'Новая таблица', bind: '', columns: [] };
    case 'column': return { label: 'Новая колонка', key: '' };
  }
}

/** Добавляет компонент; поле без группы создаёт группу, колонка без таблицы — таблицу с привязкой пока пустой */
export function addComponent(source: FormDef, kind: ComponentKind, selection: Selection, index?: number): Edit {
  const form = clone(source);
  if (kind === 'group') {
    const g = insert(form.groups, newComponent('group') as FormGroup, index);
    return { form, selection: { kind: 'group', g } };
  }
  if (kind === 'table') {
    const t = insert(form.tables, newComponent('table') as FormTable, index);
    return { form, selection: { kind: 'table', t } };
  }
  if (kind === 'column') {
    const t = selection.kind === 'table' || selection.kind === 'column' ? selection.t : form.tables.length - 1;
    if (t < 0) {
      form.tables.push(newComponent('table') as FormTable);
      return addComponent(form, 'column', { kind: 'table', t: 0 }, index);
    }
    const c = insert(form.tables[t].columns, newComponent('column') as FormColumn, index);
    return { form, selection: { kind: 'column', t, c } };
  }
  let g = selection.kind === 'group' || selection.kind === 'field' ? selection.g : form.groups.length - 1;
  if (g < 0) { form.groups.push(newComponent('group') as FormGroup); g = 0; }
  const f = insert(form.groups[g].fields, newComponent(kind) as FormField, index);
  return { form, selection: { kind: 'field', g, f } };
}

export function removeSelected(source: FormDef, selection: Selection): Edit {
  const form = clone(source);
  switch (selection.kind) {
    case 'group': form.groups.splice(selection.g, 1); return { form, selection: { kind: 'form' } };
    case 'table': form.tables.splice(selection.t, 1); return { form, selection: { kind: 'form' } };
    case 'field': form.groups[selection.g].fields.splice(selection.f, 1); return { form, selection: { kind: 'group', g: selection.g } };
    case 'column': form.tables[selection.t].columns.splice(selection.c, 1); return { form, selection: { kind: 'table', t: selection.t } };
    default: return { form, selection };
  }
}

/** Сдвиг на шаг (клавиши «Alt + стрелка»): вверх и вниз внутри своего списка */
export function moveSelected(source: FormDef, selection: Selection, delta: -1 | 1): Edit {
  const form = clone(source);
  switch (selection.kind) {
    case 'group': return { form, selection: { kind: 'group', g: relocate(form.groups, selection.g, selection.g + delta) } };
    case 'table': return { form, selection: { kind: 'table', t: relocate(form.tables, selection.t, selection.t + delta) } };
    case 'field': return { form, selection: { kind: 'field', g: selection.g, f: relocate(form.groups[selection.g].fields, selection.f, selection.f + delta) } };
    case 'column': return { form, selection: { kind: 'column', t: selection.t, c: relocate(form.tables[selection.t].columns, selection.c, selection.c + delta) } };
    default: return { form, selection };
  }
}

/** Перетаскивание: `to` — место вставки в списке-получателе до удаления из исходного */
export function dropComponent(source: FormDef, from: Selection, to: Selection & { index: number }): Edit | null {
  const form = clone(source);
  const place = (list: unknown[], fromIndex: number, toIndex: number) => relocate(list, fromIndex, toIndex > fromIndex ? toIndex - 1 : toIndex);
  if (from.kind === 'group' && to.kind === 'group') return { form, selection: { kind: 'group', g: place(form.groups, from.g, to.index) } };
  if (from.kind === 'table' && to.kind === 'table') return { form, selection: { kind: 'table', t: place(form.tables, from.t, to.index) } };
  if (from.kind === 'column' && to.kind === 'column' && from.t === to.t) return { form, selection: { kind: 'column', t: from.t, c: place(form.tables[from.t].columns, from.c, to.index) } };
  if (from.kind === 'field' && to.kind === 'field') {
    const [field] = form.groups[from.g].fields.splice(from.f, 1);
    const target = form.groups[to.g].fields;
    const adjust = from.g === to.g && to.index > from.f ? to.index - 1 : to.index;
    const f = insert(target, field, adjust);
    return { form, selection: { kind: 'field', g: to.g, f } };
  }
  return null;
}

export function itemAt(form: FormDef, selection: Selection): FormDef | FormGroup | FormField | FormTable | FormColumn | null {
  switch (selection.kind) {
    case 'form': return form;
    case 'group': return form.groups[selection.g] ?? null;
    case 'field': return form.groups[selection.g]?.fields[selection.f] ?? null;
    case 'table': return form.tables[selection.t] ?? null;
    case 'column': return form.tables[selection.t]?.columns[selection.c] ?? null;
  }
}

/** Меняет свойства выбранного; undefined в патче убирает свойство, чтобы в тексте не оставался мусор */
export function updateSelected(source: FormDef, selection: Selection, patch: Record<string, unknown>): FormDef {
  const form = clone(source);
  const item = itemAt(form, selection) as unknown as Record<string, unknown> | null;
  if (!item) return form;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '' || (Array.isArray(value) && !value.length && key === 'allowed')) delete item[key];
    else item[key] = value;
  }
  // Подпись и привязка обязательны по схеме: пустой текст оставляем пустой строкой, а не убираем
  for (const key of ['label', 'bind', 'title', 'key']) if (key in patch && !(key in item)) item[key] = '';
  return form;
}

/** Что тащат: новый компонент из палитры или существующий элемент формы */
export type DragPayload = { new: ComponentKind } | { move: Selection };

const SIDE: Record<ComponentKind, 'group' | 'field' | 'table' | 'column'> = {
  group: 'group', field: 'field', 'code-field': 'field', table: 'table', column: 'column',
};

/**
 * Бросок на строку структуры. `after` — нижняя половина строки. Поле на группу кладётся в её
 * конец, колонка на таблицу — тоже; одноимённое кладётся рядом. Непонятный бросок — null.
 */
export function applyDrop(form: FormDef, payload: DragPayload, target: Selection, after: boolean): Edit | null {
  const what = 'new' in payload ? SIDE[payload.new] : payload.move.kind;
  const bump = after ? 1 : 0;
  let to: (Selection & { index: number }) | null = null;
  if (what === 'group' && target.kind === 'group') to = { kind: 'group', g: target.g, index: target.g + bump };
  else if (what === 'group' && target.kind === 'form') to = { kind: 'group', g: 0, index: form.groups.length };
  else if (what === 'table' && target.kind === 'table') to = { kind: 'table', t: target.t, index: target.t + bump };
  else if (what === 'table' && target.kind === 'form') to = { kind: 'table', t: 0, index: form.tables.length };
  else if (what === 'field' && target.kind === 'field') to = { kind: 'field', g: target.g, f: target.f, index: target.f + bump };
  else if (what === 'field' && target.kind === 'group') to = { kind: 'field', g: target.g, f: 0, index: form.groups[target.g].fields.length };
  else if (what === 'field' && target.kind === 'form') {
    // На пустое место: в последнюю группу, а если групп нет — новая группа с этим полем
    if (!form.groups.length) return 'new' in payload ? addComponent(form, payload.new, { kind: 'form' }) : null;
    const last = form.groups.length - 1;
    to = { kind: 'field', g: last, f: 0, index: form.groups[last].fields.length };
  } else if (what === 'column' && target.kind === 'column') to = { kind: 'column', t: target.t, c: target.c, index: target.c + bump };
  else if (what === 'column' && target.kind === 'table') to = { kind: 'column', t: target.t, c: 0, index: form.tables[target.t].columns.length };
  if (!to) return null;
  if ('move' in payload) return dropComponent(form, payload.move, to);
  const where: Selection = to.kind === 'field' ? { kind: 'group', g: to.g } : to.kind === 'column' ? { kind: 'table', t: to.t } : { kind: 'form' };
  return addComponent(form, payload.new, where, to.index);
}

export const selectionKey = (s: Selection) => s.kind === 'form' ? 'form' : s.kind === 'group' ? `g${s.g}` : s.kind === 'field' ? `g${s.g}f${s.f}` : s.kind === 'table' ? `t${s.t}` : `t${s.t}c${s.c}`;
