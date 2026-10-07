/**
 * Справочник атрибутов E3: разбор листа владельца, план загрузки, выбор
 * атрибутов по типу оборудования и ячейки `e3:` в выгрузке.
 *
 * Лист ниже — синтетический, но с теми же изъянами, что у настоящего:
 * шапка не в первой строке и в несколько строк, повтор имени (в том числе с
 * пробелом в конце и другим носителем), «Да» вместе со «Служебным», служебное
 * поле «Device Designation», кабельные атрибуты. Сам файл владельца в
 * репозиторий не кладётся.
 *
 * Запуск: npx tsx scripts/test-e3-attributes.ts
 */
import {
  parseAttributeSheet, defaultClassesOf, defaultSource, planAttributes, applyAttributePlan, attributesForClass,
  e3Columns, validateAttributes, E3_FIELD_TITLES, type E3Attribute,
} from '../e3/attributes';
import { specOf, exportTable, defaultSpec } from '../src/lib/exportSpec';
import { buildEquipmentExchange, equipmentCell, type ExchangeComponent, type ParamColumn } from '../src/lib/equipmentExchange';
import { rowsOfSystem } from '../src/lib/equipmentRows';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failed++;
  console.error(`  ✗ ${name} — получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`);
};

const HEAD = [
  null,
  'Наименование атрибута E3\n(невидимый)',
  'Описание атрибута Е3\n(отображается в Екубе)',
  'Носитель артрибута Е3',
  'Основной класс\n(к какому классу изделий принадлежит)',
  'Служебный атрибут (не менять!)',
  'Скрипт, где применяется атрибут',
  'Комментарий',
  'Дата изменения',
  'Комментарий ВЕЗА',
  'Комментарий ВЕЗА2',
];
const row = (yes: unknown, name: unknown, title: string, carrier: string, cls: string, service: unknown = null, script = '', comment = '', veza = '', veza2 = ''): unknown[] =>
  [yes, name, title, carrier, cls, service, script, comment, null, veza, veza2];

const SHEET: unknown[][] = [
  ['Классификатор атрибутов E3'],
  [],
  HEAD,                                                                                         // строка 3
  row('Да', 'Device Designation', 'GLOBAL_TAG устройства', 'Изделие', 'Общий', 'ДА', 'Таблица TAGов', 'Поз. обозначение'), // 4
  row('Да', 'GLOBAL_TAG_UNIT', 'Тег установки', 'Изделие', 'Общий', 'ДА', '', '', 'Удалить, есть на строке 5'),   // 5
  row(null, 'GLOBAL_BLOCK_NAME', 'Имя блока', 'Блок', 'Общий'),                                                  // 6
  row('Да', 'GLOBAL_TAG_UNIT', 'Тег установки (вторая)', 'Изделие', 'Общий'),                                    // 7
  row(null, 'GLOBAL_BLOCK_NAME ', 'Имя блока (изделие)', 'Изделие', 'Привод', 'ДА'),                             // 8
  row(' да ', 'MOTOR_POWER', 'MOTOR_Мощность', 'Изделие', 'Двигатели'),                                          // 9
  row('Да', 'MOTOR_VOLTAGE', 'MOTOR_Напряжение', 'Изделие', 'Двигатели'),                                        // 10
  row('Да', 'MOTOR_CURRENT_RATED', 'MOTOR_Ток', 'Изделие', 'Двигатели'),                                         // 11
  row('Да', 'INST_RANGE_MIN', 'Начало диапазона', 'Изделие', 'КИП', null, '', 'Надо создать', 'Проверить', 'Ещё раз'), // 12
  row(null, 'CBL_DESC', 'Описание кабеля', 'Изделие', 'Кабель'),                                                 // 13
  row('Да', 'SIGNAL_TYPE', 'Тип сигнала', 'Изделие', 'Сигналы, Привод', 'ДА'),                                   // 14
  row('Да', 'COMPRO_POWER', 'COMPRO_Мощность', 'Изделие', 'Комплектные изделия'),                                // 15
  row(null, ' PEQ_CURRENT_TYPE', 'PEQ_Род тока', 'Изделие', 'Силовая техника '),                                 // 16
  row('Да', 'GLOBAL_NODE_NAME', 'Название узла', 'Изделие', 'Общий'),                                            // 17
  row('Да', 'GLOBAL_DEVICE_TYPE', 'Тип устройства', 'Изделие', 'Общий'),                                         // 18
  row('Да', 'LC_POWER', 'LC_Мощность', 'Изделие', 'Освещение и климат'),                                         // 19
  row('Да', 'MYSTERY_ATTR', 'Что-то новое', 'Изделие', 'Новый класс'),                                           // 20
  [null, null, null, null, null, null],                                                                         // 21 пустая
  row('Да', '', 'Без имени', 'Изделие', 'Общий'),                                                                // 22
];

