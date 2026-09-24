/**
 * Общие наборы кодов для затравки каталога ВЕЗА.
 *
 * Семейства КПУ, КЭД, ГЕРМИК-ДУ пишут привод, тип клапана, клеммы и раму одними
 * и теми же кодами; воздушные клапаны — своим рядом приводов (LM/NM/SM…).
 * Собраны здесь, чтобы исправление кода в одном месте доезжало до всех семейств.
 *
 * Источники: «Противопожарные клапаны» (ред. 03.2026), «Воздушные клапаны»
 * (ред. 17.10.2025), отдельные каталоги КПУ-3, КПУ-60, КЭД, КПУ-2Н МЕТРО, КЛАБ.
 */
import { t2, type Facts, type ParamDef, type ParamValue, type Position, type Rule, type SpecDefault, type Text2, type Cond } from '../model';

export const v = (code: string, ru: string, en?: string, facts?: Facts, extra?: Partial<ParamValue>): ParamValue =>
  ({ code, label: t2(ru, en), ...(facts ? { facts } : {}), ...(extra || {}) });

export const choice = (key: string, label: Text2, values: ParamValue[], opts: Partial<ParamDef> = {}): ParamDef =>
  ({ key, label, kind: 'choice', values, ...opts });

export const SIZE_PARAMS: ParamDef[] = [
  { key: 'W', label: t2('Ширина A', 'Width A'), kind: 'number', size: 'W', unit: 'мм', step: 'size' },
  { key: 'H', label: t2('Высота B', 'Height B'), kind: 'number', size: 'H', unit: 'мм', step: 'size' },
  { key: 'D', label: t2('Диаметр D', 'Diameter D'), kind: 'number', size: 'D', unit: 'мм', step: 'size' },
];

export const pos = (key: string, ru: string, en: string, ...formats: string[]): Position =>
  ({ key, label: t2(ru, en), formats });

export const fixed = (code: string): Position => ({ key: 'series', label: t2('Обозначение', 'Series'), formats: [code] });

/** Размер: прямоугольный `A*B` или круглый `D` */
export const sizeWH = pos('size', 'Сечение', 'Section', '{W}{x}{H}', '{D}');
/** У воздушных клапанов ВЕЗА первой пишется высота: ГЕРМИК-П-600*1000 — Н=600, В=1000 */
export const sizeHW = pos('size', 'Сечение', 'Section', '{H}{x}{W}', '{D}');

// ── Противопожарные: коды КПУ ───────────────────────────────────────────────

const AC220: Facts = { voltage: 220, current: 'AC' };
const V24: Facts = { voltage: 24 };
const BOTH = 'spring|reversible';

export const EXEC_FIRE = choice('exec', t2('Исполнение', 'Execution'), [
  v('Н', 'общепромышленное, оцинкованная сталь', 'general industrial, galvanized', { ex: false, stainless: false }),
  v('К', 'коррозионностойкое', 'corrosion resistant', { ex: false, stainless: true }),
  v('МС', 'морозостойкое', 'frost-resistant', { ex: false, frost: true, stainless: false }),
  v('МСК', 'морозостойкое коррозионностойкое', 'frost-resistant stainless', { ex: false, frost: true, stainless: true }),
  v('В', 'взрывозащищённое', 'explosion proof', { ex: true, stainless: false }),
  v('ВК', 'взрывозащищённое коррозионностойкое', 'explosion proof stainless', { ex: true, stainless: true }),
  v('ВМС', 'взрывозащищённое морозостойкое', 'explosion proof frost-resistant', { ex: true, frost: true, stainless: false }),
  v('ВМСК', 'взрывозащищённое морозостойкое коррозионностойкое', 'explosion proof frost-resistant stainless', { ex: true, frost: true, stainless: true }),
], { default: 'Н', step: 'execution' });

export const EX_EXECS = ['В', 'ВК', 'ВМС', 'ВМСК'];

export const TYPE_FIRE = choice('type', t2('Тип клапана', 'Damper type'), [
  v('2*ф', 'канальный', 'duct', { mount: 'duct' }),
  v('1*ф', 'стеновой', 'wall', { mount: 'wall' }),
], { default: '2*ф', step: 'fire' });

