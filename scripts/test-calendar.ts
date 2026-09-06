/**
 * Проверки календаря.
 *
 * Ошибка в счёте времени не падает и не мигает: встреча, посчитанная на час
 * раньше, выглядит как обычная встреча — и человек узнаёт о ней, когда его
 * ждали двадцать минут назад. Поэтому сетка, повторы и подписи считаются
 * чистым модулем и проверяются здесь, включая переход на летнее время.
 *
 * Запуск: npx tsx scripts/test-calendar.ts
 */
import {
  monthGrid, startOfDay, startOfWeek, startOfMonth, weekday, sameDay, inMonth,
  parseRule, buildRule, ruleLabel, expand, occurrences, dayOccurrences,
  timeLabel, dateLabel, monthLabel, rangeLabel, untilLabel, isDue,
  deadlineEvent, isReadOnly, WEEKDAYS, DAY, MINUTE, type CalEvent,
} from '../src/lib/calendar';
import { readFileSync } from 'fs';
import { join } from 'path';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

const base = (over: Partial<CalEvent> = {}): CalEvent => ({
  id: 'e1', projectId: 'p1', kind: 'meeting', title: 'Планёрка', description: '',
  startsAt: at(2026, 9, 7, 10, 0), endsAt: at(2026, 9, 7, 10, 30), allDay: false,
  rrule: '', place: '', joinUrl: '', createdBy: 'u1', source: 'hand', sourceId: '',
  visibility: 'project', remindMin: 5, guests: [], ...over,
});

console.log('Сетка');
{
  const grid = monthGrid(at(2026, 9, 15));
  check('в сетке всегда шесть недель', grid.length === 42, grid.length);
  check('сетка начинается с понедельника', weekday(grid[0]) === 0, WEEKDAYS[weekday(grid[0])]);
  check('дни идут подряд', grid.every((d, i) => i === 0 || d - grid[i - 1] > 0));
  check('первое число месяца попало в сетку', grid.some((d) => sameDay(d, startOfMonth(at(2026, 9, 15)))));
  check('последнее число месяца попало в сетку', grid.some((d) => sameDay(d, at(2026, 9, 30))));

  // Февраль 2027 начинается с понедельника и укладывается ровно в четыре
  // недели — самый короткий месяц, на котором сетка обычно и ломается
  const feb = monthGrid(at(2027, 2, 10));
  check('короткий месяц не ломает сетку', feb.length === 42 && weekday(feb[0]) === 0);

  check('начало недели — понедельник', weekday(startOfWeek(at(2026, 9, 9))) === 0);
  check('в этом месяце', inMonth(at(2026, 9, 30), at(2026, 9, 1)));
  check('в соседнем — нет', !inMonth(at(2026, 10, 1), at(2026, 9, 1)));
  check('тот же день', sameDay(at(2026, 9, 7, 1), at(2026, 9, 7, 23)));
  check('соседние дни различаются', !sameDay(at(2026, 9, 7), at(2026, 9, 8)));

  // Переход на летнее время: сутки не по 24 часа, и складывать сутками нельзя
  const march = monthGrid(at(2026, 3, 15));
  check('переход на летнее время не уводит сетку',
    march.every((d) => startOfDay(d) === d), march.filter((d) => startOfDay(d) !== d).length);
}

console.log('Повторы');
{
  check('пустое правило — не повтор', parseRule('') === null);
  check('мусор — не повтор', parseRule('каждый понедельник') === null);
  const weekly = parseRule('FREQ=WEEKLY;BYDAY=MO');
  check('еженедельно по понедельникам', weekly?.freq === 'WEEKLY' && weekly?.byDay[0] === 0, weekly);
  check('префикс RRULE: не мешает', parseRule('RRULE:FREQ=DAILY')?.freq === 'DAILY');
  check('правило собирается обратно',
    buildRule({ freq: 'WEEKLY', byDay: [0, 3], interval: 2 }) === 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH',
    buildRule({ freq: 'WEEKLY', byDay: [0, 3], interval: 2 }));
  check('имя правила по-русски', ruleLabel('FREQ=WEEKLY;BYDAY=MO') === 'каждую неделю: пн', ruleLabel('FREQ=WEEKLY;BYDAY=MO'));
  check('без правила так и сказано', ruleLabel('') === 'не повторяется');

  const from = at(2026, 9, 1);
  const to = at(2026, 10, 1);
  const mondays = expand(base({ rrule: 'FREQ=WEEKLY;BYDAY=MO' }), from, to);
  check('в сентябре четыре понедельника с 7-го', mondays.length === 4, mondays.map((o) => new Date(o.startsAt).getDate()));
  check('все появления в понедельник', mondays.every((o) => weekday(o.startsAt) === 0));
  check('время сохраняется', mondays.every((o) => timeLabel(o.startsAt) === '10:00'));
  check('первое появление — не повтор', mondays[0].repeated === false && mondays[1].repeated === true);
  check('длительность сохраняется', mondays.every((o) => o.endsAt - o.startsAt === 30 * MINUTE));

  const daily = expand(base({ rrule: 'FREQ=DAILY;COUNT=3' }), from, to);
  check('счётчик ограничивает', daily.length === 3, daily.length);
  const until = expand(base({ rrule: 'FREQ=DAILY;UNTIL=20260910' }), from, to);
  check('дата окончания ограничивает', until.length === 4, until.map((o) => new Date(o.startsAt).getDate()));
  const monthly = expand(base({ rrule: 'FREQ=MONTHLY' }), from, at(2027, 1, 1));
  check('ежемесячно держит день месяца', monthly.every((o) => new Date(o.startsAt).getDate() === 7), monthly.length);

  // Бесконечное правило не должно раскрываться в бесконечность
  const endless = expand(base({ rrule: 'FREQ=DAILY' }), from, at(2036, 1, 1));
  check('бесконечный повтор ограничен пределом', endless.length <= 400, endless.length);

  const single = expand(base(), from, to);
  check('одиночное событие даёт одно появление', single.length === 1);
  check('событие вне окна не попадает', expand(base(), at(2026, 10, 1), at(2026, 11, 1)).length === 0);
  // Событие, начавшееся до окна и идущее внутрь него, — видно
  const long = expand(base({ startsAt: at(2026, 8, 31, 23), endsAt: at(2026, 9, 1, 2) }), from, to);
  check('переходящее через границу окна видно', long.length === 1);
}

