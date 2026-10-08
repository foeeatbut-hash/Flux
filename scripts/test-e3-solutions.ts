/**
 * Каталог типовых решений E3: разбор «Классификатора» и «Обозначений», признаки
 * по названию, план загрузки, подбор решения для позиции, выгрузка в Excel.
 *
 * Листы ниже — синтетические, но с теми же изъянами, что у настоящих: шапка не
 * в первой строке, двухстрочные заголовки, пробелы по краям значений, два
 * решения с одним названием схемы, латинская «K» вместо «К», повтор ID, пустая
 * строка. Файл владельца в репозиторий не кладётся.
 *
 * Запуск: npx tsx scripts/test-e3-solutions.ts
 */
import * as XLSX from 'xlsx';
import {
  parseSolutionSheet, parseDictionarySheet, suggestFeatures, planSolutions, applySolutionPlan, mergeDictionary, selectSolution, emptySolutionBook,
  sanitizeFeature, sanitizeRule, sanitizeProfile, sanitizeDictionary, sanitizeClassMap, validateSolutions, planMissingDefaults, applyMissingDefaults,
  DEFAULT_FEATURES, DEFAULT_RULES, DEFAULT_IO_RULES, DEFAULT_CLASS_MAP, type E3Position, type E3Solution, type E3SolutionBook, type E3Profile,
} from '../e3/solutions';
import { solutionRows, solutionWorkbookBytes, solutionNames, solutionNamesFile, CLASSIFIER_HEADERS, CLASSIFIER_SHEET } from '../e3/solutionWorkbook';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failed++;
  console.error(`  ✗ ${name} — получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`);
};

const HEAD = [...CLASSIFIER_HEADERS];
const row = (id: string, cls: string, sub: string, short: string, name: string, desc = '', two = '', cad = '', items = ''): unknown[] =>
  [id, cls, sub, short, name, desc, '', '', two, cad, items, '', ''];

const SHEET: unknown[][] = [
  ['Классификатор'],
  HEAD,                                                                                              // 2
  row('08.01.01', 'Клапаны ', 'Клапан с электроприводом. Возвратная пружина', 'К', 'Клапан_К24', 'Пружина 24 В', 'Нет'),   // 3
  row('08.01.03', 'Клапаны', 'Клапан с электроприводом. Возвратная пружина', 'К', 'Клапан_К24_КП2'),               // 4
  row('08.01.02', 'Клапаны', 'Клапан с электроприводом. Возвратная пружина', 'К', 'Клапан_К24_КП1'),               // 5
  row('08.01.07', 'Клапаны', 'Клапан с электроприводом. Возвратная пружина', 'К', 'Клапан_К24_КП2_К'),            // 6 «К» — неоднозначно
  row('08.01.35', 'Клапаны', 'Клапан с электроприводом. Возвратная пружина', 'К ', 'Клапан_К24_КП2_ПОК_ОП'),       // 7
  row('08.01.36', 'Клапаны', 'Клапан с электроприводом. Возвратная пружина', 'К', 'Клапан_К24_КП2_К_ПОК_ОП'),      // 8
  row('08.01.37', 'Клапаны', 'Клапан с электроприводом. Возвратная пружина', 'К', 'Клапан_2К24_КП2_ПОК_ОП'),       // 9
  row('08.01.12', 'Клапаны', 'Клапан с электроприводом. Возвратная пружина', 'К', 'Клапан_К230'),                 // 10
  row('08.02.01', 'Клапаны', 'Клапаны с электроприводом. Реверсивный', 'КР', 'Клапан_КР24'),                       // 11
  row('01.02.41', 'Вентилятор', 'Вентилятор с датчиком 4-20мА', 'ПЧИД', 'Вентилятор_ПЧИД_К_РТС_ОСВ'),             // 12
  row('01.02.42', 'Вентилятор', 'Вентилятор с датчиком 4-20мА', 'ПЧИД', 'Вентилятор_ПЧИД_К_РТС_ОСВ_Влево'),        // 13
  row('01.01.01', 'Вентилятор', 'Вентилятор без датчика', 'ПП', 'Вентилятор_ПП_К_РТС'),                            // 14
  row('01.01.02', 'Вентилятор', 'Вентилятор без датчика', 'ПП230', 'Вентилятор_ПП230_К_РТС'),                      // 15
  row('01.01.03', 'Вентилятор', 'Вентилятор без датчика', 'ПЧИ', 'Вентилятор_ПЧИ_К_РТС'),                          // 16
  row('01.01.04', 'Вентилятор', 'Вентилятор без датчика', 'ПЧИ', 'Вентилятор_ПЧИ_К_2РТС'),                         // 17
  row('02.01.02', 'Вентилятор ЕС', 'Вентилятор без датчика/реле', 'ПП_ЕС', 'Вентилятор_ПП_ЕС_К_1'),                // 18 цифра
  row('02.01.03', 'Вентилятор ЕС', 'Вентилятор без датчика/реле', 'ПП_ЕС', 'Вентилятор_ПП_ЕС_К_2'),                // 19
  row('04.02.26', 'Нагреватель', 'Электрический воздухонагреватель', 'Э', 'Нагреватель_Э230_ТК2_K'),               // 20 латинская K
  row('04.01.01', 'Нагреватель', 'Водяной воздухонагреватель', 'ТО', 'Нагреватель_ТО_Т'),                          // 21
  row('03.02.01', 'Фильтры', 'Фильтр с датчиком', 'ФВД', 'Фильтр_ФВД'),                                          // 22
  row('03.04.01', 'Фильтры', 'Фильтр с датчиком', 'ФВД', 'Фильтр_ФВД_2_шт'),                                     // 23
  row('11.02.05', 'Начало установки', '1 уровень', 'Начало_1УР', 'Начало_1УР', '', 'Нет', 'Да'),                  // 24
  row('11.01.01', 'Начало установки', '1 уровень', 'Начало_1УР', 'Начало_1УР', '', '', ''),                      // 25 то же название
  row('10.06.05', 'Коробка', 'Коробка для подключения привода', 'КОРВ-88', 'КОРВ-88 тип 6.1_Пруж', 'Коробка 1 привода', '', '', 'Двигатель 3Ф+PTC; Датчик 4–20 мА'),
  [null, null, null],                                                                                    // 27 пустая
  row('08.01.03', 'Клапаны', 'Повтор ID', 'К', 'Клапан_К24_КП2_повтор'),                                          // 28 повтор ID
  row('', 'Клапаны', '', 'К', 'Клапан_без_ID'),                                                              // 29 без ID
];

const DICT_SHEET: unknown[][] = [
  ['Обозначение в классификаторе', '', '', '', 'Обозначение в классификаторе', 'Краткое описание'],
  ['ПП – прямой пуск двигателя вентилятора;', '', '', '', 'СВ', 'Сервисный выключатель'],
  ['ПЧ – пуск посредством преобразователя частоты;', '', '', '', 'РТС', 'Датчики температуры'],
  ['', '', '', '', 'ПП', 'Прямой пуск'],
  ['', '', '', '', 'ПЧИ', 'Преобразователь частоты, в шкафу'],
  ['', '', '', '', 'КП2', 'Концевой переключатель 2 ПК контакта'],
  ['', '', '', '', 'ТЕ', 'Преобразователь температуры'],
  ['', '', '', '', 'ТЕ', 'Датчик температуры, головка 4-20мА'],
  ['', '', '', '', 'KL', 'Соленоидный клапан'],
];