const by = (items: E3Attribute[], name: string) => items.find((a) => a.name === name)!;

console.log('Разбор листа');
const parsed = parseAttributeSheet(SHEET);
{
  const { items, issues } = parsed;
  eq('имена без пробелов по краям, повторы убраны', items.map((a) => a.name), [
    'Device Designation', 'GLOBAL_TAG_UNIT', 'GLOBAL_BLOCK_NAME', 'MOTOR_POWER', 'MOTOR_VOLTAGE', 'MOTOR_CURRENT_RATED',
    'INST_RANGE_MIN', 'CBL_DESC', 'SIGNAL_TYPE', 'COMPRO_POWER', 'PEQ_CURRENT_TYPE', 'GLOBAL_NODE_NAME', 'GLOBAL_DEVICE_TYPE',
    'LC_POWER', 'MYSTERY_ATTR',
  ]);
  eq('повтор — первая строка', by(items, 'GLOBAL_TAG_UNIT').title, 'Тег установки');
  eq('повтор с пробелом в имени — тоже первая строка', by(items, 'GLOBAL_BLOCK_NAME').carrier, 'Блок');
  eq('замечание о повторе называет строку', issues.includes('GLOBAL_TAG_UNIT: в файле дважды — взята строка 5'), true);
  eq('замечание о повторе с другим носителем', issues.some((s) => s.startsWith('GLOBAL_BLOCK_NAME: в файле дважды — взята строка 6') && s.includes('носитель')), true);
  eq('замечание о пробеле в имени', issues.some((s) => s.includes('Строка 16') && s.includes('пробелы по краям')), true);
  eq('«Да» + служебный — замечание', issues.some((s) => s.startsWith('SIGNAL_TYPE:') && s.includes('Служебный')), true);
  eq('Device Designation — пояснение', issues.some((s) => s.startsWith('Device Designation:') && s.includes('не атрибут')), true);
  eq('строка без имени названа', issues.some((s) => s.startsWith('Строка 22')), true);
  eq('неизвестный класс назван', issues.some((s) => s.startsWith('MYSTERY_ATTR:') && s.includes('Новый класс')), true);
  eq('«да » любого вида регистра и с пробелами — заполняет Flux', by(items, 'MOTOR_POWER').fromFlux, true);
  eq('пустой первый столбец — не заполняет', by(items, 'PEQ_CURRENT_TYPE').fromFlux, false);
  eq('служебный', [by(items, 'Device Designation').service, by(items, 'MOTOR_POWER').service], [true, false]);
  eq('спор по умолчанию: «Да» + служебный → ask', by(items, 'SIGNAL_TYPE').conflict, 'ask');
  eq('спор по умолчанию иначе — flux', [by(items, 'MOTOR_POWER').conflict, by(items, 'GLOBAL_BLOCK_NAME').conflict], ['flux', 'flux']);
  eq('источник у «Да» — по имени', by(items, 'GLOBAL_NODE_NAME').source, { kind: 'field', key: 'parentName' });
  eq('источник без «Да» — none, даже если имя известно', by(items, 'CBL_DESC').source, { kind: 'none' });
  eq('типы по умолчанию не заданы', items.every((a) => a.classes.length === 0), true);
  eq('комментарии склеены с пометкой', by(items, 'INST_RANGE_MIN').comment, 'Надо создать\nВЕЗА: Проверить\nВЕЗА2: Ещё раз');
  eq('скрипт и описание', [by(items, 'Device Designation').script, by(items, 'Device Designation').title], ['Таблица TAGов', 'GLOBAL_TAG устройства']);
  eq('без строки заголовков — пусто и замечание', parseAttributeSheet([['a', 'b'], ['c', 'd']]).items.length, 0);
  eq('без строки заголовков — сказано словами', parseAttributeSheet([['a']]).issues[0].includes('заголовков'), true);
}

