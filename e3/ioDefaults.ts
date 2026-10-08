/**
 * Стартовые правила связи «решение и признаки → строки таблицы IO»
 * (docs/e3-integration.md, 5.4 и 5.9).
 *
 * Правила — НАСТРОЙКА каталога: лежат в книге (`ioRules`), правятся в разделе
 * «Таблица IO», а здесь только то, чем книга наполняется в первый раз и что
 * дописывает действие «Добавить недостающее». Строки таблицы правила находят
 * по куску наименования и по обозначению, а не по номеру: владелец вправе
 * переставить строки или поправить подпись, и правило не сломается, пока кусок
 * в наименовании остался. Нет строки — рецепт скажет об этом замечанием.
 */
import type { E3IoRowRef, E3IoRule } from './solutionTypes';

const R = (id: string, title: string, mainClass: string, when: E3IoRule['when'], role: string, row: E3IoRowRef, count: E3IoRule['count'] = { kind: 'one' }, fromRole?: string): E3IoRule =>
  ({ id, title, mainClass, when, role, row, count, ...(fromRole ? { fromRole } : {}) });

const SENSORS = 'Датчики';
/** Строка «Давления, температуры»: один аналоговый вход на датчик 4–20 мА */
const SENSOR_AI: E3IoRowRef = { group: SENSORS, code: 'PT, PDT, TT' };
const SENSOR_PS: E3IoRowRef = { group: SENSORS, code: 'PS' };
const SENSOR_TS: E3IoRowRef = { group: SENSORS, code: 'TS' };

/** Двигатель вентилятора: с частотным регулированием или без. «ЕС» — всегда с ЧРП (AI/AO на скорость) */
const isVfd = ['ПЧИ', 'ПЧВ'];

/** Контроль «Д» (датчик 4–20 мА) и «Р» (реле перепада) одинаков у вентиляторов, фильтров и теплоутилизаторов */
const control = (mainClass: string, prefix: string, what: string): E3IoRule[] => [
  R(`${prefix}.control_d`, `${what}: датчик перепада 4–20 мА`, mainClass, [{ feature: `${prefix}.control`, values: ['Д'] }], 'Датчик перепада давления', SENSOR_AI),
  R(`${prefix}.control_r`, `${what}: реле перепада давления`, mainClass, [{ feature: `${prefix}.control`, values: ['Р'] }], 'Реле перепада давления', SENSOR_PS),
];

