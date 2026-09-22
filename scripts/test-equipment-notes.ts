/**
 * Примечания расчёта: кому принадлежат теги и что делать с расхождениями.
 *
 * Формулировки взяты из настоящего файла заказчика — того самого, где впервые
 * появились «Таг-номер вентилятор …, …» и три тега привода при двух приводах.
 * Синтетика здесь была бы бесполезна: разбор писался под эти строки.
 *
 * Запуск: npx tsx scripts/test-equipment-notes.ts
 */

import { byTagOrder, compareTags, distribute, splitNote, tagPhrasesOf, type TagSlot } from '../equipment/notes';
import { roleByWord, roleFits } from '../equipment/roles';
import { tagPolicyOf } from '../equipment/tagPolicy';

let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d))));

const policy = tagPolicyOf({ prefixes: ['3700'], allowCyrillic: false });

const FAN_NOTE = '"Таг-номер вентилятор 3700-B01-BL-001A, 3700-B01-BL-002A"';
const VALVE_NOTE = '"Класс уровня протечки по CEN EN 1751 - 3","Клапан ГЕРМИК-С заменить на клапан КЕДР-С",'
  + '"Таг-номер клапана 3700-B01-DW-001A","Таг-номер привода 3700-B01-DWD-001, 3700-B01-DWD-007, 3700-B01-DWD-004"';
const FILTER_NOTE = '"Освещение внутри блока не устанавливать","Таг-номер 3700-B01-FA-001A"';

console.log('1. Примечание разбирается на фразы');
{
  ok('фразы в кавычках', splitNote(FILTER_NOTE).length === 2, splitNote(FILTER_NOTE));
  ok('текст без кавычек — одна фраза', splitNote('Просто заметка').length === 1);
  ok('пустое примечание — ничего', splitNote('').length === 0);
  ok('распоряжение производству тегом не становится',
    tagPhrasesOf('"Освещение внутри блока не устанавливать"', policy).length === 0);
}

console.log('\n2. Слово рядом с маркером называет владельца');
{
  const fan = tagPhrasesOf(FAN_NOTE, policy);
  ok('роль — вентилятор', fan[0]?.role === 'ВЕНТИЛЯТОР', fan[0]);
  ok('два тега по порядку',
    fan[0]?.tags.join('|') === '3700-B01-BL-001A|3700-B01-BL-002A', fan[0]?.tags);

  const valve = tagPhrasesOf(VALVE_NOTE, policy);
  ok('из четырёх фраз тег-фразы только две', valve.length === 2, valve.map((v) => v.role));
  ok('клапан отделён от привода',
    valve[0]?.role === 'КЛАПАН' && valve[1]?.role === 'ПРИВОД', valve.map((v) => v.role));
  ok('у привода три тега', valve[1]?.tags.length === 3, valve[1]?.tags);
  ok('«Клапан ГЕРМИК-С заменить…» тег-фразой не считается',
    valve.every((v) => !v.phrase.text.includes('заменить')), valve.map((v) => v.phrase.text));

  const plain = tagPhrasesOf(FILTER_NOTE, policy);
  ok('без слова роли — тег самого блока', plain[0]?.role === '', plain[0]);
  ok('падежи узнаются по основе',
    roleByWord('клапана') === 'КЛАПАН' && roleByWord('привода') === 'ПРИВОД'
    && roleByWord('вентилятор') === 'ВЕНТИЛЯТОР' && roleByWord('электродвигателя') === 'ДВИГАТЕЛЬ');
}

console.log('\n3. Два вентилятора — два тега по порядку');
{
  const slots: TagSlot[] = [
    { key: 'fan1', role: 'ВЕНТИЛЯТОР', order: 1, instanceNo: 1, title: 'Вентилятор ВОСК62-100 №1' },
    { key: 'fan2', role: 'ВЕНТИЛЯТОР', order: 2, instanceNo: 2, title: 'Вентилятор ВОСК62-100 №2' },
  ];
  const res = distribute(FAN_NOTE, slots, policy);
  ok('оба тега назначены', res.assignments.every((a) => a.verdict === 'assigned'), res.assignments);
  ok('первый тег — первому вентилятору',
    res.assignments[0].identifier === '3700-B01-BL-001A' && res.assignments[0].slotKey === 'fan1');
  ok('второй — второму',
    res.assignments[1].identifier === '3700-B01-BL-002A' && res.assignments[1].slotKey === 'fan2');
  ok('позиций без тега не осталось', res.untagged.length === 0);
}

