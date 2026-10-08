/**
 * Стартовые настройки справочника типовых решений и разбор признаков из
 * названий схем (docs/e3-integration.md, 5.2 и 5.3).
 *
 * Признаки, правила, связь типов с классами — НАСТРОЙКИ: они лежат в книге и
 * правятся в каталоге. Здесь только то, чем книга наполняется в первый раз, и
 * подсказка «что значит токен в названии». Подсказка — предложение, а не
 * приговор: неоднозначное и непонятное уходит человеку на подтверждение.
 */
import type { E3Dictionary, E3Feature, E3FeatureRule, E3Solution } from './solutionTypes';
import { ADDED_RULES } from './solutionRules';

/** Без регистра, без пробелов по краям и лишних внутри, ё = е */
export const normText = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/ё/g, 'е');

// ── Тип Flux → основные классы файла ────────────────────────────────────────

export const DEFAULT_CLASS_MAP: Record<string, string[]> = {
  ВЕНТИЛЯТОР: ['Вентилятор', 'Вентилятор ЕС'],
  КЛАПАН: ['Клапаны'],
  ФИЛЬТР: ['Фильтры'],
  НАГРЕВАТЕЛЬ: ['Нагреватель'],
  ОХЛАДИТЕЛЬ: ['Охладитель'],
  РЕКУПЕРАТОР: ['Теплоутилизатор'],
  УВЛАЖНИТЕЛЬ: ['Увлажнители'],
  ОБВЯЗКА: ['Узел регулирующий'],
  ДАТЧИК: ['Датчики'],
  УСТАНОВКА: ['Начало установки', 'Конец установки'],
  КОРОБКА: ['Коробка'],
  // «Воздуховод» намеренно без типа Flux (решение владельца 8 октября 2026): блок воздуховода ставят вручную
};

// ── Признаки по классам ─────────────────────────────────────────────────────

const YN = ['нет', 'да'];
const nums = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
const F = (id: string, mainClass: string, title: string, values: string[], kind: E3Feature['kind'], hint = '', absent?: string): E3Feature =>
  ({ id, mainClass, title, values, kind, hint, ...(absent !== undefined ? { absent } : {}) });

/** Признаки вентилятора: у обычного и ЕС-вентилятора общие, различается число вентиляторов в блоке */
const fanFeatures = (cls: string, p: string): E3Feature[] => [
  F(`${p}.start`, cls, 'Способ пуска', ['ПП', 'ЗТ', 'УППИ', 'УППВ', 'ПЧИ', 'ПЧВ'], 'profile', 'ПП — прямой, ЗТ — звезда-треугольник, УПП и ПЧ: И — в шкафу, В — вне шкафа'),
  F(`${p}.control`, cls, 'Контроль', ['без', 'Д', 'Р'], 'profile', 'Д — датчик 4–20 мА, Р — реле перепада давления', 'без'),
  F(`${p}.phases`, cls, 'Фазы двигателя', ['3ф', '1ф'], 'ov', '1ф — ~230 В (ПП230)', '3ф'),
  F(`${p}.box`, cls, 'Дополнительная коробка', ['нет', 'К'], 'profile', '', 'нет'),
  F(`${p}.motor_prot`, cls, 'Защита двигателя', ['нет', 'РТС', '2РТС', 'ТК'], 'ov', 'РТС — датчики температуры, ТК — термоконтакты', 'нет'),
  F(`${p}.brno`, cls, 'БРНО', YN, 'ov', 'Блок распределения начал обмоток в двигателе', 'нет'),
  F(`${p}.service`, cls, 'Сервисный выключатель', YN, 'profile', 'СВ', 'нет'),
  F(`${p}.light`, cls, 'Освещение секции', YN, 'profile', 'ОСВ', 'нет'),
  F(`${p}.turn`, cls, 'Поворот «Влево»', YN, 'layout', 'Вытяжная линия идёт справа налево', 'нет'),
];

