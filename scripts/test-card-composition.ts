/**
 * Состав в карточке: секция не повторяет данные вложенных позиций.
 *
 * Снимок владельца: блок «Вентилятор ВСК» показывал разделы вентилятора и
 * двигателя, а тегов и двигателя в нём не было — они у вентиляторов внутри.
 * Проверяем правило: у секции прячутся ровно те разделы, что есть у позиций
 * внутри неё, её собственные («Блок», «Параметры установки») остаются; у
 * блока-изделия (фильтр с тегом) не прячется ничего; состав идёт деревом по
 * тегу, а подпозиция знает, во что входит.
 *
 * Запуск: npx tsx scripts/test-card-composition.ts
 */
import { classifyAll } from '../equipment/classes';
import { compositionView } from '../src/lib/cardComposition';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failed++;
  console.error(`  ✗ ${name} — получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`);
};

const specs = (...titles: string[]) => JSON.stringify({ groups: titles.map((title) => ({ title, params: [{ key: 'x', value: '1' }] })) });
const tag = (identifier: string) => [{ identifier }];

const NODES: any[] = [
  { id: 'fb', itemCode: '3', name: 'Вентилятор ВСК', role: 'БЛОК', equipType: 'ВЕНТИЛЯТОР',
    specs: specs('Блок', 'Параметры установки', 'Вентилятор', 'Рабочая точка', 'Электродвигатель') },
  { id: 'f2', itemCode: '3/вентилятор2', name: 'Вентилятор №2', role: 'ВЕНТИЛЯТОР', parentElementId: 'fb',
    tags: tag('X-BL-002A'), specs: specs('Вентилятор', 'Рабочая точка') },
  { id: 'f1', itemCode: '3/вентилятор1', name: 'Вентилятор №1', role: 'ВЕНТИЛЯТОР', parentElementId: 'fb',
    tags: tag('X-BL-001A'), specs: specs('Вентилятор', 'Рабочая точка') },
  { id: 'm1', itemCode: '3/вентилятор1/двигатель1', name: 'Двигатель', role: 'ДВИГАТЕЛЬ', parentElementId: 'f1',
    specs: specs('Электродвигатель') },
  { id: 'o', itemCode: '3/оснащение1', name: 'Светильник', role: 'ОСНАЩЕНИЕ', parentElementId: 'fb', sourceKind: 'cadLightSwitchKit' },
  { id: 'fl', itemCode: '1.2', name: 'Фильтр карманный', role: 'БЛОК', equipType: 'ФИЛЬТР', tags: tag('X-FA-001A'),
    specs: specs('Блок', 'Фильтр') },
  { id: 'fo', itemCode: '1.2/оснащение1', name: 'Светильник', role: 'ОСНАЩЕНИЕ', parentElementId: 'fl', specs: specs('Фильтр') },
];
const types = classifyAll(NODES);

console.log('Секция-корпус не повторяет разделы вложенных позиций');
{
  const v = compositionView(NODES[0], NODES, types);
  eq('прячутся разделы вентилятора и двигателя', v.hiddenGroups, ['Вентилятор', 'Рабочая точка', 'Электродвигатель']);
  eq('состав деревом по тегу, двигатель под своим вентилятором', v.children.map((c) => `${'  '.repeat(c.depth)}${c.id}`),
    ['f1', '  m1', 'f2', 'o']);
  eq('теги в составе видны', v.children.filter((c) => c.tag).map((c) => c.tag), ['X-BL-001A', 'X-BL-002A']);
  eq('тип строки состава', v.children[1].cls, 'ДВИГАТЕЛЬ');
  eq('у секции нет владельца', v.parent, null);
}

console.log('Блок-изделие показывает свои данные целиком');
{
  const v = compositionView(NODES[5], NODES, types);
  eq('у фильтра с тегом ничего не прячется', v.hiddenGroups, []);
  eq('но состав виден', v.children.map((c) => c.id), ['fo']);
}

console.log('Подпозиция знает, во что входит');
{
  const v = compositionView(NODES[3], NODES, types);
  eq('двигатель — внутри вентилятора №1', v.parent, { id: 'f1', label: 'Вентилятор №1', tag: 'X-BL-001A' });
  eq('у двигателя состава нет', v.children, []);
  eq('кольцо в данных не вешает карточку',
    compositionView({ id: 'a', itemCode: 'a', name: 'a', parentElementId: 'b' },
      [{ id: 'a', itemCode: 'a', name: 'a', parentElementId: 'b' }, { id: 'b', itemCode: 'b', name: 'b', parentElementId: 'a' }], new Map()).children.map((c) => c.id),
    ['b']);
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки состава карточки пройдены');
