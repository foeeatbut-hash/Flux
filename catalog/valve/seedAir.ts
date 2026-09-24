/**
 * Затравка: воздушные клапаны ВЕЗА (каталог «Воздушные клапаны», ред. 17.10.2025).
 *
 * У этого каталога есть текстовый слой, поэтому позиции обозначений надёжны.
 * Порядок позиций сверен с бланками E06-2002, принятыми заводом: ГЕРМИК и
 * РЕГУЛЯР пишут первой высоту (ГЕРМИК-П-600*1000 — Н=600, В=1000), КЕДР —
 * привод без числа сразу после размера.
 */
import { t2, type Family, type ParamValue } from '../model';
import { VALVE_CLASS_ID } from './class';
import { VEZA } from './seedFire';
import {
  v, choice, SIZE_PARAMS, pos, fixed, sizeHW, airDrives, DRIVE_COUNT, DRIVE_EX, DRIVE_EX_K, CLIMATE, THEFT_AIR,
  EXEC_AIR, DRIVE_AIR_POS, airRules, range, warnIf, spec,
} from './codes';

const AIR = 'Воздушные клапаны (ред. 17.10.2025).pdf';
const DRIVES = airDrives();
const drive = (values: ParamValue[] = DRIVES) => choice('drive', t2('Привод', 'Actuator'), values, { step: 'drive' });
const RECT = SIZE_PARAMS.filter((p) => p.key !== 'D');

function airSpecs(o: { purpose?: string; material: string; leak: string; pressure: string; temp?: string; blades?: string }) {
  const ex = { fact: 'ex', eq: true } as const;
  return [
    spec('purpose', 'Назначение', 'Purpose', o.purpose || 'регулирующий', o.purpose ? undefined : 'control'),
    spec('material', 'Материал изготовления', 'Material', o.material),
    spec('leakage', 'Класс утечки EN 1751', 'Leakage class EN 1751', o.leak),
    spec('pressure', 'Рабочее давление', 'Operating pressure', `до ${o.pressure}`, `up to ${o.pressure}`, 'Па'),
    spec('tempWork', 'Температура эксплуатации', 'Operating temperature', o.temp || '-60/+40', o.temp || '-60/+40', '°С'),
    spec('climate', 'Климатическое исполнение ГОСТ 15150', 'Climate (GOST 15150)', 'УХЛ2', 'UHL2', undefined, [
      { when: { param: 'climate', in: ['У3'] }, value: t2('У3', 'U3') },
      { when: { param: 'climate', in: ['УХЛ1'] }, value: t2('УХЛ1', 'UHL1') },
    ]),
    spec('ex', 'Взрывозащита', 'Explosion protection', 'общепром', 'general industrial', undefined, [{ when: ex, value: t2('Взрывозащищённый', 'Explosion proof') }]),
    spec('exMarking', 'Маркировка взрывозащиты', 'Ex marking', '-', '-', undefined, [{ when: ex, value: t2('II Gb c IIC T6', 'II Gb c IIC T6') }]),
    spec('blades', 'Раскрытие лопаток', 'Blade opening', o.blades || 'параллельное', o.blades ? undefined : 'parallel'),
    spec('mechanism', 'Основной исполнительный механизм', 'Main actuator', 'электропривод', 'electric actuator', undefined, [
      { when: { param: 'drive', in: ['РУЧКА'] }, value: t2('ручка', 'handle') },
    ]),
  ];
}

/** Стандартный набор параметров воздушного клапана с приводом `n*a` */
const airParams = (exec = EXEC_AIR, extra: any[] = []) => [
  ...SIZE_PARAMS, exec, DRIVE_COUNT, DRIVE_EX, drive(), DRIVE_EX_K, ...extra, CLIMATE, THEFT_AIR,
];

// ── РЕГУЛЯР, РЕГУЛЯР-Л, РЕГЛАН ──────────────────────────────────────────────

