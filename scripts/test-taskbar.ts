/**
 * Проверки нижней панели задач.
 *
 * Панель ломается незаметно: она выглядит правильно ровно в том состоянии, в
 * котором её открыли на макете, и разъезжается на четырнадцати окнах или на
 * нуле. Поэтому все решения о составе и сжатии считает чистый модуль, а здесь
 * проверяются именно они.
 */
import {
  buildTaskbar, badgeCount, clockLabel, dateLabel, deadlineLabel, badgeLabel,
  fitButtons, LABELS_UNTIL, TIDY_FROM, trayFit, type TaskbarSource,
} from '../src/lib/taskbar';
import { SECTIONS } from '../src/workspace/sections';
import { readFileSync } from 'fs';
import { join } from 'path';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const S: TaskbarSource[] = [
  { path: '/registry', title: 'Теги', pinned: true },
  { path: '/equipment', title: 'Оборудование', pinned: true },
  { path: '/explorer', title: 'Проводник', pinned: true },
  { path: '/mail', title: 'Почта', pinned: true, badge: 'mail' },
  { path: '/chat', title: 'Чат', badge: 'chat' },
  { path: '/notes', title: 'Блокнот' },
  { path: '/users', title: 'Сотрудники', adminOnly: true },
];
const NONE = { mail: 0, chat: 0, feedback: 0 };

console.log('Состав панели');
{
  const v = buildTaskbar(S, { open: [], activePath: '/', counts: NONE });
  check('без открытых разделов на панели только закреплённые', v.buttons.length === 4, v.buttons.map((b) => b.path));
  check('ни одна кнопка не «запущена»', v.buttons.every((b) => !b.running));
  check('подписи показываются', v.labels === true);
  check('прибираться не предлагается', v.tidy === false);
}
{
  const v = buildTaskbar(S, { open: ['/notes', '/registry'], activePath: '/notes', counts: NONE });
  check('открытый незакреплённый добавился в конец', v.buttons[v.buttons.length - 1].path === '/notes', v.buttons.map((b) => b.path));
  check('закреплённые не сдвинулись с места', v.buttons[0].path === '/registry');
  check('запущенное помечено', v.buttons.find((b) => b.path === '/registry')?.running === true);
  check('активное помечено ровно одно', v.buttons.filter((b) => b.active).length === 1);
  check('активное — то, что в активной панели', v.buttons.find((b) => b.active)?.path === '/notes');
}
{
  const v = buildTaskbar(S, { open: ['/users'], activePath: '/users', counts: NONE });
  check('раздел только для админа не показан обычному', !v.buttons.some((b) => b.path === '/users'));
  const a = buildTaskbar(S, { open: ['/users'], activePath: '/users', counts: NONE, isAdmin: true });
  check('админу показан', a.buttons.some((b) => b.path === '/users'));
}
{
  const dup = buildTaskbar(S, { open: ['/registry', '/registry'], activePath: '/registry', counts: NONE });
  check('закреплённый не задваивается при открытии', dup.buttons.filter((b) => b.path === '/registry').length === 1);
}