console.log('Словарь «Обозначения»');
const dict = parseDictionarySheet(DICT_SHEET);
eq('словарь берётся из правой пары столбцов, легенда слева не читается', Object.keys(dict.dictionary), ['СВ', 'РТС', 'ПП', 'ПЧИ', 'КП2', 'ТЕ', 'KL']);
eq('повтор кода — замечание и первое описание', [dict.issues.length, dict.dictionary['ТЕ']], [1, 'Преобразователь температуры']);
eq('лист без столбцов словаря', parseDictionarySheet([['a', 'b']]).issues.length, 1);

console.log('Разбор классификатора');
const ctx = { features: DEFAULT_FEATURES, dictionary: dict.dictionary };
const parsed = parseSolutionSheet(SHEET, ctx);
const by = (id: string) => parsed.items.find((s) => s.id === id)!;
const issue = (re: RegExp) => parsed.issues.filter((i) => re.test(i));
{
  eq('решений: пустая строка, повтор ID и строка без ID не считаются', parsed.items.length, 24);
  eq('значения без пробелов по краям', [by('08.01.01').mainClass, by('08.01.35').short], ['Клапаны', 'К']);
  eq('о пробелах по краям сказано словами', issue(/Пробелы по краям/).length, 1);
  eq('поля листа', [by('11.02.05').twoLevel, by('11.02.05').inCad, by('08.01.01').twoLevel, by('08.01.01').description], [false, true, false, 'Пружина 24 В']);
  eq('список изделий читается', by('10.06.05').items, 'Двигатель 3Ф+PTC; Датчик 4–20 мА');
  eq('повтор названия схемы при разных ID — замечание, оба решения на месте', [issue(/«Начало_1УР»/).length, by('11.02.05').name, by('11.01.01').name], [1, 'Начало_1УР', 'Начало_1УР']);
  eq('повтор ID — замечание, взята первая строка', [issue(/08\.01\.03: ID в файле дважды/).length, by('08.01.03').name], [1, 'Клапан_К24_КП2']);
  eq('строка без ID — замечание', issue(/нет ID решения/).length, 1);
  eq('латинская K — замечание, имя блока не тронуто', [issue(/Латинская буква/).length, by('04.02.26').name], [1, 'Нагреватель_Э230_ТК2_K']);
  eq('первое замечание — сколько ждёт подтверждения', /^Признаки разобраны из названий: подтверждения ждут \d+ из 24$/.test(parsed.issues[0]), true);
  eq('лист без заголовков', parseSolutionSheet([['x']], ctx).items.length, 0);
  eq('имя решения не пустое во всех', parsed.items.every((s) => s.name), true);
}

console.log('Признаки по названию');
{
  eq('клапан: тип, напряжение, число приводов', [by('08.01.01').features['valve.drive'], by('08.01.01').features['valve.voltage'], by('08.01.01').features['valve.drives']], ['К', '24', '1']);
  eq('клапан: «2К24» — два привода', by('08.01.37').features['valve.drives'], '2');
  eq('клапан: КР — реверсивный', by('08.02.01').features['valve.drive'], 'КР');
  eq('клапан: концевые и обогрев', [by('08.01.35').features['valve.limit'], by('08.01.35').features['valve.heat_valve'], by('08.01.35').features['valve.heat_drive']], ['КП2', 'да', 'да']);
  eq('отсутствие признака в названии — «нет»', [by('08.01.01').features['valve.limit'], by('08.01.01').features['valve.heat_valve']], ['нет', 'нет']);
  eq('без неоднозначного разбор подтверждён сам', [by('08.01.01').featuresConfirmed, by('08.01.35').featuresConfirmed], [true, true]);
  eq('«К» у клапана без напряжения — на подтверждение, принято как коробка', [by('08.01.07').featuresConfirmed, by('08.01.07').features['valve.box'], issue(/08\.01\.07 .*«К»/).length], [false, 'К', 1]);
  eq('вентилятор: пуск, контроль, фазы', [by('01.02.41').features['fan.start'], by('01.02.41').features['fan.control'], by('01.02.41').features['fan.phases']], ['ПЧИ', 'Д', '3ф']);
  eq('вентилятор: ПП230 — пуск ПП, одна фаза', [by('01.01.02').features['fan.start'], by('01.01.02').features['fan.phases']], ['ПП', '1ф']);
  eq('вентилятор: коробка, защита, освещение', [by('01.02.41').features['fan.box'], by('01.02.41').features['fan.motor_prot'], by('01.02.41').features['fan.light']], ['К', 'РТС', 'да']);
  eq('вентилятор: 2РТС и «Влево» с большой буквы', [by('01.01.04').features['fan.motor_prot'], by('01.02.42').features['fan.turn']], ['2РТС', 'да']);
  eq('«К» у вентилятора — коробка, без вопросов', [by('01.01.01').features['fan.box'], by('01.01.01').featuresConfirmed], ['К', true]);
  eq('ЕС: цифра после «_» — число вентиляторов, на подтверждение', [by('02.01.02').features['fanec.fans'], by('02.01.02').featuresConfirmed, issue(/02\.01\.02 .*число вентиляторов/).length], ['1', false, 1]);
  eq('ЕС: «ЕС» — маркер класса, а не признак', by('02.01.02').features['fanec.start'], 'ПП');
  eq('нагреватель: латинская K принята за кириллическую', [by('04.02.26').features['heater.boxes'], by('04.02.26').features['heater.supply'], by('04.02.26').features['heater.thermo']], ['1', '230', 'ТК2']);
  eq('нагреватель: Т — термостат, ТО — жидкостный', [by('04.01.01').features['heater.type'], by('04.01.01').features['heater.freeze']], ['ТО', 'да']);
  eq('фильтр: «2_шт» — двойной', [by('03.04.01').features['filter.double'], by('03.04.01').features['filter.control'], by('03.02.01').features['filter.double']], ['да', 'Д', 'нет']);
  const bare = suggestFeatures({ mainClass: 'Класс без признаков', name: 'Что-то_К' }, ctx);
  eq('класс без признаков: нечего подтверждать', [bare.features, bare.confirmed], [{}, true]);
  eq('начало установки: уровень назван, остальное — «нет»', [by('11.02.05').features, by('11.02.05').featuresConfirmed], [{ 'begin.levels': '1УР', 'begin.flow': 'не указан', 'begin.inlet': 'нет', 'begin.recup': 'нет' }, true]);
  eq('токен вне словаря и правил — «не разобрано» и подтверждение', suggestFeatures({ mainClass: 'Клапаны', name: 'Клапан_К24_НОВЫЙ' }, ctx).unknown.includes('НОВЫЙ'), true);
  eq('цифры после «_»: у нагревателя это ступени', suggestFeatures({ mainClass: 'Нагреватель', name: 'Нагреватель_Э_4_ТК2' }, ctx).features['heater.stages'], '4');
  eq('цифры после «К» у нагревателя — коробки, а не ступени', suggestFeatures({ mainClass: 'Нагреватель', name: 'Нагреватель_ТО_Т_К_3' }, ctx).features['heater.boxes'], '3');
  const custom = DEFAULT_FEATURES.map((f) => (f.id === 'valve.drive' ? { ...f, values: [...f.values, 'КНОВ'] } : f));
  eq('новое значение признака узнаётся без правки кода', suggestFeatures({ mainClass: 'Клапаны', name: 'Клапан_КНОВ_КП2' }, { features: custom, dictionary: {} }).features['valve.drive'], 'КНОВ');
  eq('код вне словаря назван', suggestFeatures({ mainClass: 'Клапаны', name: 'Клапан_К24_ЭПВ' }, ctx).notInDictionary.includes('ЭПВ'), true);
}