const regular: Family = {
  id: 'veza-regular', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'РЕГУЛЯР',
  title: t2('Клапан воздушный РЕГУЛЯР', 'Air damper REGULAR'),
  description: t2('Регулирующий и отсечной клапан, класс утечки 1, до 1500 Па.'),
  kind: 'air', typeLabel: t2('Регулирующий клапан', 'Control damper'), shapes: ['rect'],
  facts: { leakageClass: 1, pressure: 1500, material: 'galv' }, sizeSep: '*',
  params: airParams().filter((p) => p.key !== 'D'),
  positions: [fixed('РЕГУЛЯР'), { key: 'size', label: t2('Сечение', 'Section'), formats: ['{H}{x}{W}'] }, pos('exec', 'Исполнение', 'Execution', '{exec}'), DRIVE_AIR_POS, pos('climate', 'Климат', 'Climate', '{climate}'), pos('theft', 'Защита', 'Anti-theft', '{theft}')],
  rules: [
    ...airRules(DRIVES, 'стр. 8–18'),
    range('h', 'H', undefined, 100, 4940, 'Высота H от 100 мм; одна секция до 2440, кассета до 4940', 'стр. 9'),
    range('w', 'W', undefined, 100, 3060, 'Ширина B от 100 мм; одна секция до 1500, кассета до 3060', 'стр. 9'),
    warnIf('cassette', { any: [{ param: 'H', gt: 2440 }, { param: 'W', gt: 1500 }] }, 'Больше 2440×1500 — кассета: число приводов указывается суммарно', 'стр. 10'),
  ],
  match: { kinds: ['air'], functions: ['CONTROL', 'SHUTOFF'], shapes: ['rect'], tagTypes: ['DV'], bias: -0.5 },
  specs: airSpecs({ material: 'Корпус — оцинкованная сталь, лопатка — алюминий', leak: '1', pressure: '1500', temp: '-60/+40' }),
  catalog: { file: AIR, pages: '8–18', edition: '17.10.2025' },
  status: 'full',
  examples: ['РЕГУЛЯР-775*620-Н-1*NF230-S2-V-УХЛ2-0'],
  sort: 30,
};

const regularL: Family = {
  ...regular,
  id: 'veza-regular-l', code: 'РЕГУЛЯР-Л',
  title: t2('Клапан воздушный РЕГУЛЯР-Л', 'Air damper REGULAR-L'),
  description: t2('Облегчённый регулирующий клапан, прямоугольный и круглый, класс утечки 0.'),
  shapes: ['rect', 'round'],
  facts: { leakageClass: 0, pressure: 1500, material: 'galv' },
  params: airParams(),
  positions: [fixed('РЕГУЛЯР-Л'), sizeHW, pos('exec', 'Исполнение', 'Execution', '{exec}'), DRIVE_AIR_POS, pos('climate', 'Климат', 'Climate', '{climate}'), pos('theft', 'Защита', 'Anti-theft', '{theft}')],
  rules: [
    ...airRules(DRIVES, 'стр. 14–18'),
    range('h', 'H', { shape: 'rect' }, 100, 2440, 'Высота H 100–2440 мм', 'стр. 15'),
    range('w', 'W', { shape: 'rect' }, 100, 1500, 'Ширина B 100–1500 мм', 'стр. 15'),
    range('d', 'D', { shape: 'round' }, 100, 1250, 'Диаметр 100–1250 мм', 'стр. 15'),
  ],
  match: { kinds: ['air'], functions: ['CONTROL', 'SHUTOFF'], shapes: ['rect', 'round'], tagTypes: ['DV'], productPrefixes: ['VFLA2'], prefer: { shape: 'round' } },
  specs: airSpecs({ material: 'Корпус — оцинкованная сталь, лопатка — оцинкованная сталь', leak: '0', pressure: '1500' }),
  examples: ['РЕГУЛЯР-Л-560-Н-1*РУЧКА-УХЛ2-0', 'РЕГУЛЯР-Л-150*400-Н-1*РУЧКА-УХЛ2-0', 'РЕГУЛЯР-Л-315-Н-1*РУЧКА-УХЛ2-0'],
  sort: 31,
};

