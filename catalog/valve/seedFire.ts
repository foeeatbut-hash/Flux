/**
 * Затравка: противопожарные клапаны ВЕЗА.
 *
 * Каталог «Противопожарные клапаны» (ред. 03.2026) свёрстан кривыми, текстового
 * слоя почти нет, и данные из него сняты распознаванием. Поэтому у семейств из
 * него статус `partial` и список «что сверить»: инженер открывает страницу PDF
 * рядом с карточкой и подтверждает. Отдельные каталоги КПУ-3, КПУ-60, КЭД и
 * КПУ-2Н МЕТРО имеют текстовый слой — там данные надёжнее.
 *
 * Эталонные обозначения в `examples` взяты из каталогов и из настоящих
 * бланков E06-2002/2003; по ним справочник проверяется кругом.
 */
import { t2, type Family, type ParamValue } from '../model';
import { VALVE_CLASS_ID } from './class';
import {
  v, choice, SIZE_PARAMS, pos, fixed, sizeWH, EXEC_FIRE, TYPE_FIRE, fireDrives, PLACEMENT, TERMINALS, RON, THEFT,
  ADAPTER_PARAMS, ADAPTER, FLOW, FRAME, fireRules, range, warnIf, spec, codesOf,
} from './codes';

export const VEZA = 'mf-veza';
const BIG = 'Противопожарные клапаны (ред. 03.2026).pdf';

const purpose = (withSmoke: boolean, only?: string[]) => choice('purpose', t2('Назначение', 'Purpose'), [
  v('О', 'нормально открытый', 'normally open', { function: 'NO' }),
  v('З', 'нормально закрытый', 'normally closed', { function: 'NC' }),
  ...(withSmoke ? [v('Д', 'дымовой', 'smoke', { function: 'SMOKE' })] : []),
].filter((x) => !only || only.includes(x.code)), { step: 'purpose' });

const drive = (values: ParamValue[]) => choice('drive', t2('Привод', 'Actuator'), values, { step: 'drive' });

/** Позиции КПУ: 13 через дефис, неиспользуемые пишутся нулём */
const kpuPositions = (series: string) => [
  fixed(series),
  pos('purpose', 'Назначение', 'Purpose', '{purpose}'),
  pos('exec', 'Исполнение', 'Execution', '{exec}'),
  sizeWH,
  pos('type', 'Тип клапана', 'Type', '{type}'),
  pos('drive', 'Привод', 'Actuator', '{drive}'),
  pos('placement', 'Размещение привода', 'Actuator location', '{placement}'),
  pos('terminals', 'Клеммы', 'Terminals', '{terminals}'),
  pos('ron', 'РОН', 'Air intake', '{ron}'),
  pos('theft', 'Защита от кражи', 'Anti-theft', '{theft}'),
  ADAPTER,
  pos('flow', 'По потоку', 'Flow', '{flow}'),
  pos('frame', 'Рама', 'Frame', '{frame}'),
];

const FLOW_STD = choice('flow', t2('Исполнение по потоку', 'Flow execution'), [v('0', 'стандартное', 'standard')], { default: '0', step: 'options' });

/** Характеристики для блока бланка: как их заполняли в E06-2002 */
function fireSpecs(ei: string, pDuct: string, pWall: string) {
  const ex = { fact: 'ex', eq: true } as const;
  return [
    spec('purpose', 'Назначение', 'Purpose', 'нормально открытый', 'normally open', undefined, [
      { when: { param: 'purpose', in: ['З'] }, value: t2('нормально закрытый', 'normally closed') },
      { when: { param: 'purpose', in: ['Д'] }, value: t2('дымовой', 'smoke') },
    ]),
    spec('material', 'Материал изготовления', 'Material', 'Корпус — оцинкованная сталь, лопатка — стандартная', 'Body — galvanized steel, blade — standard', undefined, [
      { when: { fact: 'stainless', eq: true }, value: t2('Корпус и лопатка — коррозионностойкая сталь', 'Body and blade — stainless steel') },
    ]),
    spec('pressure', 'Рабочее давление', 'Operating pressure', `до ${pDuct}`, `up to ${pDuct}`, 'Па', [
      { when: { param: 'type', in: ['1*ф'] }, value: t2(`до ${pWall}`, `up to ${pWall}`) },
    ]),
    spec('tempWork', 'Температура эксплуатации', 'Operating temperature', '-30/+45', '-30/+45', '°С'),
    spec('tempStore', 'Температура хранения / консервации', 'Storage temperature', '-40/+45', '-40/+45', '°С'),
    spec('fire', 'Огнестойкость по ГОСТ Р 53301', 'Fire resistance (GOST R 53301)', ei, ei),
    spec('climate', 'Климатическое исполнение ГОСТ 15150', 'Climate (GOST 15150)', 'УХЛ2', 'UHL2'),
    spec('ex', 'Взрывозащита', 'Explosion protection', 'нет', 'no', undefined, [{ when: ex, value: t2('Взрывозащищённый', 'Explosion proof') }]),
    spec('exMarking', 'Маркировка взрывозащиты', 'Ex marking', '-', '-', undefined, [{ when: ex, value: t2('1Ex h IIC T6 Gb', '1Ex h IIC T6 Gb') }]),
    spec('mechanism', 'Основной исполнительный механизм', 'Main actuator', 'электропривод', 'electric actuator', undefined, [
      { when: { fact: 'actuator', eq: 'electromagnet' }, value: t2('электромагнит', 'electromagnet') },
    ]),
  ];
}

// ── КПУ-1Н ──────────────────────────────────────────────────────────────────

