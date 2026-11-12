/**
 * Проверка по JSON Schema без Ajv.
 *
 * Ajv собирает проверки через new Function, а окно Studio и окно программы работают с CSP без
 * 'unsafe-eval'. Описание формы (modules/formSchema.ts) пользуется малой частью JSON Schema; её и
 * разбирает эта функция. Ошибки имеют тот же вид (keyword, instancePath, params), что у Ajv.
 *
 * Поддерживаются только слова: type (string, number, boolean, object, array), const, enum,
 * properties, required, additionalProperties (только false), items, maxLength, maxItems,
 * uniqueItems, pattern, а также описательные title и description. Любое другое слово в схеме —
 * исключение: правка схемы не должна молча перестать проверяться.
 */
export interface SchemaError { keyword: string; instancePath: string; params: Record<string, unknown> }
type Schema = Record<string, any>;

const SUPPORTED = new Set([
  'type', 'const', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'maxLength', 'maxItems', 'uniqueItems', 'pattern',
  'title', 'description',
]);
const TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);

const typeOf = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

/** Глубокое сравнение значений JSON: порядок ключей не важен (как у Ajv для uniqueItems) */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b) || typeof a !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((item, i) => same(item, (b as unknown[])[i]));
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every(key => Object.hasOwn(y, key) && same(x[key], y[key]));
}

export function validateSchema(schema: Schema, value: unknown, instancePath = '', errors: SchemaError[] = []): SchemaError[] {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) throw new Error(`miniSchema: слово «${keyword}» не поддерживается; поддержите его здесь или проверяйте Ajv`);
  }
  if (schema.type !== undefined && !TYPES.has(schema.type)) throw new Error(`miniSchema: тип «${schema.type}» не поддерживается`);
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new Error('miniSchema: additionalProperties поддерживается только как false');
  const fail = (keyword: string, params: Record<string, unknown> = {}) => errors.push({ keyword, instancePath, params });
  if ('const' in schema && !same(value, schema.const)) { fail('const', { allowedValue: schema.const }); return errors; }
  if (schema.enum && !schema.enum.some((item: unknown) => same(item, value))) { fail('enum', { allowedValues: schema.enum }); return errors; }
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
    if (schema.uniqueItems && value.some((item, i) => value.findIndex(other => same(item, other)) !== i)) fail('uniqueItems');
    if (schema.items) value.forEach((item, index) => validateSchema(schema.items, item, `${instancePath}/${index}`, errors));
  }
  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) fail('required', { missingProperty: key });
    for (const [key, child] of Object.entries(object)) {
      // Только собственные свойства схемы: «constructor» и «toString» не должны находиться по цепочке прототипов
      if (schema.properties && Object.hasOwn(schema.properties, key)) {
        validateSchema(schema.properties[key], child, `${instancePath}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, errors);
      } else if (schema.additionalProperties === false) errors.push({ keyword: 'additionalProperties', instancePath, params: { additionalProperty: key } });
    }
  }
  return errors;
}
