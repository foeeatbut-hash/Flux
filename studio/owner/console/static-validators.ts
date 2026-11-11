/**
 * Проверки сообщений моста, собранные заранее (при сборке), а не во время работы окна: CSP окна владельца
 * запрещает eval, а Ajv компилирует схемы выполнением строки. Тот же приём, что в modules/build.ts для
 * страницы подпрограммы. Запускается только в сборке (studio/build.cjs), в окно не попадает.
 */
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone';
import { messageSchemas } from '../../../modules/schemas';

export function staticValidators(): string {
  const validator = new Ajv({ strict: false, code: { source: true } });
  for (const [key, schema] of Object.entries(messageSchemas)) validator.addSchema(schema as object, key);
  return standaloneCode(validator, Object.fromEntries(Object.keys(messageSchemas).map(key => [key, key])))
    + '\nexports.validMessage = (type, value) => !!exports[type]?.(value);';
}