export const DEFAULT_FEATURES: E3Feature[] = [
  F('valve.drive', 'Клапаны', 'Тип привода', ['К', 'КР', 'КПР', 'КЭМП', 'КТРУ', 'КПП'], 'ov', 'К — пружинный возврат, КР — реверсивный, КПР — плавное регулирование, КЭМП — электромагнит, КТРУ, КПП — пневмопривод'),
  F('valve.voltage', 'Клапаны', 'Напряжение привода, В', ['24', '230'], 'ov'),
  F('valve.drives', 'Клапаны', 'Число приводов', ['1', '2', '3'], 'ov', '', '1'),
  F('valve.limit', 'Клапаны', 'Концевые выключатели', ['нет', 'КП1', 'КП2'], 'profile', 'КП1 — один контакт, КП2 — два', 'нет'),
  F('valve.box', 'Клапаны', 'Коробка подключения', ['нет', 'К', 'К2', 'К3'], 'profile', 'К2, К3 — на два и три привода', 'нет'),
  F('valve.heat_valve', 'Клапаны', 'Обогрев клапана (ПОК)', YN, 'ov', 'Периметральный обогрев клапана', 'нет'),
  F('valve.heat_drive', 'Клапаны', 'Обогрев привода (ОП)', YN, 'ov', '', 'нет'),
  F('valve.epv', 'Клапаны', 'ЭПВ', YN, 'ov', 'Расшифровки ЭПВ в словаре нет — уточните', 'нет'),
  ...fanFeatures('Вентилятор', 'fan'),
  ...fanFeatures('Вентилятор ЕС', 'fanec'),
  F('fanec.fans', 'Вентилятор ЕС', 'Число вентиляторов в блоке', nums(1, 12), 'ov'),
  F('heater.type', 'Нагреватель', 'Вид нагревателя', ['ТО', 'Э'], 'ov', 'ТО — жидкостный, Э — электрический'),
  F('heater.supply', 'Нагреватель', 'Питание, В', ['400', '230'], 'ov', '', '400'),
  F('heater.stages', 'Нагреватель', 'Число ступеней', ['0', ...nums(1, 12)], 'ov', 'Для электрического нагревателя', '0'),
  F('heater.freeze', 'Нагреватель', 'Термостат защиты от замораживания (Т)', YN, 'ov', '', 'нет'),
  F('heater.thermo', 'Нагреватель', 'Термоконтакты', ['нет', 'ТК2'], 'ov', '', 'нет'),
  F('heater.boxes', 'Нагреватель', 'Число дополнительных коробок', ['0', ...nums(1, 8)], 'profile', '', '0'),
  F('filter.control', 'Фильтры', 'Контроль', ['Д', 'Р'], 'profile', 'Д — датчик перепада 4–20 мА, Р — реле перепада'),
  F('filter.double', 'Фильтры', 'Двойной фильтр', YN, 'ov', '2 шт', 'нет'),
  F('filter.box', 'Фильтры', 'Дополнительная коробка', ['нет', 'К'], 'profile', '', 'нет'),
  F('filter.light', 'Фильтры', 'Освещение секции', YN, 'profile', 'ОСВ', 'нет'),
  F('filter.turn', 'Фильтры', 'Поворот «Влево»', YN, 'layout', '', 'нет'),
  F('recup.type', 'Теплоутилизатор', 'Вид теплоутилизатора', ['ТР', 'ТП', 'ЖТУ'], 'ov', 'ТР — роторный, ТП — перекрёстноточный, ЖТУ — с промежуточным теплоносителем'),
  F('recup.start', 'Теплоутилизатор', 'Способ пуска привода', ['нет', 'ПЧВ', 'ПЧИ'], 'profile', '', 'нет'),
  F('recup.control', 'Теплоутилизатор', 'Контроль', ['без', 'Д', 'Р'], 'profile', '', 'без'),
  F('recup.motor_prot', 'Теплоутилизатор', 'Защита двигателя', ['нет', 'РТС', 'ТК'], 'ov', '', 'нет'),
  F('recup.bypass', 'Теплоутилизатор', 'Привод обводного канала', ['нет', 'К24', 'К230', 'КР24', 'КР230', 'КПР24', 'КПР230'], 'ov', '', 'нет'),
  F('recup.sensor', 'Теплоутилизатор', 'Датчик температуры', ['нет', 'ТЕ', 'ТСП'], 'ov', '', 'нет'),
  F('recup.pump', 'Теплоутилизатор', 'Насос', ['нет', 'Н230', 'Н400', 'НПЧ230', 'НПЧ400'], 'ov', '', 'нет'),
  F('humid.type', 'Увлажнители', 'Вид увлажнителя', ['СУ', 'ФУ', 'ПУ'], 'ov', 'СУ — сотовый, ФУ — форсуночный, ПУ — паровой'),
  F('humid.pump', 'Увлажнители', 'Насос', ['нет', 'НП230', 'Н230'], 'ov', '', 'нет'),
  F('humid.solenoid', 'Увлажнители', 'Соленоидный клапан (KL)', YN, 'ov', '', 'нет'),
  F('humid.level', 'Увлажнители', 'Датчик уровня воды (LE)', YN, 'ov', '', 'нет'),
  F('humid.me', 'Увлажнители', 'Датчик температуры и влажности (МЕ)', YN, 'ov', '', 'нет'),
  F('humid.me_link', 'Увлажнители', 'Подключение МЕ', ['нет', 'ШСАУ', 'интегрирован'], 'ov', 'В — к ШСАУ, И — в блок управления', 'нет'),
  F('cooler.model', 'Охладитель', 'Модель', ['КРАБ/ВКИ', 'МАКК', 'МАРК'], 'ov'),
  F('cooler.drive', 'Охладитель', 'Привод клапана', ['нет', 'КПР24', 'КПР230'], 'ov', '', 'нет'),
  // «Д_Т_1_шт_Д_В_1_шт»: датчик температуры (Т), давления (Д), влажности (В) и сколько штук
  F('sensor.temp', 'Датчики', 'Датчик температуры', ['нет', '1', '2'], 'ov', 'Д_Т_n_шт — n датчиков температуры', 'нет'),
  F('sensor.press', 'Датчики', 'Датчик давления', ['нет', '1', '2'], 'ov', 'Д_Д_n_шт', 'нет'),
  F('sensor.humid', 'Датчики', 'Датчик влажности', ['нет', '1', '2'], 'ov', 'Д_В_n_шт', 'нет'),
  F('wss.scheme', 'Узел регулирующий', 'Схема обвязки', ['4', '5', '6'], 'ov', 'Номер схемы узла ВЕКТОР'),
  F('wss.size', 'Узел регулирующий', 'Типоразмер узла', ['1-5', '6-11', 'любой'], 'ov', 'Диапазон типоразмеров; «любой» — решение подходит всем', 'любой'),
  F('begin.levels', 'Начало установки', 'Уровней', ['1УР', '2УР'], 'layout', 'Одноуровневая или двухуровневая установка'),
  F('begin.flow', 'Начало установки', 'Воздух', ['П', 'ПВ', 'не указан'], 'profile', 'П — приточная, ПВ — приточно-вытяжная', 'не указан'),
  F('begin.inlet', 'Начало установки', 'Вход', ['ОВ', 'РВ', 'нет'], 'profile', 'ОВ — общий вход, РВ — раздельный', 'нет'),
  F('begin.recup', 'Начало установки', 'Рекуперация', ['Р', 'БР', 'нет'], 'profile', 'Р — с рекуперацией, БР — без рекуперации', 'нет'),
  F('end.levels', 'Конец установки', 'Уровней', ['1УР', '2УР'], 'layout', 'Одноуровневая или двухуровневая установка'),
  F('end.flow', 'Конец установки', 'Воздух', ['П', 'ПВ', 'не указан'], 'profile', 'П — приточная, ПВ — приточно-вытяжная', 'не указан'),
  F('end.outlet', 'Конец установки', 'Выход', ['ОВ', 'РВ', 'нет'], 'profile', 'ОВ — общий выход, РВ — раздельные выходы', 'нет'),
  F('box.purpose', 'Коробка', 'Назначение', ['привод', 'двигатель', 'обогрев', 'светильник', 'КИП'], 'ov', 'Что подключается через коробку; берётся из класса решения'),
  F('box.drive', 'Коробка', 'Привод в коробке', ['нет', 'пружинный', 'реверсивный'], 'ov', 'Для коробки привода: пружинный или реверсивный', 'нет'),
  F('box.limit', 'Коробка', 'Концевые выключатели', ['нет', '2ПК'], 'ov', '2ПК — два переключающих контакта', 'нет'),
  F('duct.kind', 'Воздуховод', 'Исполнение блока', ['проходной', 'пустой'], 'ov', 'Проходной блок или пустой'),
];

