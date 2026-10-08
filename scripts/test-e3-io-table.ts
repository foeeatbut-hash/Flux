/**
 * Лист «Таблица IO»: разбор, план загрузки, слияние с каталогом, поиск строки по
 * ссылке правила, проверка входных данных и выгрузка обратно.
 *
 * Лист ниже синтетический, но той же формы, что у владельца: пустая первая
 * строка, двухстрочная шапка, группа только в первой строке блока, строки-
 * подзаголовки без цифр, строка без наименования, описания сигналов в кавычках
 * в нескольких строках ячейки. Файл владельца в репозиторий не кладётся.
 *
 * Запуск: npx tsx scripts/test-e3-io-table.ts
 */
import * as XLSX from 'xlsx';
import {
  parseIoSheet, planIoTable, mergeIoTable, findIoRow, ioRowId, ioSheetRows, signalsText, sanitizeIoRow, validateIoRows, sanitizeIoRule, sanitizeIoRules, sanitizeRecipeLines,
  DEFAULT_IO_RULES, IO_SHEET, type E3IoRow,
} from '../e3/solutions';
import { solutionWorkbook } from '../e3/solutionWorkbook';
import { emptySolutionBook } from '../e3/solutions';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failed++;
  console.error(`  ✗ ${name} — получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`);
};

const E = '';
// строка листа: [пусто, группа, наименование, обозначение, DI, DO, AI, AO, пусто, описания DI, DO, AI, AO]
const r = (group: string, name: string, code: string, di: unknown, d_o: unknown, ai: unknown, ao: unknown, n: string[] = [E, E, E, E]): unknown[] =>
  [E, group, name, code, di, d_o, ai, ao, E, ...n];

const SHEET: unknown[][] = [
  [],
  [E, E, E, E, 'Входы-выходы для БПУ', E, E, E, E, 'Описание сигналов'],
  [E, 'Полевые приборы', 'Наименование', 'Обозначение', 'DI', 'DO', 'AI', 'AO', E, 'DI', 'DO', 'AI', 'AO'],
  r(E, 'Подзаголовок раздела без цифр', E, E, E, E, E),
  r('Датчики', 'Давления, температуры', 'PT, PDT, TT', E, E, 1, E),
  r(E, 'Влажности', 'MT', E, E, 1, E),
  r(E, 'Капиллярный термостат', 'TS', 1, E, E, E),
  r('Приводы', 'Клапан по воде', E, E, E, 1, 1),
  r(E, 'Клапан по воздуху пружинный, с бк', E, 2, 1, E, E),
  r(E, 'Клапан по воздуху 3-позиционный, с бк', E, '2', '2', E, E),
  r('ЭК', 'Срабатывание защиты ЭК по перегреву', 'TS', 1, E, E, E),
  r('Оборудование', 'Пароувлажнитель', E, 2, 2, E, 1, ['"Работа"\n"Авария"', '"Пуск" / "Стоп"', E, '"Задание производительности"']),
  r(E, E, E, 1, 1, E, E),                                                   // сигналы есть, наименования нет
  r('Внешние сигналы', 'Связь с системой газодымозащиты', E, E, E, E, E, ['Отключить оборудование', 'Оборудование отключено']),
  r('Связь с НКУ', 'Описываются сигналы от НКУ', E, E, E, E, E),            // подзаголовок: группа обновляется, строки нет
  r('НКУ', 'НКУ', E, 5, E, E, E),
  r('НКУ', 'НКУ', E, 3, E, E, E),                                           // повтор группы и наименования
  r('Оборудование', 'Странный', E, '1-2', E, E, E),                         // не число
  [null, null, null],
];

