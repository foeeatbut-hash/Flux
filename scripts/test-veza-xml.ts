/**
 * Разбор выгрузки САПР вентиляционного оборудования.
 *
 * Главное здесь — граница. В настоящем файле сорок тысяч узлов, и почти все
 * они про производство: отверстия с координатами, профили, краска, заклёпки.
 * Разбор, который спустится ниже блока, завалит реестр оборудования мусором, и
 * заметят это не сразу, а когда инженер откроет спецификацию. Поэтому проверка
 * «ниже блока не спускаемся» стоит здесь наравне с тем, что данные вообще
 * доехали.
 *
 * Второе по важности — честность словаря. Кода, которого словарь не знает,
 * быть названным не должно: выдуманное имя параметра инженер примет за факт и
 * подставит в расчёт.
 *
 * Запуск: npx tsx scripts/test-veza-xml.ts
 */

import { VEZA_SAMPLE_XML, PLAIN_EQUIPMENT_XML } from './fixtures/veza';
import { looksLikeVezaXml, parseVezaXml } from '../server/vezaXml';
import { parseEquipmentXML, detectEquipType } from '../server/equipmentParser';
import { vezaGroup, vezaProp, vezaUnit } from '../server/vezaDict';
import type { ParsedBlock, ParsedUnit, SpecGroup } from '../server/equipmentParser';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

/** Все параметры узла одной плоской картой «раздел||ключ» → значение с единицей. */
const flat = (groups: SpecGroup[]) => {
  const map = new Map<string, string>();
  for (const g of groups) for (const p of g.params) map.set(`${g.title}||${p.key}`, `${p.value}${p.unit ? ' ' + p.unit : ''}`);
  return map;
};

const parse = () => parseVezaXml(VEZA_SAMPLE_XML, detectEquipType);

console.log('1. Формат узнаётся по существу, а не по имени файла');
{
  ok('выгрузка САПР узнаётся', looksLikeVezaXml(VEZA_SAMPLE_XML));
  ok('обычный XML расчёта за выгрузку не принимается', !looksLikeVezaXml(PLAIN_EQUIPMENT_XML));
  ok('пустая строка не узнаётся', !looksLikeVezaXml(''));
  // <Elements> без cfnElement бывает у кого угодно — одного корня мало
  ok('одного <Elements> недостаточно', !looksLikeVezaXml('<Root><Elements><a x="1"/></Elements></Root>'));

  // Общий вход сам выбирает движок, и старый разбор при этом не сломан
  const plain = parseEquipmentXML(PLAIN_EQUIPMENT_XML);
  ok('обычный расчёт по-прежнему разбирается старым движком',
    plain.units.length === 1 && plain.units[0].name === 'П-1', plain.units.map(u => u.name));
  const cad = parseEquipmentXML(VEZA_SAMPLE_XML);
  ok('выгрузка САПР доезжает через общий вход', cad.units.length === 2, cad.units.length);
}

console.log('\n2. Установка: имя — это обозначение по проекту');
{
  const r = parse();
  const [first, second] = r.units as ParsedUnit[];

  // Обозначение установки — её адрес в документации. Именно оно должно стать
  // именем и тегом, иначе привязка к уже заведённому тегу не сработает
  ok('имя установки — обозначение по проекту', first.name === 'ПР-01-AS-001', first.name);
  ok('заголовок — типоразмер', first.title === 'ПРОБА-100-200-01-УХЛ4', first.title);
  ok('обозначение стало тегом', JSON.stringify(first.tags) === '["ПР-01-AS-001"]', first.tags);

  // В настоящих выгрузках две установки из двадцати пяти идут без обозначения.
  // Выдумывать его нельзя, но и слить обе в одну строку нельзя тем более
  ok('без обозначения имя берётся от папки', second.name === 'Установка 2', second.name);
  ok('без обозначения тегов нет', (second.tags || []).length === 0, second.tags);
  ok('имена установок не совпали', first.name !== second.name);
}

console.log('\n3. Параметры заказа доезжают до каждой установки');
{
  const r = parse();
  for (const u of r.units) {
    const m = flat(u.groups);
    ok(`«${u.name}»: номер заказа на месте`, m.get('Заказ||Номер заказа') === '000000000-ПРБ', [...m.keys()].slice(0, 4));
    ok(`«${u.name}»: объект на месте`, m.get('Заказ||Объект') === 'Пробный объект');
  }
  const own = flat(r.units[0].groups);
  ok('свои параметры установки тоже на месте', own.get('Характеристики установки||Расход воздуха') === '5000 м³/ч',
    own.get('Характеристики установки||Расход воздуха'));
}

