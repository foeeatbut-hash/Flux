/**
 * Дерево тегов: у кого кто в родителях.
 *
 * Правило берётся из работы. Есть приточная установка. У неё компоненты —
 * клапан, вентилятор, калорифер, — и родитель у всех у них один: сама
 * установка. У элементов клапана родитель — клапан, у элементов калорифера —
 * калорифер. Ошибка здесь не падает: она молча переставляет местами родителя и
 * ребёнка, и состав оборудования начинает читаться наизнанку.
 *
 * Ровно это и случилось. Строка «Родительский тег» в карточке писала
 * выбранного родителя в СОБСТВЕННЫЙ список детей тега. Наружу это выходило
 * так: у 1 детьми оказывались 2 и 3, у 2 родителем — 1, а ребёнком 3, а у 3
 * родителем — 2, но «перед этим 1». Разобрать такое дерево нельзя.
 *
 * Запуск: npx tsx scripts/test-tag-tree.ts
 */
import { readFileSync } from 'fs';
import {
  childrenOf, parentOf, descendantsOf, pathTo, whyNotLink, linkChild, unlinkChild, repairTagTree,
  type TreeNode, type TreePatch,
} from '../src/lib/tagTree';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

/** Применить правки к списку — так же, как это делает реестр */
const apply = (nodes: TreeNode[], patches: TreePatch[]): TreeNode[] =>
  nodes.map((n) => {
    const p = patches.find((x) => x.id === n.id);
    return p ? { id: n.id, connections: p.connections, parentId: p.parentId } : n;
  });

// Приточная установка Вероса: компоненты и их элементы
const AHU: TreeNode[] = [
  { id: 'ahu', connections: ['valve', 'fan', 'heater'] },
  { id: 'valve', connections: ['drive'], parentId: 'ahu' },
  { id: 'fan', connections: ['motor'], parentId: 'ahu' },
  { id: 'heater', connections: [], parentId: 'ahu' },
  { id: 'drive', connections: [], parentId: 'valve' },
  { id: 'motor', connections: [], parentId: 'fan' },
];

console.log('Состав установки читается как дерево');
{
  check('у установки три компонента', childrenOf(AHU, 'ahu').join() === 'valve,fan,heater', childrenOf(AHU, 'ahu'));
  check('родитель компонента — установка', parentOf(AHU, 'valve') === 'ahu');
  // Родитель элемента — сам элемент оборудования, а не установка через голову
  check('родитель привода — клапан, а не установка', parentOf(AHU, 'drive') === 'valve', parentOf(AHU, 'drive'));
  check('у установки родителя нет', parentOf(AHU, 'ahu') === null);
  check('путь идёт сверху вниз', pathTo(AHU, 'drive').join(' → ') === 'ahu → valve → drive', pathTo(AHU, 'drive'));
  check('под установкой — всё', descendantsOf(AHU, 'ahu').size === 6, descendantsOf(AHU, 'ahu').size);
  check('под клапаном — только его элементы',
    [...descendantsOf(AHU, 'valve')].sort().join() === 'drive,valve', [...descendantsOf(AHU, 'valve')]);
}

console.log('Что связать нельзя');
{
  check('сам себе родителем не станет', !!whyNotLink(AHU, 'valve', 'valve'));
  check('свой потомок в родители не годится — вышло бы кольцо', !!whyNotLink(AHU, 'drive', 'valve'));
  check('чужого тега в проекте нет', !!whyNotLink(AHU, 'ahu', 'нет-такого'));
  check('обычная связь разрешена', whyNotLink(AHU, 'heater', 'drive') === '', whyNotLink(AHU, 'heater', 'drive'));
  check('отказ объяснён словами, а не пустотой', whyNotLink(AHU, 'drive', 'valve').length > 20);
}