console.log('Сжатие');
{
  const many = Array.from({ length: 9 }, (_, i) => ({ path: `/p${i}`, title: `Р${i}`, pinned: true }));
  const v = buildTaskbar(many, { open: [], activePath: '/', counts: NONE });
  check(`после ${LABELS_UNTIL} кнопок подписи уходят`, v.labels === false, v.buttons.length);
  const eight = buildTaskbar(many.slice(0, LABELS_UNTIL), { open: [], activePath: '/', counts: NONE });
  check('ровно на пороге подписи ещё есть', eight.labels === true);
}
{
  // Счёта кнопок мало: шесть длинных названий не влезают в ноутбучные 1180,
  // а полоса обрезана по краю — кнопки исчезали без следа, ни многоточия, ни
  // прокрутки. Ширина решает наравне с количеством
  const long = ['Оборудование', 'Справочник', 'Переводчик', 'Проводник', 'Менеджмент', 'Руководство']
    .map((title, i) => ({ path: `/p${i}`, title, pinned: true }));
  const wide = buildTaskbar(long, { open: [], activePath: '/', counts: NONE, width: 1290 });
  check('на широком экране подписи есть', wide.labels === true);
  const narrow = buildTaskbar(long, { open: [], activePath: '/', counts: NONE, width: 720 });
  check('на узком подписи уходят, а кнопки остаются', narrow.labels === false && narrow.buttons.length === 6, narrow.buttons.length);
  const unknown = buildTaskbar(long, { open: [], activePath: '/', counts: NONE });
  check('ширина не измерена — подписями не мигаем', unknown.labels === true);
  check('короткие названия влезают и в узкую панель',
    buildTaskbar([{ path: '/a', title: 'Теги', pinned: true }], { open: [], activePath: '/', counts: NONE, width: 200 }).labels === true);
  check('пустая панель не спорит с шириной',
    buildTaskbar([], { open: [], activePath: '/', counts: NONE, width: 400 }).labels === true);
}
{
  const open = Array.from({ length: TIDY_FROM }, (_, i) => `/p${i}`);
  const v = buildTaskbar(S, { open, activePath: '/', counts: NONE });
  check('на пороге предлагается прибраться', v.tidy === true);
  const less = buildTaskbar(S, { open: open.slice(0, TIDY_FROM - 1), activePath: '/', counts: NONE });
  check('до порога не предлагается', less.tidy === false);
}

console.log('Переполнение');
{
  // Полоса кнопок не прокручивается: хвост уходит под кнопку «ещё». Раньше
  // здесь была прокрутка, и на краю панели вырастал скроллбар во всю её высоту
  const many = Array.from({ length: 14 }, (_, i) => ({ path: `/p${i}`, title: `Раздел ${i}`, pinned: true }));
  const v = buildTaskbar(many, { open: [], activePath: '/', counts: NONE, width: 400 });
  check('видимых меньше, чем всего', v.visible.length < v.buttons.length, [v.visible.length, v.buttons.length]);
  check('ничего не потеряно', v.visible.length + v.hidden.length === v.buttons.length);
  check('порядок сохранён', v.visible[0].path === '/p0' && v.hidden[v.hidden.length - 1].path === '/p13');

  // Главное: при любой ширине и любом числе кнопок ряд помещается в полосу
  for (const width of [640, 800, 1024, 1366, 1600, 1920, 2560]) {
    for (const n of [0, 1, 3, 6, 9, 12, 20]) {
      const src = Array.from({ length: n }, (_, i) => ({ path: `/x${i}`, title: 'Оборудование', pinned: true }));
      const view = buildTaskbar(src, { open: [], activePath: '/', counts: NONE, width });
      const each = view.visible.map((b) => 44 + (view.labels ? b.title.length * 8 : 0));
      const sum = each.reduce((a, b) => a + b, 0) + (view.hidden.length ? 44 : 0);
      check(`ряд помещается: ${n} кнопок при ${width}`, sum <= width || n === 0, [sum, width]);
    }
  }
  check('пустая полоса ничего не сворачивает', fitButtons([], 0, true) === 0);
  check('без измеренной ширины помещается всё', fitButtons(['Теги', 'Почта'], 0, true) === 2);
  check('в узкую полосу не влезает ничего', fitButtons(['Оборудование', 'Проводник'], 60, true) === 0);
  const roomy = buildTaskbar(S, { open: [], activePath: '/', counts: NONE, width: 1600 });
  check('когда всё влезает, свёрнутых нет', roomy.hidden.length === 0);
  const unmeasured = buildTaskbar(S, { open: [], activePath: '/', counts: NONE });
  check('ширина не измерена — ничего не сворачиваем', unmeasured.hidden.length === 0);
}

console.log('Счётчики');
{
  check('почта берёт своё число', badgeCount('mail', { mail: 3, chat: 9, feedback: 4 }) === 3);
  check('чат берёт своё число', badgeCount('chat', { mail: 3, chat: 9, feedback: 4 }) === 9);
  check('обращения берут своё число', badgeCount('feedback', { mail: 3, chat: 9, feedback: 4 }) === 4);
  check('без источника счётчика нет', badgeCount(undefined, { mail: 3, chat: 9, feedback: 4 }) === 0);
  check('отрицательное не показываем', badgeCount('mail', { mail: -2, chat: 0, feedback: 0 }) === 0);
  const v = buildTaskbar(S, { open: [], activePath: '/', counts: { mail: 4, chat: 0, feedback: 0 } });
  check('счётчик доехал до кнопки', v.buttons.find((b) => b.path === '/mail')?.badge === 4);
  check('у Проводника счётчика нет', v.buttons.find((b) => b.path === '/explorer')?.badge === 0);
  check('трёхзначное сворачивается', badgeLabel(128) === '99+');
  check('двузначное остаётся как есть', badgeLabel(42) === '42');
}

