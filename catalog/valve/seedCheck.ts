/**
 * Затравка: обратные клапаны и клапаны избыточного давления ВЕЗА
 * (каталог «Воздушные клапаны», ред. 17.10.2025, стр. 68–109).
 *
 * Эти семейства различаются устройством заслонки, а не приводом: ТЮЛЬПАН —
 * лепестковый, КЛАРА — одна лопатка с противовесом снаружи, НЕРПА-КО — плотный
 * из углеродистой стали. Поэтому в профилях подбора главный признак — `blade`
 * и материал: MTO описывает клапан именно так («petal», «with one blade and
 * counterweight», «carbon steel»).
 */
import { t2, type Family } from '../model';
import { VALVE_CLASS_ID } from './class';
import { VEZA } from './seedFire';
import { v, choice, SIZE_PARAMS, pos, fixed, sizeHW, sizeWH, CLIMATE, EXEC_AIR, range, warnIf, spec } from './codes';

const AIR = 'Воздушные клапаны (ред. 17.10.2025).pdf';
const RECT = SIZE_PARAMS.filter((p) => p.key !== 'D');
const EXEC_NK = choice('exec', t2('Исполнение', 'Execution'), EXEC_AIR.values!.filter((x) => ['Н', 'К'].includes(x.code)), { default: 'Н', step: 'execution' });

function checkSpecs(o: { material: string; leak?: string; pressure: string; blades?: string }) {
  return [
    spec('purpose', 'Назначение', 'Purpose', 'обратный', 'check'),
    spec('material', 'Материал изготовления', 'Material', o.material),
    spec('leakage', 'Класс утечки EN 1751', 'Leakage class EN 1751', o.leak || '-'),
    spec('pressure', 'Рабочее давление', 'Operating pressure', `до ${o.pressure}`, `up to ${o.pressure}`, 'Па'),
    spec('tempWork', 'Температура эксплуатации', 'Operating temperature', '-60/+40', '-60/+40', '°С'),
    spec('climate', 'Климатическое исполнение ГОСТ 15150', 'Climate (GOST 15150)', 'УХЛ2', 'UHL2'),
    spec('ex', 'Взрывозащита', 'Explosion protection', 'общепром', 'general industrial', undefined, [{ when: { fact: 'ex', eq: true }, value: t2('Взрывозащищённый', 'Explosion proof') }]),
    spec('blades', 'Раскрытие лопаток', 'Blade opening', o.blades || '-'),
    spec('mechanism', 'Основной исполнительный механизм', 'Main actuator', '-', '-'),
  ];
}

// ── КЛАРА, КЛАРА-КРОС ───────────────────────────────────────────────────────

const klara: Family = {
  id: 'veza-klara', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'КЛАРА',
  title: t2('Клапан обратный КЛАРА', 'Check damper KLARA'),
  description: t2('Обратный клапан с одной лопаткой и противовесом снаружи, до 800 Па.'),
  kind: 'check', typeLabel: t2('Обратный клапан', 'Check damper'), shapes: ['rect', 'round'],
  facts: { blade: 'counterweight', pressure: 800, material: 'galv', actuator: 'none' }, sizeSep: 'х',
  params: [...SIZE_PARAMS, EXEC_NK],
  positions: [fixed('КЛАРА'), sizeHW, pos('exec', 'Исполнение', 'Execution', '{exec}')],
  rules: [
    range('h', 'H', { shape: 'rect' }, 100, 2560, 'Высота от 100 мм; одна секция до 1250, кассета до 2560', 'стр. 69'),
    range('w', 'W', { shape: 'rect' }, 100, 2560, 'Ширина от 100 мм; одна секция до 1250, кассета до 2560', 'стр. 69'),
    range('d', 'D', { shape: 'round' }, 100, 1250, 'Диаметр 100–1250 мм', 'стр. 69'),
    warnIf('cassette', { any: [{ param: 'H', gt: 1250 }, { param: 'W', gt: 1250 }] }, 'Больше 1250×1250 — кассета', 'стр. 69'),
  ],
  match: { kinds: ['check'], shapes: ['rect', 'round'], tagTypes: ['DN'], productPrefixes: ['VNRTO'], prefer: { blade: 'counterweight' }, exclude: { ex: true } },
  specs: checkSpecs({ material: 'Оцинкованная сталь', pressure: '800', blades: 'одна лопатка с противовесом' }),
  catalog: { file: AIR, pages: '68–74', edition: '17.10.2025' },
  status: 'full',
  examples: ['КЛАРА-700*500-Н', 'КЛАРА-200х250-Н'],
  sort: 60,
};

