export interface ModuleForm {
  version: number;
  onDataChanged: string;
  groups: Array<{ title: string; fields: Array<{ label: string; bind: string }> }>;
  tables: Array<{ title: string; bind: string; columns: Array<{ label: string; key: string }> }>;
}
function binding(data: unknown, path: string): unknown {
  return path.split('.').reduce((value: any, key) => {
    if (!value || ['__proto__', 'prototype', 'constructor'].includes(key) || !Object.hasOwn(value, key)) return undefined;
    return value[key];
  }, data);
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
    const section = element('section', 'p-3');
    section.append(element('h2', 'fx-group-title', group.title));
    for (const field of group.fields) {
      const row = element('div', 'flex items-center justify-between gap-4 min-h-8 border-b border-[var(--flux-line)]');
      row.append(element('span', 'fx-label', field.label), element('span', 'text-sm break-words min-w-0', binding(data, field.bind) ?? '—'));
      section.append(row);
    }
    root.append(section);
  }
  for (const definition of form.tables) {
    const section = element('section', 'p-3 min-w-0');
    section.append(element('h2', 'fx-group-title', definition.title));
    const table = element('table', 'fx-table w-full table-fixed');
    const head = document.createElement('thead');
    const header = document.createElement('tr');
    for (const column of definition.columns) header.append(element('th', 'break-words', column.label));
    head.append(header); table.append(head);
    const body = document.createElement('tbody');
    const rows = binding(data, definition.bind);
    if (Array.isArray(rows)) for (const row of rows) {
      const tr = document.createElement('tr');
      for (const column of definition.columns) tr.append(element('td', 'break-words', binding(row, column.key) ?? '—'));
      body.append(tr);
    }
    table.append(body); section.append(table); root.append(section);
  }
}