// ── Правила: признак из подбора ОВ (5.3) ────────────────────────────────────

const motorVoltage = (cls: string, id: string): E3FeatureRule => ({
  mainClass: cls, featureId: id, source: { kind: 'child-param', role: 'ДВИГАТЕЛЬ', name: 'Напряжение', unit: 'В' },
  table: [{ when: '230', answer: '1ф' }, { when: '220', answer: '1ф' }, { when: '380', answer: '3ф' }, { when: '400', answer: '3ф' }],
});
const motorProt = (cls: string, id: string): E3FeatureRule => ({
  mainClass: cls, featureId: id, source: { kind: 'child-param', role: 'ДВИГАТЕЛЬ', name: 'Термозащита' },
  table: [{ when: '~PTC', answer: 'РТС' }, { when: '~РТС', answer: 'РТС' }, { when: '~термоконтакт', answer: 'ТК' }],
});

export const DEFAULT_RULES: E3FeatureRule[] = [
  {
    mainClass: 'Клапаны', featureId: 'valve.voltage', source: { kind: 'child-param', role: 'ПРИВОД', name: 'Напряжение питания', unit: 'В' },
    table: [{ when: '24', answer: '24' }, { when: '220', answer: '230' }, { when: '230', answer: '230' }],
  },
  {
    mainClass: 'Клапаны', featureId: 'valve.drive', source: { kind: 'child-field', role: 'ПРИВОД', key: 'kind' },
    // «Без пружины» тоже содержит «пружин»: строка про неё стоит раньше
    table: [{ when: '~без пружины', answer: 'КР' }, { when: '~пружин', answer: 'К' }, { when: '~0-10', answer: 'КПР' }, { when: '~плавн', answer: 'КПР' }],
  },
  { mainClass: 'Клапаны', featureId: 'valve.drives', source: { kind: 'count', role: 'ПРИВОД' }, table: [{ when: '1', answer: '1' }, { when: '2', answer: '2' }, { when: '3', answer: '3' }] },
  {
    mainClass: 'Вентилятор', featureId: '@class', source: { kind: 'child-param', role: 'ДВИГАТЕЛЬ', name: 'Тип двигателя' },
    table: [{ when: '~EC', answer: 'Вентилятор ЕС' }, { when: '~ЕС', answer: 'Вентилятор ЕС' }], otherwise: 'Вентилятор',
  },
  { mainClass: 'Вентилятор ЕС', featureId: 'fanec.fans', source: { kind: 'count', role: 'ВЕНТИЛЯТОР' }, table: nums(1, 12).map((n) => ({ when: n, answer: n })) },
  motorVoltage('Вентилятор', 'fan.phases'), motorVoltage('Вентилятор ЕС', 'fanec.phases'),
  motorProt('Вентилятор', 'fan.motor_prot'), motorProt('Вентилятор ЕС', 'fanec.motor_prot'),
  { mainClass: 'Фильтры', featureId: 'filter.double', source: { kind: 'param', name: 'Число ступеней фильтрации' }, table: [{ when: '2', answer: 'да' }], otherwise: 'нет' },
  ...ADDED_RULES,
];

