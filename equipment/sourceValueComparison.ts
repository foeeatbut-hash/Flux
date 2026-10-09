export interface SourceValue {
  value: unknown;
  unit?: string;
}

type ComparableUnit = { dimension: string; factor: number; identity: string };

const NUMERIC_EPSILON = 1e-9;
const UNIT_ALIASES = new Map<string, ComparableUnit>();

function registerUnit(dimension: string, factor: number, aliases: string[]): void {
  for (const alias of aliases) {
    const key = normalizeUnitText(alias);
    UNIT_ALIASES.set(key, { dimension, factor, identity: `${dimension}:${factor}` });
  }
}

function normalizeUnitText(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').replace(/²/g, '2').replace(/³/g, '3');
}

registerUnit('length', 0.001, ['мм', 'мм.', 'mm', 'миллиметр', 'миллиметра', 'миллиметров']);
registerUnit('length', 0.01, ['см', 'cm', 'сантиметр', 'сантиметра', 'сантиметров']);
registerUnit('length', 1, ['м', 'm', 'метр', 'метра', 'метров']);
registerUnit('pressure', 1, ['Па', 'па', 'Pa', 'pa', 'паскаль', 'паскаля', 'паскалей']);
registerUnit('pressure', 1000, ['кПа', 'кпа', 'kPa', 'kpa', 'килопаскаль', 'килопаскаля', 'килопаскалей']);
registerUnit('power', 1, ['Вт', 'вт', 'W', 'w', 'ватт', 'ватта', 'ватт']);
registerUnit('power', 1000, ['кВт', 'квт', 'kW', 'kw', 'киловатт', 'киловатта', 'киловатт']);
registerUnit('volume-flow', 1 / 3600, [
  'м3/ч', 'м³/ч', 'м3/час', 'м³/час', 'куб.м/ч', 'куб.м/час',
  'm3/h', 'm³/h', 'кубометр/ч', 'кубометр/час',
]);
registerUnit('volume-flow', 1, [
  'м3/с', 'м³/с', 'м3/сек', 'м³/сек', 'куб.м/с', 'куб.м/сек',
  'm3/s', 'm³/s', 'm3/sec', 'm³/sec', 'кубометр/с', 'кубометр/сек',
]);
registerUnit('temperature-celsius', 1, ['°C', '°c', '°С', '°с', 'degC', 'degc', 'градC', 'градС']);
registerUnit('temperature-kelvin', 1, ['K', 'k', 'к', 'кельвин', 'кельвина', 'кельвинов']);

function unitOf(value: string | undefined): ComparableUnit | null {
  const normalized = normalizeUnitText(value || '');
  if (!normalized) return null;
  return UNIT_ALIASES.get(normalized) || {
    dimension: `exact:${normalized}`,
    factor: 1,
    identity: `exact:${normalized}`,
  };
}

/** Разбирает только число целиком, чтобы «IP54» и «230/400 В» не стали числом. */
function strictNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (!text) return null;
  const plain = /^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(text);
  const grouped = /^[+-]?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?$/.test(text);
  if (!plain && !grouped) return null;

  const number = Number(text.replace(/[ \u00a0\u202f]/g, '').replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function normalizedText(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
}

function sameUnitIdentity(a: ComparableUnit | null, b: ComparableUnit | null): boolean {
  return (a?.identity || '') === (b?.identity || '');
}

function near(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 || Math.abs(a - b) <= NUMERIC_EPSILON * scale;
}

/** Сравнивает исходные значения без потери размерности и без подстановки данных. */
export function sourceValuesEqual(a: SourceValue, b: SourceValue): boolean {
  const unitA = unitOf(a.unit);
  const unitB = unitOf(b.unit);

  if (a.value === undefined || a.value === null || b.value === undefined || b.value === null) {
    return Object.is(a.value, b.value) && sameUnitIdentity(unitA, unitB);
  }
  if (typeof a.value === 'string' && normalizedText(a.value) === '') {
    return typeof b.value === 'string' && normalizedText(b.value) === '' && sameUnitIdentity(unitA, unitB);
  }
  if (typeof b.value === 'string' && normalizedText(b.value) === '') return false;

  const numberA = strictNumber(a.value);
  const numberB = strictNumber(b.value);
  if (numberA !== null && numberB !== null) {
    if ((unitA === null) !== (unitB === null)) return false;
    if (unitA && unitB && unitA.dimension !== unitB.dimension) return false;
    return near(numberA * (unitA?.factor || 1), numberB * (unitB?.factor || 1));
  }

  if (typeof a.value === 'boolean' || typeof b.value === 'boolean') {
    return typeof a.value === 'boolean' && typeof b.value === 'boolean'
      && Object.is(a.value, b.value) && sameUnitIdentity(unitA, unitB);
  }
  if (typeof a.value !== 'string' || typeof b.value !== 'string') return false;
  return sameUnitIdentity(unitA, unitB) && normalizedText(a.value) === normalizedText(b.value);
}
