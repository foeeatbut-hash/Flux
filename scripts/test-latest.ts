/**
 * Отвечать должен последний спрошенный, а не последний ответивший.
 *
 * Сеть не обещает порядок. Человек переключил проект с A на B — и ответ по A,
 * задержавшийся на полсекунды, приходит ПОСЛЕ ответа по B и затирает его: на
 * экране проект B, в памяти словарь A, следующая запись уходит в A. Аудит
 * воспроизвёл это на настоящем хранилище переводчика.
 *
 * Здесь проверяется само правило и, главное, порядок «A→B→C при любом порядке
 * ответов заканчивается C» — критерий приёмки из отчёта.
 *
 * Запуск: npx tsx scripts/test-latest.ts
 */

import { makeLatest, stillWanted } from '../src/lib/latest';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

console.log('1. Счётчик запросов');
{
  const l = makeLatest();
  const a = l.next();
  ok('первый запрос — свой', l.isCurrent(a));

  const b = l.next();
  ok('после второго первый перестал быть своим', !l.isCurrent(a));
  ok('второй — свой', l.isCurrent(b));

  l.cancel();
  ok('после отмены и второй чужой', !l.isCurrent(b));
  ok('номер растёт, а не сбрасывается', l.current > b, l.current);
}

console.log('\n2. A→B→C при любом порядке ответов заканчивается C');
{
  // Перебираем ВСЕ шесть порядков прихода ответов
  const orders = [
    ['A', 'B', 'C'], ['A', 'C', 'B'], ['B', 'A', 'C'],
    ['B', 'C', 'A'], ['C', 'A', 'B'], ['C', 'B', 'A'],
  ];
  for (const order of orders) {
    const l = makeLatest();
    let wanted = '';
    let shown = '';
    const tokens: Record<string, number> = {};
    // Спросили по очереди A, B, C — курсор человека остановился на C
    for (const p of ['A', 'B', 'C']) { wanted = p; tokens[p] = l.next(); }
    // Ответы приходят как попало
    for (const p of order) {
      if (stillWanted({ latest: l, token: tokens[p], asked: p, wanted })) shown = p;
    }
    ok(`порядок ответов ${order.join('→')} даёт C`, shown === 'C', { order, shown });
  }
}

console.log('\n3. Совпасть должны и номер, и то, о чём спрашивали');
{
  const l = makeLatest();
  const t = l.next();

  ok('номер свой и проект тот же — берём',
    stillWanted({ latest: l, token: t, asked: 'A', wanted: 'A' }));

  // Тот же номер, но человек уже смотрит на другой проект: подставлять чужой
  // словарь нельзя, даже если запрос формально последний
  ok('проект сменился — не берём',
    !stillWanted({ latest: l, token: t, asked: 'A', wanted: 'B' }));

  const t2 = l.next();
  ok('номер устарел — не берём, даже если проект совпал',
    !stillWanted({ latest: l, token: t, asked: 'A', wanted: 'A' }));
  ok('новый номер берём', stillWanted({ latest: l, token: t2, asked: 'A', wanted: 'A' }));
}

console.log('\n4. Очистка строки поиска');
{
  // Человек стёр запрос: пустая строка не должна заполниться старым ответом
  const l = makeLatest();
  const t = l.next();
  l.cancel();
  ok('после очистки поздний ответ не показывается', !l.isCurrent(t));
}

console.log('\n5. Гонка воспроизводится на поддельных ответах');
{
  // Ровно тот сценарий, который аудит воспроизвёл на хранилище переводчика:
  // load(A) не успел, начали load(B), ответ A пришёл последним
  const l = makeLatest();
  let stored = '';
  const load = (project: string, delay: number, log: [string, number][]) => {
    const token = l.next();
    log.push([project, delay]);
    return { project, token, delay };
  };
  const log: [string, number][] = [];
  const first = load('A', 300, log);
  const second = load('B', 10, log);

  // Приходят в обратном порядке: сначала быстрый B, потом медленный A
  for (const r of [second, first]) {
    if (stillWanted({ latest: l, token: r.token, asked: r.project, wanted: 'B' })) stored = r.project;
  }
  ok('медленный ответ по A не затирает B', stored === 'B', { stored, log });
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