console.log('\n4. Три тега привода при двух приводах — расхождение, а не догадка');
{
  const slots: TagSlot[] = [
    { key: 'valve', role: 'КЛАПАН', order: 1, title: 'Клапан ГЕРМИК-С' },
    { key: 'act1', role: 'ПРИВОД', order: 2, instanceNo: 1, title: 'Электропривод SF24-S2 №1' },
    { key: 'act2', role: 'ПРИВОД', order: 3, instanceNo: 2, title: 'Электропривод SF24-S2 №2' },
  ];
  const res = distribute(VALVE_NOTE, slots, policy);
  const assigned = res.assignments.filter((a) => a.verdict === 'assigned');
  const leftover = res.assignments.filter((a) => a.verdict === 'no-slot');
  ok('клапан и два привода получили теги', assigned.length === 3, assigned.map((a) => a.slotKey));
  ok('третий тег привода остался без позиции', leftover.length === 1, leftover);
  ok('и это сказано словами, а не молчанием',
    /больше, чем позиций/.test(leftover[0]?.why || ''), leftover[0]?.why);
  ok('лишний тег не прилепился к клапану',
    assigned.find((a) => a.slotKey === 'valve')?.identifier === '3700-B01-DW-001A');
}

console.log('\n5. Позиции без тега и запрещённые написания');
{
  const slots: TagSlot[] = [
    { key: 'fan1', role: 'ВЕНТИЛЯТОР', order: 1, instanceNo: 1 },
    { key: 'fan2', role: 'ВЕНТИЛЯТОР', order: 2, instanceNo: 2 },
  ];
  const one = distribute('"Таг-номер вентилятор 3700-B01-BL-001A"', slots, policy);
  ok('второму вентилятору тега не досталось', one.untagged.length === 1 && one.untagged[0].key === 'fan2');

  const cyr = distribute('"Таг-номер вентилятор 3700-B01-BL-001В"', slots, policy);
  ok('кириллица отклонена', cyr.assignments[0].verdict === 'invalid', cyr.assignments[0]);
  ok('и предложено исправление', cyr.assignments[0].fix === '3700-B01-BL-001B', cyr.assignments[0].fix);
  ok('ни одна позиция при этом не занята', cyr.untagged.length === 2);

  const nobody = distribute('"Таг-номер двигателя 3700-B01-MT-001A"', slots, policy);
  ok('роли нет в блоке — сказано, что позиции нет',
    nobody.assignments[0].verdict === 'no-slot' && /позиции с ролью/i.test(nobody.assignments[0].why),
    nobody.assignments[0]);
}

console.log('\n6. Свидетельства и иерархия ролей');
{
  const slots: TagSlot[] = [{ key: 'filter', role: 'БЛОК', order: 1 }];
  const res = distribute(FILTER_NOTE, slots, policy);
  ok('видно, из какой фразы взят тег',
    res.assignments[0].evidence.text.includes('Таг-номер 3700-B01-FA-001A'), res.assignments[0].evidence);
  ok('двигатель помещается в вентилятор', roleFits('ВЕНТИЛЯТОР', 'ДВИГАТЕЛЬ'));
  ok('привод — в клапан', roleFits('КЛАПАН', 'ПРИВОД'));
  ok('датчик помещается куда угодно', roleFits('ДВИГАТЕЛЬ', 'ДАТЧИК') && roleFits('ПРИВОД', 'ДАТЧИК'));
  ok('вентилятор в двигатель не помещается', !roleFits('ДВИГАТЕЛЬ', 'ВЕНТИЛЯТОР'));
}

console.log('\n7. Порядок по тегу — как читает инженер');
{
  ok('001A раньше 002A', compareTags('3700-B01-001A', '3700-B01-002A') < 0);
  ok('9 раньше 10, а не наоборот', compareTags('3700-B01-9', '3700-B01-10') < 0);
  ok('регистр не мешает', compareTags('ahu-1', 'AHU-1') === 0);
  const sorted = byTagOrder([
    { tag: '3700-B01-010A', order: 1 },
    { tag: '', order: 2 },
    { tag: '3700-B01-002A', order: 3 },
    { tag: '3700-B01-001A', order: 4 },
  ]);
  ok('по алфавиту, без тега — в конец',
    sorted.map((s) => s.tag).join('|') === '3700-B01-001A|3700-B01-002A|3700-B01-010A|', sorted);
}

console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(f ? 1 : 0);
