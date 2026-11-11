/**
 * Схема form.json — одна на всех: по ней проверяет форму выпуск (modules/validateForm.ts) и
 * редакторы Studio (studio/renderer/editors), поэтому «проходит в Studio, но отвергается при
 * выпуске» невозможно по построению. Проверка — modules/miniSchema.ts, без Ajv.
 *
 * Лишние ключи отвергаются: опечатка в имени свойства иначе молча не действовала бы. Выпущенные
 * ранее формы не перепроверяются; все формы из modules/fixtures схему проходят (проверка в
 * scripts/test-modules-form.ts).
 */
import { validateSchema, type SchemaError } from './miniSchema';

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
              properties: { label: text(120), bind: text(256), kind: { const: 'code' }, unit: text(32), hint: text(300), visibleIf: visibility },
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

export const formShapeErrors = (value: unknown): SchemaError[] => validateSchema(formSchema, value);

const TYPE_NAMES: Record<string, string> = { string: 'строка', number: 'число', integer: 'целое число', boolean: 'да или нет', array: 'список', object: 'объект' };

/** Путь в форме для человека: «groups → [1] → fields → [2] → label» */
export const whereInForm = (path: Array<string | number>) =>
  path.length ? ` (${path.map(part => typeof part === 'number' ? `[${part + 1}]` : part).join(' → ')})` : '';

/** Понятная фраза об ошибке схемы (без места: место добавляет вызывающий) */
export function describeSchemaError(error: { keyword: string; params: Record<string, any> }, last?: string | number): string {
  const { keyword, params } = error;
  if (keyword === 'required') return `Не хватает поля «${params.missingProperty}»`;
  if (keyword === 'additionalProperties') return `Неизвестное поле «${params.additionalProperty}»`;
  if (keyword === 'type') return `Ожидается ${TYPE_NAMES[params.type] ?? params.type}`;
  if (keyword === 'enum') return `Допустимо только: ${params.allowedValues.map((v: unknown) => `«${v}»`).join(', ')}`;
  if (keyword === 'const') return last === 'version' ? 'Поддерживается форма версии 1: version должен быть 1' : `Допустимо только значение «${params.allowedValue}»`;
  if (keyword === 'maxLength') return `Слишком длинный текст: не больше ${params.limit} знаков`;
  if (keyword === 'maxItems') return `Слишком много элементов: не больше ${params.limit}`;
  if (keyword === 'uniqueItems') return 'Значения в списке повторяются';
  if (keyword === 'pattern') return 'Имя обработчика — латинские буквы, цифры и «_», не с цифры';
  return 'Значение не подходит под схему';
}

/** JSON-указатель Ajv-вида → путь из ключей и номеров */
export const pathOfPointer = (pointer: string): Array<string | number> => pointer.split('/').slice(1).map(part => {
  const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
  return /^(0|[1-9]\d*)$/.test(key) ? Number(key) : key;
});
