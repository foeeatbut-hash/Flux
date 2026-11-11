/**
 * Статические проверщики сообщений моста для окна подпрограммы.
 *
 * CSP подпрограммы запрещает eval, поэтому Ajv не может собрать проверку на лету: код проверки
 * генерируется при сборке (так же делает modules/build.ts). Этот файл — только для сборки Studio.
 */
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone';
import { messageSchemas } from '../../modules/schemas';

export function staticValidators(): string {
  const validator = new Ajv({ strict: false, code: { source: true } });
  for (const [key, schema] of Object.entries(messageSchemas)) validator.addSchema(schema, key);
  return standaloneCode(validator, Object.fromEntries(Object.keys(messageSchemas).map(key => [key, key])))
    + '\nexports.validMessage = (type, value) => !!exports[type]?.(value);';
}
