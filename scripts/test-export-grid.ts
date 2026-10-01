import assert from 'node:assert/strict';
import type { ExportSpec } from '../src/lib/exportSpec';
import { exportGrid, exportName } from '../src/lib/exportGrid';
import { equipmentColumns, paramColumnKey, type ExchangeComponent } from '../src/lib/equipmentExchange';
import { convert } from '../src/import/valueGrammar';

const item = (id: string, tag: string, model: string, extra: Partial<ExchangeComponent> = {}): ExchangeComponent => ({
  id, itemCode: id, name: `Оборудование ${model}`, equipType: 'ПРИВОД', cls: 'ПРИВОД', kind: 'электропривод',
  model, tags: tag ? [{ identifier: tag }] : [], systemName: 'У-1', monoblockName: 'МБ-1',
  groups: [{ title: 'Привод', params: [
    { key: 'Изготовитель', value: 'НЕМАН', unit: '' },
    { key: 'Расход', value: '', unit: '' },
    { key: 'Мощность', value: '', unit: 'Вт' },
    { key: 'Примечание', value: '', unit: '' },
  ] }],
  ...extra,
});
const setParam = (it: ExchangeComponent, key: string, value: string, unit = '') => {
  const param = it.groups[0].params.find((p) => p.key === key)!;
  param.value = value; param.unit = unit;
};
const spec = (columns: ExportSpec['columns'], order: ExportSpec['order'] = 'tag'): ExportSpec => ({
  v: 2, classes: [], kinds: [], taggedOnly: false, columns, order, groupHeaders: false,
});
const col = (key: string, label: string, unit?: string) => ({ key, label, ...(unit !== undefined ? { unit } : {}) });

const duplicateA = item('id-a', 'TAG-01', 'LM24-SR');
const duplicateB = item('id-b', 'TAG-01', 'LM24-SR');
const otherTag = item('id-c', 'TAG-02', 'LM24-SR');
const otherSuffix = item('id-d', 'TAG-01', 'LM24-SRZ');
const otherManufacturer = item('id-e', 'TAG-01', 'LM24-SR');
setParam(otherManufacturer, 'Изготовитель', 'ДРУГОЙ ЗАВОД');
const rowSpec = spec([
  col('tag', 'Тег'), col('model', 'Модель'), col('param:Привод|Изготовитель', 'Изготовитель'),
]);
const deduplicated = exportGrid([duplicateA, duplicateB, otherTag, otherSuffix, otherManufacturer], rowSpec, equipmentColumns([duplicateA, duplicateB, otherTag, otherSuffix, otherManufacturer]), { deduplicate: true });
assert.equal(deduplicated.rows.length, 4, 'схлопываются лишь полностью одинаковые строки');
assert.deepEqual(deduplicated.rows, [
  ['TAG-01', 'LM24-SR', 'НЕМАН'],
  ['TAG-01', 'LM24-SRZ', 'НЕМАН'],
  ['TAG-01', 'LM24-SR', 'ДРУГОЙ ЗАВОД'],
  ['TAG-02', 'LM24-SR', 'НЕМАН'],
]);
assert.equal(deduplicated.rowKeys[0], 'id-a:TAG-01', 'при дедупликации сохраняется ключ первой строки');
assert.equal(exportGrid([duplicateA, duplicateB, otherTag, otherSuffix, otherManufacturer], rowSpec, [], { deduplicate: true }).rows.length, 4);
assert.equal(exportGrid([duplicateA, duplicateB], rowSpec).rows.length, 2, 'без опции дедупликации одинаковые записи сохраняются');