const reglan: Family = {
  ...regular,
  id: 'veza-reglan', code: 'РЕГЛАН',
  title: t2('Клапан воздушный РЕГЛАН', 'Air damper REGLAN'),
  description: t2('Алюминиевый регулирующий клапан, высота с шагом 100 мм, до 1200 Па, без кассет.'),
  facts: { leakageClass: 1, pressure: 1200, material: 'aluminium' },
  params: [
    ...RECT, choice('exec', t2('Исполнение', 'Execution'), [EXEC_AIR.values![0]], { default: 'Н', step: 'execution' }),
    drive(DRIVES.filter((x) => x.code !== 'РУЧКА')), CLIMATE, THEFT_AIR,
  ],
  positions: [fixed('РЕГЛАН'), { key: 'size', label: t2('Сечение', 'Section'), formats: ['{H}{x}{W}'] }, pos('exec', 'Исполнение', 'Execution', '{exec}'), pos('drive', 'Привод', 'Actuator', '{drive}'), pos('climate', 'Климат', 'Climate', '{climate}'), pos('theft', 'Защита', 'Anti-theft', '{theft}')],
  rules: [
    range('h', 'H', undefined, 110, 2410, 'Высота H 110–2410 мм, ряд 110, 210, 310…', 'стр. 19'),
    { id: 'h-step', then: { range: { param: 'H', min: 110, step: 100 } }, message: 'Высота РЕГЛАН — с шагом 100 мм (110, 210, 310…)', source: 'стр. 19' },
    range('w', 'W', undefined, 100, 1800, 'Ширина B 100–1800 мм', 'стр. 19'),
  ],
  match: { kinds: ['air'], functions: ['CONTROL'], shapes: ['rect'], require: { material: 'aluminium' }, bias: -1 },
  specs: airSpecs({ material: 'Алюминий', leak: '1', pressure: '1200' }),
  examples: ['РЕГЛАН-1210*1000-Н-NM230-V-УХЛ2-0'],
  sort: 32,
};

// ── КЕДР, КЕДР-С ────────────────────────────────────────────────────────────

const kedrPositions = (series: string) => [
  fixed(series),
  { key: 'size', label: t2('Сечение', 'Section'), formats: ['{H}{x}{W}'] },
  // Бланк E06-2002, принятый заводом, пишет привод КЕДР без числа:
  // «КЕДР-С-1100*1600-SM24-S2-V-Н-УХЛ2-0». Запись с числом тоже разбирается
  { key: 'drive', label: t2('Привод', 'Actuator'), formats: ['{driveEx}{drive}{driveExK}', '{driveCount}*{driveEx}{drive}{driveExK}'], rememberFormat: true },
  pos('exec', 'Исполнение', 'Execution', '{exec}'),
  pos('climate', 'Климат', 'Climate', '{climate}'),
  pos('theft', 'Защита', 'Anti-theft', '{theft}'),
];

const kedr: Family = {
  id: 'veza-kedr', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'КЕДР',
  title: t2('Клапан воздушный КЕДР', 'Air damper KEDR'),
  description: t2('Клапан повышенной плотности, класс утечки 2–3, до 2500 Па и 20 м/с.'),
  kind: 'air', typeLabel: t2('Отсечной клапан', 'Shut-off damper'), shapes: ['rect'],
  facts: { leakageClass: 3, pressure: 2500, heating: false }, sizeSep: '*',
  params: airParams().filter((p) => p.key !== 'D'),
  positions: kedrPositions('КЕДР'),
  rules: [
    ...airRules(DRIVES, 'стр. 22–29'),
    range('h', 'H', undefined, 100, 4900, 'Высота H от 100 мм, кассета до 4900', 'стр. 23'),
    range('w', 'W', undefined, 100, 3300, 'Ширина B от 100 мм, кассета до 3300', 'стр. 23'),
  ],
  match: { kinds: ['air'], functions: ['SHUTOFF', 'CONTROL'], shapes: ['rect'], tagTypes: ['DW', 'DV'], bias: -0.5 },
  specs: airSpecs({ purpose: 'отсечной', material: 'Оцинкованная сталь с порошковым покрытием RAL 7035', leak: '3', pressure: '2500', temp: '-60/+30' }),
  catalog: { file: AIR, pages: '22–29', edition: '17.10.2025' },
  status: 'partial',
  todo: ['Порядок позиций взят из бланка E06-2002; в каталоге пример печатается полями — сверить со стр. 23'],
  examples: ['КЕДР-450*400-1*ЭПВ-LF230-S-V-В-УХЛ2-К'],
  sort: 33,
};

const kedrS: Family = {
  ...kedr,
  id: 'veza-kedr-s', code: 'КЕДР-С',
  title: t2('Клапан воздушный утеплённый КЕДР-С', 'Heated air damper KEDR-S'),
  description: t2('КЕДР с обогревом по периметру для наружного воздуха.'),
  typeLabel: t2('Отсечной клапан', 'Shut-off damper'),
  facts: { leakageClass: 3, pressure: 2500, heating: true },
  positions: kedrPositions('КЕДР-С'),
  match: { kinds: ['air'], functions: ['SHUTOFF', 'CONTROL'], shapes: ['rect'], require: { heating: true }, tagTypes: ['DW'], productPrefixes: ['VFDNO'], keywords: ['air vent valve'] },
  examples: ['КЕДР-С-1100*1600-SM24-S2-V-Н-УХЛ2-0'],
  sort: 34,
};

