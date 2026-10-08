/**
 * Синтетическая книга каталога для проверки интерфейса «Таблицы IO» и состава
 * блока. Таблица IO — той же формы, что у владельца, но строки придуманы здесь;
 * имена изделий E3 заданы для части строк, чтобы был виден и случай «имя не
 * задано». Файлов владельца здесь нет.
 */
import { emptySolutionBook, parseIoSheet, type E3Position, type E3Solution, type E3SolutionBook } from '../../e3/solutions';

const E = '';
const r = (group: string, name: string, code: string, di: unknown, d_o: unknown, ai: unknown, ao: unknown, n: string[] = [E, E, E, E]): unknown[] => [E, group, name, code, di, d_o, ai, ao, E, ...n];
const SHEET: unknown[][] = [
  [], [],
  [E, 'Полевые приборы', 'Наименование', 'Обозначение', 'DI', 'DO', 'AI', 'AO', E, 'DI', 'DO', 'AI', 'AO'],
  r('Датчики', 'Давления, температуры', 'PT, PDT, TT', E, E, 1, E),
  r(E, 'Влажности', 'MT', E, E, 1, E),
  r(E, 'Капиллярный термостат', 'TS', 1, E, E, E),
  r(E, 'Прессостат (реле давления)', 'PS', 1, E, E, E),
  r('Приводы', 'Клапан по воде', E, E, E, 1, 1),
  r(E, 'Клапан по воздуху пружинный, с бк', E, 2, 1, E, E),
  r(E, 'Клапан по воздуху 3-позиционный, с бк', E, 2, 2, E, E),
  r(E, 'Клапан по воздуху плавное регулирование с БК', E, 2, E, 1, 1),
  r('ЭК', 'Срабатывание защиты ЭК по перегреву', 'TS', 1, E, E, E),
  r('ЭК', 'ЭК, 1 ступень с ШИМ', E, 2, 2, E, E, ['"Работа" / "Авария"', '"Пуск" / "Задание ЭК"', E, E]),
  r('ЭК', 'ЭК, остальные ступени (на одну ступень)', E, 2, 1, E, E),
  r('Оборудование', 'Пароувлажнитель', E, 2, 2, E, 1, ['"Работа" / "Авария"', '"Пуск" / "Стоп"', E, '"Задание производительности"']),
  r(E, 'Охладитель (на один контур)', E, 2, 1, E, E),
  r('Клапан', 'Статус "Обогрев клапана" (для каждого клапана отдельно)', E, 2, E, E, E, ['"Работа" / "Авария"', E, E, E]),
  r('Включение обогрева клапанов', 'Циркуляционный насос (для каждого насоса отдельно)', E, 2, 1, E, E),
  r(E, 'Управление ЭД без ЧРП', E, 2, 1, E, E),
  r(E, 'Управление ЭД с ЧРП', E, 2, 1, 1, 1),
];

const COMPONENTS: Record<string, string> = {
  'клапан по воздуху пружинный, с бк': 'клапан_DIx2_DOx1', 'клапан по воздуху 3-позиционный, с бк': 'клапан_DIx2_DOx2', 'клапан по воздуху плавное регулирование с бк': 'клапан_DIx2_AIx1_AOx1',
  'клапан по воде': 'клапан_воды_AIx1_AOx1', 'управление эд без чрп': 'двигатель_DIx2_DOx1', 'управление эд с чрп': 'двигатель_ЧРП_DIx2_DOx1_AIx1_AOx1',
  'давления, температуры': 'датчик_AIx1', 'капиллярный термостат': 'термостат_DIx1',
};

const sol = (id: string, mainClass: string, name: string, features: Record<string, string>): E3Solution =>
  ({ id, mainClass, subclass: 'Подкласс', short: '', name, description: `${name}: описание`, pdf: '', e3p: '', twoLevel: false, inCad: false, items: '', symbols: '', note: '', features, featuresConfirmed: true });

export function ioBook(): E3SolutionBook {
  const rows = parseIoSheet(SHEET).rows.map((x) => (COMPONENTS[x.name.toLowerCase()] ? { ...x, component: COMPONENTS[x.name.toLowerCase()] } : x));
  const valve = (id: string, name: string, drive: string, drives: string) => sol(id, 'Клапаны', name, { 'valve.drive': drive, 'valve.voltage': '24', 'valve.drives': drives, 'valve.limit': 'КП2', 'valve.box': 'нет', 'valve.heat_valve': 'да', 'valve.heat_drive': 'нет', 'valve.epv': 'нет' });
  return {
    ...emptySolutionBook(), version: 3, ioTable: rows,
    solutions: [valve('08.01.37', 'Клапан_2К24_КП2_ПОК', 'К', '2'), valve('08.01.03', 'Клапан_К24_КП2', 'К', '1')],
  };
}

/** Клапан с двумя приводами во Flux: подобранное решение и позиции для состава */
export function ioPositions(): { valve: E3Position; siblings: E3Position[] } {
  const read = (kind: string) => (s: any) => (s.kind === 'field' ? (s.key === 'kind' ? kind : '') : s.kind === 'param' && s.name === 'Напряжение питания' ? '24' : '');
  const valve: E3Position = { id: 'v', cls: 'КЛАПАН', tag: 'K-1', role: 'БЛОК', read: read('С подогревом') };
  const drive = (n: number): E3Position => ({ id: `d${n}`, cls: 'ПРИВОД', tag: `D-${n}`, parentTag: 'K-1', role: 'ПРИВОД', read: read('С возвратной пружиной') });
  return { valve, siblings: [valve, drive(1), drive(2)] };
}