const klaraKros: Family = {
  ...klara,
  id: 'veza-klara-kros', code: 'КЛАРА-КРОС',
  title: t2('Клапан обратный КЛАРА-КРОС', 'Check damper KLARA-KROS'),
  description: t2('Разновидность КЛАРА для кровельной установки.'),
  positions: [fixed('КЛАРА-КРОС'), sizeHW, pos('exec', 'Исполнение', 'Execution', '{exec}')],
  match: { ...klara.match, bias: -1, keywords: ['крос', 'кровел'] },
  status: 'partial',
  todo: ['Отличия от КЛАРА в распознанном тексте неясны — сверить со стр. 72'],
  examples: ['КЛАРА-КРОС-700*500-Н'],
  sort: 61,
};

// ── ТЮЛЬПАН-1/2/3 ───────────────────────────────────────────────────────────

const TULIP_ADAPTER = [
  choice('adapterN', t2('Переходник: сторон', 'Adapter sides'), [v('1', 'с одной стороны', 'one side'), v('2', 'с двух сторон', 'both sides')], { step: 'options' }),
  { key: 'adapterD', label: t2('Переходник: диаметр', 'Adapter diameter'), kind: 'number' as const, unit: 'мм', step: 'options' as const },
  choice('adapterX', t2('Без переходника', 'No adapter'), [v('0', 'нет', 'none')], { default: '0', step: 'options' }),
];

function tulip(n: 1 | 2 | 3): Family {
  return {
    id: `veza-tulpan-${n}`, classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: `ТЮЛЬПАН-${n}`,
    title: t2(`Клапан обратный лепестковый ТЮЛЬПАН-${n}`, `Petal check damper TULPAN-${n}`),
    description: t2('Обратный клапан с лепестковой заслонкой.'),
    kind: 'check', typeLabel: t2('Обратный клапан', 'Check damper'), shapes: ['rect'],
    facts: { blade: 'petal', actuator: 'none', pressure: 1500, leakageClass: 1 }, sizeSep: 'х',
    params: [...RECT, EXEC_AIR, ...TULIP_ADAPTER],
    positions: [
      fixed(`ТЮЛЬПАН-${n}`),
      { key: 'size', label: t2('Сечение', 'Section'), formats: ['{H}{x}{W}'] },
      pos('exec', 'Исполнение', 'Execution', '{exec}'),
      pos('adapter', 'Переходник', 'Adapter', '{adapterN}*{adapterD}', '{adapterX}'),
    ],
    rules: [
      range('h', 'H', undefined, 150, 2400, 'Высота 150–2400 мм', 'стр. 76'),
      range('w', 'W', undefined, 150, 2000, 'Ширина 150–2000 мм', 'стр. 76'),
    ],
    match: { kinds: ['check'], shapes: ['rect'], tagTypes: ['DN'], productPrefixes: ['VNRTO'], require: { blade: 'petal' }, bias: n === 1 ? 0 : -1 },
    specs: checkSpecs({ material: 'Корпус — оцинкованная сталь, лепестки — латунь/сталь', leak: '1', pressure: '1500', blades: 'лепестковое' }),
    catalog: { file: AIR, pages: '75–84', edition: '17.10.2025' },
    status: n === 1 ? 'full' : 'partial',
    todo: n === 1 ? undefined : [`Чем ТЮЛЬПАН-${n} отличается от ТЮЛЬПАН-1 — сверить со стр. 75`],
    examples: n === 1 ? ['ТЮЛЬПАН-1-800*1000-Н-0', 'ТЮЛЬПАН-1-500*800-В-0', 'ТЮЛЬПАН-1-1800х1370-В-0'] : [],
    sort: 62 + n,
  };
}

// ── КОЛ, УКОЛ ───────────────────────────────────────────────────────────────