const KPU1_DRIVES = fireDrives();
const kpu1: Family = {
  id: 'veza-kpu-1n', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'КПУ-1Н',
  title: t2('Клапан противопожарный КПУ-1Н', 'Fire damper KPU-1N'),
  description: t2('Огнезадерживающий (НО) и нормально закрытый клапан, EI 90. Прямоугольный и круглый, стеновой и канальный.'),
  kind: 'fire', typeLabel: t2('Клапан противопожарный', 'Fire damper'), shapes: ['rect', 'round'],
  facts: { ei: 90 }, sizeSep: 'х',
  params: [purpose(false), EXEC_FIRE, ...SIZE_PARAMS, TYPE_FIRE, drive(KPU1_DRIVES), PLACEMENT, TERMINALS, RON, THEFT, ...ADAPTER_PARAMS, FLOW_STD, FRAME],
  positions: kpuPositions('КПУ-1Н'),
  rules: [
    ...fireRules({ drives: KPU1_DRIVES, page: 'стр. 13' }),
    range('duct-w', 'W', { param: 'type', in: ['2*ф'] }, 100, 4100, 'Канальный: ширина A от 100 до 4100 мм (выше 1400 — кассета)', 'стр. 13, 28'),
    range('duct-h', 'H', { param: 'type', in: ['2*ф'] }, 100, 2900, 'Канальный: высота B от 100 до 2900 мм (выше 2000 — кассета)', 'стр. 13, 28'),
    range('wall-w', 'W', { param: 'type', in: ['1*ф'] }, 250, 4100, 'Стеновой: ширина A от 250 мм (с электромагнитом — от 270)', 'стр. 13'),
    range('wall-h', 'H', { param: 'type', in: ['1*ф'] }, 300, 2900, 'Стеновой: высота B от 300 мм', 'стр. 13'),
    range('wall-em', 'W', { all: [{ param: 'type', in: ['1*ф'] }, { fact: 'actuator', eq: 'electromagnet' }] }, 270, undefined, 'Стеновой с электромагнитом: ширина A от 270 мм', 'стр. 13'),
    warnIf('cassette-duct', { all: [{ param: 'type', in: ['2*ф'] }, { any: [{ param: 'W', gt: 1400 }, { param: 'H', gt: 2000 }] }] },
      'Больше 1400×2000 — кассетное исполнение из нескольких секций: число приводов сверить по таблицам', 'стр. 28, 47–65'),
    warnIf('cassette-wall', { all: [{ param: 'type', in: ['1*ф'] }, { any: [{ param: 'W', gt: 2000 }, { param: 'H', gt: 1400 }] }] },
      'Больше 2000×1400 — кассетное исполнение: число приводов сверить по таблицам', 'стр. 28, 47–65'),
  ],
  match: { kinds: ['fire'], functions: ['NO', 'NC'], shapes: ['rect', 'round'], tagTypes: ['DF', 'DS'], productPrefixes: ['VVFIP', 'VVFIC'] },
  specs: fireSpecs('EI 90', '2000', '700'),
  catalog: { file: BIG, pages: '12–18, 66–71', edition: '03.2026' },
  status: 'partial',
  todo: ['Таблицы числа приводов по размеру (стр. 47–65) — графика, не перенесены', 'Минимальные размеры стенового клапана сверить со стр. 13'],
  examples: [
    'КПУ-1Н-О-Н-500*600-2*ф-МН220-СН-0-РОН120-0-1*500-0-0',
    'КПУ-1Н-О-В-1000х800-2*ф-ЭПВ24-СН-КК-0-0-0-0-0',
    'КПУ-1Н-З-В-1000х800 -2*ф-ЭПВ24-СН-КК-0-0-0-0-0',
    'КПУ-1Н-О-Н-100-2*ф-МV24-СН-КК-0-0-0-0-0',
    'КПУ-1Н-О-В-2800х1800 -2*ф-ЭПВ24-СН-КК-0-0-0-0-0',
    'КПУ-1Н-О-Н-500-2*ф-МН220-СН-0-РОН110-0-0-0-0',
  ],
  sort: 10,
};

// ── КПУ-2Н (включая ВД) ─────────────────────────────────────────────────────

