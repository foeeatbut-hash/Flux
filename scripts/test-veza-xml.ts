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
  ok('имя установки — обозначение по проекту', first.name === 'PR-01-AS-001', first.name);
  ok('заголовок — типоразмер', first.title === 'ПРОБА-100-200-01-УХЛ4', first.title);
  ok('обозначение стало тегом', JSON.stringify(first.tags) === '["PR-01-AS-001"]', first.tags);

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

  // Сами блоки — строки с ролью БЛОК; подпозиции лежат в том же списке и
  // отличаются заполненным `parentName`
  const blocks = mb.blocks.filter(b => !b.name.endsWith('_общие') && b.role === 'БЛОК') as ParsedBlock[];
  ok('блоков три', blocks.length === 3, blocks.map(b => b.name));
  ok('код блока — позиция', blocks.map(b => b.name).join(',') === '1.1,1.2,1.3', blocks.map(b => b.name));
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

  // Внутрь блока разбор спускается только по белому списку видов. Материал с
  // дробным количеством позицией не становится: 383 метра уплотнителя — это
  // погонаж, а не «383 штуки оборудования»
  ok('уплотнитель не стал позицией', !everything.includes('Уплотнитель D-профиль'));

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

console.log('\n11. Подпозиции: оборудование внутри блока');
{
  const r = parse();
  const all = r.units[0].monoblocks[0].blocks as ParsedBlock[];
  const by = (name: string) => all.find(b => b.name === name);

  // Клапан и два его привода. Приводов именно два: `cfnAmount="2"` — это два
  // изделия, каждое со своим тегом, а не строка спецификации с числом
  ok('клапан стал позицией внутри блока', !!by('1.1/клапан1'), all.map(b => b.name));
  ok('у клапана роль КЛАПАН', by('1.1/клапан1')?.role === 'КЛАПАН', by('1.1/клапан1')?.role);
  ok('владелец клапана — блок', by('1.1/клапан1')?.parentName === '1.1', by('1.1/клапан1')?.parentName);
  // Из расчёта приводов два; третий завёл лишний тег примечания (раздел 12)
  ok('приводов из расчёта два',
    all.filter(b => b.role === 'ПРИВОД' && b.sourceKind !== 'note').length === 2,
    all.filter(b => b.role === 'ПРИВОД').map(b => `${b.name}:${b.sourceKind}`));
  ok('владелец привода — клапан, а не блок',
    by('1.1/клапан1/привод2')?.parentName === '1.1/клапан1', by('1.1/клапан1/привод2')?.parentName);
  ok('у одинаковых экземпляров номер в названии',
    by('1.1/клапан1/привод2')?.title.endsWith('№2'), by('1.1/клапан1/привод2')?.title);

  // Два вентилятора — две позиции, у каждой свой двигатель. Количество
  // двигателей в файле тоже «2», но это ДВА НА ДВА, по одному на вентилятор:
  // не поделив, разбор завёл бы четыре мотора
  const fans = all.filter(b => b.role === 'ВЕНТИЛЯТОР');
  ok('вентиляторов два', fans.length === 2, fans.map(b => b.name));
  ok('двигателей два, а не четыре', all.filter(b => b.role === 'ДВИГАТЕЛЬ').length === 2,
    all.filter(b => b.role === 'ДВИГАТЕЛЬ').map(b => b.name));
  ok('у каждого вентилятора свой двигатель',
    by('1.3/вентилятор1/двигатель1')?.parentName === '1.3/вентилятор1'
    && by('1.3/вентилятор2/двигатель1')?.parentName === '1.3/вентилятор2');
  ok('номер экземпляра сохранён', by('1.3/вентилятор2')?.instanceNo === 2, by('1.3/вентилятор2')?.instanceNo);
  ok('сколько всего экземпляров — тоже', by('1.3/вентилятор2')?.instanceCount === 2);

  // «Вентилятор ПРОБА62-100-01500…» и «Вентилятор ПРОБА62-100» внутри него —
  // один вентилятор, записанный дважды. Вторая позиция удвоила бы реестр
  ok('типоразмер не стал вторым вентилятором',
    !all.some(b => b.title.startsWith('Вентилятор ПРОБА62-100 ') || b.title === 'Вентилятор ПРОБА62-100'),
    all.filter(b => b.role === 'ВЕНТИЛЯТОР').map(b => b.title));

  // Параметры подпозиции — из разделов коллекции блока: своих у неё нет
  ok('двигатель получил свой раздел',
    flat(by('1.3/вентилятор1/двигатель1')!.groups).get('Электродвигатель||Номинальная мощность') === '15 кВт',
    [...flat(by('1.3/вентилятор1/двигатель1')!.groups).keys()]);
  ok('вентилятору достался раздел вентилятора',
    flat(by('1.3/вентилятор1')!.groups).get('Вентилятор||K-фактор') === '470',
    [...flat(by('1.3/вентилятор1')!.groups).keys()]);
  ok('чужого раздела двигателю не досталось',
    !flat(by('1.3/вентилятор1/двигатель1')!.groups).has('Вентилятор||K-фактор'));
  ok('у блока разделы остались на месте',
    flat(by('1.3')!.groups).has('Электродвигатель||Номинальная мощность') && flat(by('1.3')!.groups).has('Вентилятор||K-фактор'));

  // Незнакомый вид не пропадает молча и не выдумывается
  ok('незнакомый вид назван', (r.unknownKinds || []).includes('cadSteamHumidifier'), r.unknownKinds);
  ok('незнакомый вид позицией не стал', !all.some(b => b.title.includes('Увлажнитель паровой')));
}