// ── ГЕРМИК-П/-Р/-С/-Т/×2П/×2С ───────────────────────────────────────────────

const EXEC_GERMIK = choice('exec', t2('Исполнение', 'Execution'), [
  v('Н', 'общепромышленное, лопатка — алюминий', 'general industrial, aluminium blade', { ex: false, stainless: false }),
  v('Ц', 'общепромышленное, лопатка — оцинкованная сталь', 'general industrial, galvanized blade', { ex: false, stainless: false }),
  v('К', 'коррозионностойкое', 'corrosion resistant', { ex: false, stainless: true }),
  v('В', 'взрывозащищённое', 'explosion proof', { ex: true, stainless: false }),
  v('ВЦ', 'взрывозащищённое, лопатка — оцинкованная сталь', 'explosion proof, galvanized blade', { ex: true, stainless: false }),
  v('КВ', 'взрывозащищённое коррозионностойкое', 'explosion proof stainless', { ex: true, stainless: true }),
], { default: 'Н', step: 'execution' });

const PLACE_GERMIK = choice('place', t2('Размещение', 'Placement'), [
  v('1', 'внутри помещения', 'indoor'),
  v('2', 'снаружи', 'outdoor'),
], { default: '1', step: 'options' });

const germikPositions = (series: string) => [
  fixed(series),
  { key: 'size', label: t2('Сечение', 'Section'), formats: ['{H}{x}{W}'] },
  pos('exec', 'Исполнение', 'Execution', '{exec}'),
  DRIVE_AIR_POS,
  pos('place', 'Размещение', 'Placement', '{place}'),
  pos('climate', 'Климат', 'Climate', '{climate}'),
  pos('theft', 'Защита', 'Anti-theft', '{theft}'),
];

function germik(o: {
  code: string; id: string; ru: string; en: string; desc: string; facts: Record<string, any>; blades: string;
  place?: boolean; tag: string[]; prefixes?: string[]; require?: Record<string, any>; bias?: number; min?: [number, number];
  max?: [number, number]; cassette?: [number, number]; pages: string; examples: string[]; status?: 'full' | 'partial'; todo?: string[]; sort: number; exOnly?: boolean;
}): Family {
  const [minH, minW] = o.min || [160, 100];
  const [maxH, maxW] = o.max || [2440, 2100];
  const [casH, casW] = o.cassette || [4940, 4260];
  const exec = o.exOnly
    ? choice('exec', EXEC_GERMIK.label, EXEC_GERMIK.values!.filter((x) => x.facts?.ex), { default: 'В', step: 'execution' })
    : EXEC_GERMIK;
  return {
    id: o.id, classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: o.code,
    title: t2(o.ru, o.en), description: t2(o.desc),
    kind: 'air', typeLabel: t2(o.facts.heating ? 'Регулирующий/отсечной клапан' : 'Регулирующий клапан', 'Control damper'), shapes: ['rect'],
    facts: { leakageClass: 1, pressure: 1800, ...o.facts }, sizeSep: '*',
    params: [...RECT, exec, DRIVE_COUNT, DRIVE_EX, drive(), DRIVE_EX_K, o.place === false ? choice('place', PLACE_GERMIK.label, [PLACE_GERMIK.values![0]], { default: '1' }) : PLACE_GERMIK, CLIMATE, THEFT_AIR],
    positions: germikPositions(o.code),
    rules: [
      ...airRules(DRIVES, o.pages, ['В', 'ВЦ', 'КВ']),
      range('h', 'H', undefined, minH, casH, `Высота H от ${minH} мм; одна секция до ${maxH}, кассета до ${casH}`, o.pages),
      range('w', 'W', undefined, minW, casW, `Ширина B от ${minW} мм; одна секция до ${maxW}, кассета до ${casW}`, o.pages),
      warnIf('cassette', { any: [{ param: 'H', gt: maxH }, { param: 'W', gt: maxW }] }, `Больше ${maxH}×${maxW} — кассета: число приводов суммарное`, o.pages),
    ],
    match: { kinds: ['air'], functions: ['CONTROL', 'SHUTOFF'], shapes: ['rect'], tagTypes: o.tag, productPrefixes: o.prefixes, require: o.require, bias: o.bias },
    specs: airSpecs({ material: 'Корпус — оцинкованная сталь, лопатка — алюминий', leak: '1', pressure: '1800', blades: o.blades }),
    catalog: { file: AIR, pages: o.pages, edition: '17.10.2025' },
    status: o.status || 'full',
    todo: o.todo,
    examples: o.examples,
    sort: o.sort,
  };
}

