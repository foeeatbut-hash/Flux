/**
 * Regression coverage for collaboration manifest work.
 *
 * Translation placeholders use private-use Unicode characters. Those same
 * characters can occur in legitimate source text, so an independent expected
 * value must survive protect/restore even beside protected engineering data.
 */
import { protect, restore } from '../src/translate/protect';

let failed = 0;
const check = (name: string, condition: boolean, got?: unknown) => {
  if (condition) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const literalSlots = String.fromCharCode(0xe010, 0xe011, 0xe5ff);
const source = `Обозначение ${literalSlots}; тег AHU-01; формула =SUM(B2:B4); размер Ø108×4.`;
const expected = `Обозначение ${literalSlots}; тег AHU-01; формула =SUM(B2:B4); размер Ø108×4.`;
const protectedText = protect(source);

check('тег и размер вынуты из текста',
  protectedText.slots.includes('AHU-01') && protectedText.slots.includes('Ø108×4'),
  protectedText.slots);
check('буквальные private-use знаки переживают восстановление рядом с данными',
  restore(protectedText.masked, protectedText.slots) === expected,
  restore(protectedText.masked, protectedText.slots));
check('формула остаётся посимвольно прежней',
  restore(protectedText.masked, protectedText.slots).includes('=SUM(B2:B4)'),
  restore(protectedText.masked, protectedText.slots));
const once = restore(protectedText.masked, protectedText.slots);
check('повторное восстановление не меняет восстановленный текст',
  restore(once, protectedText.slots) === expected,
  restore(once, protectedText.slots));

const serialized = JSON.parse(JSON.stringify(protectedText)) as typeof protectedText;
const serializedResult = restore(serialized.masked, serialized.slots, serialized.markers);
check('JSON round-trip Protected сохраняет маркеры, private-use знаки, тег и формулу',
  serializedResult === expected,
  serializedResult);

console.log(failed ? `\nПровалено: ${failed}` : '\nПроверка восстановления текста пройдена');
process.exit(failed ? 1 : 0);