console.log('План загрузки и применение');
const empty = emptySolutionBook();
let book: E3SolutionBook;
{
  const plan = planSolutions([], parsed.items, { current: {}, incoming: dict.dictionary });
  eq('первая загрузка: все новые', [plan.added.length, plan.changed.length, plan.same, plan.missing.length], [24, 0, 0, 0]);
  eq('словарь: все коды новые', plan.dictionaryAdded.length, 7);
  const items = applySolutionPlan([], parsed.items, { missing: 'keep' });
  book = { ...empty, version: 1, solutions: items, dictionary: mergeDictionary({}, dict.dictionary) };
  eq('применение сохраняет порядок файла', items.map((s) => s.id).slice(0, 3), ['08.01.01', '08.01.03', '08.01.02']);

  // Правка вручную и повторная загрузка
  const edited = items.map((s) => (s.id === '08.01.01' ? { ...s, description: 'Моя правка', edited: true } : s));
  const next = parsed.items.filter((s) => s.id !== '08.01.12').map((s) => (s.id === '08.01.01' ? { ...s, description: 'Из файла' } : s.id === '08.01.35' ? { ...s, description: 'Новое описание' } : s));
  const plan2 = planSolutions(edited, next);
  eq('повторная загрузка: правленое оставлено', plan2.editedKept, ['08.01.01']);
  eq('изменённое поле названо', plan2.changed.map((c) => [c.id, c.fields]), [['08.01.35', ['description']]]);
  eq('пропавшее названо', plan2.missing, ['08.01.12']);
  eq('без изменений — остальные', plan2.same, 21);
  const kept = applySolutionPlan(edited, next, { missing: 'keep' });
  eq('правленое описание живо, чужое обновилось', [kept.find((s) => s.id === '08.01.01')!.description, kept.find((s) => s.id === '08.01.35')!.description], ['Моя правка', 'Новое описание']);
  eq('пропавшее оставлено', kept.find((s) => s.id === '08.01.12')!.removed, undefined);
  const removed = applySolutionPlan(edited, next, { missing: 'remove' });
  eq('пропавшее снято, но не удалено', [removed.find((s) => s.id === '08.01.12')!.removed, removed.length], [true, 24]);
  const back = applySolutionPlan(removed, parsed.items, { missing: 'keep' });
  eq('вернулось в файл — снятие пропало', back.find((s) => s.id === '08.01.12')!.removed, undefined);
  eq('признаки существующего решения загрузка не трогает', applySolutionPlan(items.map((s) => (s.id === '08.01.01' ? { ...s, features: { ...s.features, 'valve.epv': 'да' }, featuresConfirmed: true } : s)), parsed.items, { missing: 'keep' }).find((s) => s.id === '08.01.01')!.features['valve.epv'], 'да');
  eq('словарь: свои описания не перезаписываются', mergeDictionary({ ПП: 'Моё' }, { ПП: 'Файл', НОВ: 'Новый' }), { ПП: 'Моё', НОВ: 'Новый' });
  eq('словарь: расхождение показано', planSolutions([], [], { current: { ПП: 'Моё' }, incoming: { ПП: 'Файл' } }).dictionaryDiffers, ['ПП']);
}

