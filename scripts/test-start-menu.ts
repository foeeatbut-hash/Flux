/**
 * Проверки меню «Пуск».
 *
 * Три места, где ошибка не видна глазом: отбор по правам (лишний раздел в меню
 * заметит только тот, у кого его быть не должно), поиск по названию с чужой
 * раскладкой и список недавних, который обязан переживать закрытие раздела.
 */
import {
  groupSections, countFound, allowed, matches, toRu, visibleRecent, RECENT_SHOWN,
  pinnedTiles, moveInList, stepFocus, OFFICE_PATHS, OFFICE_TITLE,
  type StartSource,
} from '../src/lib/startMenu';
import { SECTIONS } from '../src/workspace/sections';
import { readFileSync } from 'fs';
import { join } from 'path';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const S: StartSource[] = [
  { path: '/', title: 'Главная', scope: 'mixed' },
  { path: '/registry', title: 'Теги', scope: 'project' },
  { path: '/equipment', title: 'Оборудование', scope: 'project' },
  { path: '/explorer', title: 'Проводник', scope: 'global' },
  { path: '/mail', title: 'Почта', scope: 'global' },
  { path: '/settings', title: 'Настройки', scope: 'mixed' },
  { path: '/users', title: 'Сотрудники', scope: 'global', adminOnly: true },
];

console.log('Права');
{
  check('обычному сотруднику не видно админский раздел', !allowed(S, false).some((s) => s.path === '/users'));
  check('администратору видно', allowed(S, true).some((s) => s.path === '/users'));
  const g = groupSections(S, false);
  check('в группах нет админского', !g.some((x) => x.items.some((i) => i.path === '/users')));
}

console.log('Группы');
{
  const g = groupSections(S, true);
  check('две группы: проектная и общая', g.map((x) => x.id).join(',') === 'project,global', g.map((x) => x.id));
  check('Теги в проектной', g[0].items.some((i) => i.path === '/registry'));
  check('Почта в общей', g[1].items.some((i) => i.path === '/mail'));
  const flat = g.flatMap((x) => x.items.map((i) => i.path));
  check('смешанные в группы не попали', !flat.includes('/') && !flat.includes('/settings'), flat);
  const empty = groupSections([{ path: '/a', title: 'А', scope: 'global' }], false);
  check('пустая группа не показывается', empty.length === 1 && empty[0].id === 'global');
}

console.log('Поиск');
{
  check('точное вхождение', matches('Оборудование', 'обор'));
  check('регистр не важен', matches('Оборудование', 'ОБОР'));
  check('пустой запрос пропускает всё', matches('Что угодно', '   '));
  check('чужое не находится', !matches('Теги', 'почта'));
  check('раскладка: ntub → теги', toRu('ntub') === 'теги', toRu('ntub'));
  check('поиск понимает чужую раскладку', matches('Теги', 'ntub'));
  check('раскладка не ломает обычный запрос', matches('Почта', 'почт'));
  const g = groupSections(S, true, 'по');
  check('поиск сузил список', countFound(g) === 1, g.flatMap((x) => x.items.map((i) => i.title)));
  check('ничего не нашлось — групп нет', countFound(groupSections(S, true, 'ъъъ')) === 0);
}

console.log('Недавние');
{
  // Сам список ведёт рабочий стол; здесь проверяется только то, что меню
  // показывает из него, — и это ровно то место, где ошибка не видна глазом
  const r = visibleRecent(['/users', '/mail', '/нет-такого', '/registry'], S, false);
  check('недоступное по правам выпало', !r.some((s) => s.path === '/users'), r.map((s) => s.path));
  check('несуществующий путь выпал', !r.some((s) => s.path === '/нет-такого'));
  check('порядок сохранён', r.map((s) => s.path).join(',') === '/mail,/registry', r.map((s) => s.path));
  check('администратору свой раздел виден', visibleRecent(['/users'], S, true).length === 1);
  const dup = visibleRecent(['/mail', '/mail', '/registry'], S, false);
  check('повтор не задваивается', dup.length === 2, dup.map((s) => s.path));
  const many = Array.from({ length: RECENT_SHOWN + 4 }, () => '/mail');
  check(`показываем не больше ${RECENT_SHOWN}`, visibleRecent(many, S, false).length <= RECENT_SHOWN);
  check('пустой список не ломает', visibleRecent([], S, false).length === 0);
}

