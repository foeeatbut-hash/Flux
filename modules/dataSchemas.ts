/**
 * Схемы данных Flux по договору v1. Вынесены без Ajv: окно Studio работает без 'unsafe-eval',
 * а Ajv собирает проверки через new Function; редакторам нужны только сами схемы.
 */
export const text = { type: 'string', maxLength: 8192 };
export const id = { type: 'string', minLength: 1, maxLength: 160 };
export const nullableId = { anyOf: [id, { type: 'null' }] };
export const array = (items: object) => ({ type: 'array', maxItems: 10000, items });
export const object = (properties: Record<string, object>, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const tag = object({ id, identifier: text, name: text, parentId: nullableId });
export const dataSchemas = {
  project: { anyOf: [object({ id, name: text, code: text }), { type: 'null' }] },
  equipment: { anyOf: [object({
    id, name: text, itemCode: text, equipType: text, version: { type: 'integer', minimum: 0 },
    params: array(object({ group: text, key: text, value: text, unit: text })),
    tags: array(tag), composition: array(object({ id, name: text, itemCode: text, parentId: nullableId })),
  }), { type: 'null' }] },
  tag: { anyOf: [tag, { type: 'null' }] },
  specification: object({ rows: array(tag) }),
  catalog: object({ families: array(object({ id, name: text, code: text, classId: text })) }),
};
