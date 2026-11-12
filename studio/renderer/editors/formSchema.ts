/**
 * Проверка form.json: разбор, схема и привязки — с номером строки и понятным текстом.
 *
 * Три слоя. Разбор и схема решают, можно ли принять текст как новую форму: при ошибке в них
 * прежняя верная форма остаётся. Привязки (какого поля нет в описании данных) форму не отвергают: пока
 * инженер собирает форму, пустая привязка — обычное состояние, но выпуск с ней не уйдёт.
 */
import { describeSchemaError, formShapeErrors, pathOfPointer, whereInForm } from '../../../modules/formSchema';
import { parseJson, type JsonPath, type TextPlace } from './jsonText';
import { columnKeys, resolveBinding } from './contractModel';
import type { ContractDraft, FormDef, FormVisibility } from './types';

export interface FormDiagnostic extends TextPlace {
  layer: 'syntax' | 'schema' | 'binding';
  severity: 'error' | 'warning';
  message: string;
  path: JsonPath;
}

/** Ошибки разбора и схемы; пустой список — текст можно принять как форму */
export function structureProblems(source: string): { value?: FormDef; problems: FormDiagnostic[] } {
  const parsed = parseJson(source);
  if (!parsed.ok) {
    const { line, column, message } = parsed.problem!;
    return { problems: [{ layer: 'syntax', severity: 'error', line, column, message, path: [] }] };
  }
  const errors = formShapeErrors(parsed.value);
  if (!errors.length) return { value: parsed.value as FormDef, problems: [] };
  const problems: FormDiagnostic[] = [];
  for (const error of errors) {
    let path = pathOfPointer(error.instancePath);
    const extra = error.keyword === 'additionalProperties';
    if (extra) path = [...path, error.params.additionalProperty as string];
    problems.push({ layer: 'schema', severity: 'error', ...parsed.place(path, extra), path, message: `${describeSchemaError(error, path[path.length - 1])}${whereInForm(extra ? path.slice(0, -1) : path)}` });
  }
  problems.sort((a, b) => a.line - b.line || a.column - b.column);
  return { problems };
}

function checkVisibility(rule: FormVisibility | undefined, path: JsonPath, contract: ContractDraft, report: (path: JsonPath, message: string) => void) {
  if (!rule) return;
  const resolved = resolveBinding(rule.bind, contract);
  if (!resolved.ok) report([...path, 'visibleIf', 'bind'], `Условие показа: ${resolved.reason}`);
  if ((rule.op === 'eq' || rule.op === 'ne') && rule.value === undefined) report([...path, 'visibleIf'], 'Условие показа сравнивает со значением: укажите value');
}

/** Привязки и согласованность значений; форма уже прошла схему */
export function bindingProblems(source: string, form: FormDef, contract: ContractDraft): FormDiagnostic[] {
  const parsed = parseJson(source);
  const out: FormDiagnostic[] = [];
  const report = (path: JsonPath, message: string, severity: 'error' | 'warning' = 'error') =>
    out.push({ layer: 'binding', severity, ...parsed.place(path, false), path, message });
  form.groups.forEach((group, g) => {
    checkVisibility(group.visibleIf, ['groups', g], contract, report);
    group.fields.forEach((field, f) => {
      const at: JsonPath = ['groups', g, 'fields', f];
      if (!field.bind) report([...at, 'bind'], 'Источник значения не выбран: выберите вход или выход описания данных');
      else {
        const resolved = resolveBinding(field.bind, contract);
        if (!resolved.ok) report([...at, 'bind'], `Источник значения «${field.bind}»: ${resolved.reason}`);
        else if (resolved.type === 'array') report([...at, 'bind'], `Источник значения «${field.bind}» — список: для списка нужна таблица`);
      }
      checkVisibility(field.visibleIf, at, contract, report);
    });
  });
  form.tables.forEach((table, t) => {
    const at: JsonPath = ['tables', t];
    checkVisibility(table.visibleIf, at, contract, report);
    if (!table.bind) { report([...at, 'bind'], 'Источник значения не выбран: выберите список из данных Flux'); return; }
    // Тот же запрет, что при выпуске (modules/validateForm.ts): строки таблицы дают только данные Flux
    if (!table.bind.startsWith('flux.')) { report([...at, 'bind'], `Таблица «${table.bind}» должна ссылаться на список из данных Flux (flux.…): state и calc.out в таблицу не выводятся`); return; }
    const resolved = resolveBinding(table.bind, contract);
    if (!resolved.ok) { report([...at, 'bind'], `Источник значения «${table.bind}»: ${resolved.reason}`); return; }
    if (resolved.type !== 'array') { report([...at, 'bind'], `Таблица «${table.bind}» должна ссылаться на список, а там ${resolved.type}`); return; }
    const keys = columnKeys(table.bind, contract);
    table.columns.forEach((column, c) => {
      if (!column.key) report([...at, 'columns', c, 'key'], 'Колонка без поля: выберите, что показывать');
      else if (keys.length && !keys.includes(column.key)) report([...at, 'columns', c, 'key'], `В списке «${table.bind}» нет поля «${column.key}»`);
    });
  });
  out.sort((a, b) => a.line - b.line || a.column - b.column);
  return out;
}