const germikP = germik({
  code: 'ГЕРМИК-П', id: 'veza-germik-p', ru: 'Клапан воздушный ГЕРМИК-П', en: 'Air damper GERMIK-P',
  desc: 'Герметичный регулирующий клапан с параллельными лопатками, до 1800 Па.',
  facts: { heating: false, blade: 'parallel' }, blades: 'параллельное', tag: ['DV'], prefixes: ['VFLA1'], bias: 1,
  pages: '30–38', examples: ['ГЕРМИК-П-600*1000-Н-1*РУЧКА-1-УХЛ2-0', 'ГЕРМИК-П-400*600-H-1*РУЧКА-1-УХЛ2-0', 'Клапан ГЕРМИК-П-500*700-Н-1*РУЧКА-1-УХЛ2-0'], sort: 40,
});
const germikR = germik({
  code: 'ГЕРМИК-Р', id: 'veza-germik-r', ru: 'Клапан воздушный ГЕРМИК-Р', en: 'Air damper GERMIK-R',
  desc: 'Герметичный регулирующий клапан с разнонаправленными (симметричными) лопатками.',
  facts: { heating: false, blade: 'opposed' }, blades: 'симметричное', tag: ['DV', 'DW'], prefixes: ['VVETH'],
  pages: '30–38', examples: ['Клапан ГЕРМИК-Р-1200*1800-В-1*ЭПВ-SM24-S2-V-1-УХЛ2-0_265200168-3-КОМ'], sort: 41,
});
const germikS = germik({
  code: 'ГЕРМИК-С', id: 'veza-germik-s', ru: 'Клапан воздушный утеплённый ГЕРМИК-С', en: 'Heated air damper GERMIK-S',
  desc: 'ГЕРМИК с электрообогревом по периметру для наружного воздуха; возможна наружная установка.',
  facts: { heating: true }, blades: 'параллельное', tag: ['DW'], prefixes: ['VFDNO'], require: { heating: true }, bias: 0.5,
  pages: '39–46', examples: ['ГЕРМИК-С-760*1127-Н-1*NM230-S-V-1-УХЛ2-К', 'Клапан ГЕРМИК-С-1200*1600-В-1*ЭПВ-SM24-S2-V-1-УХЛ2-0_255200653-1-КОМ', 'Клапан ГЕРМИК-С-800*1000-Н-1*SM24-S2-V-1-УХЛ2-0_255200654-1-КОМ'], sort: 42,
});
const germikT = germik({
  code: 'ГЕРМИК-Т', id: 'veza-germik-t', ru: 'Клапан воздушный ГЕРМИК-Т', en: 'Air damper GERMIK-T',
  desc: 'Утеплённый ГЕРМИК для наружной установки, только взрывозащищённое исполнение.',
  facts: { heating: true }, blades: 'параллельное', tag: ['DW'], require: { heating: true }, bias: -1, exOnly: true,
  min: [460, 460], max: [2000, 2000], cassette: [4060, 4060], pages: '39–46', status: 'partial',
  todo: ['Назначение исполнения «Т» в распознанном тексте неясно — сверить со стр. 42'],
  examples: [], sort: 43,
});
const germikX2P = germik({
  code: 'ГЕРМИКх2П', id: 'veza-germik-x2p', ru: 'Клапан воздушный ГЕРМИК×2П', en: 'Double air damper GERMIKx2P',
  desc: 'Сдвоенный ГЕРМИК-П.', facts: { heating: false, blade: 'parallel' }, blades: 'параллельное', tag: ['DV'], bias: -1.5,
  min: [460, 460], max: [2000, 2000], cassette: [4060, 4060], pages: '39–46', status: 'partial',
  todo: ['По каталогу исполнение только Ц — сверить со стр. 44'], examples: [], sort: 44,
});
const germikX2S = germik({
  code: 'ГЕРМИКх2С', id: 'veza-germik-x2s', ru: 'Клапан воздушный ГЕРМИК×2С', en: 'Double heated air damper GERMIKx2S',
  desc: 'Сдвоенный утеплённый ГЕРМИК-С.', facts: { heating: true }, blades: 'параллельное', tag: ['DW'], require: { heating: true }, bias: -1.5,
  min: [460, 460], max: [2000, 2000], cassette: [4060, 4060], pages: '39–46', status: 'partial',
  todo: ['По каталогу исполнение только Ц — сверить со стр. 44'], examples: ['ГЕРМИКх2С-760*900-Н-2*NM230-V-1-УХЛ2-К'], sort: 45,
});