console.log('Разбор листа «Таблица IO»');
{
  const { rows, issues } = parseIoSheet(SHEET);
  eq('группа протягивается вниз', rows.slice(0, 4).map((x) => x.group), ['Датчики', 'Датчики', 'Датчики', 'Приводы']);
  eq('подзаголовок раздела без цифр пропущен', rows.some((x) => x.name.startsWith('Подзаголовок')), false);
  eq('числа читаются и из строки', rows.find((x) => x.name.includes('3-позиционный'))?.do, 2);
  eq('сигналы пружинного клапана', (({ di, do: d, ai, ao }) => ({ di, do: d, ai, ao }))(rows.find((x) => x.name.includes('пружинный'))!), { di: 2, do: 1, ai: 0, ao: 0 });
  eq('обозначение сохраняется', rows.find((x) => x.name === 'Влажности')?.code, 'MT');
  const steam = rows.find((x) => x.name === 'Пароувлажнитель')!;
  eq('описания: переводы строк заменены разделителем', steam.notes, { di: '"Работа" / "Авария"', do: '"Пуск" / "Стоп"', ai: '', ao: '"Задание производительности"' });
  eq('строка без наименования пропущена с замечанием', issues.some((t) => t.includes('наименования нет')), true);
  const gds = rows.find((x) => x.name.includes('газодымозащиты'));
  eq('описание без чисел — строка остаётся с нулями и замечанием', [gds?.di, gds?.do, issues.some((t) => t.includes('газодымозащиты') && t.includes('числа не заданы'))], [0, 0, true]);
  eq('подзаголовок меняет группу для следующих строк, но сам не строка', rows.some((x) => x.name.startsWith('Описываются')), false);
  const nku = rows.filter((x) => x.name === 'НКУ');
  eq('повтор группы и наименования получает номер', nku.map((x) => x.id.endsWith('#2')), [false, true]);
  eq('повтор — замечание', issues.some((t) => t.includes('повторяется')), true);
  eq('не число — ноль и замечание', [rows.find((x) => x.name === 'Странный')?.di, issues.some((t) => t.includes('«1-2»'))], [0, true]);
  eq('ключ стабилен к регистру и пробелам', ioRowId(' ПРИВОДЫ ', 'Клапан  по воде'), ioRowId('Приводы', 'клапан по воде'));
  eq('ключ различает группы', ioRowId('Датчики', 'ТТ') === ioRowId('ЭК', 'ТТ'), false);
  eq('ключ допустим для проверки сервера', sanitizeIoRow(rows[0])?.id, rows[0].id);
  eq('строки без компонента', rows.some((x) => 'component' in x), false);
}
{
  eq('лист без шапки', parseIoSheet([['a', 'b']]).issues.length, 1);
  eq('пустой лист', parseIoSheet([]).rows, []);
  const noCols = parseIoSheet([[E, 'Полевые приборы', 'Наименование', 'Обозначение', 'DI', 'DO']]);
  eq('нет столбцов AI и AO — замечание, строк нет', [noCols.rows.length, noCols.issues[0].includes('AI, AO')], [0, true]);
  const noNotes = parseIoSheet([[E, 'Полевые приборы', 'Наименование', 'Обозначение', 'DI', 'DO', 'AI', 'AO'], [E, 'Г', 'Прибор', E, 1, E, E, E]]);
  eq('описаний в листе может не быть', [noNotes.rows.length, noNotes.rows[0].notes], [1, { di: '', do: '', ai: '', ao: '' }]);
  const shifted = parseIoSheet([[], [], [], [E, E, 'Полевые приборы', 'Наименование', 'Обозначение', 'DI', 'DO', 'AI', 'AO'], [E, E, 'Г', 'Прибор', E, 1, E, E, E]]);
  eq('шапка ищется по подписям, а не по номеру строки', [shifted.rows[0]?.name, shifted.rows[0]?.di], ['Прибор', 1]);
}

