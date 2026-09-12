/**
 * Выгрузка оборудования: строка — изделие, столбец — характеристика.
 *
 * Владелец просил дословно: «когда мы выгружаем к примеру расход воздуха
 * вентилятора „Тег“». Проверяется то, из-за чего такая таблица обычно
 * бесполезна: единица должна стоять в заголовке, а не в ячейке (иначе столбец
 * не сложить), тег — быть в строке (иначе выгрузка не сходится с реестром), а
 * ручная правка инженера — побеждать импортированное значение.
 */
import {
  buildEquipmentExchange, equipmentColumns, equipmentCell, paramColumnKey,
  BASE_EQUIPMENT_COLUMNS, type ExchangeComponent,
} from '../src/lib/equipmentExchange';
import { pickColumns, toCsv } from '../src/lib/exchange';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : ''));

const fan: ExchangeComponent = {
  id: 'c1', itemCode: 'ВЕНТ-063', name: 'Вентилятор ВСК', equipType: 'ВЕНТИЛЯТОР',
  systemName: '1000-A01-HU-001A', monoblockName: 'M2',
  tags: [{ identifier: '1000-A01-BL-001A' }],
  groups: [
    { title: 'Аэродинамика', params: [{ key: 'Расход воздуха', value: '20000', unit: 'м³/ч' }] },
    { title: 'Электрика', params: [
      { key: 'Мощность', value: '5.5', unit: 'кВт' },
      { key: 'Частота вращения (nдв)', value: '1435', unit: 'об/мин' },
    ] },
  ],
};
const valve: ExchangeComponent = {
  id: 'c2', itemCode: '1000-D01-DS-002', name: 'КПУ-1Н-З-В-1000х800', equipType: 'КЛАПАН',
  systemName: 'клапаны', monoblockName: 'M1',
  tags: [{ identifier: '1000-D01-DS-002' }, { identifier: '1000-D01-DS-003' }],
  groups: [{ title: 'Конструкция', params: [{ key: 'Ширина В, мм', value: '1000', unit: 'мм' }] }],
  overrides: { 'Конструкция||Ширина В, мм': '1050' },
};

console.log('1. Столбцы собираются по данным проекта');
{
  const cols = equipmentColumns([fan, valve]);
  ok('постоянные столбцы идут первыми',
    cols.slice(0, BASE_EQUIPMENT_COLUMNS.length).every((c, i) => c.key === BASE_EQUIPMENT_COLUMNS[i].key), cols.slice(0, 6));
  ok('тег — самый первый столбец', cols[0].key === 'tag' && cols[0].label === 'Тег');
  ok('единица стоит в заголовке, а не в ячейке',
    cols.some(c => c.label === 'Расход воздуха, м³/ч'), cols.map(c => c.label));
  ok('характеристика без единицы заголовок не портит',
    !cols.some(c => c.label.endsWith(', ')), cols.map(c => c.label));
  ok('одинаковые характеристики разных изделий дают один столбец',
    cols.filter(c => c.label.startsWith('Расход воздуха')).length === 1);
  // Подпись из бланка часто уже несёт единицу — второй раз её не дописываем,
  // иначе в шапке Excel оказывается «Ширина В, мм, мм»
  ok('единица не дублируется, если она уже в подписи',
    cols.some(c => c.label === 'Ширина В, мм') && !cols.some(c => /, мм, мм$/.test(c.label)), cols.map(c => c.label));
}

console.log('2. Значения ячеек');
{
  ok('в ячейке остаётся только число',
    equipmentCell(fan, paramColumnKey('Аэродинамика', 'Расход воздуха')) === '20000',
    equipmentCell(fan, paramColumnKey('Аэродинамика', 'Расход воздуха')));
  ok('тег изделия в строке', equipmentCell(fan, 'tag') === '1000-A01-BL-001A');
  // Раньше здесь ждали «тег, тег» в одной ячейке. Это соответствовало старой
  // модели «один бланк — одно изделие», но каждый позиционный тег адресует
  // СВОЮ позицию проекта: перечисление через запятую означало бы, что два
  // клапана с разными адресами — один клапан
  ok('в ячейке тега один тег', equipmentCell(valve, 'tag') === '1000-D01-DS-002',
    equipmentCell(valve, 'tag'));
  ok('чужая характеристика — пустая ячейка, а не «undefined»',
    equipmentCell(valve, paramColumnKey('Аэродинамика', 'Расход воздуха')) === '');
  // Ключ правки — «группа||ключ», как его пишет карточка оборудования
  ok('ручная правка инженера сильнее импортированного значения',
    equipmentCell(valve, paramColumnKey('Конструкция', 'Ширина В, мм')) === '1050',
    equipmentCell(valve, paramColumnKey('Конструкция', 'Ширина В, мм')));
  ok('установка и моноблок в строке',
    equipmentCell(fan, 'system') === '1000-A01-HU-001A' && equipmentCell(fan, 'monoblock') === 'M2');
}

console.log('3. Таблица целиком');
{
  const cols = equipmentColumns([fan, valve]);
  const t = buildEquipmentExchange([fan, valve], cols);
  // Клапан с двумя тегами даёт две строки: вентилятор (1 тег) + клапан (2) = 3
  ok('строка на каждый тег, а не на каждый бланк', t.rows.length === 3, t.rows.length);
  ok('код позиции у обеих строк клапана общий',
    (() => {
      const at = cols.findIndex(c => c.key === 'instanceId');
      return t.rows[1][at] === t.rows[2][at] && !!t.rows[1][at];
    })(), t.rows.map(r => r[cols.findIndex(c => c.key === 'instanceId')]));
  ok('в каждой строке столько ячеек, сколько столбцов',
    t.rows.every(r => r.length === t.headers.length), [t.headers.length, t.rows.map(r => r.length)]);
  const csv = toCsv(t.headers, t.rows);
  ok('CSV открывается Excel с кириллицей (BOM)', csv.charCodeAt(0) === 0xFEFF);
  ok('в CSV попал расход вентилятора', csv.includes('20000'));
  ok('и тег, по которому строка сходится с реестром', csv.includes('1000-A01-BL-001A'));
}

console.log('4. Выбор столбцов');
{
  const cols = equipmentColumns([fan, valve]);
  const only = pickColumns(cols, ['tag', paramColumnKey('Аэродинамика', 'Расход воздуха')]);
  ok('выбраны ровно два столбца', only.length === 2, only.map(c => c.label));
  const t = buildEquipmentExchange([fan], only);
  ok('выгрузка «расход воздуха вентилятора „тег“» собирается',
    JSON.stringify(t.rows[0]) === JSON.stringify(['1000-A01-BL-001A', '20000']), t.rows[0]);
}

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
