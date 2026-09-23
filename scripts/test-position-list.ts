/**
 * Позиции списком и срез Таблицы по типу.
 *
 * Список позиций отвечает владельцу на «каждый тег — отдельная позиция,
 * сортировка по типам оборудования». Проверяем то, в чём легко ошибиться
 * незаметно: позиция с двумя тегами — две строки, безтеговая — одна и в конце
 * группы, группы идут в порядке справочника, а Таблица режет строки по типу
 * тем же правилом, что и раздел «Оборудование».
 *
 * Запуск: npx tsx scripts/test-position-list.ts
 */
import { classifyAll } from '../equipment/classes';
import { positionRows, filterRows, classCounts, groupRows, byTag, rowLabel } from '../src/lib/positionList';
import { resolveValue } from '../server/routes/constructor';
import { compareBy } from '../server/constructorSort';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failed++;
  console.error(`  ✗ ${name} — получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`);
};

const tags = (...ids: string[]) => ids.map((identifier) => ({ identifier }));
const comps: any[] = [
  { id: 'u', itemCode: '__unit__', name: 'Параметры установки', role: 'БЛОК', tags: tags('9999-X-AS-001A') },
  { id: 'v', itemCode: '1/клапан1', name: 'Клапан', role: 'КЛАПАН', tags: tags('9999-X-DW-001A'), sourceOrder: 1 },
  { id: 'd2', itemCode: '1/клапан1/привод2', name: 'Привод 2', role: 'ПРИВОД', parentElementId: 'v', tags: tags('9999-X-DWD-010'), sourceOrder: 3 },
  { id: 'd1', itemCode: '1/клапан1/привод1', name: 'Привод 1', role: 'ПРИВОД', parentElementId: 'v', tags: tags('9999-X-DWD-9'), sourceOrder: 2 },
  { id: 'd3', itemCode: '1/клапан1/привод3', name: 'Привод 3', role: 'ПРИВОД', parentElementId: 'v', sourceKind: 'note', sourceOrder: 4 },
  { id: 'f', itemCode: '2', name: 'Вентилятор', role: 'ВЕНТИЛЯТОР', tags: tags('9999-X-BL-001A', '9999-X-BL-002A') },
  { id: 'm', itemCode: '2/двигатель1', name: 'Двигатель', role: 'ДВИГАТЕЛЬ', parentElementId: 'f', manual: true },
];
const systems = [{ id: 's1', name: '9999-X-AS-001A', monoblocks: [{ name: 'Моноблок 1', components: comps }] }];
const types = classifyAll(comps);
const rows = positionRows(systems as any, types);

console.log('Строка — позиция с тегом');
{
  eq('позиция с двумя тегами — две строки', rows.filter((r) => r.id === 'f').map((r) => r.tag), ['9999-X-BL-001A', '9999-X-BL-002A']);
  eq('безтеговая — одна строка с пустым тегом', rows.filter((r) => r.id === 'd3').map((r) => r.tag), ['']);
  eq('всего строк', rows.length, 8);
  eq('тег родителя привода — тег клапана', rows.find((r) => r.id === 'd1')?.parentTag, '9999-X-DW-001A');
  eq('тег родителя двигателя — тег вентилятора', rows.find((r) => r.id === 'm')?.parentTag, '9999-X-BL-001A');
  eq('откуда: по примечанию', rows.find((r) => r.id === 'd3')?.origin, 'note');
  eq('откуда: вручную', rows.find((r) => r.id === 'm')?.origin, 'manual');
  eq('служебная строка названа словами', rowLabel({ itemCode: '__unit__', name: '__unit__' }), 'Параметры установки');
}

console.log('Группы по типу, внутри — по тегу');
{
  const g = groupRows(rows, 'class');
  eq('группы в порядке справочника', g.map((x) => x.key), ['УСТАНОВКА', 'ВЕНТИЛЯТОР', 'ДВИГАТЕЛЬ', 'КЛАПАН', 'ПРИВОД']);
  eq('подпись группы во множественном числе', g.find((x) => x.key === 'ПРИВОД')?.title, 'Приводы');
  // Естественный порядок: DWD-9 раньше DWD-010, безтеговый — в конце
  eq('приводы по тегу, безтеговый последним', g.find((x) => x.key === 'ПРИВОД')?.rows.map((r) => r.id), ['d1', 'd2', 'd3']);
  eq('по установке — одна группа', groupRows(rows, 'unit').map((x) => x.title), ['9999-X-AS-001A']);
  eq('без групп — одна группа без заголовка', groupRows(rows, 'none').map((x) => x.title), ['']);
  eq('безтеговые после тегированных', [...rows].sort(byTag).slice(-2).every((r) => !r.tag), true);
}

console.log('Отбор: тип, тег, поиск');
{
  eq('только приводы', filterRows(rows, { classes: ['ПРИВОД'] }).length, 3);
  eq('только приводы с тегом', filterRows(rows, { classes: ['ПРИВОД'], tagged: 'with' }).length, 2);
  eq('без тега во всём проекте', filterRows(rows, { tagged: 'without' }).map((r) => r.id), ['d3', 'm']);
  eq('поиск по тегу', filterRows(rows, { q: 'dwd-010' }).map((r) => r.id), ['d2']);
  eq('поиск по названию типа', filterRows(rows, { q: 'двигател' }).map((r) => r.id), ['m']);
  const c = classCounts(rows);
  eq('счётчики по типам', c.map((x) => `${x.cls}:${x.count}/${x.tagged}`), ['УСТАНОВКА:1/1', 'ВЕНТИЛЯТОР:2/2', 'ДВИГАТЕЛЬ:1/0', 'КЛАПАН:1/1', 'ПРИВОД:3/2']);
}

console.log('Таблица режет строки по типу тем же правилом');
{
  const el = (id: string) => ({ ...comps.find((c) => c.id === id), _class: types.get(id)!.cls, _kind: types.get(id)!.kind });
  eq('поле «тип» — код', resolveValue('element', el('d1'), 'class'), 'ПРИВОД');
  eq('поле «Тип» для шапки — слово', resolveValue('element', el('d1'), 'classTitle'), 'Привод');
  eq('откуда: по примечанию', resolveValue('element', el('d3'), 'origin'), 'по примечанию');
  eq('откуда: из расчёта', resolveValue('element', el('v'), 'origin'), 'из расчёта');
  eq('откуда: вручную', resolveValue('element', el('m'), 'origin'), 'заведено вручную');
  const list = ['d3', 'd2', 'f', 'd1', 'u'].map(el);
  const sorted = [...list].sort(compareBy([{ field: 'class' }, { field: 'tag' }], (r, f) => resolveValue('element', r, f)));
  eq('сортировка «тип, потом тег»: безтеговый в конце группы', sorted.map((r) => r.id), ['u', 'f', 'd1', 'd2', 'd3']);
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки списка позиций пройдены');