// ── НЕРПА ───────────────────────────────────────────────────────────────────

const PRESSURE = choice('pressure', t2('Рабочее давление', 'Operating pressure'), [1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]
  .map((p) => v(String(p), `${p} Па`, `${p} Pa`, { pressure: p })), { default: '1500', step: 'execution' });

const nerpa: Family = {
  id: 'veza-nerpa', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'НЕРПА',
  title: t2('Клапан воздушный высокого давления НЕРПА', 'High-pressure air damper NERPA'),
  description: t2('Клапан для давления до 10000 Па, прямоугольный и круглый.'),
  kind: 'air', typeLabel: t2('Отсечной клапан', 'Shut-off damper'), shapes: ['rect', 'round'],
  facts: { leakageClass: 3 }, sizeSep: '*',
  params: [...SIZE_PARAMS, DRIVE_COUNT, DRIVE_EX, drive(), DRIVE_EX_K, EXEC_AIR, PRESSURE, CLIMATE, THEFT_AIR],
  positions: [
    fixed('НЕРПА'),
    { key: 'size', label: t2('Сечение', 'Section'), formats: ['{W}{x}{H}', '{D}'] },
    DRIVE_AIR_POS,
    pos('exec', 'Исполнение', 'Execution', '{exec}'),
    pos('pressure', 'Давление', 'Pressure', '{pressure}'),
    pos('climate', 'Климат', 'Climate', '{climate}'),
    pos('theft', 'Защита', 'Anti-theft', '{theft}'),
  ],
  rules: [
    ...airRules(DRIVES, 'стр. 47–53'),
    range('w', 'W', { shape: 'rect' }, 200, 2100, 'Ширина B 200–2100 мм', 'стр. 48'),
    range('h', 'H', { shape: 'rect' }, 100, 2200, 'Высота H 100–2200 мм', 'стр. 48'),
    range('d', 'D', { shape: 'round' }, 100, 1250, 'Диаметр 100–1250 мм', 'стр. 48'),
  ],
  match: { kinds: ['air'], functions: ['SHUTOFF', 'CONTROL'], shapes: ['rect', 'round'], prefer: { pressure: 3000 }, bias: -1.5 },
  specs: airSpecs({ purpose: 'отсечной', material: 'Сталь', leak: '3', pressure: '10000' }),
  catalog: { file: AIR, pages: '47–53', edition: '17.10.2025' },
  status: 'partial',
  todo: ['Пример в каталоге напечатан полями — порядок «размер, привод, исполнение, давление» сверить со стр. 48'],
  examples: ['НЕРПА-620*620-1*SF230-S2-V-Н-3000-УХЛ2-К'],
  sort: 46,
};

// ── ГЕК, ГАЗОХОД ────────────────────────────────────────────────────────────

const MEO = [
  ...[16, 40, 100, 250].flatMap((nm) => [220, 380].map((vv) =>
    v(`МЭО-${nm}-${vv}`, `электромеханизм МЭО ${nm} Н·м, ${vv} В`, `МЭО actuator ${nm} Nm, ${vv} V`, { actuator: 'mechanism', voltage: vv, current: 'AC', torque: nm }))),
];

