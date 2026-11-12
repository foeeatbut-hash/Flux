/**
 * Договор программы глазами редакторов: какие привязки существуют и какого они типа.
 *
 * Данные Flux берутся из тех же JSON Schema (modules/dataSchemas.ts), по которым оболочка проверяет
 * сообщения и форму при выпуске, — второй список полей не ведётся. Свои значения программы
 * (state.*, calc.out.*) разработчик объявляет в договоре сам.
 */
import { dataSchemas } from '../../../modules/dataSchemas';
import { resources } from '../../../modules/contract';
import type { ContractDraft, Resource, ValueType } from './types';

export type Schema = any;

export interface BindingOption {
  path: string;
  kind: 'input' | 'output' | 'state';
  type: ValueType;
  unit?: string;
  description?: string;
}

export const isResource = (name: string): name is Resource => (resources as readonly string[]).includes(name);
const forbidden = ['__proto__', 'prototype', 'constructor'];

/** Схема без варианта «null»: пустое значение допускается всегда, поля описывает основная схема */
export function unwrapSchema(schema: Schema): Schema {
  if (schema?.anyOf) return unwrapSchema(schema.anyOf.find((variant: Schema) => variant.type !== 'null') ?? schema.anyOf[0]);
  return schema;
}

/** Идёт по схеме вглубь; тот же обход, что в modules/validateForm.ts, но без исключений */
export function stepSchema(schema: Schema, keys: string[]): Schema | null {
  const current = unwrapSchema(schema);
  if (!keys.length) return current;
  const [key, ...rest] = keys;
  if (forbidden.includes(key)) return null;
  if (current.type === 'array' && /^(0|[1-9]\d*)$/.test(key)) return stepSchema(current.items, rest);
  if (current.type === 'object' && Object.hasOwn(current.properties, key)) return stepSchema(current.properties[key], rest);
  return null;
}

export function valueType(schema: Schema): ValueType {
  const type = unwrapSchema(schema)?.type;
  return type === 'string' || type === 'number' || type === 'integer' || type === 'boolean' || type === 'array' ? type : 'object';
}

/** Не объединение по `ok`: в проекте выключен strictNullChecks, там такое сужение не работает */
export interface Resolved { ok: boolean; reason?: string; type?: ValueType; schema?: Schema | null; kind?: BindingOption['kind'] }

/** Что значит привязка: путь Flux по схеме договора, свой state или выход расчёта */
export function resolveBinding(path: string, contract: ContractDraft): Resolved {
  if (typeof path !== 'string' || !path) return { ok: false, reason: 'привязка пуста' };
  const [root, name, ...keys] = path.split('.');
  if (root === 'state' || (root === 'calc' && name === 'out')) {
    const parts = root === 'state' ? [name, ...keys] : keys;
    if (!parts.length || parts.some(part => !part)) return { ok: false, reason: `в привязке «${path}» не назван ${root === 'state' ? 'ключ состояния' : 'выход расчёта'}` };
    const declared = (root === 'state' ? contract.state : contract.outputs).find(value => value.name === parts[0]);
    if (!declared) return { ok: false, reason: `«${parts[0]}» не объявлено в договоре (${root === 'state' ? 'состояние' : 'выходы расчёта'})` };
    return { ok: true, type: parts.length === 1 ? declared.type : 'object', schema: null, kind: root === 'state' ? 'state' : 'output' };
  }
  if (root !== 'flux' || !name) return { ok: false, reason: `привязка «${path}» должна начинаться с flux., state. или calc.out.` };
  if (!isResource(name)) return { ok: false, reason: `у Flux нет данных «${name}»` };
  if (!contract.reads.includes(name)) return { ok: false, reason: `данные «${name}» не разрешены: добавьте их в договоре в «Что читает программа»` };
  const schema = stepSchema(dataSchemas[name], keys);
  if (!schema) return { ok: false, reason: `в данных «${name}» нет пути «${keys.join('.')}»` };
  return { ok: true, type: valueType(schema), schema, kind: 'input' };
}

/** Все привязки, которые можно выбрать в списке: листья данных Flux, массивы для таблиц, state и выходы */
export function bindingOptions(contract: ContractDraft): BindingOption[] {
  const out: BindingOption[] = [];
  const walk = (prefix: string, schema: Schema, depth: number) => {
    const current = unwrapSchema(schema);
    if (current.type === 'object') {
      for (const [key, child] of Object.entries<Schema>(current.properties)) walk(`${prefix}.${key}`, child, depth + 1);
      return;
    }
    out.push({ path: prefix, kind: 'input', type: valueType(current) });
  };
  for (const resource of resources) if (contract.reads.includes(resource)) walk(`flux.${resource}`, dataSchemas[resource], 0);
  for (const value of contract.state) out.push({ path: `state.${value.name}`, kind: 'state', type: value.type, unit: value.unit, description: value.description });
  for (const value of contract.outputs) out.push({ path: `calc.out.${value.name}`, kind: 'output', type: value.type, unit: value.unit, description: value.description });
  return out;
}

/** Ключи колонок таблицы: поля элемента массива, к которому привязана таблица */
export function columnKeys(tableBind: string, contract: ContractDraft): string[] {
  const resolved = resolveBinding(tableBind, contract);
  if (!resolved.ok || resolved.type !== 'array' || !resolved.schema) return [];
  const item = unwrapSchema(unwrapSchema(resolved.schema).items);
  const keys: string[] = [];
  const walk = (prefix: string, schema: Schema) => {
    const current = unwrapSchema(schema);
    if (current.type === 'object') for (const [key, child] of Object.entries<Schema>(current.properties)) walk(prefix ? `${prefix}.${key}` : key, child);
    else if (prefix) keys.push(prefix);
  };
  walk('', item);
  return keys;
}
