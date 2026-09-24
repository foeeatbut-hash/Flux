/**
 * Комплектующие клапанов: приводы, коробки, кабельные вводы.
 *
 * Значения — из бланков E06-2002/2003, согласованных с заводом: там у каждого
 * привода записаны мощность, маркировка взрывозащиты и степень защиты корпуса.
 * Блок «Информация по электроприводу» бланка берёт их отсюда, чтобы не
 * перепечатывать одно и то же в каждом листе.
 */
import { t2, type Component } from '../model';
import { VALVE_CLASS_ID } from './class';

const s = (ru: string, en: string, value: string, unit?: string) => ({ label: t2(ru, en), value, ...(unit ? { unit } : {}) });

const act = (code: string, ru: string, maker: string, facts: Component['facts'], specs: Component['specs']): Component =>
  ({ id: `cmp-${code.toLowerCase().replace(/[^a-z0-9а-я]+/gi, '-')}`, classId: VALVE_CLASS_ID, kind: 'actuator', code, title: t2(ru), manufacturer: maker, facts, specs });

export const VALVE_COMPONENTS: Component[] = [
  act('ЭПВ24', 'Взрывозащищённый электропривод ЭПВ24', 'ВЕЗА', { voltage: 24, ex: true }, [
    s('Напряжение питания', 'Supply voltage', '24 V AC/DC'),
    s('Потребляемая мощность', 'Power consumption', '10', 'Вт'),
    s('Маркировка взрывозащиты', 'Ex marking', '1Ex d IIC T6 Gb'),
    s('Степень защиты корпуса', 'Enclosure protection', 'IP66'),
    s('Концевые выключатели', 'Limit switches', '1 открыто, 1 закрыто'),
  ]),
  act('ЭПВ220', 'Взрывозащищённый электропривод ЭПВ220', 'ВЕЗА', { voltage: 220, ex: true }, [
    s('Напряжение питания', 'Supply voltage', '~220 V'),
    s('Маркировка взрывозащиты', 'Ex marking', '1Ex d IIC T6 Gb'),
    s('Степень защиты корпуса', 'Enclosure protection', 'IP66'),
  ]),
  act('MV24', 'Электропривод ВЕЗА MV24', 'ВЕЗА', { voltage: 24, ex: false }, [
    s('Напряжение питания', 'Supply voltage', '24 V AC/DC'),
    s('Потребляемая мощность', 'Power consumption', '10', 'Вт'),
    s('Степень защиты корпуса', 'Enclosure protection', 'IP54'),
    s('Концевые выключатели', 'Limit switches', '1 открыто, 1 закрыто'),
  ]),
  act('MV220', 'Электропривод ВЕЗА MV220', 'ВЕЗА', { voltage: 220, ex: false }, [
    s('Напряжение питания', 'Supply voltage', '~220 V'),
    s('Степень защиты корпуса', 'Enclosure protection', 'IP54'),
  ]),
  act('МН24', 'Электропривод НЕМАН МН24', 'НЕМАН', { voltage: 24, ex: false, brand: 'НЕМАН' }, [
    s('Напряжение питания', 'Supply voltage', '24 V AC/DC'),
    s('Потребляемая мощность', 'Power consumption', '10', 'Вт'),
    s('Степень защиты корпуса', 'Enclosure protection', 'IP54'),
    s('Температура работы', 'Operating temperature', '-30/+50', '°С'),
  ]),
  act('МН220', 'Электропривод НЕМАН МН220', 'НЕМАН', { voltage: 220, ex: false, brand: 'НЕМАН' }, [
    s('Напряжение питания', 'Supply voltage', '~220 V'),
    s('Степень защиты корпуса', 'Enclosure protection', 'IP54'),
  ]),
  act('SM24-S2-V', 'Электропривод SM24-S2-V, 20 Н·м', 'ВЕЗА', { voltage: 24, actuator: 'reversible', ex: false }, [
    s('Напряжение питания', 'Supply voltage', '24 V AC/DC'),
    s('Потребляемая мощность', 'Power consumption', 'во время вращения 8 / в покое 2', 'Вт'),
    s('Крутящий момент', 'Torque', '20', 'Н·м'),
    s('Концевые выключатели', 'Limit switches', '2'),
  ]),
  act('NF230-S2-V', 'Электропривод с пружиной NF230-S2-V, 10 Н·м', 'ВЕЗА', { voltage: 220, actuator: 'spring', ex: false }, [
    s('Напряжение питания', 'Supply voltage', '~230 V'),
    s('Крутящий момент', 'Torque', '10', 'Н·м'),
  ]),
  {
    id: 'cmp-korv', classId: VALVE_CLASS_ID, kind: 'box', code: 'КОРВ', title: t2('Коробка распределительная взрывозащищённая КОРВ'), manufacturer: 'ВЕЗА',
    facts: { ex: true },
    specs: [
      s('Маркировка взрывозащиты', 'Ex marking', '1Ex eb IIC T6 Gb'),
      s('Материал корпуса', 'Housing material', 'углеродистая сталь'),
      s('Пример обозначения', 'Designation example', 'КОРВ-В-Н-151509-11-1КОВ2МНК(A)-1КНВМ2М25НК(B)'),
    ],
  },
  {
    id: 'cmp-atelex-20nk', classId: VALVE_CLASS_ID, kind: 'gland', code: 'ATELEX 20НК', title: t2('Кабельный ввод ATELEX 20НК SS'), manufacturer: 'ATELEX',
    specs: [s('Артикул', 'Part number', '20НК 04'), s('Материал', 'Material', 'никелированная латунь')],
  },
  {
    id: 'cmp-knvm3m25nk', classId: VALVE_CLASS_ID, kind: 'gland', code: 'КНВМ3М25НК(В)', title: t2('Кабельный ввод КНВМ3М25НК'), manufacturer: 'ВЕЗА',
    specs: [s('Резьба', 'Thread', 'M25×1,5'), s('Под металлорукав', 'For conduit', 'DN25')],
  },
];
