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
import { rowsOfSystem } from '../src/lib/equipmentRows';
import { layoutPositions } from '../src/components/equipment/PositionTree';

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

console.log('\nСостав: роль, тег родителя, тег установки и порядок');
{
  /**
   * Установка с двумя вентиляторами; у каждого свой двигатель, на первом
   * двигателе — датчик ПТС, заведённый инженером руками. Ровно тот случай,
   * ради которого владелец всё и просил.
   */
  const sys = {
    name: '3700-B01-AS-001A',
    monoblocks: [
      {
        name: '__unit__',
        components: [
          { id: 'u', itemCode: '__unit__', name: 'Установка', equipType: 'УСТАНОВКА', role: 'УСТАНОВКА', tags: [{ identifier: '3700-B01-AS-001A' }] },
        ],
      },
      {
        name: 'Моноблок 3',
        components: [
          { id: 'b', itemCode: '3', name: 'Вентилятор ВСК', equipType: 'ВЕНТИЛЯТОР', role: 'БЛОК', sourceOrder: 0 },
          { id: 'f2', itemCode: '3/вентилятор2', name: 'Вентилятор №2', equipType: 'ВЕНТИЛЯТОР', role: 'ВЕНТИЛЯТОР', parentElementId: 'b', instanceNo: 2, sourceOrder: 3, tags: [{ identifier: '3700-B01-BL-002A' }] },
          { id: 'f1', itemCode: '3/вентилятор1', name: 'Вентилятор №1', equipType: 'ВЕНТИЛЯТОР', role: 'ВЕНТИЛЯТОР', parentElementId: 'b', instanceNo: 1, sourceOrder: 1, tags: [{ identifier: '3700-B01-BL-001A' }] },
          { id: 'm1', itemCode: '3/вентилятор1/двигатель1', name: 'Электродвигатель', equipType: 'ДВИГАТЕЛЬ', role: 'ДВИГАТЕЛЬ', parentElementId: 'f1', sourceOrder: 2, tags: [{ identifier: '3700-B01-M-001A' }] },
          { id: 's1', itemCode: '3/вентилятор1/двигатель1/датчик1', name: 'Датчик ПТС', equipType: 'ДАТЧИК', role: 'ДАТЧИК', parentElementId: 'm1', manual: true, sourceOrder: 9, tags: [{ identifier: '3700-B01-TE-001A' }] },
        ],
      },
    ],
  };
  const rows = rowsOfSystem(sys as any, (raw?: string) => ({ groups: [] }));
  const by = (id: string) => rows.find((r) => r.id === id)!;

  ok('служебная строка установки в изделия не попала', !rows.some((r) => r.itemCode === '__unit__'), rows.map((r) => r.itemCode));
  ok('тег установки стоит у каждой строки',
    rows.every((r) => r.unitTag === '3700-B01-AS-001A'), rows.map((r) => r.unitTag));
  ok('родитель двигателя — его вентилятор', by('m1').parentTag === '3700-B01-BL-001A', by('m1').parentTag);
  ok('родитель датчика — двигатель', by('s1').parentTag === '3700-B01-M-001A', by('s1').parentTag);
  // Блок тега не имеет — цепочка не обрывается, а поднимается к установке
  ok('вентилятор в нетегированном блоке встал под установку',
    by('f1').parentTag === '3700-B01-AS-001A', by('f1').parentTag);
  ok('ручная позиция помечена', by('s1').manual === true && by('f1').manual === false);
  ok('роль доехала до строки', by('s1').role === 'ДАТЧИК' && by('m1').role === 'ДВИГАТЕЛЬ');

  // Столбцы состава: «тег двигателей, дальше их данные и тег родителя»
  const cols = BASE_EQUIPMENT_COLUMNS.filter((c) => ['tag', 'role', 'parentTag', 'unitTag', 'origin'].includes(c.key));
  const t = buildEquipmentExchange(rows, cols as any);
  ok('столбцы состава есть в списке постоянных',
    JSON.stringify(t.headers) === JSON.stringify(['Тег', 'Роль', 'Тег родителя', 'Тег установки', 'Откуда']), t.headers);

  // Порядок строк — по алфавиту тега, а не по порядку в расчёте
  ok('строки идут по алфавиту тега',
    JSON.stringify(t.rows.map((r) => r[0])) === JSON.stringify([
      '3700-B01-BL-001A', '3700-B01-BL-002A', '3700-B01-M-001A', '3700-B01-TE-001A', '',
    ]), t.rows.map((r) => r[0]));
  ok('позиция без тега ушла в конец', t.rows[t.rows.length - 1][0] === '', t.rows[t.rows.length - 1]);
  ok('ручное и расчётное различимы',
    t.rows.find((r) => r[0] === '3700-B01-TE-001A')?.[4] === 'заведено вручную', t.rows);

  // Срез «только датчики ПТС с их тегами» — это фильтр по роли, а не программа
  const sensors = buildEquipmentExchange(rows.filter((r) => r.role === 'ДАТЧИК'), cols as any);
  ok('срез по роли оставляет одну строку', sensors.rows.length === 1, sensors.rows);
  ok('и в ней тег датчика', sensors.rows[0][0] === '3700-B01-TE-001A', sensors.rows[0]);
}