console.log('Подбор решения для позиции');
{
  const P = (id: string, cls: string, o: { tag?: string; role?: string; parentTag?: string; params?: Record<string, string>; fields?: Record<string, string>; layout?: Record<string, string> } = {}): E3Position => ({
    id, cls, role: o.role, tag: o.tag, parentTag: o.parentTag, layout: o.layout,
    read: (s) => (s.kind === 'param' ? o.params?.[s.name] ?? '' : s.kind === 'field' ? o.fields?.[s.key] ?? '' : ''),
  });
  const valve = P('v1', 'КЛАПАН', { tag: 'K-1', role: 'БЛОК' });
  const drive = P('d1', 'КЛАПАН', { role: 'ПРИВОД', parentTag: 'K-1', params: { 'Напряжение питания': '24' }, fields: { kind: 'С возвратной пружиной' } });
  const sib = [valve, drive];
  const sel = (profile: E3Profile = {}, manual?: Record<string, string>, pos = valve, siblings = sib) => selectSolution(pos, siblings, book, profile, manual);

  const many = sel();
  eq('нет ответов профиля — несколько решений, спрашиваем концевые выключатели', [many.status, many.missingFeature], ['many', 'valve.limit']);
  eq('ответы из подбора ОВ названы источником', many.answers.map((a) => [a.feature, a.value, a.from]), [['valve.drive', 'К', 'ov'], ['valve.voltage', '24', 'ov'], ['valve.drives', '1', 'ov']]);

  const withProfile = sel({ 'valve.limit': 'КП2', 'valve.box': 'нет' });
  eq('профиль сужает, но ПОК/ОП ещё не названы', [withProfile.status, withProfile.missingFeature, withProfile.candidates.map((s) => s.id)], ['many', 'valve.heat_valve', ['08.01.03', '08.01.35']]);
  const one = sel({ 'valve.limit': 'КП2', 'valve.box': 'нет' }, { 'valve.heat_valve': 'нет' });
  eq('ручной ответ выбирает единственное решение', [one.status, one.solution?.id, one.answers.find((a) => a.feature === 'valve.heat_valve')?.from], ['one', '08.01.03', 'manual']);
  eq('профиль — источник «profile»', one.answers.find((a) => a.feature === 'valve.limit')?.from, 'profile');

  // Порядок силы: ручной → ОВ → профиль
  eq('ОВ сильнее профиля', sel({ 'valve.voltage': '230' }).answers.find((a) => a.feature === 'valve.voltage'), { feature: 'valve.voltage', value: '24', from: 'ov' });
  eq('ручной сильнее ОВ', sel({}, { 'valve.voltage': '230' }).answers.find((a) => a.feature === 'valve.voltage'), { feature: 'valve.voltage', value: '230', from: 'manual' });
  eq('ручной сильнее профиля', sel({ 'valve.limit': 'КП1' }, { 'valve.limit': 'КП2' }).answers.find((a) => a.feature === 'valve.limit'), { feature: 'valve.limit', value: 'КП2', from: 'manual' });
  eq('профиль отвечает, когда ОВ нет данных', sel({ 'valve.voltage': '230' }, undefined, valve, [valve]).answers.find((a) => a.feature === 'valve.voltage'), { feature: 'valve.voltage', value: '230', from: 'profile' });
  eq('раскладка отвечает на свой признак', selectSolution(P('f', 'ФИЛЬТР', { layout: { 'filter.turn': 'да' } }), [], book, {}).answers.find((a) => a.feature === 'filter.turn')?.from, 'layout');
  eq('число приводов — число подпозиций', selectSolution(valve, [valve, drive, P('d2', 'КЛАПАН', { role: 'ПРИВОД', parentTag: 'K-1' })], book, {}).answers.find((a) => a.feature === 'valve.drives')?.value, '2');

  const two = sel({ 'valve.limit': 'КП2', 'valve.box': 'нет' }, { 'valve.heat_valve': 'да', 'valve.heat_drive': 'да' });
  eq('другое сочетание — другое решение', two.solution?.id, '08.01.35');

  // Ни одного решения: ближайшие и чем отличаются
  const none = sel({ 'valve.limit': 'КП1', 'valve.box': 'К' });
  eq('такой комбинации нет — «none»', none.status, 'none');
  eq('ближайшие первыми и с отличиями', [none.nearest[0].solution.id, none.nearest[0].diff.length], ['08.01.02', 1]);
  eq('ближайших не больше пяти', none.nearest.length <= 5, true);
  eq('у ближайшего названо, чем отличается', none.nearest[0].diff[0], { feature: 'valve.box', want: 'К', have: 'нет' });
  eq('тип Flux без класса решений — «none» без ближайших', selectSolution(P('x', 'НАСОС'), [], book, {}).nearest, []);
  eq('снятые решения не подбираются', selectSolution(valve, sib, { ...book, solutions: book.solutions.map((s) => ({ ...s, removed: true })) }, {}).candidates.length, 0);

  // Порог профиля: до 7,5 кВт — ПП, больше — ПЧИ
  const motor = (kw: string) => P('m', 'ВЕНТИЛЯТОР', { role: 'ДВИГАТЕЛЬ', parentTag: 'F-1', params: { Мощность: kw, Напряжение: '380' } });
  const fan = P('f1', 'ВЕНТИЛЯТОР', { tag: 'F-1', role: 'БЛОК' });
  const threshold: E3Profile = {
    'fan.start': { source: { kind: 'child-param', role: 'ДВИГАТЕЛЬ', name: 'Мощность', unit: 'кВт' }, steps: [{ upTo: 7.5, answer: 'ПП' }], above: 'ПЧИ' },
    'fan.control': 'без', 'fan.box': 'К', 'fan.light': 'нет', 'fan.service': 'нет',
  };
  const small = selectSolution(fan, [fan, motor('5,5')], book, threshold, { 'fan.motor_prot': 'РТС' });
  eq('порог: 5,5 кВт — ПП', [small.answers.find((a) => a.feature === 'fan.start')?.value, small.status, small.solution?.id], ['ПП', 'one', '01.01.01']);
  const edge = selectSolution(fan, [fan, motor('7.5')], book, threshold, { 'fan.motor_prot': 'РТС' });
  eq('порог: ровно 7,5 — ещё ПП', edge.answers.find((a) => a.feature === 'fan.start')?.value, 'ПП');
  const big = selectSolution(fan, [fan, motor('11')], book, threshold, { 'fan.motor_prot': 'РТС' });
  eq('порог: 11 кВт — ПЧИ', [big.answers.find((a) => a.feature === 'fan.start')?.value, big.solution?.id], ['ПЧИ', '01.01.03']);
  eq('порог без числовой мощности ответа не даёт', selectSolution(fan, [fan], book, threshold, {}).answers.some((a) => a.feature === 'fan.start'), false);
  const noProt = selectSolution(fan, [fan, motor('11')], book, threshold, {});
  eq('защита двигателя без ответа — «many», спрашиваем её', [noProt.status, noProt.missingFeature], ['many', 'fan.motor_prot']);

  // Класс ЕС выбирает правило @class
  const ecMotor = P('em', 'ВЕНТИЛЯТОР', { role: 'ДВИГАТЕЛЬ', parentTag: 'F-2', params: { 'Тип двигателя': 'EC-мотор' } });
  const ecFan = P('f2', 'ВЕНТИЛЯТОР', { tag: 'F-2', role: 'БЛОК' });
  const ec = selectSolution(ecFan, [ecFan, ecMotor], book, { 'fanec.start': 'ПП', 'fanec.control': 'без', 'fanec.box': 'К' }, { 'fanec.fans': '2' });
  eq('ЕС-двигатель: решения класса «Вентилятор ЕС»', [ec.answers[0], ec.solution?.id], [{ feature: '@class', value: 'Вентилятор ЕС', from: 'ov' }, '02.01.03']);
  const plain = selectSolution(fan, [fan, motor('1')], book, {}, {});
  eq('обычный двигатель: класс «Вентилятор»', plain.answers[0], { feature: '@class', value: 'Вентилятор', from: 'ov' });
}

