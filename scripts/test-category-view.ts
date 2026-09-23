/**
 * Вид категории по типам: порядок, скрытие, перенос старых настроек.
 *
 * Спрашиваем то, что человек заметит сразу, если сломается: новый параметр из
 * свежего расчёта не пропадает; перенос одного параметра не перемешивает
 * соседей; «скрыть пустые» не трогает заполненное; старая настройка по
 * `equipType` продолжает работать и переезжает в новый вид первой правкой.
 *
 * Запуск: npx tsx scripts/test-category-view.ts
 */
import {
  parseView, viewOf, isHiddenIn, toggleIn, arrange, catalogOf, showAll, hideEmpty, resetClass,
  moveTo, step, orderOf, groupToken, paramToken, settingKey,
} from '../src/lib/categoryView';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failed++;
  console.error(`  ✗ ${name} — получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`);
};

const card = (groups: Record<string, Record<string, string>>) => Object.entries(groups)
  .map(([title, params]) => ({ title, params: Object.entries(params).map(([key, value]) => ({ key, value, unit: key === 'Мощность' ? 'кВт' : '' })) }));

console.log('Разбор сохранённого');
{
  eq('ключ настройки — на категорию', settingKey('AHU'), 'equip_view:AHU');
  eq('мусор — пустой вид', parseView('{битое'), {});
  eq('массив — пустой вид', parseView('[1,2]'), {});
  eq('вид типа читается', parseView(JSON.stringify({ ПРИВОД: { hidden: ['g:Привод'], params: ['Привод||Модель'] } })).ПРИВОД.hidden, ['g:Привод']);
}

console.log('Порядок: названное — в порядке вида, новое — в конце раздела');
{
  const groups = card({ Привод: { Модель: 'SF24', Мощность: '5', Напряжение: '24' }, Клапан: { Размер: '1000' } });
  const cv = { hidden: [], groups: ['Клапан', 'Привод'], params: ['Привод||Напряжение', 'Привод||Модель'] };
  const out = arrange(groups, cv);
  eq('разделы в порядке вида', out.map((g) => g.title), ['Клапан', 'Привод']);
  // Мощности в виде нет: она пришла с новым расчётом — и встала в конец, а не пропала
  eq('параметры в порядке вида, новый — в конце', out[1].params.map((p) => p.key), ['Напряжение', 'Модель', 'Мощность']);
  eq('без вида — как в карточке', arrange(groups, { hidden: [] }).map((g) => g.title), ['Привод', 'Клапан']);
}

console.log('Перенос не перемешивает соседей');
{
  const list = ['a', 'b', 'c', 'd'];
  eq('вниз — встаёт после цели', moveTo(list, 'a', 'c'), ['b', 'c', 'a', 'd']);
  eq('вверх — встаёт перед целью', moveTo(list, 'd', 'b'), ['a', 'd', 'b', 'c']);
  eq('на себя — без изменений', moveTo(list, 'b', 'b'), list);
  eq('чужая цель — без изменений', moveTo(list, 'b', 'x'), list);
  eq('шаг вверх', step(list, 'c', -1), ['a', 'c', 'b', 'd']);
  eq('шаг за край — без изменений', step(list, 'a', -1), list);
  eq('порядок снимается целиком',
    orderOf(card({ A: { x: '1', y: '2' }, B: { z: '3' } })), { groups: ['A', 'B'], params: ['A||x', 'A||y', 'B||z'] });
}

console.log('Сводка типа: «есть у N из M»');
{
  const cat = catalogOf([
    { groups: card({ Привод: { Модель: 'SF24', Мощность: '' } }) },
    { groups: card({ Привод: { Модель: 'SM24', Мощность: '' } }) },
    { groups: card({ Привод: { Модель: '', Ход: '90' } }) },
  ]);
  eq('позиций в сводке', cat.total, 3);
  eq('параметры по первому появлению', cat.groups[0].params.map((p) => p.key), ['Модель', 'Мощность', 'Ход']);
  eq('модель заполнена у двух из трёх', [cat.groups[0].params[0].present, cat.groups[0].params[0].filled], [3, 2]);
  eq('единица подхвачена', cat.groups[0].params[1].unit, 'кВт');

  const hid = hideEmpty({}, 'ПРИВОД', cat);
  eq('«скрыть пустые» скрыло незаполненную мощность', isHiddenIn(hid.ПРИВОД, paramToken('Привод', 'Мощность')), true);
  eq('и не тронуло заполненную модель', isHiddenIn(hid.ПРИВОД, paramToken('Привод', 'Модель')), false);
  eq('раздел с заполненным не скрыт', isHiddenIn(hid.ПРИВОД, groupToken('Привод')), false);
  eq('«показать все» снимает скрытия', showAll(hid, 'ПРИВОД').ПРИВОД.hidden, []);
  eq('«сбросить» — снова без своего вида', resetClass(hid, 'ПРИВОД').ПРИВОД, { hidden: [] });
}

console.log('Старые скрытия по equipType переезжают без потерь');
{
  const legacy = ['g:Особые условия', 'p:Привод||Ход'];
  eq('пока своего вида нет — действуют старые', isHiddenIn(viewOf({}, 'ПРИВОД', legacy), 'p:Привод||Ход'), true);
  const next = toggleIn({}, 'ПРИВОД', 'p:Привод||Модель', legacy);
  eq('первая правка переносит старые скрытия', next.ПРИВОД.hidden, [...legacy, 'p:Привод||Модель']);
  eq('повторная — снимает своё', toggleIn(next, 'ПРИВОД', 'p:Привод||Модель', legacy).ПРИВОД.hidden, legacy);
  eq('чужой тип не задет', next.ВЕНТИЛЯТОР, undefined);
  eq('свой вид сильнее старых скрытий', viewOf({ ПРИВОД: { hidden: [] } }, 'ПРИВОД', legacy).hidden, []);
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки вида категории пройдены');