const gek: Family = {
  id: 'veza-gek', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'ГЕК',
  title: t2('Клапан герметичный ГЕК', 'Bubble-tight damper GEK'),
  description: t2('Герметичный клапан класса Bubble tight (утечка класса 4), до 10000 Па.'),
  kind: 'air', typeLabel: t2('Отсечной клапан', 'Shut-off damper'), shapes: ['rect'],
  facts: { leakageClass: 4, pressure: 10000 }, sizeSep: '*',
  params: [
    ...RECT,
    choice('drive', t2('Привод', 'Actuator'), MEO, { step: 'drive' }),
    choice('exec', t2('Исполнение', 'Execution'), EXEC_AIR.values!.filter((x) => ['Н', 'К'].includes(x.code)), { default: 'Н', step: 'execution' }),
    choice('adapterN', t2('Переходник', 'Adapter'), [v('1', 'с одной стороны', 'one side'), v('2', 'с двух сторон', 'both sides')], { step: 'options' }),
    { key: 'adapterD', label: t2('Диаметр переходника', 'Adapter diameter'), kind: 'number', unit: 'мм', step: 'options' },
    choice('adapterX', t2('Без переходника', 'No adapter'), [v('0', 'нет', 'none')], { default: '0', step: 'options' }),
    choice('reserve', t2('Резерв', 'Reserve'), [v('0', '—', '—')], { default: '0' }),
  ],
  positions: [
    fixed('ГЕК'),
    { key: 'size', label: t2('Сечение', 'Section'), formats: ['{W}{x}{H}'] },
    pos('drive', 'Привод', 'Actuator', '{drive}'),
    pos('exec', 'Исполнение', 'Execution', '{exec}'),
    pos('adapter', 'Переходник', 'Adapter', '{adapterN}*{adapterD}', '{adapterX}'),
    pos('reserve', 'Резерв', 'Reserve', '{reserve}'),
  ],
  rules: [
    range('w', 'W', undefined, 250, 1000, 'Ширина 250–1000 мм', 'стр. 58'),
    range('h', 'H', undefined, 250, 1000, 'Высота 250–1000 мм', 'стр. 58'),
  ],
  match: { kinds: ['air'], functions: ['SHUTOFF'], shapes: ['rect'], require: { leakageClass: 4 }, bias: -2, keywords: ['bubble tight', 'гек'] },
  specs: airSpecs({ purpose: 'отсечной', material: 'Сталь', leak: '4 (Bubble tight)', pressure: '10000' }),
  catalog: { file: AIR, pages: '57–61', edition: '17.10.2025' },
  status: 'partial',
  todo: ['Вариант переходника 1*D*V не заведён — сверить со стр. 58'],
  examples: ['ГЕК-400*300-МЭО-40-220-Н-1*160-0'],
  sort: 47,
};

const gazohod: Family = {
  id: 'veza-gazohod', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'ГАЗОХОД',
  title: t2('Клапан газоходный ГАЗОХОД', 'Flue gas damper GAZOKHOD'),
  description: t2('Клапан для газоходов и дымовых газов, прямоугольный и круглый.'),
  kind: 'gas', typeLabel: t2('Отсечной клапан', 'Shut-off damper'), shapes: ['rect', 'round'],
  sizeSep: '*',
  params: [
    ...SIZE_PARAMS,
    choice('drive', t2('Привод', 'Actuator'), [v('РУЧКА', 'ручной', 'manual', { actuator: 'manual' }), ...MEO], { step: 'drive' }),
    choice('exec', t2('Исполнение', 'Execution'), EXEC_AIR.values!.filter((x) => ['Н', 'К'].includes(x.code)), { default: 'Н', step: 'execution' }),
    THEFT_AIR,
  ],
  positions: [
    fixed('ГАЗОХОД'),
    { key: 'size', label: t2('Сечение', 'Section'), formats: ['{W}{x}{H}', '{D}'] },
    pos('drive', 'Привод', 'Actuator', '{drive}'),
    pos('exec', 'Исполнение', 'Execution', '{exec}'),
    pos('theft', 'Защита', 'Anti-theft', '{theft}'),
  ],
  rules: [
    range('w', 'W', { shape: 'rect' }, 200, 2000, 'Ширина 200–2000 мм', 'стр. 63'),
    range('h', 'H', { shape: 'rect' }, 200, 2000, 'Высота 200–2000 мм', 'стр. 63'),
    range('d', 'D', { shape: 'round' }, 100, 2000, 'Диаметр 100–2000 мм', 'стр. 63'),
  ],
  match: { kinds: ['gas'], shapes: ['rect', 'round'], keywords: ['газоход', 'flue'] },
  specs: airSpecs({ purpose: 'отсечной', material: 'Сталь', leak: '-', pressure: '-' }),
  catalog: { file: AIR, pages: '62–67', edition: '17.10.2025' },
  status: 'partial',
  examples: ['ГАЗОХОД-600*500-МЭО-40-220-Н-К'],
  sort: 48,
};

// ── КЛАБ ────────────────────────────────────────────────────────────────────

const KLAB_DRIVES = [
  v('РУЧКА', 'ручной', 'manual', { actuator: 'manual' }),
  ...['LM24', 'LM24-S2', 'LM24-SRA', 'LM230', 'LM230-S2', 'LM230-SRA'].map((c) =>
    v(c, `реверсивный ${c}`, `reversible ${c}`, { actuator: 'reversible', voltage: c.includes('230') ? 220 : 24, modulating: c.endsWith('SRA') })),
  ...['LF24-5', 'LF24-S2-5', 'LF230-5', 'LF230-S2-5'].map((c) =>
    v(c, `с пружиной ${c}`, `spring return ${c}`, { actuator: 'spring', voltage: c.includes('230') ? 220 : 24 })),
];

