/**
 * Подтверждённые ошибки учёта оборудования.
 *
 * Набор собран по контрольным случаям задания (G01–G27). Проверяются те, что
 * не требуют исходных бланков: синтетические G22–G26 и смысловые правила,
 * ради которых правился словарь. Случаи, привязанные к настоящим документам
 * (S001, S007, S016–S019 и каталоги), здесь НЕ проверяются — самих файлов в
 * переданном архиве нет, и объявлять их пройденными было бы неправдой.
 *
 * Каждая проверка названа тем, что ломалось у человека, а не именем функции:
 * «два привода на клапан не удваивают клапан» понятнее, чем «matchLabel qty».
 *
 * Запуск: npx tsx scripts/test-equipment-model.ts
 */

import { convert, unitInfo, unitInfoFor, unitDimensions } from '../src/import/valueGrammar';
import { matchLabel, EQUIP_TYPES } from '../src/import/dictionary';
import { draftToUnits } from '../src/import/recognize';
import { planTagLinks, normalizeTag } from '../server/equipmentTags';
import {
  equipmentColumns, buildEquipmentExchange, byTag, type ExchangeComponent,
} from '../src/lib/equipmentExchange';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

const item = (over: Partial<ExchangeComponent> = {}): ExchangeComponent => ({
  id: 'i1', itemCode: 'К1', name: 'Вентилятор', equipType: 'fan',
  groups: [], systemName: 'С1', monoblockName: 'M1', ...over,
});

console.log('G22. Разные единицы в одном столбце приводятся к одной');
{
  // Столбец «Расход воздуха, м³/ч» получал 3600 и 1 — и это было одно и то же
  // значение. Ни сложить, ни отсортировать такой столбец нельзя
  const items = [
    item({ id: 'a', groups: [{ title: 'Аэродинамика', params: [{ key: 'Расход воздуха', value: '3600', unit: 'м3/ч' }] }] }),
    item({ id: 'b', groups: [{ title: 'Аэродинамика', params: [{ key: 'Расход воздуха', value: '1', unit: 'м3/с' }] }] }),
  ];
  const cols = equipmentColumns(items);
  const table = buildEquipmentExchange(items, cols);
  const at = cols.findIndex(c => c.key.startsWith('param:'));
  ok('столбец один', cols.filter(c => c.key.startsWith('param:')).length === 1);
  ok('в шапке единица столбца', /м3\/ч/.test(cols[at].label), cols[at].label);
  ok('3600 м³/ч остаётся 3600', table.rows[0][at] === '3600', table.rows[0][at]);
  ok('1 м³/с пересчитан в 3600', table.rows[1][at] === '3600', table.rows[1][at]);
  ok('нерешаемых мест нет', table.problems.length === 0, table.problems);
}

console.log('\nG22a. Несовместимую величину не выписываем молча');
{
  // кВт и кВА — разные величины. Пересчитать их друг в друга нельзя без
  // коэффициента мощности, и выписать одно вместо другого — ошибка сметы
  const items = [
    item({ id: 'a', groups: [{ title: 'Электрика', params: [{ key: 'Мощность', value: '1.13', unit: 'кВА' }] }] }),
    item({ id: 'b', groups: [{ title: 'Электрика', params: [{ key: 'Мощность', value: '4', unit: 'Вт' }] }] }),
  ];
  const cols = equipmentColumns(items);
  const table = buildEquipmentExchange(items, cols);
  ok('ошибка подготовки названа', table.problems.length === 1, table.problems);
  ok('сказано, что именно не сходится',
    /разные величины/.test(table.problems[0]?.why || ''), table.problems[0]);
  ok('кВт в Вт переводится', convert(1, 'квт', 'вт') === 1000);
  ok('кВА в кВт не переводится', convert(1, 'ква', 'квт') === null);
}

console.log('\nG23. Две независимые установки — два корня');
{
  const items: any[] = [
    { name: 'ВЕРОСА-670 №1', title: 'Установка 1', equipType: 'ahu', fields: [], tags: ['A-001'] },
    { name: 'Фильтр', title: 'Фильтр', equipType: 'filter', fields: [] },
    { name: 'ВЕРОСА-670 №2', title: 'Установка 2', equipType: 'ahu', fields: [], tags: ['A-002'] },
    { name: 'Фильтр', title: 'Фильтр', equipType: 'filter', fields: [] },
  ];
  const units = draftToUnits(items, 'Комплектный бланк');
  ok('корней два, а не один', units.length === 2, units.length);
  ok('у каждого свой тег',
    units[0]?.tags?.[0] === 'A-001' && units[1]?.tags?.[0] === 'A-002',
    units.map(u => u.tags));
  const inFirst = JSON.stringify(units[0]);
  ok('вторая установка не лежит внутри первой', !inFirst.includes('A-002'));
}

console.log('\nG24. Совпадение после приведения — неоднозначность, а не выбор');
{
  const links = planTagLinks(
    [{ key: 'b1', tags: ['AB-01'] }],
    [{ id: 't1', identifier: 'AB-01' }, { id: 't2', identifier: 'AB_01' }],
  );
  ok('оба написания сходятся к одному виду', normalizeTag('AB-01') === normalizeTag('AB_01'));
  // Точное совпадение буква в букву есть — его и берём, это тот же тег
  ok('точное совпадение выбирается', links[0].action === 'link' && links[0].existingTagId === 't1', links[0]);

  const blind = planTagLinks(
    [{ key: 'b1', tags: ['AB.01'] }],
    [{ id: 't1', identifier: 'AB-01' }, { id: 't2', identifier: 'AB_01' }],
  );
  ok('без точного совпадения — неоднозначность', blind[0].action === 'ambiguous', blind[0]);
  ok('первый не выбран за инженера', !blind[0].existingTagId, blind[0]);
  ok('показаны оба кандидата', (blind[0].candidates || []).length === 2, blind[0].candidates);
}