const KPU2_DRIVES = fireDrives();
const FLOW_2N = FLOW;
const kpu2: Family = {
  ...kpu1,
  id: 'veza-kpu-2n', code: 'КПУ-2Н',
  title: t2('Клапан противопожарный КПУ-2Н', 'Fire damper KPU-2N'),
  description: t2('НО и НЗ с EI 120, дымовой E 120. Исполнение ВД — высокодинамичное, до 5000 Па и 30 м/с.'),
  facts: { ei: 120 },
  params: [purpose(true), EXEC_FIRE, ...SIZE_PARAMS, TYPE_FIRE, drive(KPU2_DRIVES), PLACEMENT, TERMINALS, RON, THEFT, ...ADAPTER_PARAMS, FLOW_2N, FRAME],
  positions: kpuPositions('КПУ-2Н'),
  rules: [
    ...fireRules({ drives: KPU2_DRIVES, page: 'стр. 20' }),
    range('duct-w', 'W', { param: 'type', in: ['2*ф'] }, 100, 4100, 'Канальный: ширина A от 100 до 4100 мм (выше 1400 — кассета)', 'стр. 20, 28'),
    range('duct-h', 'H', { param: 'type', in: ['2*ф'] }, 100, 2900, 'Канальный: высота B от 100 до 2900 мм', 'стр. 20, 28'),
    range('wall-w', 'W', { all: [{ param: 'type', in: ['1*ф'] }, { param: 'purpose', in: ['О', 'З'] }] }, 300, 4100, 'Стеновой О/З: ширина A от 300 мм (с электромагнитом — от 350)', 'стр. 20'),
    range('wall-w-d', 'W', { all: [{ param: 'type', in: ['1*ф'] }, { param: 'purpose', in: ['Д'] }] }, 250, 4100, 'Стеновой дымовой: ширина A от 250 мм', 'стр. 20'),
    range('wall-h', 'H', { param: 'type', in: ['1*ф'] }, 300, 2900, 'Стеновой: высота B от 300 мм', 'стр. 20'),
    range('wall-em', 'W', { all: [{ param: 'type', in: ['1*ф'] }, { fact: 'actuator', eq: 'electromagnet' }, { param: 'purpose', in: ['О', 'З'] }] }, 350, undefined, 'Стеновой О/З с электромагнитом: ширина A от 350 мм', 'стр. 20'),
    { id: 'vd-duct', when: { param: 'flow', in: ['ВД'] }, then: { allow: { param: 'type', values: ['2*ф'] } }, message: 'Исполнение ВД — только канальный клапан', source: 'стр. 34' },
    { id: 'vd-drive', when: { param: 'flow', in: ['ВД'] }, then: { forbid: { param: 'drive', values: codesOf(KPU2_DRIVES, (x) => x.facts?.actuator === 'electromagnet') } }, message: 'Исполнение ВД — без электромагнита', source: 'стр. 34' },
    range('vd-w', 'W', { param: 'flow', in: ['ВД'] }, 100, 1000, 'Исполнение ВД: ширина A до 1000 мм', 'стр. 34'),
    range('vd-h', 'H', { param: 'flow', in: ['ВД'] }, 100, 1500, 'Исполнение ВД: высота B до 1500 мм', 'стр. 34'),
    { id: 'vd-frame', when: { param: 'flow', in: ['ВД'] }, then: { forbid: { param: 'frame', values: ['МРЗ'] } }, message: 'Исполнение ВД: рама только МРП', source: 'стр. 34' },
    warnIf('cassette-duct', { all: [{ param: 'type', in: ['2*ф'] }, { any: [{ param: 'W', gt: 1400 }, { param: 'H', gt: 2000 }] }] },
      'Больше 1400×2000 — кассетное исполнение: число приводов сверить по таблицам', 'стр. 28, 47–65'),
  ],
  match: { kinds: ['fire'], functions: ['NO', 'NC', 'SMOKE'], shapes: ['rect', 'round'], tagTypes: ['DF', 'DS'], productPrefixes: ['VVFIP', 'VVFIC'] },
  specs: fireSpecs('EI 120', '2000', '700'),
  catalog: { file: BIG, pages: '19–38, 72–82', edition: '03.2026' },
  todo: ['Таблицы числа приводов по размеру (стр. 47–65) — графика, не перенесены', 'ВД: газоплотное исполнение класса 3 — по запросу'],
  examples: [
    'КПУ-2Н-О-Н-500*600-2*ф-МН220-СН-0-РОН120-0-1*500-0-0',
    'КПУ-2Н-О-Н-500*600-2*ф-МН220-СН-0-РОН120-0-1*500-ВД-0',
    'КПУ-2Н-О-Н-500-2*ф-МН220-СН-0-0-0-1*000-0-0',
  ],
  sort: 11,
};

// ── КПУ-ДД ──────────────────────────────────────────────────────────────────

const DD_DRIVES = fireDrives({ em: false, thermal: false });
const kpuDD: Family = {
  id: 'veza-kpu-dd', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'КПУ-ДД',
  title: t2('Клапан противопожарный двойного действия КПУ-ДД', 'Double acting fire damper KPU-DD'),
  description: t2('Закрывается при пожаре и открывается после него для дымоудаления, EI 15.'),
  kind: 'fire', typeLabel: t2('Клапан противопожарный', 'Fire damper'), shapes: ['rect', 'round'],
  facts: { ei: 15, function: 'DA' }, sizeSep: '*',
  params: [
    choice('act', t2('Тип привода', 'Actuator type'), [
      v('П', 'с возвратной пружиной', 'spring return', { actuator: 'spring' }),
      v('Р', 'реверсивный', 'reversible', { actuator: 'reversible' }),
    ], { step: 'drive' }),
    EXEC_FIRE, ...SIZE_PARAMS, TYPE_FIRE, drive(DD_DRIVES), PLACEMENT, TERMINALS, RON, THEFT, ...ADAPTER_PARAMS, FLOW_STD, FRAME,
  ],
  positions: [
    fixed('КПУ-ДД'),
    pos('act', 'Тип привода', 'Actuator type', '{act}'),
    ...kpuPositions('КПУ-ДД').slice(2),
  ],
  rules: [
    ...fireRules({ drives: DD_DRIVES, page: 'стр. 40' }),
    range('duct-w', 'W', { param: 'type', in: ['2*ф'] }, 100, 1200, 'Канальный: ширина A от 100 до 1200 мм', 'стр. 40'),
    range('duct-h', 'H', { param: 'type', in: ['2*ф'] }, 100, 1000, 'Канальный: высота B от 100 до 1000 мм', 'стр. 40'),
    range('wall-w', 'W', { param: 'type', in: ['1*ф'] }, 250, 1000, 'Стеновой: ширина A от 250 до 1000 мм', 'стр. 40'),
    range('wall-h', 'H', { param: 'type', in: ['1*ф'] }, 300, 1200, 'Стеновой: высота B от 300 до 1200 мм', 'стр. 40'),
  ],
  match: { kinds: ['fire'], functions: ['DA'], tagTypes: ['DS'], productPrefixes: ['VFDDA'] },
  specs: [
    ...fireSpecs('EI 15', '2000', '700').filter((s) => s.key !== 'purpose'),
    spec('purpose', 'Назначение', 'Purpose', 'двойного действия', 'double acting'),
  ],
  catalog: { file: BIG, pages: '39–46, 83–87', edition: '03.2026' },
  status: 'partial',
  todo: ['Код ниппельного типа у круглого КПУ-ДД в распознанном тексте потерян'],
  examples: [
    'КПУ-ДД-П-Н-500*600-2*ф-МН220-СН-0-РОН130-К-1*400-0-0',
    'КПУ-ДД-Р-Н-600*1000-2*ф-MV24-СН-KК-0-0-0-0-0',
    'КПУ-ДД-П-Н-600*1000-2*ф-MН24-СН-KК-0-0-0-0-0',
  ],
  sort: 12,
};