console.log('Типы оборудования по классу файла');
{
  eq('Общий / Подвал / пусто — все', [defaultClassesOf('Общий'), defaultClassesOf('Подвал'), defaultClassesOf('')], [[], [], []]);
  eq('Двигатели', defaultClassesOf('Двигатели'), ['ДВИГАТЕЛЬ']);
  eq('Нагреватели', defaultClassesOf('Нагреватели'), ['НАГРЕВАТЕЛЬ', 'ТЭН']);
  eq('КИП и КИП ЗРА', [defaultClassesOf('КИП'), defaultClassesOf('КИП ЗРА')], [['ДАТЧИК'], ['ОБВЯЗКА']]);
  eq('Привод', defaultClassesOf('Привод'), ['ПРИВОД']);
  eq('Сигналы, Привод / КИП, Привод / Сигналы', [defaultClassesOf('Сигналы, Привод'), defaultClassesOf('КИП, Привод'), defaultClassesOf('Сигналы')],
    [['ДАТЧИК', 'ПРИВОД'], ['ДАТЧИК', 'ПРИВОД'], ['ДАТЧИК', 'ПРИВОД']]);
  eq('Освещение и климат', defaultClassesOf('Освещение и климат'), ['ОСНАЩЕНИЕ']);
  eq('Силовая техника — пробел в конце и регистр не мешают', defaultClassesOf(' силовая ТЕХНИКА '), ['НАСОС', 'ДВИГАТЕЛЬ']);
  eq('Комплектные изделия и Черный ящик (ё = е)', [defaultClassesOf('Комплектные изделия'), defaultClassesOf('Чёрный ящик')], [['ПРОЧЕЕ', 'ОСНАЩЕНИЕ'], ['ПРОЧЕЕ', 'ОСНАЩЕНИЕ']]);
  eq('Кабель и Кабельный ввод — пусто', [defaultClassesOf('Кабель'), defaultClassesOf('Кабельный ввод')], [[], []]);
}

console.log('Источник значения по имени');
{
  eq('Device Designation → tag', defaultSource('Device Designation'), { kind: 'field', key: 'tag' });
  eq('поля', ['GLOBAL_TAG_UNIT', 'GLOBAL_TAG_NODE', 'GLOBAL_NODE_NAME', 'GLOBAL_DEVICE_NAME', 'GLOBAL_UNIT_NAME', 'GLOBAL_MODEL', 'GLOBAL_DEVICE_TYPE'].map((n) => (defaultSource(n) as any).key),
    ['unitTag', 'parentTag', 'parentName', 'name', 'system', 'model', 'class']);
  eq('мощность', ['MOTOR_POWER', 'ELH_POWER', 'LC_POWER', 'PEQ_POWER', 'COMPRO_POWER'].map((n) => (defaultSource(n) as any).name), Array(5).fill('Мощность'));
  eq('напряжение', ['MOTOR_VOLTAGE', 'ELH_VOLTAGE', 'LC_VOLTAGE', 'PEQ_VOLTAGE', 'COMPRO_VOLTAGE'].map((n) => (defaultSource(n) as any).name), Array(5).fill('Напряжение'));
  eq('ток', ['MOTOR_CURRENT_RATED', 'COMPRO_CURRENT_RATED'].map((n) => (defaultSource(n) as any).name), ['Ток', 'Ток']);
  eq('остальные — none', ['INST_RANGE_MIN', 'MOTOR_CURRENT_TYPE', 'MOTOR_CURRENT_CALCULATED', 'SIGNAL_DESC'].map((n) => defaultSource(n).kind), ['none', 'none', 'none', 'none']);
  eq('у каждого названного поля есть подпись', Object.keys(E3_FIELD_TITLES).length, 11);
}

