/** Запуск: npx tsx scripts/test-unit-schematic.ts */
import { buildUnitSchematic, displayParentLinks } from '../src/lib/unitSchematic';

const order = { ВОЗДУХОПРИЁМНЫЙ: 10, КЛАПАН: 20, ФИЛЬТР: 30, ВЕНТИЛЯТОР: 80 };
const items = [
  { id: 'fan2', itemCode: 'fan2', equipType: 'ВЕНТИЛЯТОР' },
  { id: 'drive2', itemCode: 'drive2', equipType: 'ПРИВОД', parentElementId: 'valve' },
  { id: 'sensor', itemCode: 'sensor', equipType: 'ДАТЧИК', parentElementId: 'motor1' },
  { id: 'unit', itemCode: '__unit__', equipType: 'УСТАНОВКА' },
  { id: 'fan1', itemCode: 'fan1', equipType: 'ВЕНТИЛЯТОР' },
  { id: 'valve', itemCode: 'valve', equipType: 'КЛАПАН' },
  { id: 'drive1', itemCode: 'drive1', equipType: 'ПРИВОД', parentElementId: 'valve' },
  { id: 'motor1', itemCode: 'motor1', equipType: 'ДВИГАТЕЛЬ', parentElementId: 'fan1' },
  { id: 'motor2', itemCode: 'motor2', equipType: 'ДВИГАТЕЛЬ', parentElementId: 'fan2' },
  { id: 'common', itemCode: 'mono_общие', equipType: 'МОНОБЛОК' },
  { id: 'orphan', itemCode: 'orphan', equipType: 'СЕКЦИЯ', parentElementId: 'missing' },
  { id: 'cycle-a', itemCode: 'cycle-a', equipType: 'СЕКЦИЯ', parentElementId: 'cycle-b' },
  { id: 'cycle-b', itemCode: 'cycle-b', equipType: 'СЕКЦИЯ', parentElementId: 'cycle-a' },
  { id: 'cycle-child', itemCode: 'cycle-child', equipType: 'ДАТЧИК', parentElementId: 'cycle-a' },
];
let failed = 0;
const ok = (name: string, condition: boolean, detail?: unknown) => condition
  ? console.log('  ✓', name)
  : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail)));

const tree = buildUnitSchematic(items, order);
const allTree = [...tree.roots, ...tree.unassigned.map(({ node }) => node)];
const flatten = (nodes: typeof allTree): string[] => nodes.flatMap(({ item, children }) => [item.id, ...flatten(children)]);
const ids = flatten(allTree);
const node = (id: string) => [...tree.roots, ...tree.unassigned.map(({ node: root }) => root)]
  .flatMap(function walk(current): typeof current[] { return [current, ...current.children.flatMap(walk)]; })
  .find((current) => current.item.id === id);

ok('служебные строки не попали в физическое дерево', tree.physicalCount === 12 && !ids.includes('unit') && !ids.includes('common'), [tree.physicalCount, ids]);
ok('на основной линии только корни в SECTION_ORDER', tree.roots.map(({ item }) => item.id).join(',') === 'valve,fan2,fan1', tree.roots.map(({ item }) => item.id));
ok('две ветви клапана содержат оба привода', node('valve')?.children.map(({ item }) => item.id).sort().join(',') === 'drive1,drive2', node('valve')?.children);
ok('двигатель и датчик остаются под своим вентилятором', node('fan1')?.children[0]?.item.id === 'motor1' && node('motor1')?.children[0]?.item.id === 'sensor');
ok('позиция с потерянным родителем видна в отдельной группе', tree.unassigned.some(({ node: root, reason }) => root.item.id === 'orphan' && reason === 'missing-parent'));
ok('цикл разомкнут в отдельной ветви без потери участников', tree.unassigned.some(({ node: root, reason }) => reason === 'cycle' && root.item.id.startsWith('cycle-')) && ids.includes('cycle-a') && ids.includes('cycle-b'));
ok('каждая физическая позиция показана ровно один раз', ids.length === tree.physicalCount && new Set(ids).size === ids.length && items.filter((item) => item.itemCode !== '__unit__' && !item.itemCode.endsWith('_общие')).every((item) => ids.includes(item.id)), [ids.length, new Set(ids).size, ids]);