// ── КПУ-2Н МЕТРО ────────────────────────────────────────────────────────────

const METRO_DRIVES = [
  v('МЭО220', 'электромеханизм МЭО ~220 В, 100 Н·м', 'МЭО actuator 220 V, 100 Nm', { actuator: 'mechanism', voltage: 220, current: 'AC', ex: false }),
  v('МЭО380', 'электромеханизм МЭО ~380 В, 100 Н·м', 'МЭО actuator 380 V, 100 Nm', { actuator: 'mechanism', voltage: 380, current: 'AC', ex: false }),
];
const metro: Family = {
  id: 'veza-kpu-2n-metro', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'КПУ-2Н МЕТРО',
  title: t2('Клапан противопожарный КПУ-2Н МЕТРО', 'Fire damper KPU-2N METRO'),
  description: t2('Тоннельный клапан метрополитена: 5000 Па, 30 м/с, +200 °С в течение часа.'),
  kind: 'fire', typeLabel: t2('Клапан противопожарный', 'Fire damper'), shapes: ['rect'],
  facts: { ei: 120, pressure: 5000 }, sizeSep: 'х',
  params: [
    purpose(false),
    choice('exec', t2('Исполнение', 'Execution'), EXEC_FIRE.values!.filter((x) => ['Н', 'К', 'МС', 'МСК'].includes(x.code)), { default: 'Н', step: 'execution' }),
    ...SIZE_PARAMS.filter((p) => p.key !== 'D'),
    choice('type', t2('Тип клапана', 'Type'), [v('2*ф', 'канальный', 'duct', { mount: 'duct' })], { default: '2*ф', step: 'fire' }),
    drive(METRO_DRIVES),
    choice('placement', t2('Размещение привода', 'Actuator location'), [v('СН', 'снаружи', 'outside')], { default: 'СН', step: 'drive' }),
    choice('reserve', t2('Резерв', 'Reserve'), [v('0', '—', '—')], { default: '0', step: 'options' }),
    choice('flow', t2('Исполнение по потоку', 'Flow'), [v('ВД', 'высокодинамичное', 'high dynamic')], { default: 'ВД', step: 'options' }),
    { key: 'ral', label: t2('Цвет покрытия RAL', 'RAL colour'), kind: 'text', step: 'options', hint: 'Для чёрной стали с покрытием: 7035' },
  ],
  positions: [
    fixed('КПУ-2Н'),
    pos('purpose', 'Назначение', 'Purpose', '{purpose}'),
    pos('exec', 'Исполнение', 'Execution', '{exec}'),
    { key: 'size', label: t2('Сечение', 'Section'), formats: ['{W}{x}{H}'] },
    pos('type', 'Тип клапана', 'Type', '{type}'),
    pos('drive', 'Привод', 'Actuator', '{drive}'),
    pos('placement', 'Размещение привода', 'Actuator location', '{placement}'),
    pos('r1', 'Клеммы', 'Terminals', '{reserve}'),
    pos('r2', 'Доп. опции', 'Extras', '{reserve}'),
    pos('r3', 'Лючок', 'Hatch', '{reserve}'),
    pos('r4', 'Переходник', 'Adapter', '{reserve}'),
    { key: 'flow', label: t2('По потоку', 'Flow'), formats: ['{flow}'] },
    { key: 'r5', label: t2('Резерв', 'Reserve'), formats: ['{reserve}_RAL{ral}', '{reserve}'] },
  ],
  rules: [
    range('w', 'W', undefined, 500, 10300, 'Ширина от 500 мм, одна секция до 2500, кассета до 10300', 'Метро, стр. 2–4'),
    range('h', 'H', undefined, 500, 5100, 'Высота от 500 мм, одна секция до 2500, кассета до 5100', 'Метро, стр. 2–4'),
    { id: 'step-w', then: { range: { param: 'W', min: 500, step: 50 } }, message: 'Ширина — с шагом 50 мм', source: 'Метро, стр. 3' },
    { id: 'step-h', then: { range: { param: 'H', min: 500, step: 50 } }, message: 'Высота — с шагом 50 мм', source: 'Метро, стр. 3' },
    warnIf('cassette', { any: [{ param: 'W', gt: 2500 }, { param: 'H', gt: 2500 }] }, 'Больше 2500×2500 — кассета: секции делятся по формуле (A/2 − 70)', 'Метро, стр. 5'),
  ],
  match: { kinds: ['fire'], functions: ['NO', 'NC'], shapes: ['rect'], keywords: ['метро', 'тоннел', 'metro', 'tunnel', 'мэо'], bias: -4 },
  specs: [...fireSpecs('EI 120', '5000', '5000'), spec('tempWork', 'Температура эксплуатации', 'Operating temperature', '-60/+40', '-60/+40', '°С')],
  catalog: { file: 'Клапаны противопожарные КПУ-2Н Метро (ред. февраль 2025).pdf', pages: '2–8', edition: '02.2025' },
  status: 'full',
  examples: ['КПУ-2Н-О-К-500х600-2*ф-МЭО220-СН-0-0-0-0-ВД-0', 'КПУ-2Н-О-Н-1000х1000-2*ф-МЭО220-СН-0-0-0-0-ВД-0_RAL7035'],
  sort: 13,
};

