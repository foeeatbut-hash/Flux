/**
 * Вид ФИО: «Раупов Х.Х.», «Х.Х. Раупов», только фамилия.
 *
 * formatName нужен подписи в шапке (Layout) и редактору подписи; раньше он
 * лежал в docFormula.ts рядом с формулами документа, и проверки жили в
 * test-formulas.ts. Формулы удалены, а функция осталась — вместе с проверками.
 */
import { formatName } from '../src/lib/names.js';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d) : ''));

console.log('ФИО: вид вывода');
const P = { lastName: 'Иванов', firstName: 'Иван', middleName: 'Иванович' };
ok('полностью', formatName(P, 'full') === 'Иванов Иван Иванович');
ok('инициалы после фамилии', formatName(P, 'initialsAfter') === 'Иванов\u00A0И.И.', formatName(P, 'initialsAfter'));
ok('инициалы перед фамилией', formatName(P, 'initialsBefore') === 'И.И.\u00A0Иванов', formatName(P, 'initialsBefore'));
ok('только фамилия', formatName(P, 'last') === 'Иванов');
ok('без отчества инициал не выдумывается', formatName({ lastName: 'Ким', firstName: 'Олег' }, 'initialsAfter') === 'Ким\u00A0О.', formatName({ lastName: 'Ким', firstName: 'Олег' }, 'initialsAfter'));
ok('старый профиль одной строкой разбирается', formatName({ name: 'Сидоров Сидор Сидорович' }, 'initialsAfter') === 'Сидоров\u00A0С.С.', formatName({ name: 'Сидоров Сидор Сидорович' }, 'initialsAfter'));
ok('пустое ФИО → пусто', formatName({}, 'full') === '');
const R = { lastName: 'Раупов', firstName: 'Хусрав', middleName: 'Хуршедович' };
ok('Раупов Хусрав Хуршедович → Раупов Х.Х.', formatName(R, 'initialsAfter') === 'Раупов\u00A0Х.Х.', formatName(R, 'initialsAfter'));
ok('он же перед фамилией → Х.Х. Раупов', formatName(R, 'initialsBefore') === 'Х.Х.\u00A0Раупов', formatName(R, 'initialsBefore'));
ok('инициалы слитно, без пробела внутри', !/Х\.\s+Х\./.test(formatName(R, 'initialsAfter')));
console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
