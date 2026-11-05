import Ajv from 'ajv';
import { resources, themeKeys } from './contract';

const text = { type: 'string', maxLength: 8192 };
const id = { type: 'string', minLength: 1, maxLength: 160 };
const nullableId = { anyOf: [id, { type: 'null' }] };
const array = (items: object) => ({ type: 'array', maxItems: 10000, items });
const object = (properties: Record<string, object>, required = Object.keys(properties)) => ({
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
const envelope = { flux: { const: 'module' }, v: { const: 1 }, session: id };
// Эти JSON Schema — источник проверки сообщений и будущих типов редактора Studio.
export const messageSchemas = {
  ready: object({ ...envelope, type: { const: 'ready' } }),
  read: object({ ...envelope, id, type: { const: 'read' }, resource: { enum: resources }, entityId: id }, ['flux', 'v', 'session', 'id', 'type', 'resource']),
  write: object(
    { ...envelope, id, type: { const: 'write' }, resource: { enum: resources }, entityId: id, data: {} },
    ['flux', 'v', 'session', 'id', 'type'],
  ),
  result: { anyOf: resources.map(resource => object({
    ...envelope, id, type: { const: 'result' }, resource: { const: resource }, data: dataSchemas[resource],
  })) },
  error: object({ ...envelope, id, type: { const: 'error' }, code: { enum: ['READ_ONLY', 'DENIED', 'NO_PROJECT', 'FAILED', 'LIMIT'] } }),
  event: object({
    ...envelope, type: { const: 'event' }, event: { enum: ['opened', 'project-changed', 'changed'] },
    context: object({ projectId: nullableId, entry: { enum: ['start', 'equipment', 'tag'] }, entityId: nullableId }),
    theme: object(Object.fromEntries(themeKeys.map(key => [key, { type: 'string', maxLength: 200 }]))),
  }),
};
const ajv = new Ajv({ allErrors: false, strict: false });
const validators = Object.fromEntries(Object.entries(messageSchemas).map(([key, schema]) => [key, ajv.compile(schema)]));
export function validMessage(type: keyof typeof messageSchemas, value: unknown): boolean {
  return !!validators[type](value);
}
export const manifestSchema = object({
  id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' }, name: text, author: text,
  version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' }, contractVersion: { const: 1 },
  entries: { type: 'array', uniqueItems: true, items: { enum: ['start', 'equipment', 'tag'] } },
  reads: { type: 'array', uniqueItems: true, items: { enum: resources } }, logic: { const: 'logic/main.ts' },
});
export const validManifest = ajv.compile(manifestSchema);
