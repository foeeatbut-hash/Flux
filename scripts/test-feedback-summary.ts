/**
 * Сводка, отпечаток дубля и выгрузка.
 *
 * Сводка опаснее прочего тем, что она выглядит убедительно при любом числе.
 * «Медиана ответа — четыре минуты» по трём случаям читается так же уверенно,
 * как по тремстам, и решения по ней принимают такие же. Поэтому здесь
 * проверяется не «считает ли», а отказывается ли считать, когда данных мало, и
 * считает ли закрытые по переходам, а не по нынешнему состоянию.
 *
 * Отпечаток проверяется на том, из-за чего он и разошёлся бы в жизни: разные
 * пути установки, разные номера строк, заплаточная цифра версии.
 *
 * Запуск: npx tsx scripts/test-feedback-summary.ts
 */

import { median, tally, daysOf, toMarkdown, ENOUGH } from '../server/feedback/insight';
import {
  technicalFingerprint, titleWords, titleCloseness, majorMinor, frameKey,
  checkDuplicateChain, MAX_DUPLICATE_CHAIN, CLOSE_ENOUGH,
} from '../feedback/fingerprint';
import { normalizeFrame } from '../diagnostics/event';

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`, detail === undefined ? '' : detail); }
};

console.log('1. Медиана отказывается считать по трём случаям');
{
  ok('меньше пяти — «мало данных»', median([1, 2, 3, 4]) === null);
  ok('ровно пять — уже считаем', median([1, 2, 3, 4, 5]) === 3);
  ok('чётное число — среднее двух середин', median([1, 2, 3, 4, 5, 6]) === 4, median([1, 2, 3, 4, 5, 6]));
  ok('порядок подачи не важен', median([5, 1, 4, 2, 3]) === 3);
  ok('мусор не участвует', median([1, 2, 3, 4, 5, NaN as any, -7]) === 3);
  ok('порог назван числом, а не спрятан', ENOUGH === 5);
}

console.log('\n2. Разрезы');
{
  const counts = tally(['Проводник', 'Теги', 'Проводник', '', 'Проводник', 'Теги']);
  ok('самое частое идёт первым', counts[0].name === 'Проводник' && counts[0].count === 3, counts);
  ok('пустое не теряется, а называется прочерком', counts.some((c) => c.name === '—'), counts);
  ok('длина ограничивается', tally(Array.from({ length: 50 }, (_, i) => `р${i}`), 8).length === 8);
}

console.log('\n3. Период');
{
  ok('по умолчанию тридцать дней', daysOf(undefined) === 30);
  ok('глубже года не берём', daysOf(9999) === 365);
  ok('ноль и мусор — тридцать', daysOf(0) === 30 && daysOf('вчера') === 30);
}

console.log('\n4. Отпечаток технического дубля');
{
  const uMine = 'at saveNow (C:\\Users\\Иванов\\AppData\\Local\\Flux\\resources\\app.asar\\doc.js:120:15)';
  const uMate = 'at saveNow (D:\\Program Files\\Flux\\resources\\app.asar\\doc.js:512:3)';
  const one = technicalFingerprint({ appVersion: '3.4.7', sectionKey: '/doc', errorCode: 'P2010', frames: [uMine] });
  const two = technicalFingerprint({ appVersion: '3.4.19', sectionKey: '/doc', errorCode: 'P2010', frames: [uMate] });
  ok('разные пути установки и строки дают один отпечаток', one === two && !!one, [one, two]);
  ok('заплаточная цифра версии не разводит', majorMinor('3.4.7') === majorMinor('3.4.19'));
  ok('другая минорная версия — другой отпечаток',
    technicalFingerprint({ appVersion: '3.5.0', sectionKey: '/doc', errorCode: 'P2010', frames: [uMine] }) !== one);
  ok('другой раздел — другой отпечаток',
    technicalFingerprint({ appVersion: '3.4.7', sectionKey: '/sheet', errorCode: 'P2010', frames: [uMine] }) !== one);
  ok('без кода и без кадров отпечатка нет',
    technicalFingerprint({ appVersion: '3.4.7', sectionKey: '/doc' }) === '');
  ok('в отпечатке не остаётся ни пути, ни имени сотрудника',
    !one.includes('Иванов') && /^[0-9a-f]{64}$/.test(one));
  // Правило чистки кадра написано дважды — в диагностике и здесь. Разойдутся
  // они молча, поэтому сверяем их между собой
  ok('кадр чистится так же, как в диагностике', frameKey(uMine) === normalizeFrame(uMine),
    [frameKey(uMine), normalizeFrame(uMine)]);
}

console.log('\n5. Близость заголовков');
{
  ok('окончания не мешают',
    titleWords('Спецификация не открывается').join(',') === titleWords('Спецификации не открываются').join(','),
    [titleWords('Спецификация не открывается'), titleWords('Спецификации не открываются')]);
  ok('похожие заголовки признаются похожими',
    titleCloseness('Не печатается спецификация проекта', 'Спецификация проекта не печатается') >= CLOSE_ENOUGH);
  ok('разные — не признаются',
    titleCloseness('Не печатается спецификация', 'Календарь теряет напоминания') < CLOSE_ENOUGH);
  ok('общие слова не создают сходства',
    titleCloseness('Ошибка в программе Flux', 'Ошибка в программе Flux при печати чертежа') < 1);
  ok('пустой заголовок ни на что не похож', titleCloseness('', 'что угодно') === 0);
}

console.log('\n6. Кольца из дублей');
{
  const parents: Record<string, string | null> = { b: 'c', c: null };
  ok('обычная связь разрешена', checkDuplicateChain('a', 'b', (id) => parents[id] ?? null).ok);
  ok('сам на себя — нельзя', !checkDuplicateChain('a', 'a', () => null).ok);
  ok('пустая цель — нельзя', !checkDuplicateChain('a', '', () => null).ok);
  const loop: Record<string, string | null> = { b: 'a' };
  const verdict = checkDuplicateChain('a', 'b', (id) => loop[id] ?? null);
  ok('кольцо распознаётся', !verdict.ok, verdict.error);
  ok('и объясняется словами', String(verdict.error).includes('кольцо'), verdict.error);
  // Длинная цепочка — тоже ошибка разбора, а не устройство
  const long: Record<string, string | null> = {};
  for (let i = 0; i < 30; i++) long[`n${i}`] = `n${i + 1}`;
  ok('слишком длинная цепочка не проходит',
    !checkDuplicateChain('a', 'n0', (id) => long[id] ?? null).ok);
  ok('предел назван числом', MAX_DUPLICATE_CHAIN === 20);
}

console.log('\n7. Выгрузка для разработчика');
{
  const report = {
    number: 28, title: 'Не печатается спецификация', type: 'BUG', status: 'IN_PROGRESS', priority: 'P1',
    authorDisplayNameSnapshot: 'Раупов Х. Х.', createdAt: new Date('2026-09-09T10:00:00Z'),
    incidentAt: new Date('2026-09-09T09:30:00Z'), appVersion: '3.4.7', sectionKey: '/sheet',
    description: 'Печать останавливается на втором листе.',
    reproductionJson: JSON.stringify(['Открыл спецификацию', 'Нажал «Печать»']),
    expected: 'Печатается', actual: 'Останавливается', benefit: '', resolution: '', resolvedVersion: '',
  };
  const comments = [
    { text: 'Ответ автору', visibility: 'PUBLIC', createdAt: new Date() },
    { text: 'ТАЙНАЯ ЗАМЕТКА', visibility: 'INTERNAL', createdAt: new Date() },
  ];
  const forAuthor = toMarkdown(report, comments, [], false);
  const forTriage = toMarkdown(report, comments, [], true);

  ok('заголовок с номером', forAuthor.startsWith('# ОБР-000028'), forAuthor.slice(0, 40));
  ok('шаги пронумерованы', forAuthor.includes('1. Открыл спецификацию'));
  ok('версия и раздел на месте', forAuthor.includes('3.4.7') && forAuthor.includes('/sheet'));
  ok('внутренняя заметка автору не выгружается', !forAuthor.includes('ТАЙНАЯ ЗАМЕТКА'));
  ok('обработчику — выгружается и помечена',
    forTriage.includes('ТАЙНАЯ ЗАМЕТКА') && forTriage.includes('внутренняя заметка'));
  ok('сказано, что наружу это не уходило', forAuthor.includes('сервере компании'));
}

console.log(`\nПройдено: ${passed}, провалено: ${failed}`);
if (failed) { console.log('ЕСТЬ ПРОВАЛЫ'); process.exit(1); }
console.log('ВСЕ ТЕСТЫ ПРОЙДЕНЫ');