export const DEFAULT_IO_RULES: E3IoRule[] = [
  // Клапан: привод по виду, столько раз, сколько приводов
  R('valve.spring', 'Клапан с пружинным приводом', 'Клапаны', [{ feature: 'valve.drive', values: ['К'] }], 'Привод', { group: 'Приводы', name: 'пружинный, с бк' }, { kind: 'feature', feature: 'valve.drives' }, 'ПРИВОД'),
  R('valve.reversible', 'Клапан с реверсивным приводом', 'Клапаны', [{ feature: 'valve.drive', values: ['КР'] }], 'Привод', { group: 'Приводы', name: '3-позиционный' }, { kind: 'feature', feature: 'valve.drives' }, 'ПРИВОД'),
  R('valve.modulating', 'Клапан с плавным регулированием', 'Клапаны', [{ feature: 'valve.drive', values: ['КПР'] }], 'Привод', { group: 'Приводы', name: 'плавное' }, { kind: 'feature', feature: 'valve.drives' }, 'ПРИВОД'),
  R('valve.heat', 'Обогрев клапана', 'Клапаны', [{ feature: 'valve.heat_valve', values: ['да'] }], 'Обогрев клапана', { name: 'Обогрев клапана' }),

  // Вентилятор: двигатель с ЧРП или без — по способу пуска; на ЕС-вентиляторе — всегда с ЧРП, на каждый
  R('fan.motor_vfd', 'Двигатель вентилятора с ЧРП', 'Вентилятор', [{ feature: 'fan.start', values: isVfd }], 'Двигатель', { name: 'ЭД с ЧРП' }, { kind: 'one' }, 'ДВИГАТЕЛЬ'),
  R('fan.motor_plain', 'Двигатель вентилятора без ЧРП', 'Вентилятор', [{ feature: 'fan.start', values: isVfd, not: true }], 'Двигатель', { name: 'ЭД без ЧРП' }, { kind: 'one' }, 'ДВИГАТЕЛЬ'),
  R('fanec.motor', 'ЕС-двигатели вентиляторов блока', 'Вентилятор ЕС', [], 'Двигатель', { name: 'ЭД с ЧРП' }, { kind: 'feature', feature: 'fanec.fans' }, 'ДВИГАТЕЛЬ'),
  ...control('Вентилятор', 'fan', 'Вентилятор'),
  ...control('Вентилятор ЕС', 'fanec', 'Вентилятор ЕС'),
  ...control('Фильтры', 'filter', 'Фильтр'),
  ...control('Теплоутилизатор', 'recup', 'Теплоутилизатор'),

  // Датчики блока «Датчики»: каждый вид — один аналоговый вход
  R('sensor.temp', 'Датчик температуры', SENSORS, [{ feature: 'sensor.temp', values: ['1'] }], 'Датчик температуры', SENSOR_AI),
  R('sensor.press', 'Датчик давления', SENSORS, [{ feature: 'sensor.press', values: ['1'] }], 'Датчик давления', SENSOR_AI),
  R('sensor.humid', 'Датчик влажности', SENSORS, [{ feature: 'sensor.humid', values: ['1'] }], 'Датчик влажности', { group: SENSORS, code: 'MT' }),

  // Нагреватель: электрический — ступени ЭК (первая с ШИМ, остальные обычные), жидкостный — клапан по воде и насос
  R('heater.stage_first', 'Электрокалорифер: первая ступень с ШИМ', 'Нагреватель', [{ feature: 'heater.type', values: ['Э'] }], 'Ступень ЭК с ШИМ', { group: 'ЭК', name: '1 ступень' }, { kind: 'feature', feature: 'heater.stages', cap: 1 }),
  R('heater.stage_next', 'Электрокалорифер: остальные ступени', 'Нагреватель', [{ feature: 'heater.type', values: ['Э'] }], 'Ступень ЭК', { group: 'ЭК', name: 'остальные ступени' }, { kind: 'feature', feature: 'heater.stages', offset: -1 }),
  R('heater.overheat', 'Электрокалорифер: защита по перегреву', 'Нагреватель', [{ feature: 'heater.type', values: ['Э'] }, { feature: 'heater.thermo', values: ['ТК2'] }], 'Термоконтакты', { group: 'ЭК', name: 'по перегреву' }),
  R('heater.water_valve', 'Жидкостный нагреватель: клапан по воде', 'Нагреватель', [{ feature: 'heater.type', values: ['ТО'] }], 'Клапан по воде', { group: 'Приводы', name: 'Клапан по воде' }),
  R('heater.pump', 'Жидкостный нагреватель: насос', 'Нагреватель', [{ feature: 'heater.type', values: ['ТО'] }], 'Насос', { name: 'Циркуляционный насос' }, { kind: 'one' }, 'НАСОС'),
  R('heater.freeze', 'Термостат защиты от замораживания', 'Нагреватель', [{ feature: 'heater.freeze', values: ['да'] }], 'Термостат', SENSOR_TS),

  // Охладитель и пароувлажнитель — свои строки
  R('cooler.unit', 'Охладитель', 'Охладитель', [], 'Охладитель', { name: 'Охладитель' }),
  R('humid.steam', 'Паровой увлажнитель', 'Увлажнители', [{ feature: 'humid.type', values: ['ПУ'] }], 'Пароувлажнитель', { name: 'Пароувлажнитель' }),
];
