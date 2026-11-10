/**
 * Подготовка предпросмотра: условия видимости, единицы и проверка ввода.
 *
 * Рисует предпросмотр сам рендерер формы Flux (modules/runtime/form.ts). Ему отдаётся форма,
 * из которой уже убрано невидимое, а единицы дописаны к значению через служебные привязки —
 * так второго набора разметки нет, и предпросмотр не разойдётся с тем, что увидит инженер.
 */
import type { ModuleForm } from '../../../modules/runtime/form';
import type { FormDef, FormField, FormVisibility } from './types';

const forbidden = ['__proto__', 'prototype', 'constructor'];
export function readBinding(data: unknown, path: string): unknown {
  return path.split('.').reduce((value: any, key) => {
    if (!value || forbidden.includes(key) || !Object.hasOwn(value, key)) return undefined;
    return value[key];
  }, data);
}

const empty = (value: unknown) => value === undefined || value === null || value === '';

export function isVisible(rule: FormVisibility | undefined, data: unknown): boolean {
  if (!rule) return true;
  const value = readBinding(data, rule.bind);
  switch (rule.op) {
    case 'filled': return !empty(value);
    case 'empty': return empty(value);
    case 'eq': return String(value ?? '') === (rule.value ?? '');
    case 'ne': return String(value ?? '') !== (rule.value ?? '');
  }
}

/** Ошибка ввода или null; ответ говорит словом, что не так, — не звёздочкой у подписи */
export function validateInput(field: FormField, raw: string): string | null {
  const value = raw.trim();
  if (!value) return field.required ? `Укажите значение: «${field.label}»` : null;
  if (field.allowed?.length && !field.allowed.includes(value)) return `Допустимо только: ${field.allowed.join(', ')}`;
  if (field.min !== undefined || field.max !== undefined) {
    const number = Number(value.replace(',', '.'));
    if (!Number.isFinite(number)) return `Нужно число${field.unit ? `, ${field.unit}` : ''}`;
    if (field.min !== undefined && number < field.min) return `Не меньше ${field.min}${field.unit ? ` ${field.unit}` : ''}`;
    if (field.max !== undefined && number > field.max) return `Не больше ${field.max}${field.unit ? ` ${field.unit}` : ''}`;
  }
  return null;
}

export interface Preview { form: ModuleForm; data: Record<string, unknown> }

/** Форма и данные для renderForm: видимые группы, поля с единицами, таблицы с единицами в шапке */
export function buildPreview(form: FormDef, data: Record<string, unknown>): Preview {
  const shown: unknown[][] = [];
  const groups: ModuleForm['groups'] = [];
  form.groups.forEach(group => {
    if (!isVisible(group.visibleIf, data)) return;
    const values: unknown[] = [];
    const fields: ModuleForm['groups'][number]['fields'] = [];
    group.fields.forEach(field => {
      if (!isVisible(field.visibleIf, data)) return;
      const value = readBinding(data, field.bind);
      const text = empty(value) ? '' : `${String(value)}${field.unit ? ` ${field.unit}` : ''}`;
      fields.push({ label: field.label, bind: `preview.${shown.length}.${values.length}`, ...(field.kind ? { kind: field.kind } : {}) });
      values.push(text === '' ? undefined : text);
    });
    shown.push(values);
    groups.push({ title: group.title, fields });
  });
  const tables = form.tables.filter(table => isVisible(table.visibleIf, data)).map(table => ({
    title: table.title,
    bind: table.bind,
    columns: table.columns.map(column => ({ label: column.unit ? `${column.label}, ${column.unit}` : column.label, key: column.key, ...(column.align ? { align: column.align } : {}) })),
  }));
  return { form: { version: 1, groups, tables }, data: { ...data, preview: shown } };
}
