/**
 * Проверка по JSON Schema без Ajv.
 *
 * Окно Studio работает с CSP без 'unsafe-eval', а Ajv собирает проверку через new Function и в
 * окне не запустится. Схема формы пользуется малой частью JSON Schema, её и разбирает эта функция;
 * ошибки имеют тот же вид (keyword, instancePath, params), что у Ajv. Согласие с Ajv закреплено
 * проверкой scripts/test-studio-editor.ts: те же тексты проходят и отвергаются обеими.
 */
export interface SchemaError { keyword: string; instancePath: string; params: Record<string, unknown> }
type Schema = Record<string, any>;

const typeOf = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

export function validateSchema(schema: Schema, value: unknown, instancePath = '', errors: SchemaError[] = []): SchemaError[] {
  const fail = (keyword: string, params: Record<string, unknown> = {}) => errors.push({ keyword, instancePath, params });
  if ('const' in schema && value !== schema.const) { fail('const', { allowedValue: schema.const }); return errors; }
  if (schema.enum && !schema.enum.includes(value)) { fail('enum', { allowedValues: schema.enum }); return errors; }
  if (schema.type) {
    const actual = typeOf(value);
    const matches = schema.type === 'number' ? actual === 'number' && Number.isFinite(value) : actual === schema.type;
    if (!matches) { fail('type', { type: schema.type }); return errors; }
  }
  if (typeof value === 'string') {
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) fail('maxLength', { limit: schema.maxLength });
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('pattern', { pattern: schema.pattern });
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('maxItems', { limit: schema.maxItems });
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail('uniqueItems');
    if (schema.items) value.forEach((item, index) => validateSchema(schema.items, item, `${instancePath}/${index}`, errors));
  }
  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) fail('required', { missingProperty: key });
    for (const [key, child] of Object.entries(object)) {
      const sub = schema.properties?.[key];
      if (sub) validateSchema(sub, child, `${instancePath}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, errors);
      else if (schema.additionalProperties === false) errors.push({ keyword: 'additionalProperties', instancePath, params: { additionalProperty: key } });
    }
  }
  return errors;
}