console.log('Новые классы: признаки из названий');
{
  const ctx = { features: DEFAULT_FEATURES, dictionary: {} };
  const f = (mainClass: string, name: string, subclass = '') => suggestFeatures({ mainClass, name, subclass }, ctx);
  const ONE = { 'sensor.temp': '1', 'sensor.press': 'нет', 'sensor.humid': 'нет' };
  eq('датчик: один температуры', f('Датчики', 'Д_Т_1_шт').features, ONE);
  eq('датчики: два вида по одному', f('Датчики', 'Д_Т_1_шт_Д_В_1_шт').features, { 'sensor.temp': '1', 'sensor.humid': '1', 'sensor.press': 'нет' });
  eq('датчики: давление и влажность', f('Датчики', 'Д_Д_1_шт_Д_В_1_шт').features, { 'sensor.press': '1', 'sensor.humid': '1', 'sensor.temp': 'нет' });
  eq('датчики: разобрано уверенно', [f('Датчики', 'Д_Т_1_шт_Д_Д_1_шт').confirmed, f('Датчики', 'Д_Т_1_шт_Д_Д_1_шт').unknown], [true, []]);
  eq('датчики: незнакомый хвост — «не разобрано»', f('Датчики', 'Д_Т_1_шт_Д_Х_1_шт').unknown.length > 0, true);

  eq('узел регулирующий: схема и типоразмер', f('Узел регулирующий', 'УР_ВЕКТОР_4ПГ_4ПУ_1_5').features, { 'wss.scheme': '4', 'wss.size': '1-5' });
  eq('узел регулирующий: «ПГ/ПУ» и диапазон 6–11', f('Узел регулирующий', 'УР_ВЕКТОР_5ПГ/ПУ_6_11').features, { 'wss.scheme': '5', 'wss.size': '6-11' });
  eq('узел регулирующий: без диапазона — «любой»', f('Узел регулирующий', 'УР_ВЕКТОР_6ПГ/ПУ').features, { 'wss.scheme': '6', 'wss.size': 'любой' });
  eq('узел регулирующий: разобрано уверенно', f('Узел регулирующий', 'УР_ВЕКТОР_4ПГ/ПУ_6_11').confirmed, true);

  eq('начало: двухуровневое приточно-вытяжное с рекуперацией', f('Начало установки', 'Начало_2УР_ПВ_Р').features, { 'begin.levels': '2УР', 'begin.flow': 'ПВ', 'begin.recup': 'Р', 'begin.inlet': 'нет' });
  eq('начало: без рекуперации', f('Начало установки', 'Начало_2УР_ПВ_БР').features['begin.recup'], 'БР');
  eq('начало: раздельный вход', f('Начало установки', 'Начало_2УР_П_РВ').features, { 'begin.levels': '2УР', 'begin.flow': 'П', 'begin.inlet': 'РВ', 'begin.recup': 'нет' });
  const typo = f('Начало установки', 'Начало_2УР_ПР_ОВ');
  eq('начало: «ПР» принято за «П» и отдано на подтверждение', [typo.features['begin.flow'], typo.features['begin.inlet'], typo.confirmed, typo.ambiguous[0]?.token], ['П', 'ОВ', false, 'ПР']);
  eq('начало: одноуровневое — остальное «не указан» / «нет»', f('Начало установки', 'Начало_1УР').features, { 'begin.levels': '1УР', 'begin.flow': 'не указан', 'begin.inlet': 'нет', 'begin.recup': 'нет' });
  eq('конец: общий выход', f('Конец установки', 'Конец_2УР_П_ОВ').features, { 'end.levels': '2УР', 'end.flow': 'П', 'end.outlet': 'ОВ' });
  eq('конец: приточно-вытяжной', f('Конец установки', 'Конец_2УР_ПВ').features['end.flow'], 'ПВ');
  eq('конец: признаки начала сюда не попадают', Object.keys(f('Конец установки', 'Конец_1УР').features).some((k) => k.startsWith('begin.')), false);

  const drive = f('Коробка', 'КОРВ-88 тип 6.1_пружина-2ПК', 'Коробка для подключения привода');
  eq('коробка привода: назначение из подкласса, пружина и 2ПК из названия', drive.features, { 'box.purpose': 'привод', 'box.drive': 'пружинный', 'box.limit': '2ПК' });
  eq('коробка привода разобрана без догадок', [drive.confirmed, drive.notInDictionary], [true, []]);
  eq('коробка: реверсивный', f('Коробка', 'КОРВ-88 тип 6.1_реверсивный-2ПК', 'Коробка для подключения привода').features['box.drive'], 'реверсивный');
  eq('коробка обогрева и КИП', [f('Коробка', 'КОРВ-74 тип 2.1', 'Силовая коробка для подключения обогрева').features['box.purpose'], f('Коробка', 'КОРВ-85 тип 4.1', 'Коробка КИП').features['box.purpose']], ['обогрев', 'КИП']);
  eq('коробка: подкласс непонятен — на подтверждение', f('Коробка', 'КОРВ-1', 'Что-то иное').confirmed, false);
  eq('воздуховод: проходной и пустой', [f('Воздуховод', 'Проходной').features, f('Воздуховод', 'Блок пусто').features], [{ 'duct.kind': 'проходной' }, { 'duct.kind': 'пустой' }]);
  eq('воздуховод: незнакомое название — на подтверждение', f('Воздуховод', 'Другой').confirmed, false);
}

