/**
 * Рецепт блока: изделия E3 и сигналы DI/DO/AI/AO по типовому решению, правилам
 * связи и таблице IO.
 *
 * Таблица IO и решения ниже синтетические, но той же формы, что у владельца;
 * имена изделий E3 придуманы здесь, в файлах владельца их нет. Файл владельца в
 * репозиторий не кладётся.
 *
 * Запуск: npx tsx scripts/test-e3-recipe.ts
 */
import {
  buildRecipe, buildRecipeFor, parseRecipeLines, recipeLinesText, selectSolution, emptySolutionBook, parseIoSheet,
  type E3Position, type E3Solution, type E3SolutionBook,
} from '../e3/solutions';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failed++;
  console.error(`  ✗ ${name} — получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`);
};

const E = '';
const row = (group: string, name: string, code: string, di: unknown, d_o: unknown, ai: unknown, ao: unknown): unknown[] => [E, group, name, code, di, d_o, ai, ao];
const SHEET: unknown[][] = [
  [], [],
  [E, 'Полевые приборы', 'Наименование', 'Обозначение', 'DI', 'DO', 'AI', 'AO'],
  row('Датчики', 'Давления, температуры', 'PT, PDT, TT', E, E, 1, E),
  row(E, 'Влажности', 'MT', E, E, 1, E),
  row(E, 'Капиллярный термостат', 'TS', 1, E, E, E),
  row(E, 'Прессостат (реле давления)', 'PS', 1, E, E, E),
  row('Приводы', 'Клапан по воде', E, E, E, 1, 1),
  row(E, 'Клапан по воздуху пружинный, с бк', E, 2, 1, E, E),
  row(E, 'Клапан по воздуху 3-позиционный, с бк', E, 2, 2, E, E),
  row(E, 'Клапан по воздуху плавное регулирование с БК', E, 2, E, 1, 1),
  row('ЭК', 'Срабатывание защиты ЭК по перегреву', 'TS', 1, E, E, E),
  row('Оборудование', 'Пароувлажнитель', E, 2, 2, E, 1),
  row(E, 'Охладитель (на один контур)', E, 2, 1, E, E),
  row('Клапан', 'Статус "Обогрев клапана" (для каждого клапана отдельно)', E, 2, E, E, E),
  row('Включение обогрева клапанов', 'Команда на централизованное включение обогрева', E, E, 3, E, E),
  row(E, 'Циркуляционный насос (для каждого насоса отдельно)', E, 2, 1, E, E),
  row(E, 'Управление ЭД без ЧРП', E, 2, 1, E, E),
  row(E, 'Управление ЭД с ЧРП', E, 2, 1, 1, 1),
  row('ЭК', 'ЭК, 1 ступень с ШИМ', E, 2, 2, E, E),
  row('ЭК', 'ЭК, остальные ступени (на одну ступень)', E, 2, 1, E, E),
];

const COMPONENTS: Record<string, string> = {
  'клапан по воздуху пружинный, с бк': 'клапан_DIx2_DOx1', 'клапан по воздуху 3-позиционный, с бк': 'клапан_DIx2_DOx2',
  'клапан по воздуху плавное регулирование с бк': 'клапан_DIx2_AIx1_AOx1', 'клапан по воде': 'клапан_воды_AIx1_AOx1',
  'управление эд без чрп': 'двигатель_DIx2_DOx1', 'управление эд с чрп': 'двигатель_ЧРП_DIx2_DOx1_AIx1_AOx1',
  'давления, температуры': 'датчик_AIx1', 'влажности': 'датчик_влажности_AIx1', 'капиллярный термостат': 'термостат_DIx1', 'прессостат (реле давления)': 'реле_DIx1',
  'циркуляционный насос (для каждого насоса отдельно)': 'насос_DIx2_DOx1', 'эк, 1 ступень с шим': 'ЭК_ШИМ_DIx2_DOx2', 'эк, остальные ступени (на одну ступень)': 'ЭК_DIx2_DOx1',
  'охладитель (на один контур)': 'охладитель_DIx2_DOx1', 'пароувлажнитель': 'увлажнитель_DIx2_DOx2_AOx1', 'срабатывание защиты эк по перегреву': 'ЭК_защита_DIx1',
  'статус "обогрев клапана" (для каждого клапана отдельно)': 'обогрев_клапана_DIx2',
};

