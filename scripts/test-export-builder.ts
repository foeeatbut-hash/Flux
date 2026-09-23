/**
 * Выгрузка по шаблону: отбор, порядок, заголовки групп и разметка листа.
 *
 * Спрашиваем то, что владелец заметит сразу: «только приводы с тегами» — это
 * и правда только они; «тип → тег» ставит приводы после клапанов, а
 * безтеговые — в конец группы; старый шаблон (только характеристики) не
 * теряется, а становится новым с тегом впереди; шаблон, разложенный в
 * Таблице, режет и сортирует строки тем же правилом.
 *
 * Запуск: npx tsx scripts/test-export-builder.ts
 */
import { specOf, defaultSpec, selectItems, orderItems, exportTable, toLayout, SERVICE_COLUMNS, applyPreset, paramSections } from '../src/lib/exportSpec';
import { equipmentColumns, type ExchangeComponent } from '../src/lib/equipmentExchange';
import { modelOf } from '../equipment/classes';
import { resolveValue } from '../server/routes/constructor';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failed++;
  console.error(`  ✗ ${name} — получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`);
};

const item = (id: string, cls: string, kind: string, tags: string[], params: Record<string, string> = {}, extra: Partial<ExchangeComponent> = {}): ExchangeComponent => ({
  id, itemCode: id, name: `Позиция ${id}`, equipType: cls, cls, kind,
  groups: [{ title: 'Привод', params: Object.entries(params).map(([key, value]) => ({ key, value, unit: key === 'Мощность' ? 'кВт' : '' })) }],
  tags: tags.map((identifier) => ({ identifier })), systemName: extra.systemName || 'У-1', monoblockName: '',
  parentTag: 'X-DW-001', ...extra,
});

const ITEMS = [
  item('d2', 'ПРИВОД', 'Без пружины', ['X-DWD-010'], { Модель: 'SM24', Мощность: '5' }),
  item('d1', 'ПРИВОД', 'С возвратной пружиной', ['X-DWD-9'], { Модель: 'SF24', Мощность: '7' }),
  item('d3', 'ПРИВОД', 'С возвратной пружиной', [], { Модель: 'SF24' }, { sourceKind: 'note' }),
  item('v', 'КЛАПАН', 'Воздушный', ['X-DW-001']),
  item('f', 'ВЕНТИЛЯТОР', 'Канальный', ['X-BL-001A', 'X-BL-002A'], {}, { systemName: 'У-2' }),
];

console.log('Отбор: типы, виды, «только с тегом»');
{
  const only = (patch: object) => selectItems(ITEMS, { ...defaultSpec(), ...patch }).map((i) => `${i.id}:${i.tags?.[0]?.identifier || ''}`);
  eq('без отбора — все, позиция с двумя тегами — две строки', only({}).length, 6);
  eq('только приводы', only({ classes: ['ПРИВОД'] }), ['d2:X-DWD-010', 'd1:X-DWD-9', 'd3:']);
  eq('только приводы с тегом', only({ classes: ['ПРИВОД'], taggedOnly: true }), ['d2:X-DWD-010', 'd1:X-DWD-9']);
  eq('вид сужает тип', only({ classes: ['ПРИВОД'], kinds: ['С возвратной пружиной'] }), ['d1:X-DWD-9', 'd3:']);
}

console.log('Порядок строк');
{
  const ids = (order: any) => orderItems(selectItems(ITEMS, defaultSpec()), order).map((i) => i.tags?.[0]?.identifier || `(${i.id})`);
  // Естественный порядок: DWD-9 раньше DWD-010
  eq('по тегу', ids('tag'), ['X-BL-001A', 'X-BL-002A', 'X-DW-001', 'X-DWD-9', 'X-DWD-010', '(d3)']);
  eq('тип → тег: вентиляторы, клапаны, приводы; безтеговый в конце группы', ids('class-tag'),
    ['X-BL-001A', 'X-BL-002A', 'X-DW-001', 'X-DWD-9', 'X-DWD-010', '(d3)']);
  eq('установка → тег', ids('unit-tag'), ['X-DW-001', 'X-DWD-9', 'X-DWD-010', '(d3)', 'X-BL-001A', 'X-BL-002A']);
}