console.log('Флукс Офис отдельной семьёй');
{
  const office = groupSections(SECTIONS as any, false).find((g) => g.title === OFFICE_TITLE);
  check('группа семьи есть', !!office, groupSections(SECTIONS as any, false).map((g) => g.title));
  check('порядок внутри семьи задан списком, а не объявлением разделов',
    (office?.items || []).map((i) => i.path).join(',')
      === OFFICE_PATHS.filter((p) => (office?.items || []).some((i) => i.path === p)).join(','),
    office?.items.map((i) => i.path));
  const all = groupSections(SECTIONS as any, true);
  const seen = all.flatMap((g) => g.items.map((i) => i.path));
  check('ни один раздел не показан дважды', new Set(seen).size === seen.length,
    seen.filter((p, i) => seen.indexOf(p) !== i));
  check('редакторы ушли из «Проекта» и «Общего»',
    !all.some((g) => g.title !== OFFICE_TITLE && g.items.some((i) => OFFICE_PATHS.includes(i.path))));
}

console.log('Закреплённое');
{
  const pin = pinnedTiles(['/mail', '/users', '/нет', '/mail'], S, false);
  check('чужое по правам не закрепляется', !pin.some((s) => s.path === '/users'), pin.map((s) => s.path));
  check('несуществующее выпало', !pin.some((s) => s.path === '/нет'));
  check('повтор не двоится', pin.length === 1, pin.map((s) => s.path));
  check('администратору его раздел виден', pinnedTiles(['/users'], S, true).length === 1);
}

console.log('Перестановка плиток');
{
  check('вперёд', moveInList(['a', 'b', 'c'], 0, 2).join('') === 'bca');
  check('назад', moveInList(['a', 'b', 'c'], 2, 0).join('') === 'cab');
  check('на месте — список тот же', moveInList(['a', 'b'], 1, 1).join('') === 'ab');
  // Промах мимо списка не должен ни ронять, ни терять плитку
  check('за пределы — ничего не потеряно', moveInList(['a', 'b'], 0, 5).join('') === 'ab');
  check('отрицательный указатель безопасен', moveInList(['a', 'b'], -1, 0).join('') === 'ab');
}

console.log('Клавиатура');
{
  // Девять плиток в три столбца
  check('первое нажатие ставит выделение в начало', stepFocus(9, -1, 'ArrowDown', 3) === 0);
  check('вправо', stepFocus(9, 0, 'ArrowRight', 3) === 1);
  check('вниз через строку', stepFocus(9, 0, 'ArrowDown', 3) === 3);
  check('вверх', stepFocus(9, 4, 'ArrowUp', 3) === 1);
  // Заворачивать за край нельзя: человек ждёт, что выделение останется на месте
  check('вниз с последней строки остаётся на месте', stepFocus(9, 7, 'ArrowDown', 3) === 7);
  check('вверх с первой строки остаётся на месте', stepFocus(9, 1, 'ArrowUp', 3) === 1);
  check('вправо за конец остаётся на месте', stepFocus(9, 8, 'ArrowRight', 3) === 8);
  check('пустой список выделять нечего', stepFocus(0, -1, 'ArrowDown', 3) === -1);
  check('чужая клавиша ничего не двигает', stepFocus(9, 4, 'a', 3) === 4);
  check('нулевое число столбцов не роняет', stepFocus(9, 0, 'ArrowDown', 0) === 1);
}

console.log('Настоящий реестр');
{
  const g = groupSections(SECTIONS as any, false);
  check('обычный сотрудник видит разделы', countFound(g) > 5, countFound(g));
  const admin = groupSections(SECTIONS as any, true);
  check('администратору видно больше', countFound(admin) > countFound(g));
  check('у всех показанных есть название', g.every((x) => x.items.every((i) => !!i.title)));
}

console.log('Список программ раскрыт, а закрепление отзывается');
{
  const src = readFileSync(join(__dirname, '../src/components/StartMenu.tsx'), 'utf8');
  // Полный список был свёрнут за кнопку, и человек, не нашедший раздела среди
  // закреплённых, видел вместо него полосу, по которой ещё надо догадаться
  // нажать. Список программ — то, ради чего Пуск и открывают
  check('кнопки «Все программы» нет', !src.includes('Все программы'));
  check('раскрытость не хранится состоянием', !src.includes('allOpen'));
  // Нажатие, после которого ничего не видно и не сказано, для человека не
  // произошло: значок появлялся ЗА открытым Пуском
  check('закрепление на столе закрывает Пуск', /pinApp\(path\);[\s\S]{0,200}onClose\(\)/.test(src));
  check('закрепление говорит словами', src.includes('на рабочем столе') && src.includes('на панели задач'));
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки меню «Пуск» пройдены');