console.log('План загрузки и применение');
{
  const { items: file } = parsed;
  const first = planAttributes([], file);
  eq('в пустой справочник — все новые', [first.added.length, first.changed.length, first.same, first.missing.length], [file.length, 0, 0, 0]);

  const book = applyAttributePlan([], file, { missing: 'keep' });
  eq('первая загрузка — как в файле', book.map((a) => a.name), file.map((a) => a.name));
  const again = planAttributes(book, file);
  eq('повторная загрузка того же — всё без изменений', [again.added.length, again.changed.length, again.same, again.missing, again.editedKept], [0, 0, file.length, [], []]);

  // Файл изменился: подпись, «Да» снят, новый атрибут, один пропал
  const next = file.filter((a) => a.name !== 'CBL_DESC').map((a) => {
    if (a.name === 'MOTOR_POWER') return { ...a, title: 'MOTOR_Мощность (кВт)' };
    if (a.name === 'LC_POWER') return { ...a, fromFlux: false };
    return a;
  });
  next.push({ ...file[0], name: 'NEW_ATTR', title: 'Новый' });
  // Настройки Flux: файл про них не знает — не должны давать «изменён»
  const tuned = book.map((a) => (a.name === 'MOTOR_VOLTAGE' ? { ...a, source: { kind: 'param', name: 'U' } as const, classes: ['ДВИГАТЕЛЬ'], conflict: 'script' as const } : a));
  const plan = planAttributes(tuned, next);
  eq('новые', plan.added.map((a) => a.name), ['NEW_ATTR']);
  eq('изменённые: имена и поля', plan.changed.map((c) => `${c.name}:${c.fields.join('+')}`), ['MOTOR_POWER:title', 'LC_POWER:fromFlux']);
  eq('изменение показывает до и после', [plan.changed[0].before.title, plan.changed[0].after.title], ['MOTOR_Мощность', 'MOTOR_Мощность (кВт)']);
  eq('без изменений — остальные', plan.same, file.length - 1 - 2);
  eq('нет в файле', plan.missing, ['CBL_DESC']);
  eq('настройки Flux не дают изменений', plan.changed.some((c) => c.name === 'MOTOR_VOLTAGE'), false);

  const kept = applyAttributePlan(tuned, next, { missing: 'keep' });
  eq('keep: порядок как в файле, затем остальные', kept.map((a) => a.name), [...next.map((a) => a.name), 'CBL_DESC']);
  eq('keep: пропавший остался нетронутым', by(kept, 'CBL_DESC').removed, undefined);
  eq('apply обновил поля файла', by(kept, 'MOTOR_POWER').title, 'MOTOR_Мощность (кВт)');
  eq('apply не тронул настройки Flux', [by(kept, 'MOTOR_VOLTAGE').source, by(kept, 'MOTOR_VOLTAGE').classes, by(kept, 'MOTOR_VOLTAGE').conflict], [{ kind: 'param', name: 'U' }, ['ДВИГАТЕЛЬ'], 'script']);
  const removed = applyAttributePlan(tuned, next, { missing: 'remove' });
  eq('remove: пропавший помечен, но не удалён', [by(removed, 'CBL_DESC').removed, removed.length], [true, kept.length]);
  eq('remove: пропавший в хвосте после файловых', removed[removed.length - 1].name, 'CBL_DESC');
  eq('после remove он не «нет в файле» повторно', planAttributes(removed, next).missing, []);
  eq('вернувшийся в файл снятый — изменение «removed»', planAttributes(removed, file).changed.map((c) => `${c.name}:${c.fields.join('+')}`).filter((s) => s.startsWith('CBL_DESC')), ['CBL_DESC:removed']);
  const restored = applyAttributePlan(removed, file, { missing: 'keep' });
  eq('вернувшийся снова живой', by(restored, 'CBL_DESC').removed, undefined);

  // Правленное руками файл не перезаписывает
  const edited = book.map((a) => (a.name === 'MOTOR_POWER' ? { ...a, title: 'Моя подпись', edited: true } : a));
  const planE = planAttributes(edited, next);
  eq('правленное — в списке «оставлено»', planE.editedKept, ['MOTOR_POWER']);
  eq('правленное не в изменённых', planE.changed.some((c) => c.name === 'MOTOR_POWER'), false);
  eq('apply оставляет правленное', by(applyAttributePlan(edited, next, { missing: 'keep' }), 'MOTOR_POWER').title, 'Моя подпись');
  eq('правленное, которое файл не меняет, — «без изменений»', planAttributes(edited.map((a) => (a.name === 'MOTOR_POWER' ? { ...a, title: 'MOTOR_Мощность' } : a)), file).editedKept, []);
  eq('повтор в загружаемом — замечание плана', planAttributes([], [file[0], file[0]]).issues.length, 1);
}