console.log('План и слияние с каталогом');
{
  const file = parseIoSheet(SHEET).rows;
  const base = file.map((x) => ({ ...x }));
  const cur = base.map((x, i) => (i === 0 ? { ...x, component: 'датчик_AI' } : x));
  const plan0 = planIoTable([], file);
  eq('в пустой каталог — все новые', [plan0.added, plan0.same], [file.length, 0]);
  const plan1 = planIoTable(cur, file);
  eq('то же самое — без изменений, имя изделия не мешает', [plan1.added, plan1.changed.length, plan1.same, plan1.missing, plan1.editedKept], [0, 0, file.length, [], []]);

  const changed = file.map((x) => (x.name === 'Влажности' ? { ...x, ai: 2, notes: { ...x.notes, ai: 'новое' } } : x)).filter((x) => x.name !== 'Клапан по воде');
  const plan2 = planIoTable(cur, changed);
  eq('изменённая строка и поля', plan2.changed.map((c) => [c.id.includes('влажности'), c.fields]), [[true, ['ai', 'notes']]]);
  eq('строки, которых нет в файле, остаются и названы', plan2.missing.length, 1);

  const edited = cur.map((x) => (x.name === 'Влажности' ? { ...x, ai: 5, edited: true, component: 'датчик_MT' } : x));
  const plan3 = planIoTable(edited, changed);
  eq('правленая вручную строка не перезаписывается', [plan3.changed.length, plan3.editedKept.length], [0, 1]);
  const merged = mergeIoTable(edited, changed);
  eq('слияние: правленая строка и её имя изделия сохранены', [merged.find((x) => x.name === 'Влажности')?.ai, merged.find((x) => x.name === 'Влажности')?.component], [5, 'датчик_MT']);
  eq('слияние: имя изделия не затёрто файлом у неправленой строки', mergeIoTable(cur, file)[0].component, 'датчик_AI');
  eq('слияние: строки вне файла остаются', merged.some((x) => x.name === 'Клапан по воде'), true);
  eq('слияние: порядок файла', mergeIoTable(cur, [...file].reverse()).map((x) => x.id).slice(0, 2), [...file].reverse().map((x) => x.id).slice(0, 2));
  eq('слияние не меняет вход', cur[0].component, 'датчик_AI');
}

console.log('Поиск строки по ссылке правила');
{
  const t = parseIoSheet(SHEET).rows;
  eq('по обозначению, всего набора кодов', findIoRow(t, { group: 'Датчики', code: 'PT, PDT, TT' }).row?.name, 'Давления, температуры');
  eq('«TS» в группе датчиков — не строка ЭК', findIoRow(t, { group: 'Датчики', code: 'TS' }).row?.name, 'Капиллярный термостат');
  eq('«TS» в группе ЭК', findIoRow(t, { group: 'ЭК', code: 'TS' }).row?.name, 'Срабатывание защиты ЭК по перегреву');
  const ambiguous = findIoRow(t, { code: 'TS' });
  eq('код без группы подходит двум строкам — первая и замечание', [ambiguous.row?.name, !!ambiguous.issue], ['Капиллярный термостат', true]);
  eq('точный набор кодов выигрывает у вхождения', findIoRow(t, { group: 'Датчики', code: 'MT' }).row?.name, 'Влажности');
  eq('вхождение кода, если точного набора нет', findIoRow(t, { group: 'Датчики', code: 'PDT' }).row?.name, 'Давления, температуры');
  eq('часть наименования без регистра', findIoRow(t, { name: '3-ПОЗИЦИОННЫЙ' }).row?.di, 2);
  eq('нет строки — замечание и нет строки', [findIoRow(t, { name: 'нет такого' }).row, findIoRow(t, { name: 'нет такого' }).issue?.includes('нет строки')], [undefined, true]);
  eq('пустая ссылка', !!findIoRow(t, {}).issue, true);
}