console.log('Новые классы: подбор по данным позиции');
{
  const sheet: unknown[][] = [HEAD,
    row('13.01.01', 'Датчики', '1 штука', 'Д_Т', 'Д_Т_1_шт'), row('13.01.03', 'Датчики', '1 штука', 'Д_В', 'Д_В_1_шт'), row('13.01.02', 'Датчики', '1 штука', 'Д_Д', 'Д_Д_1_шт'),
    row('09.01.01', 'Узел регулирующий', 'Узел', 'УР', 'УР_ВЕКТОР_4ПГ_4ПУ_1_5'), row('09.01.02', 'Узел регулирующий', 'Узел', 'УР', 'УР_ВЕКТОР_4ПГ/ПУ_6_11'), row('09.02.01', 'Узел регулирующий', 'Узел', 'УР', 'УР_ВЕКТОР_6ПГ/ПУ'),
    row('04.02.01', 'Нагреватель', 'Э', 'Э', 'Нагреватель_Э_3'), row('04.01.01', 'Нагреватель', 'ТО', 'ТО', 'Нагреватель_ТО'),
    row('05.01.01', 'Теплоутилизатор', 'ТР', 'ТР', 'Теплоутилизатор_ТР_Д'), row('05.01.02', 'Теплоутилизатор', 'ТП', 'ТП', 'Теплоутилизатор_ТП'),
    row('06.01.01', 'Увлажнители', 'ПУ', 'ПУ', 'Увлажнитель_ПУ_МЕ_В'), row('06.01.02', 'Увлажнители', 'СУ', 'СУ', 'Увлажнитель_СУ'),
  ];
  const b2: E3SolutionBook = { ...emptySolutionBook(), solutions: parseSolutionSheet(sheet, { features: DEFAULT_FEATURES, dictionary: {} }).items };
  const P = (id: string, cls: string, o: { tag?: string; role?: string; parentTag?: string; params?: Record<string, string>; fields?: Record<string, string> } = {}): E3Position => ({
    id, cls, role: o.role, tag: o.tag, parentTag: o.parentTag, read: (s) => (s.kind === 'param' ? o.params?.[s.name] ?? '' : s.kind === 'field' ? o.fields?.[s.key] ?? '' : ''),
  });
  const pick = (pos: E3Position, sib: E3Position[] = [pos], profile: E3Profile = {}, manual?: Record<string, string>) => selectSolution(pos, sib, b2, profile, manual);

  // Датчик — одна позиция Flux, вид говорит, какой он
  eq('датчик температуры → Д_Т_1_шт', pick(P('s', 'ДАТЧИК', { fields: { kind: 'Температуры' } })).solution?.name, 'Д_Т_1_шт');
  eq('датчик давления → Д_Д_1_шт', pick(P('s', 'ДАТЧИК', { fields: { kind: 'Давления' } })).solution?.name, 'Д_Д_1_шт');
  eq('реле перепада — не датчик давления: решения нет', pick(P('s', 'ДАТЧИК', { fields: { kind: 'Реле перепада давления' } })).status, 'none');
  eq('датчик вида «Влажности», вписанного руками → Д_В_1_шт', pick(P('s', 'ДАТЧИК', { fields: { kind: 'Влажности' } })).solution?.name, 'Д_В_1_шт');
  const unknown = pick(P('s', 'ДАТЧИК'));
  eq('вид датчика неизвестен — ни трёх «нет», ни выдумки: подбор просит ответ', [unknown.status, unknown.answers.length], ['many', 0]);

  // Узел регулирующий: «любой» подходит всем типоразмерам
  const wss = (scheme: string, size: string) => pick(P('w', 'ОБВЯЗКА', { params: { 'Схема обвязки': scheme, 'Типоразмер узла': size } }));
  eq('схема 4, типоразмер 3 → диапазон 1–5', wss('4', '3').solution?.name, 'УР_ВЕКТОР_4ПГ_4ПУ_1_5');
  eq('схема 4, типоразмер 8 → диапазон 6–11', wss('4', '8').solution?.name, 'УР_ВЕКТОР_4ПГ/ПУ_6_11');
  eq('схема 6 подходит любому типоразмеру («любой»)', [wss('6', '3').solution?.name, wss('6', '10').solution?.name], ['УР_ВЕКТОР_6ПГ/ПУ', 'УР_ВЕКТОР_6ПГ/ПУ']);

  // Нагреватель, теплоутилизатор, увлажнитель
  const heater = (kind: string, groups = '') => pick(P('h', 'НАГРЕВАТЕЛЬ', { fields: { kind }, params: groups ? { 'Группы нагрева': groups } : {} }), undefined, {}, { 'heater.freeze': 'нет', 'heater.thermo': 'нет' });
  eq('электрический нагреватель, три группы нагрева → Э_3', [heater('Электрический', '3').answers.filter((a) => a.feature === 'heater.type' || a.feature === 'heater.stages').map((a) => a.value), heater('Электрический', '3').solution?.name], [['Э', '3'], 'Нагреватель_Э_3']);
  eq('жидкостный нагреватель → ТО', heater('Жидкостный').answers.find((a) => a.feature === 'heater.type')?.value, 'ТО');
  const unit = P('r', 'РЕКУПЕРАТОР', { fields: { kind: 'Роторный' } });
  eq('роторный рекуператор → ТР', pick(unit, [unit], { 'recup.start': 'нет', 'recup.bypass': 'нет', 'recup.sensor': 'нет', 'recup.pump': 'нет' }, { 'recup.control': 'Д', 'recup.motor_prot': 'нет' }).answers.find((a) => a.feature === 'recup.type')?.value, 'ТР');
  eq('виды увлажнителя → ПУ, СУ', ['Паровой', 'Сотовый'].map((k) => pick(P('u', 'УВЛАЖНИТЕЛЬ', { fields: { kind: k } })).answers.find((a) => a.feature === 'humid.type')?.value), ['ПУ', 'СУ']);

  // Подпозиции: коробка, оснащение, датчики, модель привода
  const valve = P('v', 'КЛАПАН', { tag: 'K-1', role: 'БЛОК', fields: { kind: 'С подогревом' } });
  const box = P('b', 'КОРОБКА', { role: 'КОРОБКА', parentTag: 'K-1' });
  const epv = P('e', 'ПРИВОД', { role: 'ПРИВОД', parentTag: 'K-1', fields: { model: 'Электропривод ЭПВ24' } });
  const v1 = pick(valve, [valve, box, epv]);
  const ans = (r: typeof v1, id: string) => r.answers.find((a) => a.feature === id);
  eq('клапан: коробка — по подпозиции, обогрев — по виду «С подогревом», ЭПВ — по модели привода', [ans(v1, 'valve.box')?.value, ans(v1, 'valve.heat_valve')?.value, ans(v1, 'valve.epv')?.value], ['К', 'да', 'да']);
  eq('клапан: две коробки → К2', ans(pick(valve, [valve, box, { ...box, id: 'b2' }]), 'valve.box')?.value, 'К2');
  const plain = P('v', 'КЛАПАН', { tag: 'K-1', role: 'БЛОК', fields: { kind: 'Воздушный' } });
  eq('клапан без коробки во Flux: коробки в ответе нет — решит профиль, а не «нет»', [ans(pick(plain), 'valve.box'), ans(pick(plain), 'valve.heat_valve')?.value], [undefined, 'нет']);
  eq('клапан неизвестного вида: об обогреве не отвечаем', ans(pick(P('v', 'КЛАПАН', { tag: 'K-1', role: 'БЛОК' })), 'valve.heat_valve'), undefined);
  eq('профиль отвечает про коробку, когда подпозиции нет', ans(pick(plain, [plain], { 'valve.box': 'К' }), 'valve.box'), { feature: 'valve.box', value: 'К', from: 'profile' });

  // Несколько подпозиций одной роли: правило берёт ту, что подошла, а не только первую
  const fan = P('f', 'ВЕНТИЛЯТОР', { tag: 'F-1', role: 'БЛОК' });
  const light = P('o1', 'ОСНАЩЕНИЕ', { role: 'ОСНАЩЕНИЕ', parentTag: 'F-1', fields: { kind: 'Светильник с выключателем' } });
  const service = P('o2', 'ОСНАЩЕНИЕ', { role: 'ОСНАЩЕНИЕ', parentTag: 'F-1', fields: { kind: 'Сервисный выключатель' } });
  const relay = P('s1', 'ДАТЧИК', { role: 'ДАТЧИК', parentTag: 'F-1', fields: { kind: 'Реле перепада давления' } });
  const fr = pick(fan, [fan, light, service, relay]);
  eq('вентилятор: светильник и сервисный выключатель — оба найдены среди оснащения, реле — контроль «Р»', [ans(fr, 'fan.light')?.value, ans(fr, 'fan.service')?.value, ans(fr, 'fan.control')?.value], ['да', 'да', 'Р']);
  eq('вентилятор без оснащения: ответ даёт профиль', ans(pick(fan, [fan], { 'fan.light': 'нет' }), 'fan.light')?.from, 'profile');
}

