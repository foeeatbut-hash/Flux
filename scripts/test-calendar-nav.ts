/**
 * Листание календаря.
 *
 * Два дефекта, и оба человек видит глазами.
 *
 * Первый: шаг на месяц делался через `setMonth` с сохранением дня. 31 января
 * плюс месяц — это «31 февраля», то есть 3 марта. Стоя на 31-м числе, человек
 * нажимал «вперёд» и проскакивал февраль целиком; обратно тот же шаг его тоже
 * не возвращал.
 *
 * Второй: вид «Сроки» считал отрезок от `Date.now()`, а заголовок брал из
 * выбранного месяца. Стрелки меняли надпись и не меняли список под ней.
 *
 * Запуск: npx tsx scripts/test-calendar-nav.ts
 */

import { stepMonth, dueRange, startOfMonth, monthLabel, DAY } from '../src/lib/calendar';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

/** Местное время: календарь живёт в нём, а не в UTC. */
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const ym = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}`; };
const dayOf = (t: number) => new Date(t).getDate();

console.log('1. Длинный месяц не проскакивает короткий');
{
  // Ради этого весь набор: 31 января -> февраль, а не март
  ok('31 января + 1 = февраль', ym(stepMonth(at(2025, 1, 31), 1)) === '2025-2', ym(stepMonth(at(2025, 1, 31), 1)));
  ok('31 марта + 1 = апрель', ym(stepMonth(at(2025, 3, 31), 1)) === '2025-4');
  ok('31 мая + 1 = июнь', ym(stepMonth(at(2025, 5, 31), 1)) === '2025-6');
  ok('31 августа + 1 = сентябрь', ym(stepMonth(at(2025, 8, 31), 1)) === '2025-9');
  ok('31 октября + 1 = ноябрь', ym(stepMonth(at(2025, 10, 31), 1)) === '2025-11');
  // Назад тот же капкан: 31 марта минус месяц давало 3 марта, то есть тот же месяц
  ok('31 марта − 1 = февраль', ym(stepMonth(at(2025, 3, 31), -1)) === '2025-2', ym(stepMonth(at(2025, 3, 31), -1)));
  ok('31 декабря − 1 = ноябрь', ym(stepMonth(at(2025, 12, 31), -1)) === '2025-11');
}

console.log('\n2. 28, 29, 30, 31 — любой день месяца ведёт себя одинаково');
{
  for (const d of [1, 15, 28, 29, 30, 31]) {
    const t = at(2025, 1, Math.min(d, 31));
    ok(`${d} января + 1 = февраль`, ym(stepMonth(t, 1)) === '2025-2', ym(stepMonth(t, 1)));
  }
  ok('якорь всегда встаёт на первое число', dayOf(stepMonth(at(2025, 1, 31), 1)) === 1);
  ok('и на полночь', new Date(stepMonth(at(2025, 1, 31), 1)).getHours() === 0);
}

console.log('\n3. Через границу года');
{
  ok('декабрь + 1 = январь следующего', ym(stepMonth(at(2025, 12, 15), 1)) === '2026-1', ym(stepMonth(at(2025, 12, 15), 1)));
  ok('январь − 1 = декабрь прошлого', ym(stepMonth(at(2025, 1, 15), -1)) === '2024-12');
  ok('31 декабря + 1 = январь', ym(stepMonth(at(2025, 12, 31), 1)) === '2026-1');
}

console.log('\n4. Високосный год');
{
  ok('29 февраля 2024 + 1 = март', ym(stepMonth(at(2024, 2, 29), 1)) === '2024-3');
  ok('31 января 2024 + 1 = февраль', ym(stepMonth(at(2024, 1, 31), 1)) === '2024-2');
  ok('29 февраля 2024 − 1 = январь', ym(stepMonth(at(2024, 2, 29), -1)) === '2024-1');
  // 2100 — не високосный, хотя делится на 100
  ok('31 января 2100 + 1 = февраль', ym(stepMonth(at(2100, 1, 31), 1)) === '2100-2');
}

console.log('\n5. Двенадцать шагов возвращают в тот же месяц');
{
  let t = at(2025, 1, 31);
  for (let i = 0; i < 12; i++) t = stepMonth(t, 1);
  ok('год вперёд — январь 2026', ym(t) === '2026-1', ym(t));

  // Прежний счёт за двенадцать шагов уезжал на несколько месяцев вперёд
  let back = t;
  for (let i = 0; i < 12; i++) back = stepMonth(back, -1);
  ok('и обратно — январь 2025', ym(back) === '2025-1', ym(back));

  ok('шаг вперёд и назад — то же начало месяца',
    stepMonth(stepMonth(at(2025, 1, 31), 1), -1) === startOfMonth(at(2025, 1, 1)));
  ok('нулевой шаг — начало своего месяца', stepMonth(at(2025, 7, 17), 0) === startOfMonth(at(2025, 7, 17)));
}

console.log('\n6. Заголовок и список смотрят в одну сторону');
{
  const anchor = at(2025, 3, 10);
  const [from, to] = dueRange(anchor);

  ok('отрезок начинается до выбранного месяца', from < startOfMonth(anchor));
  ok('и заканчивается сильно после', to > startOfMonth(anchor));
  ok('ширина окна прежняя — 210 дней', Math.round((to - from) / DAY) === 210, Math.round((to - from) / DAY));

  // Вот сам дефект: шаг по месяцам обязан двигать отрезок
  const next = stepMonth(anchor, 1);
  const [from2, to2] = dueRange(next);
  ok('стрелка «вперёд» двигает начало', from2 > from, [from, from2]);
  ok('и конец', to2 > to);
  ok('на длину месяца', Math.round((from2 - from) / DAY) === 31, Math.round((from2 - from) / DAY));

  // Заголовок берётся из того же якоря — значит, расходиться им не с чем
  ok('заголовок следующего месяца — апрель', monthLabel(next).startsWith('Апрель'), monthLabel(next));

  ok('назад — симметрично', dueRange(stepMonth(anchor, -1))[0] < from);
  ok('дважды от одного якоря — один ответ', dueRange(anchor)[0] === dueRange(anchor)[0]);
  ok('якорь внутри месяца не влияет: 1-е и 28-е дают одно окно',
    dueRange(at(2025, 3, 1))[0] === dueRange(at(2025, 3, 28))[0]);
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