// ── КПУ-3 ───────────────────────────────────────────────────────────────────

const KPU3_DRIVES = fireDrives({ em: false, thermal: false, ex: false, veza: false }).filter((x) => x.code.startsWith('МН'));
const kpu3: Family = {
  id: 'veza-kpu-3', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'КПУ-3',
  title: t2('Клапан противопожарный КПУ-3', 'Fire damper KPU-3'),
  description: t2('НО и НЗ с EI 180, дымовой E 180. Только канальный, привод НЕМАН снаружи.'),
  kind: 'fire', typeLabel: t2('Клапан противопожарный', 'Fire damper'), shapes: ['rect'],
  facts: { ei: 180 }, sizeSep: '*',
  params: [
    purpose(true),
    choice('exec', t2('Исполнение', 'Execution'), EXEC_FIRE.values!.filter((x) => ['Н', 'К', 'МС', 'МСК'].includes(x.code)), { default: 'Н', step: 'execution' }),
    ...SIZE_PARAMS.filter((p) => p.key !== 'D'),
    choice('type', t2('Тип клапана', 'Type'), [v('2*ф', 'канальный', 'duct', { mount: 'duct' })], { default: '2*ф', step: 'fire' }),
    drive(KPU3_DRIVES),
    choice('placement', t2('Размещение привода', 'Actuator location'), [v('СН', 'снаружи', 'outside')], { default: 'СН', step: 'drive' }),
    TERMINALS, RON, THEFT, ...ADAPTER_PARAMS, FLOW_STD,
    choice('frame', t2('Монтажная рама', 'Frame'), [v('0', 'нет', 'none'), v('МРП', 'МРП', 'МРП')], { default: '0', step: 'options' }),
  ],
  positions: kpuPositions('КПУ-3').map((p) => (p.key === 'size' ? { ...p, formats: ['{W}{x}{H}'] } : p)),
  rules: [
    range('w', 'W', undefined, 100, 2060, 'Ширина A от 100 мм; одна секция до 1000, кассета до 2060', 'КПУ-3, стр. 5–7'),
    range('h', 'H', undefined, 100, 1660, 'Высота B от 100 мм; одна секция до 800, кассета до 1660', 'КПУ-3, стр. 5–7'),
    warnIf('cassette', { any: [{ param: 'W', gt: 1000 }, { param: 'H', gt: 800 }] }, 'Больше 1000×800 — кассета: секции делятся по формуле (A/2 − 30)', 'КПУ-3, стр. 7'),
    { id: 'theft', when: { param: 'theft', in: ['К', 'З'] }, then: { allow: { param: 'drive', values: ['МН220', 'МН24'] } }, message: 'Защита от кражи — для приводов МН', source: 'КПУ-3, стр. 5' },
  ],
  match: { kinds: ['fire'], functions: ['NO', 'NC', 'SMOKE'], shapes: ['rect'], tagTypes: ['DF', 'DS'] },
  specs: [...fireSpecs('EI 180', '1500', '1500'), spec('tempWork', 'Температура эксплуатации', 'Operating temperature', '-30/+50', '-30/+50', '°С')],
  catalog: { file: 'Клапан противопожарный КПУ-3.pdf', pages: '3–12' },
  status: 'full',
  examples: ['КПУ-3-З-Н-500*600-2*ф-МН220-СН-0-РОН120-0-0-0-0'],
  sort: 14,
};

// ── КПУ-60 ──────────────────────────────────────────────────────────────────

const kpu60: Family = {
  id: 'veza-kpu-60', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'КПУ-60',
  title: t2('Клапан противопожарный КПУ-60', 'Fire damper KPU-60'),
  description: t2('Нормально закрытый стеновой клапан EI 60 с приводом НЕМАН внутри.'),
  kind: 'fire', typeLabel: t2('Клапан противопожарный', 'Fire damper'), shapes: ['rect'],
  facts: { ei: 60, mount: 'wall' }, sizeSep: '*',
  params: [
    purpose(false, ['З']),
    choice('exec', t2('Исполнение', 'Execution'), [EXEC_FIRE.values![0]], { default: 'Н', step: 'execution' }),
    ...SIZE_PARAMS.filter((p) => p.key !== 'D'),
    choice('type', t2('Тип клапана', 'Type'), [v('1*ф', 'стеновой', 'wall', { mount: 'wall' })], { default: '1*ф', step: 'fire' }),
    drive(KPU3_DRIVES),
    choice('placement', t2('Размещение привода', 'Actuator location'), [v('ВН', 'внутри', 'inside')], { default: 'ВН', step: 'drive' }),
    TERMINALS, RON, THEFT,
    choice('adapterX', t2('Переходник', 'Adapter'), [v('0', 'нет', 'none')], { default: '0', step: 'options' }),
    FLOW_STD,
    choice('frame', t2('Монтажная рама', 'Frame'), [v('0', 'нет', 'none'), v('МРЗ', 'МРЗ', 'МРЗ')], { default: '0', step: 'options' }),
  ],
  positions: kpuPositions('КПУ-60').map((p) => (p.key === 'size' ? { ...p, formats: ['{W}{x}{H}'] } : p.key === 'adapter' ? { ...p, formats: ['{adapterX}'] } : p)),
  rules: [
    range('w', 'W', undefined, 250, 1500, 'Ширина A от 250 до 1500 мм', 'КПУ-60, стр. 4'),
    range('h', 'H', undefined, 300, 1500, 'Высота B от 300 до 1500 мм', 'КПУ-60, стр. 4'),
  ],
  match: { kinds: ['fire'], functions: ['NC'], shapes: ['rect'], require: { mount: 'wall' } },
  specs: [...fireSpecs('EI 60', '700', '700')],
  catalog: { file: 'Клапан противопожарный КПУ-60.pdf', pages: '4–6' },
  status: 'partial',
  todo: ['Минимальный размер на стр. 4 распознан неуверенно — сверить'],
  examples: ['КПУ-60-З-Н-500*600-1*ф-МН220-ВН-0-РОН120-0-0-0-0'],
  sort: 15,
};