/** Привод КПУ. Назначение О — пружинный возврат, З/Д — реверсивный, код один */
export function fireDrives(opts: { em?: boolean; thermal?: boolean; ex?: boolean; veza?: boolean } = {}): ParamValue[] {
  const out: ParamValue[] = [];
  if (opts.em !== false) {
    out.push(v('ЭМП220', 'электромагнит ~220 В', 'electromagnet 220 V AC', { actuator: 'electromagnet', ...AC220, ex: false }));
    out.push(v('ЭМП24', 'электромагнит 24 В', 'electromagnet 24 V', { actuator: 'electromagnet', ...V24, ex: false }));
  }
  out.push(v('МН220', 'привод НЕМАН ~220 В', 'NEMAN actuator 220 V AC', { actuator: BOTH, ...AC220, ex: false, brand: 'НЕМАН' }));
  out.push(v('МН24', 'привод НЕМАН 24 В', 'NEMAN actuator 24 V', { actuator: BOTH, ...V24, ex: false, brand: 'НЕМАН' }));
  if (opts.thermal !== false) {
    out.push(v('МН220-Т', 'привод НЕМАН ~220 В с ТРУ', 'NEMAN 220 V with thermal release', { actuator: 'spring', thermal: true, ...AC220, ex: false, brand: 'НЕМАН' }));
    out.push(v('МН24-Т', 'привод НЕМАН 24 В с ТРУ', 'NEMAN 24 V with thermal release', { actuator: 'spring', thermal: true, ...V24, ex: false, brand: 'НЕМАН' }));
  }
  out.push(v('МВ220', 'привод BELIMO ~220 В', 'BELIMO actuator 220 V AC', { actuator: BOTH, ...AC220, ex: false, brand: 'BELIMO' }));
  out.push(v('МВ24', 'привод BELIMO 24 В', 'BELIMO actuator 24 V', { actuator: BOTH, ...V24, ex: false, brand: 'BELIMO' }));
  if (opts.thermal !== false) {
    out.push(v('МВ220-Т', 'привод BELIMO ~220 В с ТРУ', 'BELIMO 220 V with thermal release', { actuator: 'spring', thermal: true, ...AC220, ex: false, brand: 'BELIMO' }));
    out.push(v('МВ24-Т', 'привод BELIMO 24 В с ТРУ', 'BELIMO 24 V with thermal release', { actuator: 'spring', thermal: true, ...V24, ex: false, brand: 'BELIMO' }));
  }
  if (opts.veza !== false) {
    // Латинское MV — привод ВЕЗА. В бланках E06-2002 стоит именно он
    // («КПУ-1Н-О-Н-100-2*ф-МV24-…»); кириллическое МВ — это BELIMO, и путать их нельзя
    out.push(v('MV220', 'привод ВЕЗА MV ~220 В', 'VEZA MV actuator 220 V AC', { actuator: BOTH, ...AC220, ex: false, brand: 'ВЕЗА' }));
    out.push(v('MV24', 'привод ВЕЗА MV 24 В', 'VEZA MV actuator 24 V', { actuator: BOTH, ...V24, ex: false, brand: 'ВЕЗА' }));
  }
  if (opts.ex !== false) {
    out.push(v('ЭПВ220', 'взрывозащищённый привод ~220 В', 'explosion proof actuator 220 V', { actuator: BOTH, ...AC220, ex: true }));
    out.push(v('ЭПВ24', 'взрывозащищённый привод 24 В', 'explosion proof actuator 24 V', { actuator: BOTH, ...V24, ex: true }));
    out.push(v('ЭПВ220-К', 'взрывозащищённый привод ~220 В, корпус нерж.', 'Ex actuator 220 V, stainless housing', { actuator: BOTH, ...AC220, ex: true, stainless: true }));
    out.push(v('ЭПВ24-К', 'взрывозащищённый привод 24 В, корпус нерж.', 'Ex actuator 24 V, stainless housing', { actuator: BOTH, ...V24, ex: true, stainless: true }));
  }
  return out;
}

export const codesOf = (values: ParamValue[], pred: (v: ParamValue) => boolean) => values.filter(pred).map((x) => x.code);

export const PLACEMENT = choice('placement', t2('Размещение привода', 'Actuator location'), [
  v('СН', 'снаружи', 'outside'),
  v('ВН', 'внутри', 'inside'),
], { default: 'СН', step: 'drive' });

export const TERMINALS = choice('terminals', t2('Клеммы', 'Terminals'), [
  v('0', 'нет', 'none', { junctionBox: false }),
  v('КК', 'клеммная коробка', 'terminal box', { junctionBox: true }),
  v('КЛ', 'клеммная колодка', 'terminal block', { junctionBox: false }),
], { default: '0', step: 'options' });