console.log('Связь заводится обеими записями сразу');
{
  // Привод переносим с клапана на вентилятор
  const next = apply(AHU, linkChild(AHU, 'fan', 'drive'));
  check('у нового родителя ребёнок появился', childrenOf(next, 'fan').includes('drive'), childrenOf(next, 'fan'));
  // Без этого тег висел бы на двух родителях сразу, и линий к нему стало бы две
  check('у прежнего родителя его больше нет', !childrenOf(next, 'valve').includes('drive'), childrenOf(next, 'valve'));
  check('отметка у ребёнка выправлена', next.find((n) => n.id === 'drive')?.parentId === 'fan');
  check('родитель у тега ровно один', parentOf(next, 'drive') === 'fan');

  check('невозможная связь не даёт правок', linkChild(AHU, 'drive', 'valve').length === 0);
  check('повтор той же связи не переписывает лишнего',
    linkChild(AHU, 'valve', 'drive').length === 0, linkChild(AHU, 'valve', 'drive'));

  const cut = apply(AHU, unlinkChild(AHU, 'valve', 'drive'));
  check('разрыв убирает ребёнка из списка', !childrenOf(cut, 'valve').includes('drive'));
  check('и отметку у ребёнка тоже — иначе дерево помнит разорванное',
    cut.find((n) => n.id === 'drive')?.parentId === undefined);
}

console.log('Дерево, испорченное прежней карточкой, выправляется');
{
  // Ровно то, что описывал владелец: 1 держит детьми 2 и 3, а 2 и 3 держат
  // своими детьми собственных родителей — связь смотрит в обе стороны сразу
  const broken: TreeNode[] = [
    { id: '1', connections: ['2', '3'] },
    { id: '2', connections: ['1', '3'], parentId: '1' },
    { id: '3', connections: ['2'], parentId: '2' },
  ];
  const fixed = apply(broken, repairTagTree(broken));
  check('родитель больше не числится ребёнком своего ребёнка',
    !childrenOf(fixed, '2').includes('1'), childrenOf(fixed, '2'));
  check('у каждого тега родитель один',
    fixed.every((n) => broken.filter((x) => childrenOf(fixed, x.id).includes(n.id)).length <= 1));
  check('у 2 родитель — 1', parentOf(fixed, '2') === '1', parentOf(fixed, '2'));
  // 3 числился ребёнком и у 1, и у 2; сам он называет родителем 2 — его и оставляем
  check('спор о родителе решён в пользу того, кого называет сам ребёнок',
    parentOf(fixed, '3') === '2', parentOf(fixed, '3'));
  check('обход дерева кончается', descendantsOf(fixed, '1').size === 3, descendantsOf(fixed, '1').size);
  check('отметка у ребёнка совпала со списком родителя',
    fixed.every((n) => (n.parentId || null) === parentOf(fixed, n.id)));

  // Нашлось живой пробой: прежняя карточка записывала родителя ТОЛЬКО у
  // ребёнка. Если такую связь просто вычистить, дерево станет плоским, и
  // состав установки потеряется целиком — выправление превратится в разрыв
  const oneSided: TreeNode[] = [
    { id: 'ahu', connections: [] },
    { id: 'valve', connections: ['ahu'], parentId: 'ahu' },
    { id: 'drive', connections: ['valve'], parentId: 'valve' },
  ];
  const kept = apply(oneSided, repairTagTree(oneSided));
  check('связь, о которой знал только ребёнок, восстановлена, а не разорвана',
    childrenOf(kept, 'ahu').join() === 'valve', childrenOf(kept, 'ahu'));
  check('и вся цепочка тоже', childrenOf(kept, 'valve').join() === 'drive', childrenOf(kept, 'valve'));
  check('родитель привода — клапан, а не установка через голову',
    parentOf(kept, 'drive') === 'valve', parentOf(kept, 'drive'));
  check('дерево целое: под установкой все трое', descendantsOf(kept, 'ahu').size === 3);

  check('здоровое дерево не переписывается ни одной записью',
    repairTagTree(AHU).length === 0, repairTagTree(AHU));

  const selfLoop: TreeNode[] = [{ id: 'a', connections: ['a'], parentId: 'a' }];
  check('тег не остаётся собственным ребёнком',
    childrenOf(apply(selfLoop, repairTagTree(selfLoop)), 'a').length === 0);

  const ghost: TreeNode[] = [{ id: 'a', connections: ['удалённый'] }];
  check('исчезнувший тег вычёркивается из детей',
    childrenOf(apply(ghost, repairTagTree(ghost)), 'a').length === 0);

  const ring: TreeNode[] = [
    { id: 'a', connections: ['b'], parentId: 'c' },
    { id: 'b', connections: ['c'], parentId: 'a' },
    { id: 'c', connections: ['a'], parentId: 'b' },
  ];
  const unring = apply(ring, repairTagTree(ring));
  const roots = unring.filter((n) => parentOf(unring, n.id) === null);
  check('кольцо разомкнуто — иначе обход не кончается', roots.length >= 1, roots.map((r) => r.id));
  check('и после размыкания у всех по одному родителю',
    unring.every((n) => unring.filter((x) => childrenOf(unring, x.id).includes(n.id)).length <= 1));
}

