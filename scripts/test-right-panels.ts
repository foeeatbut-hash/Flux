/**
 * Правые панели: уживаются друг с другом и не лезут на панель задач.
 *
 * Проверка написана по двум жалобам владельца. Панели накрывали панель задач —
 * то есть часы, календарь и значки трея, ровно то, ради чего она нужна. И они
 * не умели быть открытыми одновременно: открытие одной закрывало другую, и
 * человек, читавший уведомление и решивший спросить помощника, терял
 * уведомление из виду.
 *
 * Панели теперь скруглённые карточки у правого края (как в Windows 11): на
 * широком экране стоят рядом колонками и не перекрывают друг друга, на узком
 * остаётся последняя открытая. Деление одной колонки по высоте с подвижным
 * разделителем убрано: на низком экране от каждой панели оставался огрызок.
 *
 * Ошибка в раскладке не падает и не мигает — она тихо отрезает кусок экрана.
 * Поэтому правила проверяются здесь, а не глазами.
 *
 * Запуск: npx tsx scripts/test-right-panels.ts
 */
import {
  dockPlan, dockWidth, openPanel, closePanel, togglePanel, panelTitle, panelWidth,
  NARROW_W, NOTIF_W, ASSIST_W, DOCK_GAP, type PanelId,
} from '../src/lib/rightPanels';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const N: PanelId = 'notifications';
const A: PanelId = 'assistant';

console.log('Очередь открытых панелей');
{
  check('открытая встаёт в очередь', openPanel([], N).length === 1);
  check('вторая открывается, не закрывая первую', openPanel([N], A).join() === 'notifications,assistant');
  check('повторное открытие не двоит', openPanel([N], N).length === 1);
  check('закрытие убирает только своё', closePanel([N, A], N).join() === 'assistant');
  check('нажатие по открытой закрывает', togglePanel([N, A], A).join() === 'notifications');
  check('нажатие по закрытой открывает', togglePanel([N], A).join() === 'notifications,assistant');
}

console.log('Кто где стоит на широком экране');
{
  const one = dockPlan([N], 1600);
  check('одна панель — одна колонка', one.columns.join() === 'notifications' && !one.hidden.length, one);

  const two = dockPlan([N, A], 1600);
  check('обе панели показаны вместе', two.columns.length === 2 && !two.hidden.length, two);
  check('помощник левее, уведомления у угла с часами', two.columns.join() === 'assistant,notifications', two.columns);

  const other = dockPlan([A, N], 1600);
  check('место не зависит от порядка открытия: колонки не прыгают', other.columns.join() === 'assistant,notifications', other.columns);

  check('пустая колонка никого не показывает', dockPlan([], 1600).columns.length === 0);
  check('повторы в очереди не двоят колонки', dockPlan([N, N, A], 1600).columns.length === 2);
}

console.log('Колонки не перекрываются и не выходят за экран');
{
  const both = dockWidth(['assistant', 'notifications']);
  check('ширина = обе колонки + три зазора', both === NOTIF_W + ASSIST_W + DOCK_GAP * 3, both);
  check('вдвоём помещаются на границе «узкого» экрана с запасом под окна', both < NARROW_W - 300, both);
  check('пустая колонка не занимает места', dockWidth([]) === 0);
  check('ширины колонок известны', panelWidth(N) === NOTIF_W && panelWidth(A) === ASSIST_W);
}

console.log('Узкий экран: остаётся последняя открытая');
{
  const narrow = dockPlan([N, A], NARROW_W - 1);
  check('показана одна колонка', narrow.columns.length === 1, narrow.columns);
  check('та, которую человек хотел видеть сейчас', narrow.columns[0] === A, narrow.columns);
  check('прежняя помечена скрытой — оболочка её закроет', narrow.hidden.join() === 'notifications', narrow.hidden);
  const reverse = dockPlan([A, N], NARROW_W - 1);
  check('последней открыли уведомления — остаются они', reverse.columns.join() === 'notifications' && reverse.hidden.join() === 'assistant', reverse);
  check('одна панель на узком экране не прячется', dockPlan([N], 800).columns.length === 1 && dockPlan([N], 800).hidden.length === 0);
  check('на границе ширины панели ещё рядом', dockPlan([N, A], NARROW_W).columns.length === 2);
  check('у панелей есть человеческие названия', panelTitle(N) === 'Уведомления' && panelTitle(A) === 'Помощник');
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки правых панелей пройдены');