const io = parseIoSheet(SHEET).rows.map((r) => ({ ...r, ...(COMPONENTS[r.name.toLowerCase()] ? { component: COMPONENTS[r.name.toLowerCase()] } : {}) }));
const sol = (id: string, mainClass: string, features: Record<string, string>, extra: Partial<E3Solution> = {}): E3Solution =>
  ({ id, mainClass, subclass: '', short: '', name: id, description: '', pdf: '', e3p: '', twoLevel: false, inCad: false, items: '', symbols: '', note: '', features, featuresConfirmed: true, ...extra });
const book = (solutions: E3Solution[], over: Partial<E3SolutionBook> = {}): E3SolutionBook => ({ ...emptySolutionBook(), solutions, ioTable: io, ...over });
const pos = (id: string, cls: string, extra: Partial<E3Position> = {}): E3Position => ({ id, cls, read: () => '', ...extra });
const sig = (r: { total: { di: number; do: number; ai: number; ao: number } }) => `${r.total.di}/${r.total.do}/${r.total.ai}/${r.total.ao}`;

const valve = (drive: string, drives = '1', extra: Record<string, string> = {}) => sol(`v-${drive}-${drives}`, 'Клапаны', { 'valve.drive': drive, 'valve.drives': drives, 'valve.heat_valve': 'нет', ...extra });
const owner = pos('v', 'КЛАПАН', { tag: 'V-1', role: 'БЛОК' });
const drive = (n: number) => pos(`d${n}`, 'ПРИВОД', { tag: `D-${n}`, parentTag: 'V-1', role: 'ПРИВОД' });

console.log('Клапан: привод по виду');
{
  const b = book([]);
  const spring = buildRecipeFor(valve('К'), owner, [], b);
  eq('пружинный с бк: 2 DI, 1 DO', sig(spring), '2/1/0/0');
  eq('пружинный: одно изделие с именем E3', spring.items.map((i) => [i.role, i.component]), [['Привод', 'клапан_DIx2_DOx1']]);
  eq('пружинный: замечаний нет', spring.issues, []);
  eq('3-позиционный: 2 DI, 2 DO', sig(buildRecipeFor(valve('КР'), owner, [], b)), '2/2/0/0');
  eq('плавный: 2 DI, 1 AI, 1 AO', sig(buildRecipeFor(valve('КПР'), owner, [], b)), '2/0/1/1');
  const two = buildRecipeFor(valve('К', '2'), owner, [drive(1), drive(2)], b);
  eq('два привода — два изделия, сигналы удвоены', [two.items.length, sig(two)], [2, '4/2/0/0']);
  eq('изделия привязаны к подпозициям Flux по порядку', two.items.map((i) => i.fromPosition), [{ role: 'ПРИВОД', index: 0 }, { role: 'ПРИВОД', index: 1 }]);
  eq('почему: ответ и порядковый номер', two.items[1].why.includes('Тип привода = К') && two.items[1].why.includes('2 из 2'), true);
  const three = buildRecipeFor(valve('КПР', '3'), owner, [], b);
  eq('три привода без подпозиций во Flux', [three.items.length, sig(three), three.items.some((i) => i.fromPosition)], [3, '6/0/3/3', false]);
  const mismatch = buildRecipeFor(valve('К', '2'), owner, [drive(1)], b);
  eq('подпозиций во Flux меньше, чем нужно блоку — замечание', mismatch.issues.some((t) => t.includes('подпозиций «ПРИВОД» — 1, а блоку нужно 2')), true);
  const heat = buildRecipeFor(valve('К', '1', { 'valve.heat_valve': 'да' }), owner, [], b);
  eq('обогрев клапана добавляет статус', [heat.items.map((i) => i.role), sig(heat)], [['Привод', 'Обогрев клапана'], '4/1/0/0']);
  eq('обогрев клапана двух приводов — один статус на клапан', buildRecipeFor(valve('К', '2', { 'valve.heat_valve': 'да' }), owner, [], b).items.filter((i) => i.role === 'Обогрев клапана').length, 1);
}

