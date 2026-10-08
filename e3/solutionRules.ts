/**
 * Правила признаков «из подбора ОВ» для классов, которым их не хватало
 * (docs/e3-integration.md, 5.3): завод, коробки, оснащение, датчики, нагреватели,
 * теплоутилизаторы, увлажнители, охладители, узел регулирующий.
 *
 * Правило заведено только там, где у признака есть настоящий источник во Flux:
 * вид позиции (`kind`), модель, характеристика из словаря выгрузки САПР
 * (`server/vezaDict.ts`) или подпозиция роли (коробка, датчик, оснащение).
 * Признаки без источника (БРНО, обогрев привода, концевые КП1/КП2, число
 * фаз нагревателя…) правил не имеют — их отвечает профиль проекта или человек.
 * Правило без `otherwise` не отвечает, когда данных нет: тогда слово берёт
 * профиль проекта, и «нет коробки в Flux» не превращается в «коробки не надо».
 *
 * Правила правятся в каталоге; здесь только стартовый набор, которым
 * книга наполняется в первый раз и который дописывает «Добавить недостающее».
 */
import type { E3FeatureRule, E3RuleSource } from './solutionTypes';

const nums = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
const same = (list: string[]) => list.map((n) => ({ when: n, answer: n }));

const KIND: E3RuleSource = { kind: 'field', key: 'kind' };
const sensorKind: E3RuleSource = { kind: 'child-field', role: 'ДАТЧИК', key: 'kind' };
const outfitKind: E3RuleSource = { kind: 'child-field', role: 'ОСНАЩЕНИЕ', key: 'kind' };
const boxes = (n: number): E3FeatureRule['table'] => nums(1, n).map((v) => ({ when: v, answer: v }));

/** Правила, одинаковые у вентилятора, ЕС-вентилятора, фильтра: датчик контроля, коробка, оснащение секции */
const common = (mainClass: string, p: string, opts: { service?: boolean }): E3FeatureRule[] => [
  // Реле перепада — «Р». Датчик давления 4–20 мА — «Д» (вид «Давления»). Вид реле от датчика САПР не отличает, поэтому «Д» — только явный вид
  { mainClass, featureId: `${p}.control`, source: sensorKind, table: [{ when: '~реле', answer: 'Р' }, { when: 'Давления', answer: 'Д' }] },
  { mainClass, featureId: `${p}.box`, source: { kind: 'count', role: 'КОРОБКА' }, table: [{ when: '1', answer: 'К' }] },
  { mainClass, featureId: `${p}.light`, source: outfitKind, table: [{ when: '~светильник', answer: 'да' }] },
  ...(opts.service ? [{ mainClass, featureId: `${p}.service`, source: outfitKind, table: [{ when: '~сервисный', answer: 'да' }] }] : []),
];

/** Виды датчика Flux, по которым ответ на «температура / давление / влажность» известен: Давления — точно, чтобы реле перепада давления не считалось датчиком давления */
const SENSOR_KINDS: Array<[string, string]> = [['sensor.temp', '~температур'], ['sensor.press', 'Давления'], ['sensor.humid', '~влажн']];
const OTHER_SENSOR_KINDS = ['~реле', '~птс', '~термостат'];
const sensorRules: E3FeatureRule[] = SENSOR_KINDS.map(([featureId, mine]) => ({
  mainClass: 'Датчики', featureId, source: KIND,
  table: [{ when: mine, answer: '1' }, ...SENSOR_KINDS.filter(([, w]) => w !== mine).map(([, when]) => ({ when, answer: 'нет' })), ...OTHER_SENSOR_KINDS.map((when) => ({ when, answer: 'нет' }))],
}));