// ── Разбор названия схемы ───────────────────────────────────────────────────

/** Латинская буква, которую легко принять за кириллическую: «K» вместо «К» */
const LOOKALIKE: Record<string, string> = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' };
const LATIN = /[A-Za-z]/;
const CYR = /[А-Яа-яЁё]/;

/** Токен кириллицей, если он написан латинскими двойниками. Известный словарю код не трогаем */
export function cyrillicToken(token: string, dictionary: E3Dictionary = {}): string {
  if (!LATIN.test(token) || token in dictionary) return token;
  const conv = [...token].map((ch) => (LATIN.test(ch) ? LOOKALIKE[ch.toUpperCase()] : ch));
  return conv.every((c) => c !== undefined) ? conv.join('') : token;
}

type Set3 = [feature: string, value: string, ambiguous?: string];
interface Ctx { p: string; prev: string; next: string }
/** `null` — правило токен не берёт (он не подошёл по условию вне регулярного выражения) */
type Rule = [RegExp, (m: RegExpMatchArray, c: Ctx) => Set3[] | null];

const FAN_RULES: Rule[] = [
  [/^(ПП|ЗТ|УППИ|УППВ|ПЧИ|ПЧВ)(Д|Р)?(230)?$/, (m, c) => [[`${c.p}.start`, m[1]], [`${c.p}.control`, m[2] === 'Д' ? 'Д' : m[2] === 'Р' ? 'Р' : 'без'], [`${c.p}.phases`, m[3] ? '1ф' : '3ф']]],
  [/^ЕС$/, () => []],
  [/^(\d?)РТС$/, (m, c) => [[`${c.p}.motor_prot`, `${m[1]}РТС`]]],
  [/^ТК$/, (_m, c) => [[`${c.p}.motor_prot`, 'ТК']]],
  [/^БРНО$/, (_m, c) => [[`${c.p}.brno`, 'да']]],
  [/^СВ$/, (_m, c) => [[`${c.p}.service`, 'да']]],
  [/^ОСВ$/, (_m, c) => [[`${c.p}.light`, 'да']]],
  [/^влево$/i, (_m, c) => [[`${c.p}.turn`, 'да']]],
  [/^К$/, (_m, c) => [[`${c.p}.box`, 'К']]],
];