console.log('Вентилятор: двигатель с ЧРП и без');
{
  const fan = (start: string, extra: Record<string, string> = {}) => sol(`f-${start}`, 'Вентилятор', { 'fan.start': start, 'fan.control': 'без', ...extra });
  const b = book([]);
  const f = pos('f', 'ВЕНТИЛЯТОР', { tag: 'F-1' });
  eq('прямой пуск: ЭД без ЧРП, 2 DI 1 DO', [sig(buildRecipeFor(fan('ПП'), f, [], b)), buildRecipeFor(fan('ПП'), f, [], b).items[0].component], ['2/1/0/0', 'двигатель_DIx2_DOx1']);
  eq('звезда-треугольник и УПП — тоже без ЧРП', ['ЗТ', 'УППИ', 'УППВ'].map((s) => sig(buildRecipeFor(fan(s), f, [], b))), ['2/1/0/0', '2/1/0/0', '2/1/0/0']);
  eq('ПЧИ и ПЧВ: ЭД с ЧРП, 2 DI 1 DO 1 AI 1 AO', ['ПЧИ', 'ПЧВ'].map((s) => sig(buildRecipeFor(fan(s), f, [], b))), ['2/1/1/1', '2/1/1/1']);
  eq('двигатель привязан к подпозиции ДВИГАТЕЛЬ', buildRecipeFor(fan('ПЧИ'), f, [pos('m', 'ДВИГАТЕЛЬ', { tag: 'M-1', parentTag: 'F-1', role: 'ДВИГАТЕЛЬ' })], b).items[0].fromPosition, { role: 'ДВИГАТЕЛЬ', index: 0 });

  const ec = (n: string, start = 'ПП') => sol(`ec-${n}`, 'Вентилятор ЕС', { 'fanec.start': start, 'fanec.fans': n, 'fanec.control': 'без' });
  eq('ЕС-вентилятор — всегда с ЧРП, на каждый двигатель', [sig(buildRecipeFor(ec('3'), f, [], b)), buildRecipeFor(ec('3'), f, [], b).items.length], ['6/3/3/3', 3]);
  eq('ЕС без числа вентиляторов — замечание и нет изделий', [buildRecipeFor(sol('ec', 'Вентилятор ЕС', { 'fanec.start': 'ПП' }), f, [], b).items.length, buildRecipeFor(sol('ec', 'Вентилятор ЕС', { 'fanec.start': 'ПП' }), f, [], b).issues.some((t) => t.includes('Число вентиляторов'))], [0, true]);

  eq('датчик 4–20 мА на вентиляторе: +1 AI', sig(buildRecipeFor(fan('ПП', { 'fan.control': 'Д' }), f, [], b)), '2/1/1/0');
  eq('реле перепада: +1 DI', sig(buildRecipeFor(fan('ПП', { 'fan.control': 'Р' }), f, [], b)), '3/1/0/0');
  eq('у решения не задан способ пуска — правило не применяется, замечание', buildRecipeFor(sol('f', 'Вентилятор', {}), f, [], b).issues.some((t) => t.includes('Способ пуска')), true);
}

console.log('Датчики');
{
  const b = book([]);
  const s = (f: Record<string, string>) => sol('s', 'Датчики', { 'sensor.temp': 'нет', 'sensor.press': 'нет', 'sensor.humid': 'нет', ...f });
  const p = pos('s', 'ДАТЧИК');
  eq('датчик давления/температуры PT — 1 AI', sig(buildRecipeFor(s({ 'sensor.press': '1' }), p, [], b)), '0/0/1/0');
  eq('температура и влажность — два AI', sig(buildRecipeFor(s({ 'sensor.temp': '1', 'sensor.humid': '1' }), p, [], b)), '0/0/2/0');
  eq('влажность берёт строку MT', buildRecipeFor(s({ 'sensor.humid': '1' }), p, [], b).items[0].component, 'датчик_влажности_AIx1');
  eq('термостат TS — 1 DI (защита от замораживания у нагревателя)', sig(buildRecipeFor(sol('h', 'Нагреватель', { 'heater.type': 'ТО', 'heater.freeze': 'да' }), p, [], b)), '3/1/1/1');
}

