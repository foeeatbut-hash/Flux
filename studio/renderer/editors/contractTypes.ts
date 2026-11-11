/**
 * Типы и справка из договора подпрограммы.
 *
 * Для TypeScript и JavaScript из договора создаётся настоящий файл `.d.ts`: он описывает только
 * разрешённые чтения и объявленные значения, поэтому опечатка в поле или чтение не разрешённых
 * данных — ошибка типов у того, кто подключит файл к компилятору (тест проверяет его настоящим
 * tsc). Ни Studio, ни выпуск (modules/build.ts) по нему типы пока не проверяют. Для остальных языков Flux обменивается JSON (`compute(input)`), и
 * редактор показывает справку: какой JSON придёт на вход и какой ждут на выходе.
 */
import { dataSchemas } from '../../../modules/dataSchemas';
import { resources } from '../../../modules/contract';
import { unwrapSchema, type Schema } from './contractModel';
import type { ContractDraft, ContractValue, ValueType } from './types';

const IDENT = /^[A-Za-z_$][\w$]*$/;
const prop = (name: string) => IDENT.test(name) ? name : JSON.stringify(name);

const VALUE_TS: Record<ValueType, string> = {
  string: 'string', number: 'number', integer: 'number', boolean: 'boolean', object: 'Record<string, unknown>', array: 'unknown[]',
};

/** JSON Schema договора → тип TypeScript */
export function schemaToTs(schema: Schema, indent = ''): string {
  if (!schema || Object.keys(schema).length === 0) return 'unknown';
  if (schema.anyOf) return schema.anyOf.map((variant: Schema) => schemaToTs(variant, indent)).join(' | ');
  switch (schema.type) {
    case 'null': return 'null';
    case 'string': return 'string';
    case 'integer': case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'array': {
      const item = schemaToTs(schema.items, indent);
      return schema.items?.anyOf ? `Array<${item}>` : `${item}[]`;
    }
    case 'object': {
      const inner = `${indent}  `;
      const required: string[] = schema.required ?? [];
      const lines = Object.entries<Schema>(schema.properties).map(([key, child]) =>
        `${inner}${prop(key)}${required.includes(key) ? '' : '?'}: ${schemaToTs(child, inner)};`);
      return lines.length ? `{\n${lines.join('\n')}\n${indent}}` : '{}';
    }
    default: return 'unknown';
  }
}

const valueTs = (value: ContractValue) => value.type === 'array' && value.items ? `${VALUE_TS[value.items]}[]` : VALUE_TS[value.type];
const members = (values: ContractValue[], indent: string) => values.filter((value, i, all) => all.findIndex(other => other.name === value.name) === i).map(value => {
  const note = [value.description, value.unit && `единица: ${value.unit}`].filter(Boolean).join('; ');
  return `${note ? `${indent}/** ${note.replace(/\*\//g, '* /')} */\n` : ''}${indent}${prop(value.name)}?: ${valueTs(value)};`;
}).join('\n');

/** Файл `.d.ts` для логики на TypeScript и JavaScript; в пакете лежит как `contract.d.ts` рядом с каталогом logic/ */
export function generateContractDts(contract: ContractDraft): string {
  const reads = resources.filter(resource => contract.reads.includes(resource));
  return `// Создано Studio из договора подпрограммы (версия ${contract.version}). Не правьте вручную: изменения пропадут.
export interface FluxData {
${reads.map(resource => `  ${resource}: ${schemaToTs(dataSchemas[resource], '  ')};`).join('\n')}
}
/** Своё состояние подпрограммы: ввод пользователя в её окне, во Flux не пишется */
export interface State {
${members(contract.state, '  ')}
}
/** Результат расчёта: значения, которые подпрограмма отдаёт форме */
export interface CalcOut {
${members(contract.outputs, '  ')}
}
export interface ModuleApi {
  flux: {
    /** Чтение данных Flux с правами пользователя; разрешены только перечисленные в договоре */
    read<R extends keyof FluxData>(resource: R, entityId?: string): Promise<FluxData[R]>;
    on(event: 'changed', listener: () => void | Promise<void>): () => void;
  };
  log: { info(text: string): void; warn(text: string): void; error(text: string): void };
  state: State;
  calc: { out: CalcOut };
}
`;
}

/** Образец значения по схеме: для справки и контрольных примеров */
export function sampleFromSchema(schema: Schema): unknown {
  const current = unwrapSchema(schema);
  switch (current?.type) {
    case 'string': return '';
    case 'integer': case 'number': return 0;
    case 'boolean': return false;
    case 'array': return [sampleFromSchema(current.items)];
    case 'object': return Object.fromEntries(Object.entries<Schema>(current.properties).map(([key, child]) => [key, sampleFromSchema(child)]));
    default: return null;
  }
}

const SAMPLE_VALUE: Record<ValueType, unknown> = { string: '', number: 0, integer: 0, boolean: false, object: {}, array: [] };

/** Справка для языков без типов Flux: форма JSON на входе и выходе `compute` */
export function contractReference(contract: ContractDraft): string {
  const flux = Object.fromEntries(resources.filter(resource => contract.reads.includes(resource)).map(resource => [resource, sampleFromSchema(dataSchemas[resource])]));
  const state = Object.fromEntries(contract.state.map(value => [value.name, SAMPLE_VALUE[value.type]]));
  const out = Object.fromEntries(contract.outputs.map(value => [value.name, SAMPLE_VALUE[value.type]]));
  const describe = (title: string, values: ContractValue[]) => values.length
    ? [`${title}:`, ...values.map(value => `  ${value.name} — ${value.type}${value.unit ? `, ${value.unit}` : ''}${value.description ? `: ${value.description}` : ''}`)]
    : [`${title}: не объявлено`];
  return [
    'Вход compute(input) — JSON:',
    JSON.stringify({ flux, state }, null, 2),
    '',
    'Выход — JSON:',
    JSON.stringify({ state, calc: { out } }, null, 2),
    '',
    ...describe('Состояние (state)', contract.state),
    ...describe('Выходы расчёта (calc.out)', contract.outputs),
    '',
    `Разрешённые чтения: ${contract.reads.length ? contract.reads.join(', ') : 'нет'}. Других данных Flux расчёт не получит.`,
  ].join('\n');
}