const tagItems = [
  { id: 'tag-owner', itemCode: 'owner', equipType: 'СЕКЦИЯ', tags: [{ id: 'owner-tag' }] },
  { id: 'tag-child', itemCode: 'child', equipType: 'ДВИГАТЕЛЬ', tags: [{ id: 'child-tag', metadata: { parentId: 'owner-tag' } }] },
  { id: 'tag-orphan', itemCode: 'orphan-tag', equipType: 'ПРИВОД', tags: [{ id: 'orphan-child-tag', metadata: JSON.stringify({ parentId: 'absent-tag' }) }] },
  { id: 'tag-parent-a', itemCode: 'parent-a', equipType: 'СЕКЦИЯ', tags: [{ id: 'parent-a-tag' }] },
  { id: 'tag-parent-b', itemCode: 'parent-b', equipType: 'СЕКЦИЯ', tags: [{ id: 'parent-b-tag' }] },
  { id: 'tag-conflict', itemCode: 'conflict', equipType: 'ПРИВОД', tags: [
    { id: 'conflict-tag-a', metadata: { parentId: 'parent-a-tag' } },
    { id: 'conflict-tag-b', metadata: JSON.stringify({ parentId: 'parent-b-tag' }) },
  ] },
  { id: 'tag-self', itemCode: 'self', equipType: 'СЕКЦИЯ', tags: [
    { id: 'self-parent-tag' }, { id: 'self-child-tag', metadata: { parentId: 'self-parent-tag' } },
  ] },
  { id: 'tag-explicit', itemCode: 'explicit', equipType: 'ПРИВОД', parentElementId: 'tag-owner', tags: [{ id: 'explicit-tag', metadata: { parentId: 'parent-a-tag' } }] },
];
const displayItems = displayParentLinks(tagItems);
const tagTree = buildUnitSchematic(tagItems, order);
const tagRoots = [...tagTree.roots, ...tagTree.unassigned.map(({ node }) => node)];
const findTagNode = (id: string) => tagRoots.flatMap(function walk(current): typeof current[] {
  return [current, ...current.children.flatMap(walk)];
}).find((current) => current.item.id === id);
ok('родительский тег создаёт ветвь при пустом parentElementId', displayItems.find((item) => item.id === 'tag-child')?.parentElementId === 'tag-owner' && findTagNode('tag-owner')?.children.some(({ item }) => item.id === 'tag-child'));
ok('ссылка на отсутствующий родительский тег уходит в нераспределённые', displayItems.find((item) => item.id === 'tag-orphan')?.parentElementId === 'tag-parent:absent-tag' && tagTree.unassigned.some(({ node }) => node.item.id === 'tag-orphan'));
ok('разные владельцы родительских тегов помечаются неоднозначными', displayItems.find((item) => item.id === 'tag-conflict')?.parentElementId === 'tag-ambiguous:tag-conflict' && tagTree.unassigned.some(({ node }) => node.item.id === 'tag-conflict'));
ok('родительский тег на той же позиции не создаёт самоссылку', !displayItems.find((item) => item.id === 'tag-self')?.parentElementId && tagTree.roots.some(({ item }) => item.id === 'tag-self'));
ok('явная связь позиции сильнее metadata родительского тега', displayItems.find((item) => item.id === 'tag-explicit')?.parentElementId === 'tag-owner');
ok('восстановление связей не меняет исходные позиции', tagItems.find((item) => item.id === 'tag-child')?.parentElementId === undefined);

console.log(`\n${failed ? 'Провалено' : 'Все проверки пройдены'}: ${failed}`);
process.exit(failed ? 1 : 0);