console.log('\n12. Теги примечания раздаются по порядку');
{
  const all = parse().units[0].monoblocks[0].blocks as ParsedBlock[];
  const by = (name: string) => all.find(b => b.name === name);

  ok('тег клапана ушёл клапану', JSON.stringify(by('1.1/клапан1')?.tags) === '["PR-01-DW-001A"]', by('1.1/клапан1')?.tags);
  ok('блоку тег клапана не достался', !(by('1.1')?.tags || []).includes('PR-01-DW-001A'), by('1.1')?.tags);

  // Порядок — единственное правило раздачи: первый тег первой позиции
  ok('первый тег привода — первому приводу',
    JSON.stringify(by('1.1/клапан1/привод1')?.tags) === '["PR-01-DWD-001"]', by('1.1/клапан1/привод1')?.tags);
  ok('второй — второму',
    JSON.stringify(by('1.1/клапан1/привод2')?.tags) === '["PR-01-DWD-007"]', by('1.1/клапан1/привод2')?.tags);

  // Три тега привода при двух приводах: по распоряжению владельца лишний тег
  // заводит третий привод — «если позиции нет, всё создаётся автоматически».
  // Не молча: позиция помечена «по примечанию» и объясняет, откуда взялась
  const third = by('1.1/клапан1/привод3');
  ok('лишний тег завёл третий привод', JSON.stringify(third?.tags) === '["PR-01-DWD-004"]', third);
  ok('он помечен «по примечанию»', third?.sourceKind === 'note', third?.sourceKind);
  ok('стоит в клапане, а не в блоке', third?.parentName === '1.1/клапан1', third?.parentName);
  ok('номер продолжает счёт', /№3$/.test(third?.title || ''), third?.title);
  const born = (third?.tagNotes || [])[0];
  ok('у позиции сказана причина', born?.verdict === 'created' && /по примечанию/.test(born?.why || ''), born);
  ok('видна фраза, из которой он взят', (born?.phrase || '').includes('Таг-номер привода'), born?.phrase);
  ok('на блоке лишнего тега не осталось',
    !(by('1.1')?.tagNotes || []).some(e => e.identifier === 'PR-01-DWD-004'), by('1.1')?.tagNotes);

  // Два вентилятора — два тега подряд, по порядку появления в файле
  ok('вентилятору №1 — первый тег',
    JSON.stringify(by('1.3/вентилятор1')?.tags) === '["PR-01-BL-001A"]', by('1.3/вентилятор1')?.tags);
  ok('вентилятору №2 — второй тег',
    JSON.stringify(by('1.3/вентилятор2')?.tags) === '["PR-01-BL-002A"]', by('1.3/вентилятор2')?.tags);
  ok('двигателю тег вентилятора не достался', !(by('1.3/вентилятор1/двигатель1')?.tags || []).length);

  // Фраза без маркера остаётся обычным примечанием
  ok('примечание не про теги осталось примечанием',
    (by('1.1')?.note || '').includes('Класс уровня протечки'), by('1.1')?.note);
}