console.log('«Добавить недостающее»');
{
  // Книга, собранная до появления новых классов: нет их признаков, правил и правил состава, нет типа КОРОБКА
  const old = emptySolutionBook();
  const oldFeatures = DEFAULT_FEATURES.filter((x) => !['Датчики', 'Узел регулирующий', 'Начало установки', 'Конец установки', 'Коробка', 'Воздуховод'].includes(x.mainClass));
  const sol = (id: string, mainClass: string, name: string, subclass = ''): E3Solution => ({ id, mainClass, subclass, short: '', name, description: '', pdf: '', e3p: '', twoLevel: false, inCad: false, items: '', symbols: '', note: '', features: {}, featuresConfirmed: true });
  const keepRule = { mainClass: 'Нагреватель', featureId: 'heater.stages', source: { kind: 'param' as const, name: 'Моя характеристика' }, table: [{ when: '1', answer: '1' }] };
  const book0: E3SolutionBook = {
    ...old, features: oldFeatures, rules: [keepRule, ...DEFAULT_RULES.filter((r) => r.featureId === 'valve.drive')], ioRules: DEFAULT_IO_RULES.filter((r) => r.mainClass === 'Клапаны'),
    classMap: { КЛАПАН: ['Клапаны'] },
    solutions: [sol('13.01.01', 'Датчики', 'Д_Т_1_шт'), sol('11.01.01', 'Начало установки', 'Начало_2УР_ПВ_Р'), { ...sol('10.06.05', 'Коробка', 'КОРВ-88 тип 6.1_Пруж', 'Коробка для подключения привода'), featuresConfirmed: false },
      { ...sol('08.01.01', 'Клапаны', 'Клапан_К24'), features: { 'valve.drive': 'К' } }],
  };
  const plan = planMissingDefaults(book0);
  eq('в плане признаки шести классов и не больше', [...new Set(plan.features.map((x) => x.mainClass))].sort(), ['Воздуховод', 'Датчики', 'Конец установки', 'Коробка', 'Начало установки', 'Узел регулирующий']);
  eq('в плане правила состава, кроме клапанных (они есть)', [plan.ioRules.length > 0, plan.ioRules.some((r) => r.mainClass === 'Клапаны')], [true, false]);
  eq('в плане правила признаков, кроме уже заведённых', [plan.rules.some((r) => r.featureId === 'valve.drive'), plan.rules.some((r) => r.featureId === 'heater.stages')], [false, false]);
  eq('в плане связь типов, которой не хватает', plan.classMap.sort(), Object.keys(DEFAULT_CLASS_MAP).filter((k) => k !== 'КЛАПАН').sort());
  eq('решениям новых классов предложены ответы, клапану — нет', plan.filled.map((x) => x.id).sort(), ['10.06.05', '11.01.01', '13.01.01']);
  const next = { ...book0, ...applyMissingDefaults(book0) };
  eq('после записи недостающего нет', (({ features, rules, ioRules, classMap, filled }) => [features.length, rules.length, ioRules.length, classMap.length, filled.length])(planMissingDefaults(next)), [0, 0, 0, 0, 0]);
  eq('своё правило нагревателя не тронуто и не продублировано', next.rules.filter((r) => r.featureId === 'heater.stages' && r.mainClass === 'Нагреватель').map((r) => (r.source as any).name), ['Моя характеристика']);
  eq('ответы дописаны решению датчиков', next.solutions.find((x) => x.id === '13.01.01')!.features, { 'sensor.temp': '1', 'sensor.press': 'нет', 'sensor.humid': 'нет' });
  eq('однозначно разобранное подтверждено, неподтверждённое осталось таким', [next.solutions.find((x) => x.id === '13.01.01')!.featuresConfirmed, next.solutions.find((x) => x.id === '10.06.05')!.featuresConfirmed], [true, false]);
  eq('начало с рекуперацией подтверждено, чужих ответов не затёрто', [next.solutions.find((x) => x.id === '11.01.01')!.features['begin.recup'], next.solutions.find((x) => x.id === '08.01.01')!.features], ['Р', { 'valve.drive': 'К' }]);
  eq('связь КЛАПАН осталась как была', next.classMap.КЛАПАН, ['Клапаны']);
  eq('воздуховод без типа Flux', ['КОРОБКА' in next.classMap, Object.values(next.classMap).flat().includes('Воздуховод'), Object.values(DEFAULT_CLASS_MAP).flat().includes('Воздуховод')], [true, false, false]);
  const edited = { ...book0, solutions: book0.solutions.map((x) => (x.id === '13.01.01' ? { ...x, features: { 'sensor.temp': '2' }, featuresConfirmed: true } : x)) };
  const keepAnswer = applyMissingDefaults(edited).solutions!.find((x) => x.id === '13.01.01')!;
  eq('ответ, который человек уже дал, не перезаписывается; дописывается только недостающее', [keepAnswer.features['sensor.temp'], keepAnswer.features['sensor.press']], ['2', 'нет']);
  eq('снятое решение не трогается', planMissingDefaults({ ...book0, solutions: book0.solutions.map((x) => ({ ...x, removed: true })) }).filled, []);
  eq('книга уже полная — плана нет', ((m) => m.features.length + m.rules.length + m.ioRules.length + m.classMap.length + m.filled.length)(planMissingDefaults(emptySolutionBook())), 0);
}

console.log('Правила и признаки согласованы');
{
  const ids = new Set(DEFAULT_FEATURES.map((x) => x.id));
  eq('у каждого стартового правила есть свой признак (кроме выбора класса)', DEFAULT_RULES.filter((r) => r.featureId !== '@class' && !ids.has(r.featureId)).map((r) => r.featureId), []);
  eq('правило признака — только для класса своего признака', DEFAULT_RULES.filter((r) => r.featureId !== '@class' && DEFAULT_FEATURES.find((x) => x.id === r.featureId)?.mainClass !== r.mainClass).map((r) => r.featureId), []);
  eq('ответы правил — варианты признака (или «иначе»)', DEFAULT_RULES.flatMap((r) => { const f = DEFAULT_FEATURES.find((x) => x.id === r.featureId); return f ? [...r.table.map((t) => t.answer), ...(r.otherwise ? [r.otherwise] : [])].filter((a) => !f.values.includes(a)).map((a) => `${r.featureId}=${a}`) : []; }), []);
  eq('у каждого признака один и тот же ключ правила не повторяется', new Set(DEFAULT_RULES.map((r) => `${r.mainClass}|${r.featureId}`)).size, DEFAULT_RULES.length);
  eq('условия правил состава ссылаются на настоящие признаки своего класса', DEFAULT_IO_RULES.flatMap((r) => r.when.concat(r.count.kind === 'feature' ? [{ feature: r.count.feature, values: [] }] : []).filter((c) => DEFAULT_FEATURES.find((x) => x.id === c.feature)?.mainClass !== r.mainClass).map((c) => `${r.id}:${c.feature}`)), []);
  eq('значения условий правил состава — варианты признака', DEFAULT_IO_RULES.flatMap((r) => r.when.flatMap((c) => c.values.filter((v) => !DEFAULT_FEATURES.find((x) => x.id === c.feature)?.values.includes(v)).map((v) => `${r.id}:${c.feature}=${v}`))), []);
  eq('ключи правил состава не повторяются', new Set(DEFAULT_IO_RULES.map((r) => r.id)).size, DEFAULT_IO_RULES.length);
  eq('связь типов: коробка есть, у воздуховода типа нет', [DEFAULT_CLASS_MAP.КОРОБКА, Object.keys(DEFAULT_CLASS_MAP).includes('ВОЗДУХОВОД')], [['Коробка'], false]);
}