export const RON = choice('ron', t2('Воздухоприёмное устройство', 'Air intake'), [
  v('0', 'нет', 'none'),
  v('РОН110', 'РОН110', 'РОН110'),
  v('РОН120', 'РОН120', 'РОН120'),
  v('РОН130', 'РОН130', 'РОН130'),
], { default: '0', step: 'options' });

export const THEFT = choice('theft', t2('Защита от кражи привода', 'Anti-theft'), [
  v('0', 'нет', 'none'),
  v('К', 'антивандальное исполнение', 'anti-removal design'),
  v('З', 'привод снят и приложен', 'actuator shipped separately'),
], { default: '0', step: 'options' });

/** Переходник на круглый воздуховод `1*500` или исключение вылета `1*000` */
export const ADAPTER_PARAMS: ParamDef[] = [
  choice('adapterN', t2('Переходник: сторон', 'Adapter: sides'), [v('1', 'с одной стороны', 'one side'), v('2', 'с двух сторон', 'both sides')], { step: 'options' }),
  { key: 'adapterD', label: t2('Переходник: диаметр', 'Adapter diameter'), kind: 'number', unit: 'мм', step: 'options' },
  choice('adapterX', t2('Исключение вылета заслонки', 'No blade overhang'), [
    v('0', 'нет', 'none'),
    v('1*000', 'с одной стороны', 'one side'),
    v('2*000', 'с двух сторон', 'both sides'),
  ], { default: '0', step: 'options' }),
];
export const ADAPTER = pos('adapter', 'Переходник / вылет', 'Adapter / overhang', '{adapterN}*{adapterD}', '{adapterX}');

export const FLOW = choice('flow', t2('Исполнение по потоку', 'Flow execution'), [
  v('0', 'стандартное', 'standard'),
  v('ВД', 'высокодинамичное (5000 Па, 30 м/с)', 'high dynamic (5000 Pa, 30 m/s)', { pressure: 5000 }),
], { default: '0', step: 'options' });

export const FRAME = choice('frame', t2('Монтажная рама', 'Mounting frame'), [
  v('0', 'нет', 'none'),
  v('МРЗ', 'МРЗ (для стенового)', 'МРЗ (wall)'),
  v('МРП', 'МРП (для канального)', 'МРП (duct)'),
], { default: '0', step: 'options' });

/**
 * Ряд диаметров круглых КПУ. 100 в распознанном каталоге нет, но в бланке
 * E06-2002, принятом заводом, стоит «КПУ-1Н-О-Н-100-2*ф-МV24-…» — значит,
 * диаметр 100 завод делает. Остальное сверить со стр. 66–71
 */
export const ROUND_SERIES = [100, 125, 140, 150, 160, 180, 200, 225, 250, 280, 315, 355, 400, 450, 500, 560, 630, 710, 800, 900, 1000];

// ── Правила, общие для КПУ-подобных ─────────────────────────────────────────

const inn = (param: string, values: string[]): Cond => ({ param, in: values });

