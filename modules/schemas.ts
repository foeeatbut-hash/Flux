import Ajv from 'ajv';
import { resources, themeKeys } from './contract';
import { COMPUTE_ERROR_CODES, LANGUAGES, PLATFORMS, SOURCE_LANGUAGES, LOGIC_FILES } from './engine/types';

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
  failure: object({ ...envelope, type: { const: 'failure' }, kind: { enum: ['crash', 'timeout', 'memory', 'bridge', 'controls'] } }),
  read: object({ ...envelope, id, type: { const: 'read' }, resource: { enum: resources }, entityId: id }, ['flux', 'v', 'session', 'id', 'type', 'resource']),
  write: object(
    { ...envelope, id, type: { const: 'write' }, resource: { enum: resources }, entityId: id, data: {} },
    ['flux', 'v', 'session', 'id', 'type'],
  ),
  result: { anyOf: resources.map(resource => object({
    ...envelope, id, type: { const: 'result' }, resource: { const: resource }, data: dataSchemas[resource],
  })) },
  // Расчёт на любом языке: модуль присылает вход, Flux выбирает механизм по подписанному манифесту,
  // проверяет выход по схеме и возвращает его (modules/engine). Какой язык — модуль не указывает.
  compute: object({ ...envelope, id, type: { const: 'compute' }, input: { type: 'object' } }),
  'compute-result': object({
    ...envelope, id, type: { const: 'compute-result' },
    output: object({ state: { type: 'object' }, calc: object({ out: { type: 'object' } }) }),
  }),
  'compute-error': object({ ...envelope, id, type: { const: 'compute-error' }, code: { enum: [...COMPUTE_ERROR_CODES] } }),
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
const shortText = (max: number) => ({ type: 'string', maxLength: max });
const storeBlock = object({
  category: { enum: ['calc', 'link', 'docs', 'reports', 'other'] }, summary: shortText(200), description: shortText(4000),
  color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
  requires: object({
    flux: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' }, platform: { enum: ['any', 'windows'] },
    external: { type: 'array', maxItems: 10, items: shortText(80) },
  }, []),
  dependsOn: { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' } },
  roles: { type: 'array', maxItems: 20, uniqueItems: true, items: shortText(64) },
  screenshots: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', pattern: '^store/[A-Za-z0-9_-]{1,40}\\.(png|jpg|webp)$' } },
}, ['category', 'summary']);
export const manifestSchema = object({
  id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' }, name: text, author: text,
  version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' }, contractVersion: { const: 1 },
  entries: { type: 'array', uniqueItems: true, items: { enum: ['start', 'equipment', 'tag'] } },
  reads: { type: 'array', uniqueItems: true, items: { enum: resources } }, logic: { enum: Object.values(LOGIC_FILES) },
  language: { enum: [...LANGUAGES] }, sourceLanguage: { enum: [...SOURCE_LANGUAGES] }, platform: { enum: [...PLATFORMS] },
  store: storeBlock,
}, ['id', 'name', 'author', 'version', 'contractVersion', 'entries', 'reads', 'logic']);
// Файл логики обязан соответствовать языку: иначе подпись покрывала бы один файл, а запускался другой
const languageIs = (language: string) => ({ required: ['language'], properties: { language: { const: language } } });
(manifestSchema as any).allOf = [
  { if: languageIs('python'), then: { properties: { logic: { const: LOGIC_FILES.python } }, not: { required: ['sourceLanguage'] } } },
  { if: languageIs('wasm'), then: { properties: { logic: { const: LOGIC_FILES.wasm } }, required: ['sourceLanguage'] } },
  { if: { not: { required: ['language'], properties: { language: { enum: ['python', 'wasm'] } } } },
    then: { properties: { logic: { const: LOGIC_FILES.typescript } }, not: { required: ['sourceLanguage'] } } },
];
export const validManifest = ajv.compile(manifestSchema);