const NUM = /^\d{1,2}$/;

/**
 * Начало и конец установки читаются одинаково: «2УР» — уровней, «П» / «ПВ» —
 * приточная или приточно-вытяжная, «ОВ» / «РВ» — общий или раздельный вход (у
 * конца — выход), «Р» / «БР» — с рекуперацией или без. «ПР» в одном названии
 * похоже на опечатку вместо «П» — принято как «П» и отдано на подтверждение.
 */
const UNIT_END = (p: 'begin' | 'end', gate: 'inlet' | 'outlet'): Rule[] => [
  [/^([12])УР$/, (m) => [[`${p}.levels`, `${m[1]}УР`]]],
  [/^ПВ$/, () => [[`${p}.flow`, 'ПВ']]],
  [/^П$/, () => [[`${p}.flow`, 'П']]],
  [/^ПР$/, () => [[`${p}.flow`, 'П', '«ПР» — вероятно, опечатка вместо «П» (приточная): проверьте название схемы']]],
  [/^(ОВ|РВ)$/, (m) => [[`${p}.${gate}`, m[1]]]],
  ...(p === 'begin' ? [[/^(Р|БР)$/, (m: RegExpMatchArray) => [['begin.recup', m[1]] as Set3]] as Rule] : []),
];

const GRAMMAR: Record<string, Rule[]> = {
  'Клапаны': [
    [/^(\d)?(КПР|КР|КЭМП|КТРУ|КПП|К)(24|230)$/, (m) => [['valve.drive', m[2]], ['valve.drives', m[1] || '1'], ['valve.voltage', m[3]]]],
    [/^КП([12])$/, (m) => [['valve.limit', `КП${m[1]}`]]],
    [/^К(\d)?$/, (m) => [['valve.box', m[1] ? `К${m[1]}` : 'К', '«К» у клапана без напряжения: коробка подключения или тип привода — принято как коробка']]],
    [/^ПОК$/, () => [['valve.heat_valve', 'да']]],
    [/^ОП$/, () => [['valve.heat_drive', 'да']]],
    [/^ЭПВ$/, () => [['valve.epv', 'да']]],
  ],
  'Вентилятор': [...FAN_RULES],
  'Вентилятор ЕС': [
    ...FAN_RULES,
    [/^\d{1,2}$/, (m) => [['fanec.fans', m[0], 'цифра после «_» у вентилятора ЕС — число вентиляторов в блоке; у других классов такие цифры значат иное']]],
  ],
  'Нагреватель': [
    [/^ТО$/, () => [['heater.type', 'ТО']]],
    [/^Э(230)?$/, (m) => [['heater.type', 'Э'], ['heater.supply', m[1] ? '230' : '400']]],
    [/^Т$/, () => [['heater.freeze', 'да']]],
    [/^ТК(\d?)$/, (m) => [['heater.thermo', `ТК${m[1]}`]]],
    [/^К(\d?)$/, (m) => [['heater.boxes', m[1] || '1']]],
    [/^\d{1,2}$/, (m, c) => (/^К$/.test(c.prev)
      ? [['heater.boxes', m[0], 'цифра после «К» у нагревателя — число коробок']]
      : [['heater.stages', m[0], 'цифра после «_» у нагревателя — число ступеней; у вентиляторов ЕС это число вентиляторов']])],
  ],
  'Фильтры': [
    [/^ФВ(Д|Р)$/, (m) => [['filter.control', m[1]]]],
    [/^К$/, () => [['filter.box', 'К']]],
    [/^ОСВ$/, () => [['filter.light', 'да']]],
    [/^влево$/i, () => [['filter.turn', 'да']]],
    [/^\d$/, (m, c) => (c.next === 'шт' ? [['filter.double', m[0] === '2' ? 'да' : 'нет']] : null)],
    [/^шт$/, () => []],
  ],
  'Теплоутилизатор': [
    [/^(ТП|ТР|ЖТУ)$/, (m) => [['recup.type', m[1]]]],
    [/^(ПЧВ|ПЧИ)$/, (m) => [['recup.start', m[1]]]],
    [/^(Д|Р)$/, (m) => [['recup.control', m[1]]]],
    [/^(ТК|РТС)$/, (m) => [['recup.motor_prot', m[1]]]],
    [/^(К24|К230|КР24|КР230|КПР24|КПР230)$/, (m) => [['recup.bypass', m[1]]]],
    [/^О$/, () => []],
    [/^(ТЕ|ТСП)$/, (m) => [['recup.sensor', m[1]]]],
    [/^(Н230|Н400|НПЧ230|НПЧ400)$/, (m) => [['recup.pump', m[1]]]],
  ],
  'Увлажнители': [
    [/^(СУ|ФУ|ПУ)$/, (m) => [['humid.type', m[1]]]],
    [/^(НП230|Н230)$/, (m) => [['humid.pump', m[1]]]],
    [/^KL$/, () => [['humid.solenoid', 'да']]],
    [/^LE$/, () => [['humid.level', 'да']]],
    [/^МЕ$/, () => [['humid.me', 'да']]],
    [/^В$/, () => [['humid.me_link', 'ШСАУ']]],
    [/^И$/, () => [['humid.me_link', 'интегрирован']]],
  ],
  'Охладитель': [
    [/^(ФО|ХО)$/, () => []],
    [/^(КПР24|КПР230)$/, (m) => [['cooler.drive', m[1]]]],
  ],
  // УР_ВЕКТОР_4ПГ/ПУ_6_11: схема — цифра перед «ПГ»/«ПУ», типоразмер — пара чисел в конце; «ПГ/ПУ» в словаре нет, различий между решениями не даёт
  'Узел регулирующий': [
    [/^ВЕКТОР$/, () => []],
    [/^(\d)(?:ПГ(?:\/ПУ)?|ПУ)$/, (m) => [['wss.scheme', m[1]]]],
    [/^\d{1,2}$/, (m, c) => (NUM.test(c.next) ? [['wss.size', `${m[0]}-${c.next}`]] : NUM.test(c.prev) ? [] : null)],
  ],
  'Начало установки': UNIT_END('begin', 'inlet'),
  'Конец установки': UNIT_END('end', 'outlet'),
  // КОРВ-88 тип 6.1_пружина-2ПК: номер коробки не признак, а «пружина / реверсивный» и «2ПК» — признаки
  'Коробка': [
    [/^КОРВ-\d+ тип [\d.]+$/, () => []],
    [/^(?:пружин\S*|Пруж)(?:-(2ПК))?$/i, (m) => [['box.drive', 'пружинный'], ...(m[1] ? [['box.limit', '2ПК'] as Set3] : [])]],
    [/^реверсивн\S*(?:-(2ПК))?$/i, (m) => [['box.drive', 'реверсивный'], ...(m[1] ? [['box.limit', '2ПК'] as Set3] : [])]],
  ],
};

