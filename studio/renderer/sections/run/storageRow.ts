/**
 * Строка журнала запуска о записи состояния самостоятельной программы в хранилище (область `studio`).
 *
 * Тексты отказов приходят от главного процесса готовыми: `LIMIT` — «Хранилище программы заполнено: N из 1 МиБ», тот же текст
 * видит человек во Flux. Успешная запись молчит, чтобы журнал не заполнялся при каждом сохранении состояния.
 */
import type { RunStorageKeepReply } from '../../../shared/runActions';
import type { LogRow } from './model';

export function keepRow(reply: RunStorageKeepReply): { kind: string; text: string; level: LogRow['level'] } | null {
  // Без строгой проверки null тип не сужается по `ok`, поэтому отказ узнаётся по полю `code`
  if (!('code' in reply)) return reply.line ? { kind: 'хранилище', text: reply.line, level: 'warn' } : null;
  return { kind: 'хранилище', text: `${reply.code}: ${reply.line}`, level: 'error' };
}