export function fireRules(p: { drives: ParamValue[]; page: string; exExecs?: string[] }): Rule[] {
  const em = codesOf(p.drives, (x) => x.facts?.actuator === 'electromagnet');
  const thermal = codesOf(p.drives, (x) => !!x.facts?.thermal);
  const ex = codesOf(p.drives, (x) => x.facts?.ex === true);
  const theftOk = codesOf(p.drives, (x) => /^(МН|МВ|MV)/.test(x.code));
  const exExecs = p.exExecs ?? EX_EXECS;
  const src = p.page;
  const rules: Rule[] = [
    { id: 'place-wall', when: inn('type', ['1*ф']), then: { allow: { param: 'placement', values: ['ВН'] } }, message: 'У стенового клапана (1*ф) привод внутри — ВН', source: src },
    { id: 'place-duct', when: inn('type', ['2*ф']), then: { allow: { param: 'placement', values: ['СН'] } }, message: 'У канального клапана (2*ф) привод снаружи — СН', source: src },
    { id: 'frame-wall', when: inn('type', ['1*ф']), then: { forbid: { param: 'frame', values: ['МРП'] } }, message: 'Рама МРП — только для канального клапана', source: 'стр. 175' },
    { id: 'frame-duct', when: inn('type', ['2*ф']), then: { forbid: { param: 'frame', values: ['МРЗ'] } }, message: 'Рама МРЗ — только для стенового клапана', source: 'стр. 175' },
    { id: 'adapter-duct', when: { any: [{ param: 'adapterN', set: true }, inn('adapterX', ['1*000', '2*000'])] }, then: { allow: { param: 'type', values: ['2*ф'] } }, message: 'Переходник и исключение вылета — только у канального клапана', source: src },
  ];
  if (exExecs.length) {
    rules.push({ id: 'ex-duct', when: inn('exec', exExecs), then: { allow: { param: 'type', values: ['2*ф'] } }, message: 'Взрывозащищённое исполнение — только канальный клапан (2*ф)', source: src });
    if (ex.length) {
      rules.push({ id: 'ex-drive', when: inn('exec', exExecs), then: { allow: { param: 'drive', values: ex } }, message: 'Во взрывозащищённом исполнении — только взрывозащищённый привод ЭПВ', source: src });
      rules.push({ id: 'drive-ex', when: inn('drive', ex), then: { allow: { param: 'exec', values: exExecs } }, message: 'Привод ЭПВ ставится только на взрывозащищённое исполнение (В, ВК, ВМС, ВМСК)', source: src });
    }
  }
  if (em.length) rules.push({ id: 'em-exec', when: inn('drive', em), then: { allow: { param: 'exec', values: ['Н', 'К'] } }, message: 'Электромагнит — только в исполнениях Н и К', source: src });
  if (thermal.length) rules.push({ id: 'thermal-no', when: inn('drive', thermal), then: { allow: { param: 'purpose', values: ['О'] } }, message: 'Привод с ТРУ (-Т) — только у нормально открытого клапана', source: src });
  rules.push({ id: 'theft-drive', when: inn('theft', ['К', 'З']), then: { allow: { param: 'drive', values: theftOk } }, message: 'Защита от кражи — только для приводов МН и МВ', source: src });
  rules.push({ id: 'round-series', when: { shape: 'round' }, then: { range: { param: 'D', series: ROUND_SERIES } }, message: `Диаметр — из ряда ${ROUND_SERIES.join(', ')}`, source: src });
  rules.push({ id: 'round-duct', when: { shape: 'round' }, then: { allow: { param: 'type', values: ['2*ф'] } }, message: 'Круглый клапан — только канальный', source: src });
  return rules;
}

export const range = (id: string, param: 'W' | 'H' | 'D', when: Cond | undefined, min: number | undefined, max: number | undefined, message: string, source?: string): Rule =>
  ({ id, when, then: { range: { param, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) } }, message, source });

export const warnIf = (id: string, when: Cond, message: string, source?: string): Rule =>
  ({ id, when, then: { warn: message }, message, source });

// ── Воздушные клапаны: приводы LM/NM/SM… ────────────────────────────────────

/**
 * Ряд приводов воздушных клапанов (каталог «Воздушные клапаны», стр. 110):
 * LM 5 Нм, NM 10, SM 20, GM 40 — реверсивные; LF 5, NF 10, SF 20 — с
 * возвратной пружиной. Напряжение 24 или 230, суффикс -S / -S2 — один или два
 * концевых выключателя, -SR — управление 0(2)–10 В; в конце всегда -V.
 */
export function airDrives(opts: { manual?: boolean } = {}): ParamValue[] {
  const out: ParamValue[] = [];
  if (opts.manual !== false) out.push(v('РУЧКА', 'ручной (рукоятка)', 'manual handle', { actuator: 'manual', ex: false }));
  const bases: Array<[string, number, boolean]> = [
    ['LM', 5, false], ['NM', 10, false], ['SM', 20, false], ['GM', 40, false],
    ['LF', 5, true], ['NF', 10, true], ['SF', 20, true],
  ];
  for (const [base, nm, spring] of bases) {
    for (const volt of [24, 230]) {
      for (const suf of ['', '-S', '-S2', '-SR', '-SR-S2']) {
        if (spring && suf.startsWith('-SR')) continue;
        const code = `${base}${volt}${suf}-V`;
        const facts: Facts = {
          actuator: spring ? 'spring' : 'reversible',
          voltage: volt === 230 ? 220 : 24,
          ...(volt === 230 ? { current: 'AC' } : {}),
          torque: nm,
          modulating: suf.includes('SR'),
          limitSwitches: suf.includes('-S2') || suf === '-S',
        };
        const what = `${spring ? 'с пружиной' : 'реверсивный'} ${nm} Н·м, ${volt} В${suf.includes('SR') ? ', 0–10 В' : ''}${suf.includes('S2') ? ', 2 концевых' : suf === '-S' ? ', 1 концевой' : ''}`;
        out.push(v(code, what, `${spring ? 'spring return' : 'reversible'} ${nm} Nm, ${volt} V`, facts));
      }
    }
  }
  return out;
}