/** Слово перед первым «_», которое называет класс, а не признак */
const PREFIXES = new Set(['клапан', 'вентилятор', 'фильтр', 'нагреватель', 'теплоутилизатор', 'увлажнитель', 'ур', 'начало', 'конец']);

/** Токен — артикул или название линейки, а не код обозначения: в словаре «Обозначения» его искать нечего */
const NOT_A_CODE = /^(КОРВ-|ВЕКТОР$)/;

interface Pre { sets: Set3[]; unknown: string[]; tokens: boolean }
/**
 * Классы, чьи признаки читаются не по токенам названия: у датчиков число стоит
 * после буквы вида («Д_Т_1_шт»), у коробки назначение — в подклассе, у
 * воздуховода всего два названия.
 */
const PRE: Record<string, (sol: Pick<E3Solution, 'name'> & { subclass?: string }) => Pre> = {
  'Датчики': (sol) => {
    const kinds: Record<string, string> = { 'Т': 'sensor.temp', 'Д': 'sensor.press', 'В': 'sensor.humid' };
    const sets: Set3[] = [];
    const rest = String(sol.name || '').replace(/Д_([ТДВ])_(\d+)_шт/g, (_all, k: string, n: string) => { sets.push([kinds[k], n]); return ''; });
    const unknown = rest.split('_').map((t) => t.trim()).filter(Boolean);
    return { sets, unknown, tokens: false };
  },
  'Воздуховод': (sol) => {
    const n = normText(sol.name);
    if (n === 'проходной') return { sets: [['duct.kind', 'проходной']], unknown: [], tokens: false };
    if (n === 'блок пусто') return { sets: [['duct.kind', 'пустой']], unknown: [], tokens: false };
    return { sets: [], unknown: [String(sol.name || '')], tokens: false };
  },
  'Коробка': (sol) => {
    const sub = normText(sol.subclass);
    const purpose = /подключения\s+привод/.test(sub) ? 'привод' : /подключения\s+двигател/.test(sub) ? 'двигатель' : /подключения\s+обогрев/.test(sub) ? 'обогрев'
      : /подключения\s+светильник/.test(sub) ? 'светильник' : /коробка\s+кип/.test(sub) ? 'КИП' : '';
    return { sets: purpose ? [['box.purpose', purpose]] : [], unknown: purpose ? [] : [`назначение коробки не распознано по классу «${sol.subclass || ''}»`], tokens: true };
  },
};