const klab: Family = {
  id: 'veza-klab', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'КЛАБ',
  title: t2('Клапан балансировочный КЛАБ', 'Balancing damper KLAB'),
  description: t2('Балансировочный клапан: регулирующий, отсечной и регулирующий дымоудаления.'),
  kind: 'balancing', typeLabel: t2('Балансировочный клапан', 'Balancing damper'), shapes: ['round', 'rect'],
  sizeSep: '*',
  params: [
    ...SIZE_PARAMS,
    choice('type', t2('Тип', 'Type'), [v('0*ф', 'ниппельный', 'nipple', { mount: 'nipple' }), v('2*ф', 'канальный', 'duct', { mount: 'duct' })], { default: '0*ф', step: 'fire' }),
    choice('exec', t2('Исполнение', 'Execution'), EXEC_AIR.values!.filter((x) => ['Н', 'К'].includes(x.code)), { default: 'Н', step: 'execution' }),
    choice('drive', t2('Привод', 'Actuator'), KLAB_DRIVES, { default: 'РУЧКА', step: 'drive' }),
    choice('purpose', t2('Назначение', 'Purpose'), [
      v('0', 'регулирующий', 'control', { function: 'CONTROL' }),
      v('1', 'отсечной', 'shut-off', { function: 'SHUTOFF' }),
      v('2', 'регулирующий дымоудаления до 1000 Па', 'smoke control up to 1000 Pa', { function: 'SMOKE' }),
      v('3', 'регулирующий дымоудаления выше 1000 Па', 'smoke control above 1000 Pa', { function: 'SMOKE' }),
    ], { default: '0', step: 'purpose' }),
    THEFT_AIR,
  ],
  positions: [
    fixed('КЛАБ'),
    sizeHW,
    pos('type', 'Тип', 'Type', '{type}'),
    pos('exec', 'Исполнение', 'Execution', '{exec}'),
    pos('drive', 'Привод', 'Actuator', '{drive}'),
    pos('purpose', 'Назначение', 'Purpose', '{purpose}'),
    pos('theft', 'Защита', 'Anti-theft', '{theft}'),
  ],
  rules: [
    { id: 'rect-duct', when: { shape: 'rect' }, then: { allow: { param: 'type', values: ['2*ф'] } }, message: 'Прямоугольный КЛАБ — только канальный', source: 'КЛАБ, стр. 3' },
    { id: 'rect-smoke', when: { shape: 'rect' }, then: { allow: { param: 'purpose', values: ['2', '3'] } }, message: 'Прямоугольный КЛАБ — только назначения 2 и 3 (дымоудаление)', source: 'КЛАБ, стр. 3' },
    { id: 'rect-manual', when: { shape: 'rect' }, then: { allow: { param: 'drive', values: ['РУЧКА'] } }, message: 'Прямоугольный КЛАБ — только с ручкой', source: 'КЛАБ, стр. 3' },
    range('d', 'D', { shape: 'round' }, 100, 1000, 'Диаметр 100–1000 мм', 'КЛАБ, стр. 2'),
    range('h', 'H', { shape: 'rect' }, 100, 2440, 'Высота 100–2440 мм', 'КЛАБ, стр. 2'),
    range('w', 'W', { shape: 'rect' }, 100, 1500, 'Ширина 100–1500 мм', 'КЛАБ, стр. 2'),
  ],
  match: { kinds: ['balancing'], shapes: ['round', 'rect'], keywords: ['клаб', 'балансир', 'balancing'] },
  specs: airSpecs({ purpose: 'балансировочный', material: 'Оцинкованная сталь', leak: '-', pressure: '1000' }),
  catalog: { file: 'Клапан балансировочный КЛАБ.pdf', pages: '1–7' },
  status: 'partial',
  todo: ['Последняя позиция примера («-0») — защита от кражи или резерв? Сверить со стр. 3'],
  examples: ['КЛАБ-400-0*ф-Н-РУЧКА-1-0'],
  sort: 49,
};

export const AIR_FAMILIES: Family[] = [regular, regularL, reglan, kedr, kedrS, germikP, germikR, germikS, germikT, germikX2P, germikX2S, nerpa, gek, gazohod, klab];