console.log('День и порядок');
{
  const list = occurrences([
    base({ id: 'a', title: 'Планёрка', startsAt: at(2026, 9, 7, 10), endsAt: at(2026, 9, 7, 11) }),
    base({ id: 'b', title: 'Созвон', startsAt: at(2026, 9, 7, 9), endsAt: at(2026, 9, 7, 9, 30) }),
    base({ id: 'c', title: 'Другой день', startsAt: at(2026, 9, 8, 9), endsAt: at(2026, 9, 8, 10) }),
  ], at(2026, 9, 1), at(2026, 10, 1));
  check('по времени начала', list[0].event.id === 'b' && list[1].event.id === 'a', list.map((o) => o.event.id));
  const day = dayOccurrences(list, at(2026, 9, 7, 15));
  check('в дне только его события', day.length === 2 && day.every((o) => sameDay(o.startsAt, at(2026, 9, 7))));
}

console.log('Подписи');
{
  check('время', timeLabel(at(2026, 9, 7, 9, 5)) === '09:05');
  check('дата по-русски', dateLabel(at(2026, 9, 7)) === '7 сентября');
  check('месяц с большой буквы', monthLabel(at(2026, 9, 7)) === 'Сентябрь 2026', monthLabel(at(2026, 9, 7)));
  check('диапазон', rangeLabel({ startsAt: at(2026, 9, 7, 10), endsAt: at(2026, 9, 7, 10, 30) }, false) === '10:00 – 10:30');
  check('весь день', rangeLabel({ startsAt: at(2026, 9, 7), endsAt: at(2026, 9, 7) }, true) === 'весь день');

  const now = at(2026, 9, 7, 9, 55);
  check('через пять минут', untilLabel(at(2026, 9, 7, 10), now) === 'через 5 мин.');
  check('идёт сейчас', untilLabel(at(2026, 9, 7, 9, 30), now) === 'идёт сейчас');
  check('уже прошло', untilLabel(at(2026, 9, 7, 7), now) === 'уже прошло');
  check('через часы', untilLabel(at(2026, 9, 7, 13), now) === 'через 3 ч.', untilLabel(at(2026, 9, 7, 13), now));
  check('завтра', untilLabel(at(2026, 9, 8, 10), now).startsWith('завтра'), untilLabel(at(2026, 9, 8, 10), now));
  check('далеко — дата', untilLabel(at(2026, 9, 20, 10), now) === '20 сентября в 10:00');
}

console.log('Напоминание');
{
  const start = at(2026, 9, 7, 10);
  check('за пять минут пора', isDue(start, 5, start - 5 * MINUTE));
  check('за десять ещё рано', !isDue(start, 5, start - 10 * MINUTE));
  check('в момент начала ещё показываем', isDue(start, 5, start));
  check('через полчаса уже нет', !isDue(start, 5, start + 30 * MINUTE));
  check('без напоминания молчим', !isDue(start, 0, start));
}

console.log('Сроки ВДР — проекция, а не запись');
{
  const ev = deadlineEvent({
    id: 'v1', title: 'Опросный лист', dueAt: at(2026, 9, 12), code: 'АВО-2-НС-001',
    register: 'ВДР-1', projectId: 'p1',
  });
  check('срок стал событием на весь день', ev.allDay && ev.kind === 'deadline');
  check('идентификатор говорит, откуда взялся', ev.id === 'vdr:v1' && ev.source === 'vdr');
  check('обозначение в названии', ev.title.startsWith('АВО-2-НС-001'));
  check('срок нельзя двигать из календаря', isReadOnly(ev));
  check('обычное событие двигать можно', !isReadOnly(base()));
  check('у срока нет напоминания по умолчанию', ev.remindMin === 0);
}

console.log('В сетке нет кнопки внутри кнопки');
{
  // Клетка дня и строка часа были кнопками, а внутри них стояли кнопки
  // событий. Нажатие работало, но разметка недопустима, и React ругался на
  // каждой отрисовке месяца; ругань по устройству программы попадает в Журнал,
  // и он засорялся при каждом открытии Календаря
  const src = readFileSync(join(__dirname, '../src/screens/CalendarScreen.tsx'), 'utf8');
  check('клетка дня — не кнопка', !src.includes('<button key={day}'));
  check('строка часа — не кнопка', !src.includes('<button key={h}'));
  check('клетка дня осталась клеткой сетки', src.includes('role="gridcell"'));
  check('событие по-прежнему кнопка', src.includes('function Chip(') && src.includes('stopPropagation'));
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки календаря пройдены');
