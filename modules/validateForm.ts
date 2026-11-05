import { dataSchemas } from './schemas';
import type { Resource } from './contract';
import type { ModuleForm } from './runtime/form';

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
  const form = value as ModuleForm;
  if (!form || form.version !== 1 || !Array.isArray(form.groups) || !Array.isArray(form.tables)) {
    fail('ожидается форма версии 1 с groups и tables');
  }
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
  // Проверяем тот же JSON, который попадёт в пакет. Ошибка разработчика
  // не должна превращаться у инженера в сообщение об отсутствии доступа.
  for (const group of form.groups) {
    if (!Array.isArray(group.fields)) fail('группа должна содержать fields');
    for (const field of group.fields) resolve(field.bind);
  }
  for (const table of form.tables) {
    const schema = resolve(table.bind);
    if (schema.type !== 'array') fail(`таблица «${table.bind}» должна ссылаться на массив Flux`);
    if (!Array.isArray(table.columns)) fail('таблица должна содержать columns');
    for (const column of table.columns) {
      if (typeof column.key !== 'string' || !step(schema.items, column.key.split('.'))) {
        fail(`неизвестная колонка «${table.bind}.${column.key}» в схеме договора v1`);
      }
    }
  }
}