console.log('Атрибуты типа оборудования');
{
  const items = applyAttributePlan([], parsed.items, { missing: 'keep' });
  const names = (id: string) => attributesForClass(items, id).map((a) => a.name);
  eq('двигатель: общие + двигательные, без кабелей и КИП', names('ДВИГАТЕЛЬ'), [
    'Device Designation', 'GLOBAL_TAG_UNIT', 'GLOBAL_BLOCK_NAME', 'MOTOR_POWER', 'MOTOR_VOLTAGE', 'MOTOR_CURRENT_RATED',
    'PEQ_CURRENT_TYPE', 'GLOBAL_NODE_NAME', 'GLOBAL_DEVICE_TYPE', 'MYSTERY_ATTR',
  ]);
  eq('датчик получает КИП и сигналы', names('ДАТЧИК').filter((n) => n === 'INST_RANGE_MIN' || n === 'SIGNAL_TYPE'), ['INST_RANGE_MIN', 'SIGNAL_TYPE']);
  eq('кабельный атрибут не входит ни в один тип', ['ВЕНТИЛЯТОР', 'ПРИВОД', 'ДАТЧИК', 'ПРОЧЕЕ'].some((id) => names(id).includes('CBL_DESC')), false);
  eq('вручную заданные типы сильнее класса файла', attributesForClass(items.map((a) => (a.name === 'CBL_DESC' ? { ...a, classes: ['ПРОЧЕЕ'] } : a)), 'ПРОЧЕЕ').some((a) => a.name === 'CBL_DESC'), true);
  eq('вручную заданные типы закрывают остальные', attributesForClass(items.map((a) => (a.name === 'MOTOR_POWER' ? { ...a, classes: ['ПРОЧЕЕ'] } : a)), 'ДВИГАТЕЛЬ').some((a) => a.name === 'MOTOR_POWER'), false);
  eq('снятые не входят', attributesForClass(items.map((a) => (a.name === 'MOTOR_POWER' ? { ...a, removed: true } : a)), 'ДВИГАТЕЛЬ').some((a) => a.name === 'MOTOR_POWER'), false);
  eq('двигатель по силовой технике: PEQ', attributesForClass(items, 'НАСОС').some((a) => a.name === 'PEQ_CURRENT_TYPE'), true);
}