console.log('\n4. Моноблок и блоки');
{
  const r = parse();
  const mb = r.units[0].monoblocks[0];
  ok('моноблок один', r.units[0].monoblocks.length === 1, r.units[0].monoblocks.length);
  ok('имя моноблока от папки', mb.name === 'Моноблок 1', mb.name);

  // Свои параметры моноблока кладутся служебной строкой «_общие» — тот же
  // уговор, что у разбора Excel. Разойдись они, выгрузка в Excel поедет
  const general = mb.blocks.find(b => b.name.endsWith('_общие'));
  ok('у моноблока есть строка «_общие»', !!general, mb.blocks.map(b => b.name));
  ok('в ней собственные параметры моноблока',
    flat(general!.groups).get('Моноблок||Масса') === '300 кг', flat(general!.groups).get('Моноблок||Масса'));
  ok('строка «_общие» помечена как моноблок', general!.equipType === 'МОНОБЛОК', general!.equipType);

  const blocks = mb.blocks.filter(b => !b.name.endsWith('_общие')) as ParsedBlock[];
  ok('блоков два', blocks.length === 2, blocks.map(b => b.name));
  ok('код блока — позиция', blocks[0].name === '1.1' && blocks[1].name === '1.2', blocks.map(b => b.name));
  ok('название блока — из параметра, без приставки «Блок 1.1»',
    blocks[0].title === 'Блок воздухоприемный(один горизонтальный клапан)', blocks[0].title);

  // Блок воздухоприёмный — воздухоприёмный, хотя в названии есть слово «клапан»
  ok('вид блока определён по существу названия', blocks[0].equipType === 'ВОЗДУХОПРИЁМНЫЙ', blocks[0].equipType);
  ok('фильтр определён фильтром', blocks[1].equipType === 'ФИЛЬТР', blocks[1].equipType);
  ok('у второго блока свои параметры',
    flat(blocks[1].groups).get('Фильтр||Класс фильтрации') === 'G4');
}

console.log('\n5. Ниже блока не спускаемся');
{
  const r = parse();
  const everything = JSON.stringify(r);
  // В настоящей выгрузке этого добра сорок тысяч узлов. Попади оно в реестр —
  // им нельзя будет пользоваться, и виновата будет не выгрузка, а разбор
  ok('отверстий в результате нет', !everything.includes('Отверстие'), 'нашлось «Отверстие»');
  ok('панелей корпуса нет', !everything.includes('Панель боковая'), 'нашлась «Панель боковая»');
  ok('материалов нет', !everything.includes('Прокат'), 'нашёлся «Прокат»');
  ok('внутреннего каркаса нет', !everything.includes('Внутренний каркас'));

  // Ни один блок не должен обзавестись детьми: ParsedBlock их не имеет вовсе,
  // но параметры могли бы просочиться из нижних узлов
  const blocks = r.units.flatMap(u => u.monoblocks.flatMap(m => m.blocks));
  const keys = blocks.flatMap(b => [...flat(b.groups).keys()]);
  ok('в параметрах блоков нет производственных ключей',
    !keys.some(k => /отверст|прокат|заклёп|заклеп/i.test(k)), keys.filter(k => /отверст|прокат/i.test(k)));
}

console.log('\n6. Единицы переведены в обозначения программы');
{
  ok('unCubicMeterPerHour → м³/ч', vezaUnit('unCubicMeterPerHour') === 'м³/ч', vezaUnit('unCubicMeterPerHour'));
  ok('unDecibelA → дБ(А)', vezaUnit('unDecibelA') === 'дБ(А)', vezaUnit('unDecibelA'));
  ok('unKiloVoltAmper → кВ·А', vezaUnit('unKiloVoltAmper') === 'кВ·А', vezaUnit('unKiloVoltAmper'));
  ok('unNone — пусто, а не «unNone»', vezaUnit('unNone') === '');

  // unPiece2 стоит у безразмерных: K-фактор, доля, отношение. «шт» здесь было
  // бы враньём, которое уедет в спецификацию
  ok('unPiece2 — безразмерная, не «шт»', vezaUnit('unPiece2') === '', vezaUnit('unPiece2'));
  ok('unPiece — «шт»', vezaUnit('unPiece') === 'шт');
  ok('незнакомая единица остаётся как есть', vezaUnit('unЧтоТоНовое') === 'unЧтоТоНовое');

  const m = flat(parse().units[0].groups);
  ok('единица доехала до параметра', m.get('Шум||Уровень звуковой мощности на выходе, дБ(А)') === '74.5 дБ(А)',
    m.get('Шум||Уровень звуковой мощности на выходе, дБ(А)'));
  ok('безразмерное осталось без единицы', m.get('Вентилятор||K-фактор') === '470', m.get('Вентилятор||K-фактор'));
}