console.log('\nДерево позиций: отступ по составу, алфавит внутри уровня');
{
  const comps = [
    { id: 'b', itemCode: '3', name: 'Блок', equipType: 'ВЕНТИЛЯТОР', role: 'БЛОК', sourceOrder: 0 },
    { id: 'f2', itemCode: '3/в2', name: 'Вентилятор №2', equipType: 'ВЕНТИЛЯТОР', role: 'ВЕНТИЛЯТОР', parentElementId: 'b', sourceOrder: 3, tags: [{ id: 't2', identifier: 'BL-002A' }] },
    { id: 'f1', itemCode: '3/в1', name: 'Вентилятор №1', equipType: 'ВЕНТИЛЯТОР', role: 'ВЕНТИЛЯТОР', parentElementId: 'b', sourceOrder: 1, tags: [{ id: 't1', identifier: 'BL-001A' }] },
    { id: 'm1', itemCode: '3/в1/д1', name: 'Двигатель', equipType: 'ДВИГАТЕЛЬ', role: 'ДВИГАТЕЛЬ', parentElementId: 'f1', sourceOrder: 2 },
    // Владелец потерялся: позиция должна остаться видимой, а не пропасть
    { id: 'x', itemCode: '3/сирота', name: 'Сирота', equipType: 'ПРОЧЕЕ', role: 'ДАТЧИК', parentElementId: 'нет-такого', sourceOrder: 7 },
  ];
  const out = layoutPositions(comps as any);
  ok('все позиции остались', out.length === comps.length, out.map((o) => o.c.itemCode));
  ok('двигатель стоит глубже своего вентилятора',
    out.find((o) => o.c.id === 'm1')!.depth === out.find((o) => o.c.id === 'f1')!.depth + 1, out.map((o) => [o.c.id, o.depth]));
  ok('вентиляторы идут по алфавиту тега',
    out.filter((o) => o.c.role === 'ВЕНТИЛЯТОР').map((o) => o.c.id).join(',') === 'f1,f2',
    out.map((o) => o.c.id));
  ok('позиция с потерянным владельцем видна на верхнем уровне',
    out.find((o) => o.c.id === 'x')!.depth === 0, out.map((o) => [o.c.id, o.depth]));

  // Кольцо в данных не должно вешать окно
  const ring = [
    { id: 'a', itemCode: 'a', name: 'A', equipType: '', role: 'БЛОК', parentElementId: 'b' },
    { id: 'b', itemCode: 'b', name: 'B', equipType: '', role: 'БЛОК', parentElementId: 'a' },
  ];
  ok('кольцо не зацикливает раскладку', layoutPositions(ring as any).length >= 0);
}

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