// ── ГЕРМИК-ДУ ───────────────────────────────────────────────────────────────

const DU_DRIVES = fireDrives({ thermal: false, ex: false });
const germikDU: Family = {
  id: 'veza-germik-du', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'ГЕРМИК-ДУ',
  title: t2('Клапан дымоудаления ГЕРМИК-ДУ', 'Smoke damper GERMIK-DU'),
  description: t2('Нормально закрытый EI 120 и дымовой E 120, 1500 Па, общепромышленное исполнение.'),
  kind: 'fire', typeLabel: t2('Клапан противопожарный', 'Fire damper'), shapes: ['rect'],
  facts: { ei: 120, ex: false }, sizeSep: '*',
  params: [
    choice('purpose', t2('Назначение', 'Purpose'), [v('З', 'нормально закрытый', 'normally closed', { function: 'NC' }), v('Д', 'дымовой', 'smoke', { function: 'SMOKE' })], { step: 'purpose' }),
    ...SIZE_PARAMS.filter((p) => p.key !== 'D'), TYPE_FIRE, drive(DU_DRIVES), PLACEMENT, TERMINALS, RON, FRAME, THEFT,
  ],
  positions: [
    fixed('ГЕРМИК-ДУ'),
    pos('purpose', 'Назначение', 'Purpose', '{purpose}'),
    { key: 'size', label: t2('Сечение', 'Section'), formats: ['{W}{x}{H}'] },
    pos('type', 'Тип клапана', 'Type', '{type}'),
    pos('drive', 'Привод', 'Actuator', '{drive}'),
    pos('placement', 'Размещение', 'Location', '{placement}'),
    pos('terminals', 'Клеммы', 'Terminals', '{terminals}'),
    pos('ron', 'РОН', 'Air intake', '{ron}'),
    pos('frame', 'Рама', 'Frame', '{frame}'),
    pos('theft', 'Защита', 'Anti-theft', '{theft}'),
  ],
  rules: [
    // Исполнения у ГЕРМИК-ДУ в обозначении нет — правило «электромагнит только
    // в исполнениях Н и К» ссылалось бы на несуществующий параметр
    ...fireRules({ drives: DU_DRIVES, page: 'стр. 91', exExecs: [] }).filter((r) => r.id !== 'round-series' && r.id !== 'round-duct' && r.id !== 'em-exec'),
    range('duct-w', 'W', { param: 'type', in: ['2*ф'] }, 100, undefined, 'Канальный: от 100 мм', 'стр. 91'),
    range('duct-h', 'H', { param: 'type', in: ['2*ф'] }, 100, undefined, 'Канальный: от 100 мм', 'стр. 91'),
    range('wall-w', 'W', { param: 'type', in: ['1*ф'] }, 300, undefined, 'Стеновой: от 300 мм', 'стр. 91'),
    range('wall-h', 'H', { param: 'type', in: ['1*ф'] }, 300, undefined, 'Стеновой: от 300 мм', 'стр. 91'),
  ],
  match: { kinds: ['fire'], functions: ['NC', 'SMOKE'], shapes: ['rect'], exclude: { ex: true }, bias: -1 },
  specs: fireSpecs('EI 120', '1500', '1500'),
  catalog: { file: BIG, pages: '89–106', edition: '03.2026' },
  status: 'partial',
  todo: ['Максимальные размеры не распознаны — сверить со стр. 91–95'],
  examples: ['ГЕРМИК-ДУ-Д-500*600-2*ф-МН220-СН-КК-РОН110-МРП-К'],
  sort: 16,
};

// ── КЭД ─────────────────────────────────────────────────────────────────────