export const ADDED_RULES: E3FeatureRule[] = [
  // Клапан: коробка — подпозиции КОРОБКА (1 → К, 2 → К2…); обогрев — вид «С подогревом»; ЭПВ — модель привода
  { mainClass: 'Клапаны', featureId: 'valve.box', source: { kind: 'count', role: 'КОРОБКА' }, table: [{ when: '1', answer: 'К' }, { when: '2', answer: 'К2' }, { when: '3', answer: 'К3' }] },
  // Вид клапана известен — ответ есть («нет» только у тех видов, у которых подогрева не бывает); вид неизвестен — ответа нет, спросит профиль
  { mainClass: 'Клапаны', featureId: 'valve.heat_valve', source: KIND, table: [{ when: '~подогрев', answer: 'да' }, { when: '~воздушн', answer: 'нет' }, { when: '~обратн', answer: 'нет' }, { when: '~противопожар', answer: 'нет' }] },
  { mainClass: 'Клапаны', featureId: 'valve.epv', source: { kind: 'child-field', role: 'ПРИВОД', key: 'model' }, table: [{ when: '~ЭПВ', answer: 'да' }] },

  ...common('Вентилятор', 'fan', { service: true }),
  ...common('Вентилятор ЕС', 'fanec', { service: true }),
  ...common('Фильтры', 'filter', {}),

  // Нагреватель: вид — по виду позиции, ступени — «Группы нагрева» из выгрузки САПР, термостат — подпозиция ДАТЧИК, коробки — подпозиции КОРОБКА
  { mainClass: 'Нагреватель', featureId: 'heater.type', source: KIND, table: [{ when: '~жидкост', answer: 'ТО' }, { when: '~электр', answer: 'Э' }] },
  { mainClass: 'Нагреватель', featureId: 'heater.stages', source: { kind: 'param', name: 'Группы нагрева' }, table: same(nums(1, 12)) },
  { mainClass: 'Нагреватель', featureId: 'heater.freeze', source: sensorKind, table: [{ when: '~заморож', answer: 'да' }] },
  { mainClass: 'Нагреватель', featureId: 'heater.boxes', source: { kind: 'count', role: 'КОРОБКА' }, table: boxes(8) },

  // Теплоутилизатор: вид — по виду позиции; контроль и защита двигателя — подпозиция ДАТЧИК (вид «ПТС» — датчики температуры РТС)
  { mainClass: 'Теплоутилизатор', featureId: 'recup.type', source: KIND, table: [{ when: '~ротор', answer: 'ТР' }, { when: '~пластин', answer: 'ТП' }, { when: '~промежуточн', answer: 'ЖТУ' }] },
  { mainClass: 'Теплоутилизатор', featureId: 'recup.control', source: sensorKind, table: [{ when: '~реле', answer: 'Р' }, { when: 'Давления', answer: 'Д' }] },
  { mainClass: 'Теплоутилизатор', featureId: 'recup.motor_prot', source: sensorKind, table: [{ when: '~птс', answer: 'РТС' }] },

  // Увлажнитель: вид — по виду позиции
  { mainClass: 'Увлажнители', featureId: 'humid.type', source: KIND, table: [{ when: '~паров', answer: 'ПУ' }, { when: '~сотов', answer: 'СУ' }, { when: '~форсун', answer: 'ФУ' }] },

  // Охладитель: линейка — по модели позиции
  { mainClass: 'Охладитель', featureId: 'cooler.model', source: { kind: 'field', key: 'model' }, table: [{ when: '~КРАБ', answer: 'КРАБ/ВКИ' }, { when: '~ВКИ', answer: 'КРАБ/ВКИ' }, { when: '~МАКК', answer: 'МАКК' }, { when: '~МАРК', answer: 'МАРК' }] },

  // Датчик — одна позиция Flux: вид говорит, температура это, давление или влажность; два других признака тогда «нет».
  // Вид неизвестен — ответа нет вовсе, а не три «нет»: иначе подбор объявил бы, что такого решения не существует
  ...sensorRules,

  // Узел регулирующий: схема и типоразмер — характеристики «Узла обвязки» из выгрузки САПР
  { mainClass: 'Узел регулирующий', featureId: 'wss.scheme', source: { kind: 'param', name: 'Схема обвязки' }, table: same(['4', '5', '6']) },
  { mainClass: 'Узел регулирующий', featureId: 'wss.size', source: { kind: 'param', name: 'Типоразмер узла' }, table: [...nums(1, 5).map((n) => ({ when: n, answer: '1-5' })), ...nums(6, 11).map((n) => ({ when: n, answer: '6-11' }))] },
];