console.log('Столбцы выгрузки');
{
  const items = applyAttributePlan([], parsed.items, { missing: 'keep' })
    .map((a) => (a.name === 'MOTOR_POWER' ? { ...a, source: { kind: 'param', name: 'Мощность', unit: 'кВт' } as const } : a));
  const cols = e3Columns(items, ['ДВИГАТЕЛЬ'], { header: 'name' });
  eq('ключи и порядок книги', cols.map((c) => c.key).slice(0, 4), ['e3:Device Designation', 'e3:GLOBAL_TAG_UNIT', 'e3:GLOBAL_BLOCK_NAME', 'e3:MOTOR_POWER']);
  eq('единица берётся у характеристики', cols.find((c) => c.key === 'e3:MOTOR_POWER')?.unit, 'кВт');
  eq('у поля единицы нет', 'unit' in cols[0], false);
  eq('источник у «Да»', cols[0].source, { kind: 'field', key: 'tag' });
  eq('источник без «Да» — none, даже если он настроен', e3Columns(items.map((a) => (a.name === 'PEQ_CURRENT_TYPE' ? { ...a, source: { kind: 'const', value: 'x' } as const } : a)), ['ДВИГАТЕЛЬ'], { header: 'name' }).find((c) => c.key === 'e3:PEQ_CURRENT_TYPE')?.source, { kind: 'none' });
  eq('заголовок — описание', e3Columns(items, ['ДВИГАТЕЛЬ'], { header: 'title' })[3].label, 'MOTOR_Мощность');
  eq('заголовок — имя', cols[3].label, 'MOTOR_POWER');
  eq('onlyFromFlux', e3Columns(items, ['ДВИГАТЕЛЬ'], { header: 'name', onlyFromFlux: true }).some((c) => c.key === 'e3:GLOBAL_BLOCK_NAME'), false);
  const two = e3Columns(items, ['ДВИГАТЕЛЬ', 'ДАТЧИК'], { header: 'name' }).map((c) => c.key);
  eq('несколько типов — объединение без повторов', two.length, new Set(two).size);
  eq('несколько типов — есть и двигатель, и датчик', [two.includes('e3:MOTOR_POWER'), two.includes('e3:INST_RANGE_MIN')], [true, true]);
  eq('пусто — все типы, но не снятые', e3Columns(items.map((a) => (a.name === 'CBL_DESC' ? { ...a, removed: true } : a)), [], { header: 'name' }).length, items.length - 1);
  eq('пусто — все типы, включая кабельные', e3Columns(items, [], { header: 'name' }).some((c) => c.key === 'e3:CBL_DESC'), true);
}