const KED_DRIVES: ParamValue[] = [
  ...fireDrives({ thermal: false, ex: false }).filter((x) => !x.code.startsWith('МВ')),
  v('MB220', 'привод BELIMO ~220 В', 'BELIMO actuator 220 V', { actuator: 'spring|reversible', voltage: 220, current: 'AC', ex: false, brand: 'BELIMO' }),
  v('MB24', 'привод BELIMO 24 В', 'BELIMO actuator 24 V', { actuator: 'spring|reversible', voltage: 24, ex: false, brand: 'BELIMO' }),
];
const ked: Family = {
  id: 'veza-ked', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'КЭД',
  title: t2('Клапан дымоудаления КЭД', 'Smoke damper KED'),
  description: t2('Модификации 1 и 2 — дымоудаления E 120 (створка от помещения / к помещению), 3 — нормально закрытый EI 120.'),
  kind: 'fire', typeLabel: t2('Клапан дымоудаления', 'Smoke damper'), shapes: ['rect'],
  facts: { ei: 120, ex: false }, sizeSep: '*',
  params: [
    choice('mod', t2('Модификация', 'Modification'), [
      v('1', 'дымоудаления, створка от помещения', 'smoke, blade away from room', { function: 'SMOKE' }),
      v('2', 'дымоудаления, створка к помещению', 'smoke, blade towards room', { function: 'SMOKE' }),
      v('3', 'нормально закрытый EI 120', 'normally closed EI 120', { function: 'NC' }),
    ], { step: 'purpose' }),
    ...SIZE_PARAMS.filter((p) => p.key !== 'D'), TYPE_FIRE, drive(KED_DRIVES), PLACEMENT, TERMINALS, RON, FRAME, THEFT,
    choice('install', t2('Установка', 'Installation'), [v('В', 'вертикальная', 'vertical'), v('Г', 'горизонтальная', 'horizontal')], { default: 'В', step: 'options' }),
  ],
  positions: [
    fixed('КЭД'),
    pos('mod', 'Модификация', 'Modification', '{mod}'),
    { key: 'size', label: t2('Сечение', 'Section'), formats: ['{W}{x}{H}'] },
    pos('type', 'Тип клапана', 'Type', '{type}'),
    pos('drive', 'Привод', 'Actuator', '{drive}'),
    pos('placement', 'Размещение', 'Location', '{placement}'),
    pos('terminals', 'Клеммы', 'Terminals', '{terminals}'),
    pos('ron', 'РОН', 'Air intake', '{ron}'),
    pos('frame', 'Рама', 'Frame', '{frame}'),
    pos('theft', 'Защита', 'Anti-theft', '{theft}'),
    pos('install', 'Установка', 'Installation', '{install}'),
  ],
  rules: [
    ...fireRules({ drives: KED_DRIVES, page: 'КЭД, стр. 6', exExecs: [] }).filter((r) => !r.id.startsWith('round') && r.id !== 'theft-drive' && r.id !== 'em-exec'),
    { id: 'theft', when: { param: 'theft', in: ['К', 'З'] }, then: { allow: { param: 'drive', values: ['MV220', 'MV24', 'MB220', 'MB24', 'МН220', 'МН24'] } }, message: 'Защита от кражи — для приводов MV, MB и МН', source: 'КЭД, стр. 6' },
    { id: 'duct-mod', when: { param: 'type', in: ['2*ф'] }, then: { allow: { param: 'mod', values: ['1', '3'] } }, message: 'Канальный (2*ф) — только модификации 1 и 3', source: 'стр. 113' },
    { id: 'horiz-mod', when: { param: 'install', in: ['Г'] }, then: { allow: { param: 'mod', values: ['1'] } }, message: 'Горизонтальная установка — только модификация 1', source: 'стр. 113' },
    range('wall-w', 'W', { param: 'type', in: ['1*ф'] }, 300, 2000, 'Стеновой: ширина от 300 до 2000 мм', 'КЭД, стр. 7'),
    range('wall-h', 'H', { param: 'type', in: ['1*ф'] }, 300, 1550, 'Стеновой: высота от 300 до 1550 мм', 'КЭД, стр. 7'),
    range('duct-w', 'W', { param: 'type', in: ['2*ф'] }, 250, 2000, 'Канальный: ширина от 250 до 2000 мм', 'КЭД, стр. 7'),
    range('duct-h', 'H', { param: 'type', in: ['2*ф'] }, 300, 1550, 'Канальный: высота от 300 до 1550 мм', 'КЭД, стр. 7'),
  ],
  match: { kinds: ['fire'], functions: ['SMOKE', 'NC'], shapes: ['rect'], keywords: ['кэд', 'дымоудал', 'smoke'], exclude: { ex: true } },
  specs: [
    ...fireSpecs('EI 120', '700', '700').filter((s) => s.key !== 'purpose' && s.key !== 'fire'),
    spec('purpose', 'Назначение', 'Purpose', 'дымоудаления', 'smoke exhaust', undefined, [{ when: { param: 'mod', in: ['3'] }, value: t2('нормально закрытый', 'normally closed') }]),
    spec('fire', 'Огнестойкость по ГОСТ Р 53301', 'Fire resistance', 'E 120', 'E 120', undefined, [{ when: { param: 'mod', in: ['3'] }, value: t2('EI 120', 'EI 120') }]),
  ],
  catalog: { file: 'Клапан противопожарный КЭД.pdf', pages: '3–14' },
  status: 'partial',
  todo: ['РОН120/130 только для модификации 1 — в распознанном тексте неуверенно'],
  examples: ['КЭД-3-600*400-1*ф-MV220-ВН-КК-0-МРЗ-К-В', 'КЭД-1-600*400-1*ф-МН220-ВН-КК-0-МРЗ-К-Г'],
  sort: 17,
};

// ── ОКСИД ───────────────────────────────────────────────────────────────────