console.log('«+ родительский тег» вешает тег под выбранного, а не наоборот');
{
  // Кнопка в карточке зовёт handleAddConnection(выбранный, свой) — родитель
  // первым доводом. Перепутанный порядок и есть та самая поломка, из-за
  // которой строку «Родительский тег» пришлось убирать: она делала родителя
  // ребёнком собственного ребёнка
  const next = apply(AHU, linkChild(AHU, 'heater', 'drive'));
  check('выбранный стал родителем', parentOf(next, 'drive') === 'heater', parentOf(next, 'drive'));
  check('а не ребёнком', !childrenOf(next, 'drive').includes('heater'), childrenOf(next, 'drive'));
  // Родитель у тега один: прежнего linkChild отцепляет сам, без отдельной кнопки
  check('прежний родитель отцеплен', !childrenOf(next, 'valve').includes('drive'), childrenOf(next, 'valve'));
  check('и держит его ровно один тег',
    next.filter((n) => childrenOf(next, n.id).includes('drive')).length === 1);

  // Свой же состав в родители не годится — это кольцо. Такие теги из списка
  // кандидатов убирают заранее, а не ругаются на выбор постфактум
  const kin = descendantsOf(AHU, 'valve');
  check('свой потомок в кандидаты не попадёт', kin.has('drive'));
  check('сам тег в кандидаты не попадёт', kin.has('valve'));
  check('чужая ветка в кандидаты попадёт', !kin.has('fan') && !kin.has('motor'));
  check('и правила с этим согласны',
    !!whyNotLink(AHU, 'drive', 'valve') && whyNotLink(AHU, 'fan', 'valve') === '');
}

console.log('Неправильная логика убрана из программы');
{
  // Карточка доски вынесена из Registry в BoardCard: кнопки «+ родительский
  // тег» и «+ дочерний тег» теперь живут там, а проверка должна видеть обе
  // половины, иначе она стережёт файл, в котором этих строк больше нет
  const reg = readFileSync(new URL('../src/screens/Registry.tsx', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/components/registry/BoardCard.tsx', import.meta.url), 'utf8');
  // Родитель — ПЕРВЫЙ довод. Если вызов перевернут, эта строка исчезнет
  check('в карточке родителя ставят первым доводом',
    reg.includes('await handleAddConnection(t.id, tag.id)'));
  check('а ребёнка — вторым', reg.includes('await handleAddConnection(tag.id, t.id)'));
  check('кандидаты в родители отбираются по потомкам', reg.includes('descendantsOf(treeNodes(), tagId)'));
  // Строка писала родителя в собственные дети тега — из-за неё всё и поехало
  check('строки «Родительский тег» в карточке нет',
    !/>Родительский тег</.test(reg) && !reg.includes('Нет родительского тега'));
  check('и её обработчика тоже нет', !reg.includes('handleUpdateParent'));
  check('связи заводятся общими правилами', reg.includes("from '../lib/tagTree'"));
  check('испорченное дерево выправляется при загрузке', reg.includes('repairTagTree'));
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки дерева тегов пройдены');