console.log('Таблица: столбцы, заголовки групп, единицы');
{
  const spec = {
    ...defaultSpec(), classes: ['ПРИВОД', 'КЛАПАН'],
    columns: [{ key: 'tag', label: 'Тег' }, { key: 'kind', label: 'Вид' }, { key: 'model', label: 'Марка' },
      { key: 'origin', label: 'Откуда' }, { key: 'param:Привод|Мощность', label: 'Мощность', unit: 'кВт' }],
  };
  const t = exportTable(ITEMS, spec, equipmentColumns(ITEMS) as any);
  eq('заголовки — как названы в шаблоне', t.headers, ['Тег', 'Вид', 'Марка', 'Откуда', 'Мощность']);
  eq('перед каждым типом — строка-заголовок', t.groupRows.map((i) => t.rows[i][0]), ['Клапаны', 'Приводы']);
  eq('строк данных — без заголовков', t.count, 4);
  eq('первая строка приводов', t.rows[t.groupRows[1] + 1], ['X-DWD-9', 'С возвратной пружиной', 'SF24', 'из расчёта', '7']);
  eq('позиция по примечанию так и названа', t.rows[t.rows.length - 1][3], 'по примечанию');
  const flat = exportTable(ITEMS, { ...spec, groupHeaders: false }, equipmentColumns(ITEMS) as any);
  eq('без заголовков групп — только данные', flat.rows.length, 4);
  eq('заголовки групп только при «тип → тег»', exportTable(ITEMS, { ...spec, order: 'tag' }).groupRows, []);
}

console.log('Старый шаблон читается как новый');
{
  const v1 = specOf(null, { role: 'ДВИГАТЕЛЬ', fields: [{ group: 'Электродвигатель', key: 'Номинальная мощность', unit: 'кВт' }] });
  eq('тег и тег родителя впереди', v1.columns.slice(0, 2).map((c) => c.key), ['tag', 'parentTag']);
  eq('характеристика — столбцом с единицей', v1.columns[3], { key: 'param:Электродвигатель|Номинальная мощность', label: 'Номинальная мощность', unit: 'кВт' });
  eq('роль стала отбором по типу', v1.classes, ['ДВИГАТЕЛЬ']);
  const v2 = specOf(JSON.stringify({ v: 2, classes: ['ПРИВОД', 'ТРАКТОР'], columns: [{ key: 'tag' }, { key: 'rm -rf' }], order: 'tag' }));
  eq('неизвестный тип и столбец отброшены', [v2.classes, v2.columns.map((c) => c.key)], [['ПРИВОД'], ['tag']]);
  eq('пустой заголовок служебного столбца — его имя', v2.columns[0].label, 'Тег');
  eq('служебных столбцов хватает на «тег, тип, вид, модель»', ['tag', 'class', 'kind', 'model'].every((k) => SERVICE_COLUMNS.some((c) => c.key === k)), true);
}

console.log('Шаблон в Таблице: отбор и порядок — тем же правилом');
{
  const layout = toLayout({ ...defaultSpec(), classes: ['ПРИВОД'], kinds: ['Без пружины'], taggedOnly: true }, 2, 1);
  eq('строка — позиция', layout.grain, 'element');
  eq('шапка там, где курсор', [layout.headerRow, layout.columns[0].col], [2, 1]);
  eq('служебные столбцы — полями Таблицы', layout.columns.map((c) => c.path), ['tag', 'name', 'classTitle', 'kind', 'model', 'parentTag']);
  eq('отбор по типу, виду и тегу', layout.filters, [
    { field: 'class', op: 'in', value: 'ПРИВОД' }, { field: 'kind', op: 'in', value: 'Без пружины' }, { field: 'tag', op: 'nempty', value: '' },
  ]);
  eq('порядок «тип → тег»', layout.sort, [{ field: 'class' }, { field: 'tag' }]);
  const specs = JSON.stringify({ groups: [{ title: 'Привод', params: [{ key: 'Модель', value: 'SF24-S2' }] }] });
  eq('модель в Таблице — та же, что в выгрузке', resolveValue('element', { specs }, 'model'), modelOf(specs));
  eq('марка вентилятора — из поля «Вентилятор»', modelOf({ groups: [{ title: 'Вентилятор', params: [{ key: 'Вентилятор', value: 'ВОСК62' }] }] }), 'ВОСК62');
}

console.log('Быстрые наборы и характеристики по разделам');
{
  const withParam = { ...defaultSpec(), columns: [{ key: 'tag', label: 'Тег' }, { key: 'param:Привод|Мощность', label: 'Мощность', unit: 'кВт' }] };
  const p = applyPreset(withParam, 'tree');
  eq('набор ставит свои служебные столбцы', p.columns.slice(0, 5).map((c) => c.key), ['tag', 'parentTag', 'unitTag', 'class', 'name']);
  eq('и не стирает выбранные характеристики', p.columns[p.columns.length - 1].key, 'param:Привод|Мощность');
  eq('неизвестный набор — без изменений', applyPreset(withParam, 'нет'), withParam);
  const sec = paramSections(ITEMS, equipmentColumns(ITEMS).filter((c) => c.key.startsWith('param:')) as any);
  eq('разделы характеристик', sec.map((s) => s.title), ['Привод']);
  eq('у скольких позиций значение есть', sec[0].params.map((x) => `${x.label}:${x.count}`), ['Модель:3', 'Мощность:2']);
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки выгрузки по шаблону пройдены');
