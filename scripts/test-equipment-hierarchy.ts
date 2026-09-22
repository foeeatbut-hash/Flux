/**
 * Родство тегов: кто у кого в родителях после импорта расчёта.
 *
 * Правило владельца проекта дословно: «самый главный тег — это тег установки.
 * Родительским тегом для вентилятора будет тег установки. Если в вентиляторе
 * есть двигатель, то для него родителем будет тег вентилятора. Если есть
 * позиция датчик ПТС в двигателе, то для него родителем будет тег двигателя, а
 * потом тег установки».
 *
 * Здесь проверяется ровно это и три вещи, без которых правило вредит:
 * промежуточная позиция без тега не обрывает цепочку и не получает выдуманного
 * тега; ручное решение инженера сильнее расчёта; повторный импорт того же
 * файла не переписывает ни одной связи.
 *
 * Запуск: npx tsx scripts/test-equipment-hierarchy.ts
 */

import { planTagParents, parentSetByHand, type TaggedPosition } from '../server/equipmentHierarchy';
import { parentOf, type TreeNode, type TreePatch } from '../src/lib/tagTree';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

/** Теги проекта: установка, два вентилятора, их двигатели и датчик */
const TAGS = ['уст', 'вент1', 'вент2', 'двиг1', 'двиг2', 'датчик1', 'клапан', 'привод'];
const freshNodes = (): TreeNode[] => TAGS.map((id) => ({ id, connections: [], parentId: null }));

/** Применить правки — так же, как это делает запись импорта */
const withPatches = (nodes: TreeNode[], patches: TreePatch[]): TreeNode[] => {
  const byId = new Map(nodes.map((n) => [n.id, { ...n }]));
  for (const p of patches) {
    const n = byId.get(p.id) || { id: p.id };
    n.connections = p.connections;
    n.parentId = p.parentId ?? null;
    byId.set(p.id, n);
  }
  return [...byId.values()];
};

/**
 * Состав из присланного заказчиком файла: блок «Вентилятор ВСК» с двумя
 * вентиляторами, у каждого свой двигатель; в первом двигателе — датчик ПТС,
 * заведённый инженером вручную.
 */
const composition: TaggedPosition[] = [
  { key: 'у‖‖__unit__', parentKey: '', tagId: 'уст', title: 'Установка' },
  { key: 'у‖м‖3', parentKey: '', title: 'Блок «Вентилятор ВСК»' },
  { key: 'у‖м‖3/вентилятор1', parentKey: 'у‖м‖3', tagId: 'вент1', title: 'Вентилятор №1' },
  { key: 'у‖м‖3/вентилятор1/двигатель1', parentKey: 'у‖м‖3/вентилятор1', tagId: 'двиг1', title: 'Электродвигатель' },
  { key: 'у‖м‖3/вентилятор1/двигатель1/датчик1', parentKey: 'у‖м‖3/вентилятор1/двигатель1', tagId: 'датчик1', title: 'Датчик ПТС' },
  { key: 'у‖м‖3/вентилятор2', parentKey: 'у‖м‖3', tagId: 'вент2', title: 'Вентилятор №2' },
  { key: 'у‖м‖3/вентилятор2/двигатель1', parentKey: 'у‖м‖3/вентилятор2', tagId: 'двиг2', title: 'Электродвигатель' },
];

console.log('1. Цепочка установка → вентилятор → двигатель → датчик');
{
  const plan = planTagParents(composition, 'уст', freshNodes());
  const after = withPatches(freshNodes(), plan.patches);

  ok('родитель вентилятора — тег установки', parentOf(after, 'вент1') === 'уст', parentOf(after, 'вент1'));
  ok('у второго вентилятора тоже установка', parentOf(after, 'вент2') === 'уст', parentOf(after, 'вент2'));
  ok('родитель двигателя — свой вентилятор, а не установка',
    parentOf(after, 'двиг1') === 'вент1', parentOf(after, 'двиг1'));
  ok('у двигателя второго вентилятора — второй вентилятор',
    parentOf(after, 'двиг2') === 'вент2', parentOf(after, 'двиг2'));
  // Датчик ПТС внутри двигателя: родитель — двигатель, а не вентилятор через
  // голову и не установка. Цепочка идёт по составу, звено за звеном
  ok('родитель датчика — двигатель', parentOf(after, 'датчик1') === 'двиг1', parentOf(after, 'датчик1'));

  // Блок тега не имеет — и выдумывать его никто не стал
  ok('нетегированный блок в дерево не попал', !after.some((n) => n.id === 'у‖м‖3'));
  ok('у самой установки родителя нет', !parentOf(after, 'уст'), parentOf(after, 'уст'));

  // Каждое решение объяснено словами: инженер видит, откуда взялся родитель
  const why = plan.decisions.find((d) => d.childTagId === 'двиг1')?.why || '';
  ok('решение объяснено человеческими словами', why.includes('Вентилятор №1'), why);
}

