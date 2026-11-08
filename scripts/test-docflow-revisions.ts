/** Схема ревизий и срок ответа — чистые правила выпуска и возвратов (docs/docflow-program.md, 7.1, 7.3). */
import assert from 'node:assert/strict';
import { addCalendarDays, endOfDay, expectedRevision, normalizeRevisionRules, revisionProblem, responseDeadline, validDay } from '../shared/docflow/revisions.js';

let passed = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  passed++;
};
const rules = normalizeRevisionRules({});
check('после A идёт B, после Z букв нет, после буквы — первая цифра', expectedRevision(rules, 'A', 'letter') === 'B' && expectedRevision(rules, 'Z', 'letter') === null && expectedRevision(rules, 'C', 'digit') === '0');
check('после цифры буквенная невозможна, цифры идут подряд', expectedRevision(rules, '1', 'letter') === null && expectedRevision(rules, '1', 'digit') === '2');
check('первый выпуск принимает любую ревизию своего вида', expectedRevision(rules, null, 'letter') === '' && revisionProblem(rules, null, 'C', 'letter') === null);
check('пропуск ревизии отвергается', /следующей должна быть B/.test(revisionProblem(rules, 'A', 'C', 'letter') || ''));
check('свои правила схемы: пропуск буквы I', expectedRevision(normalizeRevisionRules({ letters: 'ABCDEFGHJK', firstDigit: 1 }), 'H', 'letter') === 'J' && expectedRevision(normalizeRevisionRules({ letters: 'ABC', firstDigit: 1 }), 'C', 'digit') === '1');
check('несуществующая дата отвергается', !validDay('2026-02-31') && validDay('2026-02-28') && !validDay('26-1-1'));
check('календарные дни через переход на зимнее время не плывут', addCalendarDays('2026-10-24', 3) === '2026-10-27' && addCalendarDays('2026-12-30', 3) === '2027-01-02');
check('срок кончается в последнюю секунду дня часового пояса пользователя',
  endOfDay('2026-11-10', 'Europe/Moscow').toISOString() === '2026-11-10T20:59:59.000Z' && endOfDay('2026-11-10', 'America/New_York').toISOString() === '2026-11-11T04:59:59.000Z'
  && responseDeadline('2026-11-05', 10, 'Asia/Novosibirsk').toISOString() === '2026-11-15T16:59:59.000Z');
console.log(`docflow-revisions: ${passed} проверок прошли`);
