import type { OfficeBinding, OfficePart } from '../src/lib/officeModel';
import { insertOfficeHeaderField, insertOfficeHeaderPart, mergeOfficeHeaderBinding, moveOfficeHeaderPart, removeOfficeHeaderBinding, removeOfficeHeaderPart } from '../src/components/office/officeHeaderEditor';

let passed = 0;
let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) passed++;
  else { failed++; console.error(`✗ ${name}\n  получили: ${JSON.stringify(got)}\n  ожидалось: ${JSON.stringify(want)}`); }
}

const binding = (sourceId: string, fieldKey: string): OfficeBinding => ({
  sourceId, fieldKey, entityType: 'element', entityId: null, sourceRevision: 'r1', anchorId: 'a1',
});
const first = binding('equipment', 'tag');
const second = binding('equipment', 'name');
const original: OfficePart[] = [
  { kind: 'text', text: 'Тег: ' },
  { kind: 'field', binding: first },
  { kind: 'text', text: ' · ' },
];

eq('поле вставляется в выбранное место последовательности', insertOfficeHeaderField(original, 2, second).map((part) => part.kind), ['text', 'field', 'field', 'text']);
eq('текст и оператор можно вставить между защищёнными полями', insertOfficeHeaderPart(original, 2, { kind: 'operator', operator: '+' }).map((part) => part.kind), ['text', 'field', 'operator', 'text']);
eq('перемещение сохраняет порядок соседнего текста и поля', moveOfficeHeaderPart(original, 2, 1).map((part) => part.kind), ['text', 'text', 'field']);
eq('удаление обычной части не трогает остальные', removeOfficeHeaderPart(original, 1).map((part) => part.kind), ['text', 'text']);
eq('недопустимая перестановка сохраняет исходный массив', moveOfficeHeaderPart(original, 0, 9), original);
const merged = mergeOfficeHeaderBinding(original, 1, second);
eq('объединение меняет только позицию выбранного поля', merged.map((part) => part.kind), ['text', 'union', 'text']);
eq('объединение сохраняет приоритеты по порядку добавления', merged[1], { kind: 'union', mode: 'first-match', alternatives: [{ ...first, priority: 0 }, { ...second, priority: 1 }] });
eq('повторное объединение той же привязки не меняет порядок', mergeOfficeHeaderBinding(merged, 1, second), merged);

const union: OfficePart = { kind: 'union', mode: 'first-match', alternatives: [
  { ...first, priority: 0 }, { ...second, priority: 1 },
] };
const unionParts: OfficePart[] = [{ kind: 'text', text: 'Значение: ' }, union, { kind: 'text', text: ' шт.' }];
const oneLeft = removeOfficeHeaderBinding(unionParts, 1, first);
eq('удаление альтернативы сохраняет оставшееся поле и соседний текст', oneLeft.map((part) => part.kind), ['text', 'field', 'text']);
eq('оставшееся поле теряет приоритет объединения', oneLeft[1], { kind: 'field', binding: second });
eq('удаление другой альтернативы также сохраняет объединение и окружающий текст', removeOfficeHeaderBinding(unionParts, 1, second).map((part) => part.kind), ['text', 'field', 'text']);
eq('удаление связывания из другого источника не меняет схему', removeOfficeHeaderBinding(unionParts, 1, binding('tags', 'name')), unionParts);
eq('удаление объединения сохраняет обычный текст до и после него', removeOfficeHeaderPart(unionParts, 1), [{ kind: 'text', text: 'Значение: ' }, { kind: 'text', text: ' шт.' }]);

console.log(`\n${passed} проверок пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