console.log('Нагреватель, охладитель, увлажнитель');
{
  const b = book([]);
  const p = pos('h', 'НАГРЕВАТЕЛЬ', { tag: 'H-1' });
  const el = (stages: string, extra: Record<string, string> = {}) => sol('el', 'Нагреватель', { 'heater.type': 'Э', 'heater.stages': stages, 'heater.freeze': 'нет', 'heater.thermo': 'нет', ...extra });
  const one = buildRecipeFor(el('1'), p, [], b);
  eq('одна ступень: только первая, с ШИМ', [one.items.map((i) => i.role), sig(one)], [['Ступень ЭК с ШИМ'], '2/2/0/0']);
  const four = buildRecipeFor(el('4'), p, [], b);
  eq('четыре ступени: первая с ШИМ и три обычных', [four.items.map((i) => i.component), sig(four)], [['ЭК_ШИМ_DIx2_DOx2', 'ЭК_DIx2_DOx1', 'ЭК_DIx2_DOx1', 'ЭК_DIx2_DOx1'], '8/5/0/0']);
  eq('ноль ступеней — ничего не ставится', buildRecipeFor(el('0'), p, [], b).items.length, 0);
  eq('термоконтакты ТК2 — защита по перегреву', sig(buildRecipeFor(el('1', { 'heater.thermo': 'ТК2' }), p, [], b)), '3/2/0/0');
  const water = buildRecipeFor(sol('to', 'Нагреватель', { 'heater.type': 'ТО', 'heater.stages': '0', 'heater.freeze': 'нет', 'heater.thermo': 'нет' }), p, [], b);
  eq('жидкостный: клапан по воде и насос', [water.items.map((i) => i.role), sig(water)], [['Клапан по воде', 'Насос'], '2/1/1/1']);
  eq('жидкостный: насос привязан к подпозиции НАСОС', buildRecipeFor(sol('to', 'Нагреватель', { 'heater.type': 'ТО', 'heater.freeze': 'нет' }), p, [pos('n', 'НАСОС', { parentTag: 'H-1', role: 'НАСОС' })], b).items[1].fromPosition, { role: 'НАСОС', index: 0 });
  eq('охладитель — своя строка', sig(buildRecipeFor(sol('c', 'Охладитель', { 'cooler.model': 'МАКК' }), pos('c', 'ОХЛАДИТЕЛЬ'), [], b)), '2/1/0/0');
  eq('паровой увлажнитель — своя строка', sig(buildRecipeFor(sol('u', 'Увлажнители', { 'humid.type': 'ПУ' }), pos('u', 'УВЛАЖНИТЕЛЬ'), [], b)), '2/2/0/1');
  const comb = buildRecipeFor(sol('u2', 'Увлажнители', { 'humid.type': 'СУ' }), pos('u', 'УВЛАЖНИТЕЛЬ'), [], b);
  eq('сотовый: для него правил нет — пусто и сказано об этом', [comb.items.length, comb.issues.length], [0, 1]);
}

console.log('Чего нет — замечание, а не выдумка');
{
  const f = pos('f', 'ВЕНТИЛЯТОР', { tag: 'F-1' });
  const s = sol('f', 'Вентилятор', { 'fan.start': 'ПЧИ', 'fan.control': 'без' });
  const noName = book([], { ioTable: io.map((r) => ({ ...r, component: undefined })) });
  const r1 = buildRecipeFor(s, f, [], noName);
  eq('нет имени изделия: сигналы посчитаны, изделие без имени, замечание', [sig(r1), r1.items[0].component, r1.issues.some((t) => t.includes('не задано имя изделия E3'))], ['2/1/1/1', undefined, true]);
  const noRow = book([], { ioTable: io.filter((r) => !r.name.includes('с ЧРП')) });
  const r2 = buildRecipeFor(s, f, [], noRow);
  eq('нет строки IO: изделий нет, замечание называет строку', [r2.items.length, r2.issues.some((t) => t.includes('нет строки') && t.includes('ЭД с ЧРП'))], [0, true]);
  const r3 = buildRecipeFor(s, f, [], book([], { ioTable: [] }));
  eq('таблица IO не загружена — одно замечание, а не по замечанию на правило', [r3.items.length, r3.issues.length, r3.issues[0].includes('не загружена')], [0, 1, true]);
  const r4 = buildRecipeFor(sol('x', 'Выдуманный класс', {}), f, [], book([]));
  eq('у класса нет правил — подсказка про ручной состав', r4.issues[0].includes('вручную'), true);
  const twice = buildRecipeFor(sol('ec', 'Вентилятор ЕС', { 'fanec.start': 'ПП', 'fanec.fans': '2', 'fanec.control': 'без' }), f, [], noName);
  eq('одно замечание про строку, сколько бы изделий ни было', twice.issues.filter((t) => t.includes('не задано имя')).length, 1);
}