console.log('Ячейки e3: в выгрузке');
{
  const base = (over: Partial<ExchangeComponent> = {}): ExchangeComponent => ({
    id: 'm1', itemCode: 'M', name: 'Двигатель вентилятора', equipType: 'Двигатель', cls: 'ДВИГАТЕЛЬ', kind: 'Асинхронный', model: 'AM-90',
    groups: [
      { title: 'Электрика', params: [{ key: 'Мощность', value: '7500', unit: 'Вт' }, { key: 'Напряжение', value: '380', unit: 'В' }] },
      { title: 'Паспорт', params: [{ key: 'Мощность', value: '', unit: '' }, { key: 'Ток, номинальный', value: '15,5', unit: 'А' }] },
    ],
    tags: [{ identifier: 'X-BL-001M' }], systemName: 'П-1', monoblockName: 'МБ-1',
    parentTag: 'X-BL-001', parentName: 'Вентилятор канальный', unitTag: 'X-P-1', ...over,
  });
  const col = (key: string, source: any, unit = ''): ParamColumn => ({ key, label: key, unit, group: '', param: '', source });
  const cell = (it: ExchangeComponent, source: any, unit = '') => equipmentCell(it, 'e3:X', unit, source);

  eq('none → пусто', cell(base(), { kind: 'none' }), '');
  eq('без источника → пусто', cell(base(), undefined), '');
  eq('const', cell(base(), { kind: 'const', value: 'ВЕЗА' }), 'ВЕЗА');
  for (const [key, want] of [
    ['tag', 'X-BL-001M'], ['parentTag', 'X-BL-001'], ['unitTag', 'X-P-1'], ['name', 'Двигатель вентилятора'], ['parentName', 'Вентилятор канальный'],
    ['model', 'AM-90'], ['kind', 'Асинхронный'], ['class', 'Двигатель'], ['system', 'П-1'], ['monoblock', 'МБ-1'], ['itemCode', 'M'],
  ] as const) eq(`поле ${key}`, cell(base(), { kind: 'field', key }), want);
  eq('поле parentName без родителя — пусто', cell(base({ parentName: undefined }), { kind: 'field', key: 'parentName' }), '');

  eq('param: приведение к единице столбца (Вт → кВт)', cell(base(), { kind: 'param', name: 'Мощность' }, 'кВт'), '7.5');
  eq('param: единица из источника, если у столбца нет своей', cell(base(), { kind: 'param', name: 'Мощность', unit: 'кВт' }), '7.5');
  eq('param: без единицы — как в карточке', cell(base(), { kind: 'param', name: 'Мощность' }), '7500');
  eq('param: без учёта регистра, ё = е и пробелов', cell(base(), { kind: 'param', name: '  напряжение ' }), '380');
  eq('param: пробелы внутри названия схлопываются', cell(base(), { kind: 'param', name: 'Ток,   НОМИНАЛЬНЫЙ' }), '15,5');
  eq('param: первое непустое среди одноимённых', cell(base({ groups: [{ title: 'Паспорт', params: [{ key: 'Мощность', value: '', unit: '' }] }, { title: 'Электрика', params: [{ key: 'Мощность', value: '3000', unit: 'Вт' }] }] }), { kind: 'param', name: 'Мощность' }, 'кВт'), '3');
  eq('param: «Раздел|Название» — точно', cell(base(), { kind: 'param', name: 'Паспорт|Мощность' }), '');
  eq('param: «Раздел|Название» — нужный раздел', cell(base(), { kind: 'param', name: 'Электрика|Мощность' }, 'кВт'), '7.5');
  eq('param: нет такой характеристики', cell(base(), { kind: 'param', name: 'КПД' }), '');
  eq('param: ручная правка сильнее', cell(base({ overrides: { 'Электрика||Мощность': '9000' } }), { kind: 'param', name: 'Мощность' }, 'кВт'), '9');
  eq('param: правка у характеристики, которой нет в группах (единицы у неё нет — как есть)', cell(base({ groups: [], overrides: { 'Электрика||Мощность': '2000' } }), { kind: 'param', name: 'Мощность' }, 'кВт'), '2000');
  eq('param: правка сильнее при точном адресе', cell(base({ overrides: { 'Электрика||Мощность': '1000' } }), { kind: 'param', name: 'Электрика|Мощность' }, 'кВт'), '1');

  // buildEquipmentExchange: те же значения и список того, что не привелось
  const built = buildEquipmentExchange([base()], [
    col('e3:A', { kind: 'field', key: 'tag' }), col('e3:B', { kind: 'param', name: 'Мощность' }, 'кВт'), col('e3:C', { kind: 'param', name: 'Ток, номинальный' }, 'кВт'),
  ]);
  eq('buildEquipmentExchange: строка', built.rows[0], ['X-BL-001M', '7.5', '15,5']);
  eq('buildEquipmentExchange: несовместимая единица попала в замечания', built.problems.map((p) => `${p.column}:${p.from}→${p.to}`), ['e3:C:А→кВт']);

  // Через шаблон: e3Columns → specOf → exportTable
  const attrs = applyAttributePlan([], parsed.items, { missing: 'keep' })
    .map((a) => (a.name === 'MOTOR_POWER' ? { ...a, source: { kind: 'param', name: 'Мощность', unit: 'кВт' } as const } : a));
  const columns = e3Columns(attrs, ['ДВИГАТЕЛЬ'], { header: 'name', onlyFromFlux: true });
  const spec = specOf({ ...defaultSpec(), columns: [{ key: 'tag', label: 'Тег' }, ...columns] });
  eq('specOf не теряет столбцы e3:', spec.columns.map((c) => c.key).filter((k) => k.startsWith('e3:')), columns.map((c) => c.key));
  eq('specOf сохраняет source', spec.columns.find((c) => c.key === 'e3:MOTOR_POWER')?.source, { kind: 'param', name: 'Мощность', unit: 'кВт' });
  eq('specOf: источник поля', spec.columns.find((c) => c.key === 'e3:GLOBAL_NODE_NAME')?.source, { kind: 'field', key: 'parentName' });
  eq('specOf: подпись столбца сохранена', spec.columns.find((c) => c.key === 'e3:MOTOR_POWER')?.label, 'MOTOR_POWER');
  eq('specOf переживает JSON (шаблон хранится строкой)', specOf(JSON.stringify(spec)).columns.find((c) => c.key === 'e3:MOTOR_POWER')?.source, { kind: 'param', name: 'Мощность', unit: 'кВт' });
  eq('specOf отбрасывает негодный источник, столбец остаётся', specOf({ v: 2, columns: [{ key: 'e3:ZZ', label: 'ZZ', source: { kind: 'field', key: 'нет' } }] }).columns[0].source, undefined);
  eq('specOf: подпись по умолчанию — имя атрибута', specOf({ v: 2, columns: [{ key: 'e3:ZZ' }] }).columns[0].label, 'ZZ');
  eq('specOf по-прежнему отбрасывает чужие ключи', specOf({ v: 2, columns: [{ key: 'tag' }, { key: 'нет-такого' }] }).columns.map((c) => c.key), ['tag']);
  const table = exportTable([base()], { ...spec, groupHeaders: false });
  eq('таблица: заголовки', table.headers.slice(0, 3), ['Тег', 'Device Designation', 'GLOBAL_TAG_UNIT']);
  const powerAt = table.headers.indexOf('MOTOR_POWER');
  const at = (h: string) => table.rows[0][table.headers.indexOf(h)];
  eq('таблица: тег, тег установки, название узла, мощность в кВт', [at('Device Designation'), at('GLOBAL_TAG_UNIT'), at('GLOBAL_NODE_NAME'), table.rows[0][powerAt]], ['X-BL-001M', 'X-P-1', 'Вентилятор канальный', '7.5']);

  // parentName проставляет сборка строк проекта
  const rows = rowsOfSystem({
    name: 'П-1',
    monoblocks: [{ name: 'МБ-1', components: [
      { id: 'a', itemCode: 'A', name: 'Вентилятор канальный', equipType: 'Вентилятор', tags: [{ identifier: 'X-BL-001' }] },
      { id: 'b', itemCode: 'B', name: 'Двигатель', equipType: 'Двигатель', parentElementId: 'a' },
      { id: 'c', itemCode: 'C', name: 'Корпус', equipType: 'Корпус' },
    ] }],
  }, () => ({ groups: [] }));
  eq('rowsOfSystem: parentName — название владельца', rows.map((r) => r.parentName), ['', 'Вентилятор канальный', '']);
}