const groupedA = item('g-a', 'G-01', 'LM24-SR');
setParam(groupedA, 'Расход', '1,5', 'м³/с');
setParam(groupedA, 'Мощность', '10', 'Вт');
setParam(groupedA, 'Примечание', 'первый источник');
const groupedB = item('g-b', 'G-02', 'LM24-SR');
setParam(groupedB, 'Расход', '2.25', 'м³/с');
setParam(groupedB, 'Мощность', 'не указана');
setParam(groupedB, 'Примечание', 'второй источник');
const groupedSpec = spec([
  col('model', 'Модель'),
  col('param:Привод|Расход', 'Расход'),
  col('param:Привод|Мощность', 'Мощность'),
  col('param:Привод|Примечание', 'Примечание'),
]);
const grouped = exportGrid([groupedA, groupedB], groupedSpec, equipmentColumns([groupedA, groupedB]), {
  groupBy: ['model'], sums: ['param:Привод|Расход', 'param:Привод|Мощность'],
});
assert.equal(grouped.rows.length, 1);
assert.equal(grouped.rows[0][1], '3.75', 'числовые значения складываются с десятичной точностью');
assert.equal(grouped.rows[0][2], '10 · не указана', 'нечисловое значение сохраняется в списке, а не теряется');
assert.equal(grouped.rows[0][3], 'первый источник · второй источник');
assert.ok(grouped.warnings.some((warning) => warning.includes('нечисловые значения')));

const repeated = [
  item('r1', 'P-01', 'A'), item('r2', 'P-02', 'B'), item('r3', 'P-03', 'C'), item('r4', 'P-04', 'D'),
];
for (const [row, parent] of repeated.map((x, i) => [x, ['PARENT-1', 'PARENT-1', 'PARENT-2', 'PARENT-1'][i]] as const)) row.parentTag = parent;
const blanked = exportGrid(repeated, spec([col('tag', 'Тег'), col('parentTag', 'Тег родителя')]), [], { blankRepeats: ['parentTag'] });
assert.deepEqual(blanked.rows.map((row) => row[1]), ['PARENT-1', '', 'PARENT-2', 'PARENT-1'], 'пустые повторы идут только подряд; после смены родителя метка появляется снова');

const formulaGrid = exportGrid(
  [item('f1', 'F-01', 'A'), item('f2', 'F-02', 'B')],
  spec([col('tag', 'Тег'), { key: 'formula:check', label: 'Проверка', formula: '=ROW({row})&"{row}"' }]),
);
assert.deepEqual(formulaGrid.headers, ['Тег', 'Проверка']);
assert.deepEqual(formulaGrid.formulas, [1]);
assert.deepEqual(formulaGrid.rows.map((row) => row[1]), ['=ROW(2)&"2"', '=ROW(3)&"3"']);

const unitItem = item('unit-1', 'U-01', 'FLOW');
setParam(unitItem, 'Расход', '3600', 'м³/ч');
const flowKey = paramColumnKey('Привод', 'Расход');
const unitGrid = exportGrid([unitItem], spec([
  col(flowKey, 'Расход, м³/ч', 'м³/ч'), col(flowKey, 'Расход, м³/с', 'м³/с'),
]));
assert.deepEqual(unitGrid.headers, ['Расход, м³/ч', 'Расход, м³/с']);
assert.deepEqual(unitGrid.rows[0], ['3600', '1'], 'одна исходная характеристика выводится в каждой явно заданной единице');
assert.equal(convert(3600, 'м³/ч', 'м³/с'), 1);
assert.ok(Math.abs((convert(1, 'кгс/м²', 'Па') || 0) - 9.80665) < 1e-9);
assert.equal(convert(1, 'кВА', 'кВт'), null, 'нормализация квадратных/кубических единиц не должна смешивать Вт и ВА');
assert.notEqual(unitGrid.columnKeys[0], unitGrid.columnKeys[1], 'разные единицы должны иметь разные ключи столбцов для обмена/именованных диапазонов');

const namedCells = [
  ['rows', 'col'], ['rows', 'other'], ['other', 'col'], ['r|c', 'd'], ['r', 'c|d'],
] as const;
const names = namedCells.map(([row, c]) => exportName(row, c));
assert.equal(new Set(names).size, namedCells.length, 'имена столбцов должны быть уникальными для независимых координат');
assert.equal(exportName('rows', 'col'), exportName('rows', 'col'), 'имя стабильно для одной пары ячейка/поле');
const order = ['second', 'first', 'third'];
const namesByRow = new Map(order.map((row) => [row, exportName(row, 'value')]));
assert.deepEqual([...order].reverse().map((row) => exportName(row, 'value')), [...order].reverse().map((row) => namesByRow.get(row)), 'имена не зависят от обхода строк');
assert.notEqual(exportName('ab', 'c'), exportName('a', 'bc'));

console.log('Сетка экспорта: дедупликация, группировка, повторы, формулы, единицы и имена проверены.');
