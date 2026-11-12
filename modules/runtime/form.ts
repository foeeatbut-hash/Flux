export interface ModuleVisibility { bind: string; op: 'eq' | 'ne' | 'filled' | 'empty'; value?: string }
export interface ModuleForm {
  version: number;
  onDataChanged?: string;
  groups: Array<{
    title: string; visibleIf?: ModuleVisibility;
    /** unit — единица после значения; hint — пояснение под полем; visibleIf — условие показа */
    fields: Array<{ label: string; bind: string; kind?: 'code'; unit?: string; hint?: string; visibleIf?: ModuleVisibility }>;
  }>;
  tables: Array<{ title: string; bind: string; visibleIf?: ModuleVisibility; columns: Array<{ label: string; key: string; align?: 'end'; unit?: string }> }>;
}
export function binding(data: unknown, path: string): unknown {
  return path.split('.').reduce((value: any, key) => {
    if (!value || ['__proto__', 'prototype', 'constructor'].includes(key) || !Object.hasOwn(value, key)) return undefined;
    return value[key];
  }, data);
}
const blank = (value: unknown) => value === undefined || value === null || value === '';
/** Условие показа: одно правило и для окна программы, и для предпросмотра в Studio */
export function isVisible(rule: ModuleVisibility | undefined, data: unknown): boolean {
  if (!rule) return true;
  const value = binding(data, rule.bind);
  switch (rule.op) {
    case 'filled': return !blank(value);
    case 'empty': return blank(value);
    case 'eq': return String(value ?? '') === (rule.value ?? '');
    case 'ne': return String(value ?? '') !== (rule.value ?? '');
    default: return true;
  }
}
const element = (tag: string, className: string, text?: unknown) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = String(text ?? '—');
  return node;
};
export function renderForm(root: HTMLElement, form: ModuleForm, data: unknown) {
  root.replaceChildren();
  for (const group of form.groups) {
    if (!isVisible(group.visibleIf, data)) continue;
    const section = element('section', 'p-3');
    section.append(element('h2', 'fx-group-title', group.title));
    for (const field of group.fields) {
      if (!isVisible(field.visibleIf, data)) continue;
      const row = element('div', 'flex items-center justify-between gap-4 min-h-8 border-b border-[var(--flux-line)]');
      const value = binding(data, field.bind);
      // Единица стоит только у значения: у пустого поля остаётся «—»
      const shown = blank(value) || !field.unit ? value : `${String(value)} ${field.unit}`;
      row.append(
        element('span', 'fx-label', field.label),
        element('span', `text-sm break-words min-w-0${field.kind === 'code' ? ' font-mono' : ''}`, shown ?? '—'),
      );
      section.append(row);
      if (field.hint) section.append(element('p', 'fx-hint', field.hint));
    }
    root.append(section);
  }
  for (const definition of form.tables) {
    if (!isVisible(definition.visibleIf, data)) continue;
    const section = element('section', 'p-3 min-w-0');
    section.append(element('h2', 'fx-group-title', definition.title));
    const table = element('table', 'fx-table w-full table-fixed');
    const head = document.createElement('thead');
    const header = document.createElement('tr');
    for (const column of definition.columns) header.append(element('th', `break-words${column.align === 'end' ? ' text-right' : ''}`, column.unit ? `${column.label}, ${column.unit}` : column.label));
    head.append(header); table.append(head);
    const body = document.createElement('tbody');
    const rows = binding(data, definition.bind);
    if (Array.isArray(rows)) for (const row of rows) {
      const tr = document.createElement('tr');
      for (const column of definition.columns) tr.append(element(
        'td', `break-words${column.align === 'end' ? ' text-right tabular-nums' : ''}`, binding(row, column.key) ?? '—',
      ));
      body.append(tr);
    }
    table.append(body); section.append(table); root.append(section);
  }
}