console.log('\n13. Модель привода — у привода');
{
  const all = parse().units[0].monoblocks[0].blocks as ParsedBlock[];
  const drive = all.find(b => b.name === '1.1/клапан1/привод1');
  const valve = all.find(b => b.name === '1.1/клапан1');
  const d = flat(drive?.groups || []);
  ok('у привода есть модель', d.get('Привод||Модель') === 'ПР24-С', [...d.entries()]);
  ok('у клапана модель привода осталась',
    [...flat(valve?.groups || []).entries()].some(([k, v]) => /Электропривод/.test(k) && v === 'ПР24-С'),
    [...flat(valve?.groups || []).keys()]);
}

console.log('\n14. Теги по коду проекта — без маркера и в любом месте фразы');
{
  const policy = { allowCyrillic: false, prefixes: ['PR'], masks: [], version: 1 };
  const xml = VEZA_SAMPLE_XML.replace(
    '&quot;Таг-номер вентилятор PR-01-BL-001A, PR-01-BL-002A&quot;',
    '&quot;Вентиляторы PR-01-BL-001A и PR-01-BL-002A, коробка PR-01-JB-001&quot;',
  );
  const all = parseVezaXml(xml, detectEquipType, { policy }).units[0].monoblocks[0].blocks as ParsedBlock[];
  const by = (name: string) => all.find(b => b.name === name);
  ok('без «Таг-номер» тег вентилятора найден по коду',
    JSON.stringify(by('1.3/вентилятор1')?.tags) === '["PR-01-BL-001A"]', by('1.3/вентилятор1')?.tags);
  ok('второй — второму', JSON.stringify(by('1.3/вентилятор2')?.tags) === '["PR-01-BL-002A"]', by('1.3/вентилятор2')?.tags);
  const box = all.find(b => b.role === 'КОРОБКА');
  ok('клеммная коробка из примечания стала позицией', JSON.stringify(box?.tags) === '["PR-01-JB-001"]', all.map(b => `${b.name}:${b.role}`));
  ok('коробка — «по примечанию»', box?.sourceKind === 'note', box?.sourceKind);

  // Без кода проекта прежнее правило: тег только после маркера
  const bare = parseVezaXml(xml, detectEquipType).units[0].monoblocks[0].blocks as ParsedBlock[];
  ok('без кода проекта фраза без маркера тегов не даёт',
    !(bare.find(b => b.name === '1.3/вентилятор1')?.tags || []).length);
}

console.log('\n15. Опечатка раскладки в обозначении установки');
{
  const policy = { allowCyrillic: false, prefixes: ['PR'], masks: [], version: 1 };
  // Кириллическая «С» в обозначении — так в одиннадцати выгрузках заказчика из двадцати трёх
  const xml = VEZA_SAMPLE_XML.replace('proUnitName="PR-01-AS-001"', 'proUnitName="PR-01-AS-001С"');
  const u = parseVezaXml(xml, detectEquipType, { policy }).units[0] as ParsedUnit;
  ok('обозначение исправлено на латиницу', u.name === 'PR-01-AS-001C', u.name);
  ok('тег установки — исправленный', JSON.stringify(u.tags) === '["PR-01-AS-001C"]', u.tags);
  ok('исправление названо', u.nameFix?.from === 'PR-01-AS-001С' && /С → C/.test(u.nameFix?.what || ''), u.nameFix);
  // Без правил проекта исправляется только смешение алфавитов — оно тут есть
  const loose = parseVezaXml(xml, detectEquipType).units[0] as ParsedUnit;
  ok('смешение алфавитов исправляется и без проекта', loose.name === 'PR-01-AS-001C', loose.name);
}

console.log('\n16. Вид узла, отнесённый к роли человеком');
{
  const r = parseVezaXml(VEZA_SAMPLE_XML, detectEquipType, { kinds: { cadSteamHumidifier: 'УВЛАЖНИТЕЛЬ' } });
  const all = r.units.flatMap(u => u.monoblocks.flatMap(m => m.blocks)) as ParsedBlock[];
  ok('незнакомый вид больше не незнакомый', !(r.unknownKinds || []).includes('cadSteamHumidifier'), r.unknownKinds);
  ok('и приехал позицией', all.some(b => b.role === 'УВЛАЖНИТЕЛЬ'), all.map(b => b.role));
  const skipped = parseVezaXml(VEZA_SAMPLE_XML, detectEquipType, { kinds: { cadSteamHumidifier: 'НЕ_ПОЗИЦИЯ' } });
  ok('«не позиция» просто пропускается', !(skipped.unknownKinds || []).includes('cadSteamHumidifier'), skipped.unknownKinds);
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