export interface E3Suggestion {
  features: Record<string, string>;
  /** Всё разобрано однозначно: подтверждать нечего */
  confirmed: boolean;
  ambiguous: { token: string; reason: string }[];
  unknown: string[];
  /** Латинские двойники кириллических кодов: [найдено, принято за] */
  latin: [string, string][];
  /** Коды, которых нет в словаре */
  notInDictionary: string[];
}

/**
 * Признаки решения по его названию. Токены читаются по правилам класса, а
 * затем по вариантам самих признаков: администратор добавил значение
 * признаку — токен с этим значением узнаётся без правки программы.
 */
export function suggestFeatures(sol: Pick<E3Solution, 'mainClass' | 'name'> & { subclass?: string }, ctx: { features: E3Feature[]; dictionary: E3Dictionary }): E3Suggestion {
  const out: E3Suggestion = { features: {}, confirmed: true, ambiguous: [], unknown: [], latin: [], notInDictionary: [] };
  const feats = ctx.features.filter((f) => f.mainClass === sol.mainClass);
  if (!feats.length) return out;
  const ids = new Set(feats.map((f) => f.id));
  const raw = String(sol.name || '').split('_').map((t) => t.trim());
  const tokens = raw.length && PREFIXES.has(normText(raw[0])) ? raw.slice(1) : raw;
  const grammar = GRAMMAR[sol.mainClass] || [];
  const dictionary = ctx.dictionary || {};
  const prefix = sol.mainClass === 'Вентилятор' ? 'fan' : 'fanec';

  const pre = PRE[sol.mainClass]?.(sol);
  if (pre) {
    for (const [id, value] of pre.sets) if (ids.has(id)) out.features[id] = value;
    out.unknown.push(...pre.unknown);
  }

  tokens.forEach((orig, i) => {
    if (!orig || (pre && !pre.tokens)) return;
    const token = cyrillicToken(orig, dictionary);
    if (token !== orig) out.latin.push([orig, token]);
    const c: Ctx = { p: prefix, prev: tokens[i - 1] ? cyrillicToken(tokens[i - 1], dictionary) : '', next: tokens[i + 1] ? cyrillicToken(tokens[i + 1], dictionary) : '' };
    let sets: Set3[] | null = null;
    for (const [re, fn] of grammar) { const m = token.match(re); const r = m && fn(m, c); if (r) { sets = r; break; } }
    if (!sets) {
      // По вариантам признаков: токен равен значению ровно одного признака класса
      const hit = feats.filter((f) => f.values.some((v) => normText(v) === normText(token)));
      if (hit.length === 1) sets = [[hit[0].id, hit[0].values.find((v) => normText(v) === normText(token))!]];
      else if (hit.length > 1) { out.ambiguous.push({ token: orig, reason: `значение есть у нескольких признаков: ${hit.map((f) => f.title).join(', ')}` }); return; }
    }
    if (!sets) { out.unknown.push(orig); return; }
    for (const [id, value, reason] of sets) {
      if (!ids.has(id)) continue;
      out.features[id] = value;
      if (reason && !out.ambiguous.some((a) => a.token === orig)) out.ambiguous.push({ token: orig, reason });
    }
    const code = token.replace(/^\d+/, '');
    if (Object.keys(dictionary).length && !NOT_A_CODE.test(token) && /\p{L}/u.test(code) && !(token in dictionary) && !(code in dictionary) && !out.notInDictionary.includes(code)) out.notInDictionary.push(code);
  });

  // Признак, которого в названии нет: «нет» / «без» там, где это названо настройкой
  const missing: string[] = [];
  for (const f of feats) {
    if (f.id in out.features) continue;
    if (f.absent !== undefined) out.features[f.id] = f.absent; else missing.push(f.title);
  }
  for (const t of missing) out.unknown.push(`признак «${t}» в названии не найден`);
  out.confirmed = !out.ambiguous.length && !out.unknown.length;
  return out;
}