console.log('\n2. Промежуточная позиция без тега цепочку не обрывает');
{
  // Вентилятор тега не получил (в примечании его не было). Двигатель не
  // остаётся сиротой и тега вентилятору не выдумывает — он поднимается выше
  const noFanTag = composition.map((p) => (p.tagId === 'вент1' ? { ...p, tagId: undefined } : p));
  const plan = planTagParents(noFanTag, 'уст', freshNodes());
  const after = withPatches(freshNodes(), plan.patches);

  ok('двигатель поднялся к установке', parentOf(after, 'двиг1') === 'уст', parentOf(after, 'двиг1'));
  ok('датчик остался под своим двигателем', parentOf(after, 'датчик1') === 'двиг1', parentOf(after, 'датчик1'));
  ok('тега вентилятору не выдумали', !after.some((n) => n.id === 'вент1' && (n.connections || []).length));

  const why = plan.decisions.find((d) => d.childTagId === 'двиг1')?.why || '';
  ok('сказано, почему родителем стала установка', why.includes('установки'), why);
}

console.log('\n3. Ручное решение инженера сильнее расчёта');
{
  // Инженер увёл двигатель под клапан: на объекте так и есть, а расчёт про
  // это не знает. Повторный импорт обязан оставить связь как есть
  const nodes = withPatches(freshNodes(), [
    { id: 'клапан', connections: ['двиг1'], parentId: undefined },
    { id: 'двиг1', connections: [], parentId: 'клапан' },
  ]);
  const plan = planTagParents(composition, 'уст', nodes, new Set(['двиг1']));
  const after = withPatches(nodes, plan.patches);

  ok('ручная связь не переписана', parentOf(after, 'двиг1') === 'клапан', parentOf(after, 'двиг1'));
  const d = plan.decisions.find((x) => x.childTagId === 'двиг1');
  ok('расхождение не спрятано', !!d && d.applied === false, d);
  ok('и названо словами', /вручную/.test(d?.why || ''), d?.why);

  // Остальные связи при этом строятся как обычно
  ok('соседние связи построены', parentOf(after, 'вент1') === 'уст' && parentOf(after, 'двиг2') === 'вент2');
}

console.log('\n4. Повторный импорт ничего не переписывает');
{
  const first = planTagParents(composition, 'уст', freshNodes());
  const after = withPatches(freshNodes(), first.patches);
  const second = planTagParents(composition, 'уст', after);

  ok('первый прогон построил связи', first.patches.length > 0, first.patches.length);
  ok('второй прогон не пишет ни одной правки', second.patches.length === 0, second.patches);
  ok('и не сообщает о несделанном', second.decisions.length === 0, second.decisions);
}

console.log('\n5. Кольца не заводятся');
{
  // Тег установки уже стоит ребёнком вентилятора (след старой правки).
  // Сделать вентилятор ребёнком установки значило бы замкнуть круг
  const nodes = withPatches(freshNodes(), [
    { id: 'вент1', connections: ['уст'], parentId: undefined },
    { id: 'уст', connections: [], parentId: 'вент1' },
  ]);
  const plan = planTagParents(composition.filter((p) => p.tagId !== 'двиг1' && p.tagId !== 'датчик1'), 'уст', nodes);
  const after = withPatches(nodes, plan.patches);

  ok('кольцо не построено', parentOf(after, 'уст') === 'вент1', parentOf(after, 'уст'));
  const d = plan.decisions.find((x) => x.childTagId === 'вент1');
  ok('отказ объяснён, а не проглочен', !!d && d.applied === false && /кольцо/.test(d.why), d);
}

console.log('\n6. Отметка «поставил человек» читается из metadata');
{
  ok('строка JSON читается', parentSetByHand('{"parentBy":"hand"}'));
  ok('объект читается', parentSetByHand({ parentBy: 'hand' }));
  ok('импортная связь не считается ручной', !parentSetByHand('{"parentBy":"import"}'));
  // Связи, заведённые до появления поля, переспрашивать не за что
  ok('старая связь без отметки — не ручная', !parentSetByHand('{"connections":["a"]}'));
  ok('мусор не роняет разбор', !parentSetByHand('не json'));
}

console.log('\n7. У установки нет тега — строится всё, что можно');
{
  /**
   * Обозначение установки не всегда проходит правило проекта: кириллическая
   * «С» вместо латинской — и тега у неё просто нет. Живая проверка показала,
   * что тогда родство не строилось ВООБЩЕ НИ У КОГО, причём молча: двигатель
   * не вставал под свой вентилятор, хотя оба тега были на месте.
   */
  const plan = planTagParents(composition, '', freshNodes());
  const after = withPatches(freshNodes(), plan.patches);

  ok('двигатель всё равно встал под свой вентилятор',
    parentOf(after, 'двиг1') === 'вент1', parentOf(after, 'двиг1'));
  ok('датчик — под своим двигателем', parentOf(after, 'датчик1') === 'двиг1');
  // А вот вентилятору родителя взять неоткуда, и выдумывать его никто не стал
  ok('вентилятор остался без родителя', !parentOf(after, 'вент1'), parentOf(after, 'вент1'));
  ok('о нём и не сказано лишнего',
    !plan.decisions.some((d) => d.childTagId === 'вент1'), plan.decisions);
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