console.log('\n7. Словарь не выдумывает');
{
  ok('знакомый параметр назван', vezaProp('ptgBLOCK', 'ptMASS').title === 'Масса');
  ok('знакомый параметр помечен опознанным', vezaProp('ptgBLOCK', 'ptMASS').known);

  // Вот ради чего всё: код, которого словарь не знает, остаётся кодом
  const unknown = vezaProp('ptgCARCASS', 'ptRact');
  ok('незнакомый параметр остаётся кодом', unknown.title === 'ptRact', unknown.title);
  ok('незнакомый параметр помечен неопознанным', !unknown.known);

  ok('знакомая группа названа', vezaGroup('ptgCOILS') === 'Теплообменник');
  ok('незнакомая группа остаётся кодом', vezaGroup('ptgНЕИЗВЕСТНО') === 'ptgНЕИЗВЕСТНО', vezaGroup('ptgНЕИЗВЕСТНО'));

  const m = flat(parse().units[0].groups);
  ok('незнакомая группа доехала под своим кодом целиком',
    m.get('ptgНЕИЗВЕСТНО||ptЧтоТо') === '42', [...m.keys()].filter(k => k.startsWith('ptg')));

  const block = parse().units[0].monoblocks[0].blocks.find(b => b.name === '1.1')!;
  ok('незнакомый код виден в параметрах блока',
    flat(block.groups).get('Каркас||ptRact') === '70x50x1,0 ОЦ', [...flat(block.groups).keys()]);
}

console.log('\n8. Нумерованные группы клапана берут названия базовой');
{
  // Клапанов в блоке бывает несколько: ptgVARCONN, ptgVARCONN1, ptgVARCONN2 —
  // с теми же параметрами. Дублировать таблицу нечестно: разойдётся при первой
  // же правке
  ok('ptgVARCONN2.ptACTUATOR назван', vezaProp('ptgVARCONN2', 'ptACTUATOR').title === 'Электропривод');
  ok('и помечен опознанным', vezaProp('ptgVARCONN2', 'ptACTUATOR').known);
  ok('но раздел остаётся своим', vezaGroup('ptgVARCONN2') === 'Клапан 2', vezaGroup('ptgVARCONN2'));

  const block = parse().units[0].monoblocks[0].blocks.find(b => b.name === '1.1')!;
  ok('второй клапан приехал отдельным разделом',
    flat(block.groups).get('Клапан 2||Электропривод') === 'ПР24-С', [...flat(block.groups).keys()]);
}

console.log('\n9. Повторы параметров');
{
  const block = parse().units[0].monoblocks[0].blocks.find(b => b.name === '1.1')!;
  const dpa = (block.groups.find(g => g.title === 'Блок')?.params || [])
    .filter(p => p.key.startsWith('Аэродинамическое сопротивление'));

  // Потерять одно из двух расчётных значений хуже, чем показать оба
  ok('повтор с другим значением сохранён вторым ключом', dpa.length === 2, dpa);
  ok('значения оба на месте',
    dpa.map(p => p.value).sort().join(',') === '30,45', dpa.map(p => p.value));
  ok('второй ключ пронумерован',
    dpa.some(p => p.key === 'Аэродинамическое сопротивление (2)'), dpa.map(p => p.key));
}

console.log('\n10. Кривой файл не роняет импорт');
{
  ok('пустая строка — пустой результат', parseVezaXml('', detectEquipType).units.length === 0);
  ok('не XML вовсе — пустой результат', parseVezaXml('просто текст', detectEquipType).units.length === 0);
  ok('корень есть, дерева нет — пустой результат',
    parseVezaXml('<Root><Elements><N1 cfnElement="cadOrderFolder"/></Elements></Root>', detectEquipType).units.length === 0);
  ok('дерево есть, словаря нет — пустой результат',
    parseVezaXml('<Root><Structure><N1 cfnAmount="1"/></Structure></Root>', detectEquipType).units.length === 0);

  // Общий вход при неудаче нового движка обязан отдать управление старому,
  // а не отказать: файл мог быть обычным расчётом с похожим корнем
  const mixed = parseEquipmentXML('<Root><Elements/><Structure/></Root>');
  ok('общий вход не падает на обрубке', Array.isArray(mixed.units) && mixed.units.length === 0, mixed);
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
