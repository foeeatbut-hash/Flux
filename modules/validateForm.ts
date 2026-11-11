import { dataSchemas } from './schemas';
import type { Resource } from './contract';
import type { ModuleForm } from './runtime/form';
import { describeSchemaError, formShapeErrors, pathOfPointer, whereInForm } from './formSchema';

function step(schema: any, keys: string[]): any {
  if (schema.anyOf) {
    for (const variant of schema.anyOf) {
      const result = step(variant, keys);
      if (result) return result;
    }
    return null;
  }
  if (!keys.length) return schema;
  const [key, ...rest] = keys;
  if (['__proto__', 'prototype', 'constructor'].includes(key)) return null;
  if (schema.type === 'array' && /^(0|[1-9]\d*)$/.test(key)) return step(schema.items, rest);
  if (schema.type === 'object' && Object.hasOwn(schema.properties, key)) return step(schema.properties[key], rest);
  return null;
}
export function validateModuleForm(value: unknown, moduleId: string, reads: Resource[]): asserts value is ModuleForm {
  const fail = (reason: string): never => { throw new Error(`form.json модуля «${moduleId}»: ${reason}`); };
  // Форма разбирается по той же схеме, что в редакторах Studio: лишние и неверные свойства отвергаются здесь,
  // а не молча не действуют у пользователя
  const shape = formShapeErrors(value)[0];
  if (shape) {
    const path = pathOfPointer(shape.instancePath);
    if (shape.keyword === 'additionalProperties') path.push(shape.params.additionalProperty as string);
    fail(`${describeSchemaError(shape, path[path.length - 1])}${whereInForm(path)}`);
  }
  const form = value as ModuleForm;
  const resolve = (path: string): any => {
    if (typeof path !== 'string') fail('привязка должна быть строкой');
    const [root, resource, ...keys] = path.split('.');
    if (root === 'state' && resource && !keys.some(key => !key)) return {};
    if (root === 'calc' && resource === 'out' && keys.length && keys.every(Boolean)) return {};
    if (root !== 'flux' || !Object.hasOwn(dataSchemas, resource)) fail(`неизвестная привязка «${path}»`);
    if (!reads.includes(resource as Resource)) fail(`привязка «${path}» требует разрешения reads: ${resource}`);
    const schema = step(dataSchemas[resource as Resource], keys);
    if (!schema) fail(`неизвестная привязка «${path}»: путь отсутствует в схеме договора v1`);
    return schema;
  };
  const visibility = (rule: { bind: string; op: string; value?: string } | undefined) => {
    if (!rule) return;
    resolve(rule.bind);
    if ((rule.op === 'eq' || rule.op === 'ne') && rule.value === undefined) fail(`условие показа «${rule.bind}» сравнивает со значением: нужен value`);
  };
  // Проверяем тот же JSON, который попадёт в пакет. Ошибка разработчика
  // не должна превращаться у инженера в сообщение об отсутствии доступа.
  for (const group of form.groups) {
    visibility(group.visibleIf);
    for (const field of group.fields) {
      const schema = resolve(field.bind);
      if (schema.type === 'array') fail(`поле «${field.label}» привязано к списку «${field.bind}»: список показывает таблица`);
      visibility(field.visibleIf);
    }
  }
  for (const table of form.tables) {
    visibility(table.visibleIf);
    // Строки таблицы дают только данные Flux по договору: у state и calc.out нет схемы, и колонки не проверить
    if (!table.bind.startsWith('flux.')) fail(`таблица «${table.bind}» должна ссылаться на массив Flux (flux.…): state и calc.out в таблицу не выводятся`);
    const schema = resolve(table.bind);
    if (schema.type !== 'array') fail(`таблица «${table.bind}» должна ссылаться на массив Flux`);
    for (const column of table.columns) {
      if (!column.key || !step(schema.items, column.key.split('.'))) {
        fail(`неизвестная колонка «${table.bind}.${column.key}» в схеме договора v1`);
      }
    }
  }
}