console.log('Проверка входных данных');
{
  const rows = parseIoSheet(SHEET).rows;
  eq('строки из файла принимаются', 'rows' in validateIoRows(rows) && (validateIoRows(rows) as any).rows.length, rows.length);
  eq('имя изделия из файла отбрасывается', (validateIoRows([{ ...rows[0], component: 'чужое' }]) as any).rows[0].component, undefined);
  eq('нет списка', 'error' in validateIoRows('x'), true);
  eq('дробное число', 'error' in validateIoRows([{ ...rows[0], di: 1.5 }]), true);
  eq('отрицательное число', 'error' in validateIoRows([{ ...rows[0], ao: -1 }]), true);
  eq('нет наименования', sanitizeIoRow({ ...rows[0], name: '  ' }), null);
  eq('ключ с недопустимыми знаками', sanitizeIoRow({ ...rows[0], id: '../x' }), null);
  eq('имя изделия принимается для одной строки', sanitizeIoRow({ ...rows[0], component: ' датчик_AI ' })?.component, 'датчик_AI');
  eq('слишком длинное описание', sanitizeIoRow({ ...rows[0], notes: { ...rows[0].notes, di: 'x'.repeat(401) } }), null);
  eq('не больше 500 строк', 'error' in validateIoRows(Array.from({ length: 501 }, () => rows[0])), true);

  const rule = DEFAULT_IO_RULES[0];
  eq('стартовые правила проходят проверку', sanitizeIoRules(DEFAULT_IO_RULES)?.length, DEFAULT_IO_RULES.length);
  eq('правило без строки IO', sanitizeIoRule({ ...rule, row: {} }), null);
  eq('правило без роли', sanitizeIoRule({ ...rule, role: '' }), null);
  eq('правило с чужим видом числа', sanitizeIoRule({ ...rule, count: { kind: 'вдруг' } }), null);
  eq('служебное имя признака', sanitizeIoRule({ ...rule, when: [{ feature: '__proto__', values: ['x'] }] }), null);
  eq('условие без значений', sanitizeIoRule({ ...rule, when: [{ feature: 'a.b', values: [] }] }), null);
  eq('ключи правил не повторяются', sanitizeIoRules([rule, rule])?.length, 1);
  eq('ручной состав', sanitizeRecipeLines([{ role: 'Привод', row: { name: 'пружинный' }, count: 2 }])?.[0].count, 2);
  eq('ручной состав: число не из диапазона', sanitizeRecipeLines([{ role: 'Привод', row: { name: 'x' }, count: 0 }]), null);
  eq('ручной состав: без строки IO', sanitizeRecipeLines([{ role: 'Привод', row: {}, count: 1 }]), null);
  eq('ручной состав: не больше 40 строк', sanitizeRecipeLines(Array.from({ length: 41 }, () => ({ role: 'a', row: { name: 'b' }, count: 1 }))), null);
}

console.log('Выгрузка и чтение обратно');
{
  // Строка без сигналов и описаний при чтении обратно — подзаголовок: в файле её нет смысла хранить
  const rows = parseIoSheet(SHEET).rows.filter((x) => x.di + x.do + x.ai + x.ao > 0 || Object.values(x.notes).some(Boolean));
  const back = parseIoSheet(ioSheetRows(rows));
  eq('выгруженный лист читается так же', back.rows.map((x) => [x.id, x.group, x.name, x.code, x.di, x.do, x.ai, x.ao, x.notes]), rows.map((x) => [x.id, x.group, x.name, x.code, x.di, x.do, x.ai, x.ao, x.notes]));
  const book = { ...emptySolutionBook(), ioTable: rows };
  const wb = solutionWorkbook(book);
  eq('лист есть в книге выгрузки и называется как у владельца', wb.SheetNames.includes(IO_SHEET), true);
  const viaXlsx = parseIoSheet(XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[IO_SHEET], { header: 1, defval: '', blankrows: true }));
  eq('через настоящий xlsx строки те же', viaXlsx.rows.length, rows.length);
  eq('без таблицы листа в книге нет', solutionWorkbook(emptySolutionBook()).SheetNames.includes(IO_SHEET), false);
  eq('сигналы словами', [signalsText({ di: 2, do: 1, ai: 0, ao: 0 }), signalsText({ di: 0, do: 0, ai: 0, ao: 0 })], ['DI 2 · DO 1', 'нет сигналов']);
}

if (failed) { console.error(`\nПровалено проверок: ${failed}`); process.exit(1); }
console.log('\nВсе проверки пройдены');
export type { E3IoRow };