export const DRIVE_COUNT: ParamDef = {
  key: 'driveCount', label: t2('Приводов на клапан', 'Actuators per damper'), kind: 'number', default: 1, min: 1, step: 'drive',
};

export const DRIVE_EX = choice('driveEx', t2('Взрывозащищённая оболочка привода', 'Explosion-proof enclosure'), [
  v('', 'нет', 'no', { ex: false }),
  v('ЭПВ-', 'ЭПВ — в стальной оболочке', 'ЭПВ — steel enclosure', { ex: true }),
], { default: '', step: 'drive' });

export const DRIVE_EX_K = choice('driveExK', t2('Оболочка из нержавеющей стали', 'Stainless enclosure'), [
  v('', 'нет', 'no'),
  v('-К', 'да', 'yes', { stainless: true }),
], { default: '', step: 'drive' });

export const CLIMATE = choice('climate', t2('Климатическое исполнение', 'Climate'), [
  v('УХЛ2', 'УХЛ2', 'UHL2', { climate: 'УХЛ2' }),
  v('У3', 'У3', 'U3', { climate: 'У3' }),
  v('УХЛ1', 'УХЛ1', 'UHL1', { climate: 'УХЛ1' }),
  v('У2', 'У2', 'U2', { climate: 'У2' }),
], { default: 'УХЛ2', step: 'execution' });

export const THEFT_AIR = choice('theft', t2('Защита от кражи привода', 'Anti-theft'), [
  v('0', 'нет', 'none'),
  v('К', 'антивандальное исполнение', 'anti-removal design'),
], { default: '0', step: 'options' });

export const EXEC_AIR = choice('exec', t2('Исполнение', 'Execution'), [
  v('Н', 'общепромышленное', 'general industrial', { ex: false, stainless: false }),
  v('К', 'коррозионностойкое', 'corrosion resistant', { ex: false, stainless: true }),
  v('В', 'взрывозащищённое', 'explosion proof', { ex: true, stainless: false }),
  v('КВ', 'взрывозащищённое коррозионностойкое', 'explosion proof stainless', { ex: true, stainless: true }),
], { default: 'Н', step: 'execution' });

/** Позиция привода воздушного клапана: `1*NF230-S2-V`, `1*ЭПВ-SM24-S2-V`, `1*РУЧКА` */
export const DRIVE_AIR_POS = pos('drive', 'Привод', 'Actuator', '{driveCount}*{driveEx}{drive}{driveExK}');

export function airRules(drives: ParamValue[], src: string, exExecs = ['В', 'КВ', 'ВЦ']): Rule[] {
  const motor = codesOf(drives, (x) => x.code !== 'РУЧКА');
  return [
    { id: 'ex-enclosure', when: { param: 'exec', in: exExecs }, then: { allow: { param: 'driveEx', values: ['ЭПВ-'] } }, message: 'Во взрывозащищённом исполнении привод — в оболочке ЭПВ', source: src },
    { id: 'enclosure-motor', when: { param: 'driveEx', in: ['ЭПВ-'] }, then: { allow: { param: 'drive', values: motor } }, message: 'Оболочка ЭПВ — только для электропривода', source: src },
    { id: 'enclosure-k', when: { param: 'driveExK', in: ['-К'] }, then: { allow: { param: 'driveEx', values: ['ЭПВ-'] } }, message: 'Нержавеющая оболочка — только у взрывозащищённого привода', source: src },
  ];
}

// ── Характеристики для бланка ───────────────────────────────────────────────

export const spec = (key: string, ru: string, en: string, valueRu: string, valueEn?: string, unit?: string, cases?: SpecDefault['cases']): SpecDefault =>
  ({ key, label: t2(ru, en), value: t2(valueRu, valueEn), ...(unit ? { unit } : {}), ...(cases ? { cases } : {}) });

export const whenExec = (execs: string[]): Cond => ({ param: 'exec', in: execs });