console.log('Выгрузка в Excel');
{
  const rows = solutionRows(book);
  eq('заголовки как в файле владельца', rows[0].slice(0, 13), HEAD);
  eq('столбцы признаков и подтверждение', [rows[0].length, rows[0][rows[0].length - 1], rows[0].includes(`Тип привода (Клапаны) [valve.drive]`)], [13 + DEFAULT_FEATURES.length + 1, 'Признаки подтверждены', true]);
  eq('строк: заголовок и все решения', rows.length, 25);
  const r1 = rows.find((r) => r[0] === '08.01.01')!;
  eq('поля решения', [r1[1], r1[4], r1[8], r1[9]], ['Клапаны', 'Клапан_К24', 'Нет', '']);
  const driveCol = rows[0].indexOf('Тип привода (Клапаны) [valve.drive]');
  eq('признак своего класса заполнен, чужого — нет', [r1[driveCol], r1[rows[0].indexOf('Способ пуска (Вентилятор) [fan.start]')]], ['К', '']);
  eq('снятые не выгружаются', solutionRows({ ...book, solutions: book.solutions.map((s, i) => (i === 0 ? { ...s, removed: true } : s)) }).length, 24);

  // Туда и обратно: книга → файл → разбор даёт те же решения и признаки без разбора названий
  const wb = XLSX.read(solutionWorkbookBytes(book), { type: 'array' });
  eq('листы книги', wb.SheetNames, [CLASSIFIER_SHEET, 'Обозначения']);
  const aoa = (n: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, defval: '', blankrows: true });
  const again = parseSolutionSheet(aoa(CLASSIFIER_SHEET), { features: DEFAULT_FEATURES, dictionary: {} });
  eq('круг: решения те же', again.items.map((s) => s.id), book.solutions.map((s) => s.id));
  const hand = book.solutions.map((s) => (s.id === '08.01.07' ? { ...s, features: { ...s.features, 'valve.box': 'К2' }, featuresConfirmed: true } : s));
  const again2 = parseSolutionSheet(XLSX.utils.sheet_to_json<unknown[]>(XLSX.read(solutionWorkbookBytes({ ...book, solutions: hand }), { type: 'array' }).Sheets[CLASSIFIER_SHEET], { header: 1, defval: '', blankrows: true }), { features: DEFAULT_FEATURES, dictionary: {} });
  eq('круг: подтверждённые признаки и ответ человека сохранились', [again2.items.find((s) => s.id === '08.01.07')!.features['valve.box'], again2.items.find((s) => s.id === '08.01.07')!.featuresConfirmed], ['К2', true]);
  eq('круг: словарь читается обратно', Object.keys(parseDictionarySheet(aoa('Обозначения')).dictionary), Object.keys(book.dictionary));
  eq('круг: правки полей (twoLevel, inCad) сохранились', [again.items.find((s) => s.id === '11.02.05')!.inCad, again.items.find((s) => s.id === '08.01.01')!.twoLevel], [true, false]);
}

console.log('Названия для пробы E3');
{
  const mk = (name: string, removed = false) => ({ ...book.solutions[0], name, removed });
  eq('названия: порядок книги, края обрезаны, пустые, снятые и повторы (без учёта регистра) убраны',
    solutionNames([mk(' Клапан_К24 '), mk(''), mk('   '), mk('Клапан_К24'), mk('клапан_к24'), mk('Снятое', true), mk('Вентилятор_ПП'), mk('Клапан_К24_КП2')]),
    ['Клапан_К24', 'Вентилятор_ПП', 'Клапан_К24_КП2']);
  const live = book.solutions.filter((s) => !s.removed);
  const names = solutionNames(book.solutions);
  eq('названия: из книги — без повторов и пустых', [names.length === new Set(names.map((n) => n.toLocaleLowerCase('ru'))).size, names.every((n) => n === n.trim() && n !== ''), names.length <= live.length], [true, true, true]);
  eq('названия: два решения с одним названием схемы дают одну строку', [live.length, names.length < live.length], [24, true]);
  const file = solutionNamesFile([mk('Клапан_К24'), mk('Вентилятор_ПП')]);
  eq('файл: BOM в начале, строки через CRLF, без пустой строки в конце', [file.charCodeAt(0), file.slice(1)], [0xfeff, 'Клапан_К24\r\nВентилятор_ПП\r\n']);
  eq('файл: BOM в UTF-8 — EF BB BF, кириллица двухбайтная', [...Buffer.from(file, 'utf8').subarray(0, 5)], [0xef, 0xbb, 0xbf, 0xd0, 0x9a]);
  eq('файл: пустая книга — пустой файл с BOM', solutionNamesFile([]), '\uFEFF');
}

console.log('Проверка входных данных');
{
  eq('стартовые признаки проходят проверку', DEFAULT_FEATURES.every((f) => !!sanitizeFeature(f)), true);
  eq('стартовые правила проходят проверку', DEFAULT_RULES.every((r) => !!sanitizeRule(r)), true);
  eq('значение «нет данных» вне вариантов признака', sanitizeFeature({ ...DEFAULT_FEATURES[0], absent: 'нет такого' }), null);
  eq('вид признака негодный', sanitizeFeature({ ...DEFAULT_FEATURES[0], kind: 'x' }), null);
  eq('правило: источник негодный', sanitizeRule({ ...DEFAULT_RULES[0], source: { kind: 'sql' } }), null);
  eq('правило: id признака «@class» допустим', !!sanitizeRule(DEFAULT_RULES.find((r) => r.featureId === '@class')), true);
  eq('словарь: служебный ключ', sanitizeDictionary(JSON.parse('{"__proto__":"x"}')), null);
  eq('словарь: ключ не длиннее 60', sanitizeDictionary({ ['я'.repeat(61)]: 'x' }), null);
  eq('связь классов: неизвестный тип Flux', sanitizeClassMap({ НЕТ: ['Клапаны'] }), null);
  eq('связь классов: нормальная', sanitizeClassMap({ КЛАПАН: ['Клапаны'] }), { КЛАПАН: ['Клапаны'] });
  eq('профиль: ответ и порог', !!sanitizeProfile({ a: 'ПП', b: { source: { kind: 'count', role: 'ПРИВОД' }, steps: [{ upTo: 1, answer: 'x' }], above: 'y' } }), true);
  eq('профиль: порог без числа', sanitizeProfile({ b: { source: { kind: 'count', role: 'ПРИВОД' }, steps: [{ upTo: 'x', answer: 'x' }], above: 'y' } }), null);
  eq('решения: не массив', 'error' in validateSolutions({}), true);
  eq('решения: больше 2000', 'error' in validateSolutions(Array.from({ length: 2001 }, () => book.solutions[0])), true);
  eq('решения: ID с лишними знаками', 'error' in validateSolutions([{ ...book.solutions[0], id: 'a b' }]), true);
  eq('решения: длинное поле', 'error' in validateSolutions([{ ...book.solutions[0], note: 'я'.repeat(1001) }]), true);
  eq('решения: признаки не строкой', 'error' in validateSolutions([{ ...book.solutions[0], features: { a: 1 } }]), true);
  eq('решения: хорошие проходят', 'items' in validateSolutions(book.solutions), true);
  eq('решения: ручной состав проходит и сохраняется', (validateSolutions([{ ...book.solutions[0], recipeOverride: [{ role: 'Привод', row: { name: 'x' }, count: 2 }] }]) as any).items[0].recipeOverride[0].count, 2);
  eq('решения: негодный ручной состав', 'error' in validateSolutions([{ ...book.solutions[0], recipeOverride: [{ role: '', row: {}, count: 0 }] }]), true);
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки каталога типовых решений E3 пройдены');