const oksid: Family = {
  id: 'veza-oksid', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'ОКСИД',
  title: t2('Клапан избыточного давления противопожарный ОКСИД', 'Fire overpressure damper OKSID'),
  description: t2('Противопожарный клапан избыточного давления EI 90, давление открытия 20–150 Па.'),
  kind: 'overpressure', typeLabel: t2('Клапан избыточного давления', 'Overpressure damper'), shapes: ['rect'],
  facts: { ei: 90 }, sizeSep: '*',
  params: [
    ...SIZE_PARAMS.filter((p) => p.key !== 'D'), TYPE_FIRE,
    choice('exec', t2('Исполнение', 'Execution'), EXEC_FIRE.values!.filter((x) => ['Н', 'К', 'МС', 'МСК'].includes(x.code)), { default: 'Н', step: 'execution' }),
    RON, FRAME,
  ],
  positions: [
    fixed('ОКСИД'),
    { key: 'size', label: t2('Сечение', 'Section'), formats: ['{W}{x}{H}'] },
    pos('type', 'Тип клапана', 'Type', '{type}'),
    pos('exec', 'Исполнение', 'Execution', '{exec}'),
    pos('ron', 'РОН', 'Air intake', '{ron}'),
    pos('frame', 'Рама', 'Frame', '{frame}'),
  ],
  rules: [
    range('duct-w', 'W', { param: 'type', in: ['2*ф'] }, 150, 1200, 'Канальный: ширина 150–1200 мм', 'стр. 141'),
    range('duct-h', 'H', { param: 'type', in: ['2*ф'] }, 200, 1200, 'Канальный: высота 200–1200 мм', 'стр. 141'),
    range('wall-w', 'W', { param: 'type', in: ['1*ф'] }, 150, 1200, 'Стеновой: ширина 150–1200 мм', 'стр. 141'),
    range('wall-h', 'H', { param: 'type', in: ['1*ф'] }, 230, 1230, 'Стеновой: высота 230–1230 мм', 'стр. 141'),
  ],
  match: { kinds: ['overpressure'], shapes: ['rect'], bias: -2, keywords: ['оксид'] },
  specs: [
    spec('purpose', 'Назначение', 'Purpose', 'избыточного давления', 'overpressure'),
    spec('fire', 'Огнестойкость', 'Fire resistance', 'EI 90', 'EI 90'),
    spec('pressure', 'Давление открытия', 'Opening pressure', '20–150', '20–150', 'Па'),
  ],
  catalog: { file: BIG, pages: '139–148', edition: '03.2026' },
  status: 'partial',
  examples: ['ОКСИД-600*400-1*ф-Н-РОН110-0'],
  sort: 18,
};

// ── ПРОК ────────────────────────────────────────────────────────────────────

const prok: Family = {
  id: 'veza-prok', classId: VALVE_CLASS_ID, manufacturerId: VEZA, code: 'ПРОК',
  title: t2('Клапан обратный противопожарный ПРОК', 'Fire check damper PROK'),
  description: t2('Противопожарный обратный клапан EI 120: модификация 1 — горизонтальный, 2 — вертикальный вытяжной, 3 — вертикальный приточный.'),
  kind: 'check', typeLabel: t2('Клапан обратный противопожарный', 'Fire check damper'), shapes: ['rect', 'round'],
  facts: { ei: 120 }, sizeSep: '*',
  params: [
    choice('mod', t2('Модификация', 'Modification'), [
      v('1', 'горизонтальный', 'horizontal', { orientation: 'horizontal' }),
      v('2', 'вертикальный вытяжной', 'vertical exhaust', { orientation: 'vertical' }),
      v('3', 'вертикальный приточный', 'vertical supply', { orientation: 'vertical' }),
    ], { step: 'purpose' }),
    choice('exec', t2('Исполнение', 'Execution'), EXEC_FIRE.values!.filter((x) => ['Н', 'К'].includes(x.code)), { default: 'Н', step: 'execution' }),
    ...SIZE_PARAMS,
    choice('overhang', t2('Исключение вылета', 'No overhang'), [
      v('0', 'нет', 'none'), v('1*000*V1', 'с одной стороны, V1', 'one side, V1'), v('1*000*V2', 'с одной стороны, V2', 'one side, V2'), v('2*000', 'с двух сторон (круглый)', 'both sides (round)'),
    ], { default: '0', step: 'options' }),
  ],
  positions: [
    fixed('ПРОК'),
    pos('mod', 'Модификация', 'Modification', '{mod}'),
    pos('exec', 'Исполнение', 'Execution', '{exec}'),
    sizeWH,
    pos('overhang', 'Исключение вылета', 'No overhang', '{overhang}'),
  ],
  rules: [
    range('w', 'W', { shape: 'rect' }, 300, 1250, 'Ширина 300–1250 мм', 'стр. 151'),
    range('h', 'H', { shape: 'rect' }, 300, 1250, 'Высота 300–1250 мм', 'стр. 151'),
    { id: 'overhang-round', when: { shape: 'rect' }, then: { forbid: { param: 'overhang', values: ['2*000'] } }, message: '2*000 — только у круглого', source: 'стр. 151' },
  ],
  match: { kinds: ['check'], shapes: ['rect', 'round'], require: { ei: 120 }, bias: -2, keywords: ['прок'] },
  specs: [
    spec('purpose', 'Назначение', 'Purpose', 'обратный противопожарный', 'fire check'),
    spec('fire', 'Огнестойкость', 'Fire resistance', 'EI 120', 'EI 120'),
    spec('pressure', 'Рабочее давление', 'Operating pressure', 'до 2000', 'up to 2000', 'Па'),
  ],
  catalog: { file: BIG, pages: '149–161', edition: '03.2026' },
  status: 'partial',
  todo: ['Обозначение восстановлено по распознанному тексту — сверить порядок позиций со стр. 151'],
  examples: ['ПРОК-1-Н-800*400-1*000*V1'],
  sort: 19,
};

export const FIRE_FAMILIES: Family[] = [kpu1, kpu2, kpuDD, metro, kpu3, kpu60, germikDU, ked, oksid, prok];