console.log('\nG25. Один и тот же клапан не задваивается в выгрузке');
{
  // Клапан виден и в составе установки, и в категории клапанов. Это две
  // строки представления и ОДНА физическая позиция
  const same = item({ id: 'valve-1', name: 'КЕДР-С', equipType: 'valve', tags: [{ identifier: 'V-1' }] });
  const table = buildEquipmentExchange([same, same], equipmentColumns([same]));
  const idAt = equipmentColumns([same]).findIndex(c => c.key === 'instanceId');
  const ids = new Set(table.rows.map(r => r[idAt]));
  ok('код позиции один и тот же', ids.size === 1, [...ids]);
  ok('по нему повтор и виден', table.rows.length === 2 && ids.size === 1);
}

console.log('\nG03/G25a. Четыре тега — четыре строки, один код позиции');
{
  const four = item({
    id: 'fan-1', name: 'ОСА-Е466', equipType: 'fan',
    tags: [{ identifier: '3700-H04-BL-001A' }, { identifier: '3700-H04-BL-001B' },
      { identifier: '3700-H04-BL-001C' }, { identifier: '3700-H04-BL-001D' }],
  });
  const rows = byTag([four]);
  ok('строк четыре', rows.length === 4, rows.length);
  ok('в каждой ровно один тег', rows.every(r => (r.tags || []).length === 1));
  ok('код позиции общий', new Set(rows.map(r => r.id)).size === 1);
  const cols = equipmentColumns([four]);
  const table = buildEquipmentExchange([four], cols);
  const tagAt = cols.findIndex(c => c.key === 'tag');
  ok('теги не слиты запятой в одну ячейку',
    table.rows.every(r => !r[tagAt].includes(',')), table.rows.map(r => r[tagAt]));
}

console.log('\nG26/G05. Два привода на клапан не удваивают клапан');
{
  const own = matchLabel('количество');
  ok('«количество» — это количество позиции', own?.field.target === 'qty', own?.field.id);
  const sub = matchLabel('число приводов');
  ok('«число приводов» — не количество позиции', sub?.field.target !== 'qty', sub?.field.id);
  ok('и попадает в состав', sub?.field.id === 'componentCount', sub?.field.id);
  ok('«количество приводов» тоже',
    matchLabel('количество приводов')?.field.id === 'componentCount');
}

console.log('\nG06. Длительность нагрева — не температура');
{
  // «нагрев 300 с» становился температурой 300 °C с высокой уверенностью:
  // в онтологии «с» означала градусы, а секунд не было вовсе
  ok('«с» сама по себе неоднозначна', unitInfo('с') === null);
  ok('и это названо обеими величинами',
    unitDimensions('с').sort().join(',') === 'duration,temp', unitDimensions('с'));
  ok('поле длительности читает секунды', unitInfoFor('с', 'duration')?.dim === 'duration');
  ok('поле температуры читает градусы', unitInfoFor('с', 'temp')?.dim === 'temp');
  ok('«сек» — однозначно длительность', unitInfo('сек')?.dim === 'duration');
  ok('«°C» — однозначно температура', unitInfo('°c')?.dim === 'temp');
  ok('секунды в минуты переводятся', convert(300, 'сек', 'мин') === 5);
  ok('секунды в градусы — нет', convert(300, 'сек', '°c') === null);
  ok('подпись «нагрев» ведёт в длительность',
    matchLabel('время нагрева')?.field.id === 'duration', matchLabel('время нагрева')?.field.id);
}

console.log('\n§3.3. Классы, слитые по ошибке, разведены');
{
  const by = (id: string) => EQUIP_TYPES.find(t => t.id === id);
  ok('насос не в категории вентиляторов', by('pump')?.category === 'PUMP', by('pump')?.category);
  ok('решётка не в категории клапанов', by('grille')?.category === 'GRILLE', by('grille')?.category);
  ok('нагреватель и охладитель — разные типы',
    !!by('heater') && !!by('cooler') && by('heater')!.id !== by('cooler')!.id);
  ok('охладитель не зовётся калорифером', !(by('heater')?.words || []).includes('охладитель'));
  ok('у датчика свой тип', by('sensor')?.category === 'AUTOMATION');
  ok('у гильзы свой тип', by('thermowell')?.category === 'AUTOMATION');
  ok('регулирующий узел — составное изделие, не клапан',
    by('hydro_unit')?.composite === true && by('hydro_unit')?.category !== 'VALVE');
}

console.log('\n§9. Величины, которые нельзя путать');
{
  ok('DN и миллиметр габарита — не одно и то же поле',
    matchLabel('диаметр условного прохода')?.field.id !== matchLabel('ширина')?.field.id);
  ok('кВт и кВА — разные размерности',
    unitInfo('квт')?.dim !== unitInfo('ква')?.dim);
  ok('Па и мм вод. ст. переводятся друг в друга',
    Math.abs((convert(1, 'мм вод ст', 'па') || 0) - 9.80665) < 1e-9);
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
