/**
 * Проверка form.json: разбор, схема и привязки — с номером строки и понятным текстом.
 *
 * Три слоя. Разбор и схема решают, можно ли принять текст как новую форму: при ошибке в них
 * прежняя верная форма остаётся. Привязки (какого поля нет в договоре) форму не отвергают: пока
 * инженер собирает форму, пустая привязка — обычное состояние, но выпуск с ней не уйдёт.
 */
import Ajv from 'ajv';
import { parseJson, type JsonPath, type TextPlace } from './jsonText';
import { columnKeys, resolveBinding } from './contractModel';
import type { ContractDraft, FormDef, FormVisibility } from './types';

export interface FormDiagnostic extends TextPlace {
  layer: 'syntax' | 'schema' | 'binding';
  severity: 'error' | 'warning';
  message: string;
  path: JsonPath;
}

const text = (max: number) => ({ type: 'string', maxLength: max });
const visibility = {
  type: 'object', additionalProperties: false, required: ['bind', 'op'],
  properties: { bind: text(256), op: { enum: ['eq', 'ne', 'filled', 'empty'] }, value: text(256) },
};
export const formSchema = {
  type: 'object', additionalProperties: false, required: ['version', 'groups', 'tables'],
  properties: {
    version: { const: 1 },
    onDataChanged: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]{0,127}$' },
    groups: {
      type: 'array', maxItems: 64, items: {
        type: 'object', additionalProperties: false, required: ['title', 'fields'],
        properties: {
          title: text(120), visibleIf: visibility,
          fields: {
            type: 'array', maxItems: 128, items: {
              type: 'object', additionalProperties: false, required: ['label', 'bind'],
              properties: {
                label: text(120), bind: text(256), kind: { const: 'code' }, unit: text(32),
                allowed: { type: 'array', maxItems: 64, uniqueItems: true, items: text(120) },
                min: { type: 'number' }, max: { type: 'number' }, required: { type: 'boolean' },
                placeholder: text(120), hint: text(300), visibleIf: visibility,
              },
            },
          },
        },
      },
    },
    tables: {
      type: 'array', maxItems: 32, items: {
        type: 'object', additionalProperties: false, required: ['title', 'bind', 'columns'],
        properties: {
          title: text(120), bind: text(256), visibleIf: visibility,
          columns: {
            type: 'array', maxItems: 32, items: {
              type: 'object', additionalProperties: false, required: ['label', 'key'],
              properties: { label: text(120), key: text(256), align: { const: 'end' }, unit: text(32) },
            },
          },
        },
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile(formSchema);

const TYPE_NAMES: Record<string, string> = { string: 'строка', number: 'число', integer: 'целое число', boolean: 'да или нет', array: 'список', object: 'объект' };
const pathOf = (pointer: string): JsonPath => pointer.split('/').slice(1).map(part => {
  const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
  return /^(0|[1-9]\d*)$/.test(key) ? Number(key) : key;
});
const where = (path: JsonPath) => path.length ? ` (${path.map(part => typeof part === 'number' ? `[${part + 1}]` : part).join(' → ')})` : '';

function schemaMessage(error: { keyword: string; params: any; message?: string }, last: string | number | undefined): string {
  const { keyword, params } = error;
  if (keyword === 'required') return `Не хватает поля «${params.missingProperty}»`;
  if (keyword === 'type') return `Ожидается ${TYPE_NAMES[params.type] ?? params.type}`;
  if (keyword === 'enum') return `Допустимо только: ${params.allowedValues.map((v: unknown) => `«${v}»`).join(', ')}`;
  if (keyword === 'const') return last === 'version' ? 'Поддерживается форма версии 1: version должен быть 1' : `Допустимо только значение «${params.allowedValue}»`;
  if (keyword === 'maxLength') return `Слишком длинный текст: не больше ${params.limit} знаков`;
  if (keyword === 'maxItems') return `Слишком много элементов: не больше ${params.limit}`;
  if (keyword === 'uniqueItems') return 'Значения в списке повторяются';
  if (keyword === 'pattern') return 'Имя обработчика — латинские буквы, цифры и «_», не с цифры';
  return error.message ?? 'Значение не подходит под схему';
}

/** Ошибки разбора и схемы; пустой список — текст можно принять как форму */
export function structureProblems(source: string): { value?: FormDef; problems: FormDiagnostic[] } {
  const parsed = parseJson(source);
  if (!parsed.ok) {
    const { line, column, message } = parsed.problem!;
    return { problems: [{ layer: 'syntax', severity: 'error', line, column, message, path: [] }] };
  }
  if (validateShape(parsed.value)) return { value: parsed.value as FormDef, problems: [] };
  const problems: FormDiagnostic[] = [];
  for (const error of validateShape.errors ?? []) {
    let path = pathOf(error.instancePath);
    let key = false;
    if (error.keyword === 'additionalProperties') {
      path = [...path, error.params.additionalProperty];
      key = true;
      problems.push({ layer: 'schema', severity: 'error', ...parsed.place(path, key), path, message: `Неизвестное поле «${error.params.additionalProperty}»${where(path.slice(0, -1))}` });
      continue;
    }
    problems.push({ layer: 'schema', severity: 'error', ...parsed.place(path, key), path, message: `${schemaMessage(error, path[path.length - 1])}${where(path)}` });
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
      if (!field.bind) report([...at, 'bind'], 'Привязка не выбрана: выберите вход или выход договора');
      else {
        const resolved = resolveBinding(field.bind, contract);
        if (!resolved.ok) report([...at, 'bind'], `Привязка «${field.bind}»: ${resolved.reason}`);
        else if (resolved.type === 'array') report([...at, 'bind'], `Привязка «${field.bind}» — список: для списка нужна таблица`);
      }
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) report([...at, 'min'], 'Наименьшее значение больше наибольшего');
      checkVisibility(field.visibleIf, at, contract, report);
    });
  });
  form.tables.forEach((table, t) => {
    const at: JsonPath = ['tables', t];
    checkVisibility(table.visibleIf, at, contract, report);
    if (!table.bind) { report([...at, 'bind'], 'Привязка не выбрана: выберите список из данных Flux'); return; }
    const resolved = resolveBinding(table.bind, contract);
    if (!resolved.ok) { report([...at, 'bind'], `Привязка «${table.bind}»: ${resolved.reason}`); return; }
    if (resolved.type !== 'array') { report([...at, 'bind'], `Таблица «${table.bind}» должна ссылаться на список, а там ${TYPE_NAMES[resolved.type] ?? resolved.type}`); return; }
    const keys = columnKeys(table.bind, contract);
    table.columns.forEach((column, c) => {
      if (!column.key) report([...at, 'columns', c, 'key'], 'Колонка без поля: выберите, что показывать');
      else if (keys.length && !keys.includes(column.key)) report([...at, 'columns', c, 'key'], `В списке «${table.bind}» нет поля «${column.key}»`);
    });
  });
  out.sort((a, b) => a.line - b.line || a.column - b.column);
  return out;
}