console.log('Часы и срок');
{
  check('часы двузначные', clockLabel(new Date(2026, 7, 23, 9, 5)) === '09:05');
  check('полночь', clockLabel(new Date(2026, 7, 23, 0, 0)) === '00:00');
  const now = new Date(2026, 7, 23, 12, 47);
  check('дата по-русски', dateLabel(now) === '23 августа', dateLabel(now));
  check('срока нет — показываем дату', deadlineLabel(null, now) === '23 августа');
  check('сегодня', deadlineLabel(new Date(2026, 7, 23, 23, 0), now) === 'ВДР сегодня');
  check('завтра', deadlineLabel(new Date(2026, 7, 24, 1, 0), now) === 'ВДР завтра');
  check('на неделе', deadlineLabel(new Date(2026, 7, 26), now) === 'ВДР через 3 дн.');
  check('далеко — дата', deadlineLabel(new Date(2026, 8, 12), now) === 'ВДР 12 сентября', deadlineLabel(new Date(2026, 8, 12), now));
  check('просрочен на день', deadlineLabel(new Date(2026, 7, 22), now) === 'ВДР просрочен на день');
  check('просрочен надолго', deadlineLabel(new Date(2026, 7, 18), now) === 'ВДР просрочен на 5 дн.');
}

console.log('Реестр разделов');
{
  const pinned = SECTIONS.filter((s) => s.pinned);
  check('закреплено пять программ', pinned.length === 5, pinned.map((s) => s.path));
  check('закреплённое не помечено adminOnly', pinned.every((s) => !s.adminOnly));
  check('у всех закреплённых есть значок', pinned.every((s) => !!s.icon));
  const badged = SECTIONS.filter((s) => s.badge);
  // Красный кружок означает «надо разобрать». Он есть там, где человек кому-то
  // должен ответить: письмо, сообщение, обращение, — и больше нигде
  check('счётчики только там, где ждут ответа',
    badged.map((s) => s.path).sort().join(',') === '/chat,/feedback,/mail', badged.map((s) => s.path));
  const v = buildTaskbar(SECTIONS as any, { open: [], activePath: '/', counts: NONE });
  check('настоящий реестр даёт панель с подписями', v.labels === true, v.buttons.length);
}

console.log('Тесная панель');
{
  const wide = trayFit(1440);
  check('на широком окне трей полный', wide.layout && wide.hint && wide.projectMax === 200, wide);
  const mid = trayFit(1100);
  check('на ноутбуке уходят кнопки раскладки', !mid.layout && mid.hint, mid);
  const narrow = trayFit(820);
  check('в узком окне уходит и подсказка', !narrow.layout && !narrow.hint, narrow);
  check('название проекта ужимается, а не пропадает', narrow.projectMax > 0 && narrow.projectMax < mid.projectMax, [narrow.projectMax, mid.projectMax]);
  check('ширина не измерена — ничего не прячем', trayFit(0).layout === true);
  check('чем у́же, тем короче название',
    trayFit(1440).projectMax >= trayFit(1100).projectMax && trayFit(1100).projectMax >= trayFit(820).projectMax);
}

console.log('В трее нет второго входа в учётную запись');
{
  const bar = readFileSync(join(__dirname, '../src/components/Taskbar.tsx'), 'utf8');
  const start = readFileSync(join(__dirname, '../src/components/StartMenu.tsx'), 'utf8');
  // Круг с инициалами в трее повторял подвал Пуска целиком, а второй вход в
  // одно и то же место только заставляет гадать, чем они отличаются
  check('в трее нет кнопки учётной записи', !bar.includes('setUserMenu'));
  check('выход из программы остался в Пуске', start.includes('setUser(null)'));
  check('параметры программы остались в Пуске', start.includes("go('/settings')"));
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки нижней панели пройдены');