const kol: Family = {
  id: 'veza-kol', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'КОЛ',
  title: t2('Клапан обратный круглый КОЛ', 'Round check damper KOL'),
  description: t2('Круглый обратный клапан, 1500 Па.'),
  kind: 'check', typeLabel: t2('Обратный клапан', 'Check damper'), shapes: ['round'],
  facts: { pressure: 1500, actuator: 'none' }, sizeSep: '*',
  params: [SIZE_PARAMS[2], EXEC_NK],
  positions: [fixed('КОЛ'), { key: 'size', label: t2('Диаметр', 'Diameter'), formats: ['{D}'] }, pos('exec', 'Исполнение', 'Execution', '{exec}')],
  rules: [range('d', 'D', undefined, 400, 1000, 'Диаметр 400–1000 мм', 'стр. 86')],
  match: { kinds: ['check'], shapes: ['round'], tagTypes: ['DN'], productPrefixes: ['VNRTD'], bias: -0.5 },
  specs: checkSpecs({ material: 'Оцинкованная сталь', pressure: '1500' }),
  catalog: { file: AIR, pages: '85–90', edition: '17.10.2025' },
  status: 'full',
  examples: ['КОЛ-450-Н'],
  sort: 66,
};

const ukol: Family = {
  id: 'veza-ukol', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'УКОЛ',
  title: t2('Клапан обратный утеплённый УКОЛ', 'Insulated check damper UKOL'),
  description: t2('Утеплённый обратный клапан, 2000 Па; установка 1, 2 или 3.'),
  kind: 'check', typeLabel: t2('Обратный клапан', 'Check damper'), shapes: ['rect'],
  facts: { pressure: 2000, actuator: 'none' }, sizeSep: '*',
  params: [
    choice('install', t2('Тип установки', 'Installation'), [v('1', 'тип 1', 'type 1'), v('2', 'тип 2', 'type 2'), v('3', 'тип 3', 'type 3')], { default: '1', step: 'purpose' }),
    EXEC_NK, ...RECT,
    choice('overhang', t2('Исключение вылета', 'No overhang'), [v('0', 'нет', 'none'), v('1*000*V1', 'с одной стороны, V1', 'one side V1'), v('1*000*V2', 'с одной стороны, V2', 'one side V2')], { default: '0', step: 'options' }),
  ],
  positions: [
    fixed('УКОЛ'),
    pos('install', 'Установка', 'Installation', '{install}'),
    pos('exec', 'Исполнение', 'Execution', '{exec}'),
    pos('overhang', 'Исключение вылета', 'No overhang', '{overhang}'),
    { key: 'size', label: t2('Сечение', 'Section'), formats: ['{W}{x}{H}'] },
  ],
  rules: [
    range('w', 'W', undefined, 300, 1250, 'Ширина 300–1250 мм', 'стр. 92'),
    range('h', 'H', undefined, 300, 1250, 'Высота 300–1250 мм', 'стр. 92'),
  ],
  match: { kinds: ['check'], shapes: ['rect'], keywords: ['укол', 'утепл', 'insulated'], bias: -1.5 },
  specs: checkSpecs({ material: 'Оцинкованная сталь с утеплением', pressure: '2000' }),
  catalog: { file: AIR, pages: '91–96', edition: '17.10.2025' },
  status: 'partial',
  todo: ['Размер в конце обозначения — сверить порядок позиций со стр. 92'],
  examples: ['УКОЛ-1-Н-1*000*V1-800*400'],
  sort: 67,
};

// ── НЕРПА-КО ────────────────────────────────────────────────────────────────

const nerpaKO: Family = {
  id: 'veza-nerpa-ko', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'НЕРПА-КО',
  title: t2('Клапан обратный высокой плотности НЕРПА-КО', 'High-density check damper NERPA-KO'),
  description: t2('Плотный обратный клапан из углеродистой стали, прямоугольный и круглый.'),
  kind: 'check', typeLabel: t2('Обратный клапан', 'Check damper'), shapes: ['rect', 'round'],
  facts: { material: 'carbon', leakageClass: 2, actuator: 'none' }, sizeSep: '*',
  params: [
    ...SIZE_PARAMS, CLIMATE, EXEC_AIR,
    choice('pressure', t2('Рабочее давление', 'Operating pressure'), [1000, 1500, 2000, 2500, 3000, 5000, 10000].map((p) => v(String(p), `${p} Па`, `${p} Pa`, { pressure: p })), { default: '1500', step: 'execution' }),
  ],
  positions: [
    fixed('НЕРПА-КО'),
    { key: 'size', label: t2('Сечение', 'Section'), formats: ['{H}{x}{W}', '{D}'] },
    pos('climate', 'Климат', 'Climate', '{climate}'),
    pos('exec', 'Исполнение', 'Execution', '{exec}'),
    pos('pressure', 'Давление', 'Pressure', '{pressure}'),
  ],
  rules: [
    range('h', 'H', { shape: 'rect' }, 100, 3160, 'Высота от 100 мм; одна секция до 1500, кассета до 3160', 'стр. 98'),
    range('w', 'W', { shape: 'rect' }, 100, 3300, 'Ширина от 100 мм; одна секция до 1600, кассета до 3300', 'стр. 98'),
    range('d', 'D', { shape: 'round' }, 100, 1250, 'Диаметр 100–1250 мм', 'стр. 98'),
  ],
  match: { kinds: ['check'], shapes: ['rect', 'round'], tagTypes: ['DN'], productPrefixes: ['VNRTD'], prefer: { material: 'carbon', shape: 'round' } },
  specs: checkSpecs({ material: 'Углеродистая сталь с защитным покрытием', leak: '2', pressure: '10000' }),
  catalog: { file: AIR, pages: '97–102', edition: '17.10.2025' },
  status: 'full',
  examples: ['НЕРПА-КО-600*1000-УХЛ2-Н-2000', 'НЕРПА-КО-1250-УХЛ2-В-1500'],
  sort: 68,
};