console.log('Ручной состав сильнее правил');
{
  const b = book([]);
  const s = valve('К', '1', { }); s.recipeOverride = [{ role: 'Привод', row: { name: '3-позиционный' }, count: 2 }, { role: 'Датчик', row: { group: 'Датчики', code: 'TS' }, count: 1 }];
  const r = buildRecipeFor(s, owner, [], b);
  eq('состав — как задан, а не по правилам', [r.items.map((i) => i.component), sig(r)], [['клапан_DIx2_DOx2', 'клапан_DIx2_DOx2', 'термостат_DIx1'], '5/4/0/0']);
  eq('почему: задано вручную', r.items[0].why.startsWith('Задано вручную'), true);
  eq('пустой ручной состав — работают правила', sig(buildRecipeFor({ ...s, recipeOverride: [] }, owner, [], b)), '2/1/0/0');
  const bad = buildRecipeFor({ ...s, recipeOverride: [{ role: 'Привод', row: { name: 'нет такой' }, count: 1 }] }, owner, [], b);
  eq('ручная строка без строки IO — замечание', [bad.items.length, bad.issues.length], [0, 1]);
  const text = '  Привод | пружинный, с бк | 2\nДатчик | код:TS | 1 | Датчики\n\nМотор | ЭД с ЧРП | 1 | | ДВИГАТЕЛЬ';
  const parsed = parseRecipeLines(text);
  eq('текст ручного состава разбирается', [parsed.errors, parsed.lines.map((l) => [l.role, l.row, l.count, l.fromRole])], [[], [['Привод', { name: 'пружинный, с бк' }, 2, undefined], ['Датчик', { code: 'TS', group: 'Датчики' }, 1, undefined], ['Мотор', { name: 'ЭД с ЧРП' }, 1, 'ДВИГАТЕЛЬ']]]);
  eq('текст и обратно', parseRecipeLines(recipeLinesText(parsed.lines)).lines, parsed.lines);
  eq('ошибки текста по строкам', parseRecipeLines('| x | 1\nПривод\nПривод | x | 0\nПривод | x | два').errors.length, 4);
}

console.log('От позиции до рецепта: подбор и состав вместе');
{
  const v1 = valve('К'); const v2 = valve('КПР');
  const b = book([{ ...v1, id: 'a', features: { ...v1.features, 'valve.voltage': '24' } }, { ...v2, id: 'b', features: { ...v2.features, 'valve.voltage': '24' } }]);
  const valvePos = pos('v', 'КЛАПАН', { tag: 'V-1', read: () => '' });
  const prv = { ...pos('d1', 'ПРИВОД', { tag: 'D-1', parentTag: 'V-1', role: 'ПРИВОД' }), read: (s: any) => (s.kind === 'field' ? (s.key === 'kind' ? 'С возвратной пружиной' : '') : '24') };
  const selection = selectSolution(valvePos, [valvePos, prv], { ...b, rules: b.rules.filter((r) => r.mainClass === 'Клапаны') }, {});
  eq('подобрано одно решение', selection.status, 'one');
  const recipe = buildRecipe(selection, valvePos, [valvePos, prv], b);
  eq('рецепт по подобранному решению', [recipe.solutionId, recipe.items.length], [selection.solution?.id, 1]);
  const many = buildRecipe({ status: 'many', candidates: [], answers: [], nearest: [] }, valvePos, [], b);
  eq('решение не выбрано — рецепта нет, причина названа', [many.items.length, many.issues[0].includes('не выбрано')], [0, true]);
  const none = buildRecipe({ status: 'none', candidates: [], answers: [], nearest: [] }, valvePos, [], b);
  eq('решения нет — рецепта нет', [none.items.length, none.issues[0].includes('Решения нет')], [0, true]);
}

if (failed) { console.error(`\nПровалено проверок: ${failed}`); process.exit(1); }
console.log('\nВсе проверки пройдены');