console.log('Проверка входных данных');
{
  const good = applyAttributePlan([], parsed.items, { missing: 'keep' });
  eq('разобранный лист проходит проверку', 'items' in validateAttributes(good), true);
  const err = (patch: (a: any) => any, list = good.slice(0, 2)) => 'error' in validateAttributes(list.map((a, i) => (i === 0 ? patch({ ...a }) : a)));
  eq('не массив', 'error' in validateAttributes({}), true);
  eq('больше 2000', 'error' in validateAttributes(Array.from({ length: 2001 }, () => good[0])), true);
  eq('строка длиннее 500', err((a) => ({ ...a, comment: 'я'.repeat(501) })), true);
  eq('строка ровно 500', err((a) => ({ ...a, comment: 'я'.repeat(500) })), false);
  eq('источник негодный', err((a) => ({ ...a, source: { kind: 'sql', value: 'x' } })), true);
  eq('источник param без названия', err((a) => ({ ...a, source: { kind: 'param', name: ' ' } })), true);
  eq('источник field с чужим ключом', err((a) => ({ ...a, source: { kind: 'field', key: 'password' } })), true);
  eq('источник const со длинным значением', err((a) => ({ ...a, source: { kind: 'const', value: 'я'.repeat(501) } })), true);
  eq('неизвестный тип оборудования', err((a) => ({ ...a, classes: ['НЕТ'] })), true);
  eq('неизвестное правило спора', err((a) => ({ ...a, conflict: 'always' })), true);
  eq('нет имени', err((a) => ({ ...a, name: '  ' })), true);
  eq('service не boolean', err((a) => ({ ...a, service: 'ДА' })), true);
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки справочника атрибутов E3 пройдены');