// ── КИД ─────────────────────────────────────────────────────────────────────

const kid: Family = {
  id: 'veza-kid', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'КИД',
  title: t2('Клапан избыточного давления КИД', 'Overpressure damper KID'),
  description: t2('Тип 1 — стеновой, 2 — канальный (механизм настройки внутри), 3 — канальный с механизмом снаружи.'),
  kind: 'overpressure', typeLabel: t2('Клапан избыточного давления', 'Overpressure damper'), shapes: ['rect'],
  facts: { actuator: 'none' }, sizeSep: '*',
  params: [
    ...RECT, EXEC_AIR,
    choice('type', t2('Тип', 'Type'), [
      v('1', 'стеновой', 'wall', { mount: 'wall' }),
      v('2', 'канальный, механизм внутри', 'duct, internal mechanism', { mount: 'duct' }),
      v('3', 'канальный, механизм снаружи', 'duct, external mechanism', { mount: 'duct' }),
    ], { default: '3', step: 'fire' }),
    CLIMATE,
  ],
  positions: [
    fixed('КИД'),
    sizeWH,
    pos('exec', 'Исполнение', 'Execution', '{exec}'),
    pos('type', 'Тип', 'Type', '{type}'),
    pos('climate', 'Климат', 'Climate', '{climate}'),
  ].map((p) => (p.key === 'size' ? { ...p, formats: ['{W}{x}{H}'] } : p)),
  rules: [
    range('w', 'W', { param: 'type', in: ['1', '2'] }, 200, 2060, 'Ширина от 200 мм; одна секция до 1000, кассета до 2060', 'стр. 104'),
    range('h', 'H', { param: 'type', in: ['1', '2'] }, 175, 2060, 'Высота от 175 мм; одна секция до 1000, кассета до 2060', 'стр. 104'),
    range('w3', 'W', { param: 'type', in: ['3'] }, 150, 2060, 'Тип 3: ширина от 150 мм', 'стр. 104'),
    range('h3', 'H', { param: 'type', in: ['3'] }, 200, 2060, 'Тип 3: высота от 200 мм', 'стр. 104'),
    warnIf('cassette', { any: [{ param: 'W', gt: 1000 }, { param: 'H', gt: 1000 }] }, 'Больше 1000×1000 — кассета', 'стр. 104'),
  ],
  match: { kinds: ['overpressure'], shapes: ['rect'], tagTypes: ['DP'], productPrefixes: ['VOVVL'] },
  specs: [
    spec('purpose', 'Назначение', 'Purpose', 'избыточного давления', 'overpressure'),
    spec('material', 'Материал изготовления', 'Material', 'Оцинкованная сталь'),
    spec('pressure', 'Давление открытия', 'Opening pressure', '20–150', '20–150', 'Па'),
    spec('climate', 'Климатическое исполнение ГОСТ 15150', 'Climate (GOST 15150)', 'УХЛ2', 'UHL2'),
    spec('ex', 'Взрывозащита', 'Explosion protection', 'общепром', 'general industrial', undefined, [{ when: { fact: 'ex', eq: true }, value: t2('Взрывозащищённый', 'Explosion proof') }]),
  ],
  catalog: { file: AIR, pages: '103–109', edition: '17.10.2025' },
  status: 'full',
  examples: ['КИД-500*600-Н-1-УХЛ2', 'КИД-800*700-Н-3-УХЛ2'],
  sort: 70,
};

export const CHECK_FAMILIES: Family[] = [klara, klaraKros, tulip(1), tulip(2), tulip(3), kol, ukol, nerpaKO, kid];
