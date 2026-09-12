// Грамматика значений: онтология единиц с конверсией, устойчивый разбор чисел
// (запятая/точка, тысячи, диапазоны, кратность, допуск, «~/≈», «400/690»),
// и физическая самопроверка (для вентиляторов P ≈ Q·ΔP/η). Полностью офлайн и
// детерминированно. Ничего не меняет в значениях — только даёт число для проверки
// и предупреждения; правку оставляет пользователю.

// ── Онтология единиц: приведение к базовой (СИ-подобной) для сравнения ────────

export type Dimension =
  | 'flow' | 'pressure' | 'power' | 'apparentPower' | 'voltage' | 'current'
  | 'rpm' | 'temp' | 'duration' | 'mass' | 'length' | 'speed' | 'noise';

// unit (в нижнем регистре, без точек) → { dim, factor к базовой }
const UNIT_TABLE: Record<string, { dim: Dimension; f: number }> = {
  // расход (база: м³/с)
  'м3/ч': { dim: 'flow', f: 1 / 3600 }, 'м³/ч': { dim: 'flow', f: 1 / 3600 },
  'м3/час': { dim: 'flow', f: 1 / 3600 }, 'м³/час': { dim: 'flow', f: 1 / 3600 },
  'm3/h': { dim: 'flow', f: 1 / 3600 }, 'куб.м/ч': { dim: 'flow', f: 1 / 3600 },
  'тыс.м3/ч': { dim: 'flow', f: 1000 / 3600 }, 'тыс м3/ч': { dim: 'flow', f: 1000 / 3600 },
  'л/с': { dim: 'flow', f: 1 / 1000 }, 'l/s': { dim: 'flow', f: 1 / 1000 },
  'л/ч': { dim: 'flow', f: 1 / 3600000 }, 'м3/с': { dim: 'flow', f: 1 },
  // давление (база: Па)
  'па': { dim: 'pressure', f: 1 }, 'pa': { dim: 'pressure', f: 1 },
  'кпа': { dim: 'pressure', f: 1000 }, 'kpa': { dim: 'pressure', f: 1000 },
  'мм вод ст': { dim: 'pressure', f: 9.80665 }, 'мм в.ст': { dim: 'pressure', f: 9.80665 },
  'ммвс': { dim: 'pressure', f: 9.80665 }, 'кгс/м2': { dim: 'pressure', f: 9.80665 },
  'кгс/м²': { dim: 'pressure', f: 9.80665 }, 'бар': { dim: 'pressure', f: 100000 },
  // мощность (база: Вт)
  'вт': { dim: 'power', f: 1 }, 'w': { dim: 'power', f: 1 },
  'квт': { dim: 'power', f: 1000 }, 'kw': { dim: 'power', f: 1000 },
  'ккал/ч': { dim: 'power', f: 1.163 }, 'квт(т)': { dim: 'power', f: 1000 },
  // электрика
  'в': { dim: 'voltage', f: 1 }, 'v': { dim: 'voltage', f: 1 }, 'вольт': { dim: 'voltage', f: 1 },
  'а': { dim: 'current', f: 1 }, 'a': { dim: 'current', f: 1 },
  'об/мин': { dim: 'rpm', f: 1 }, 'об мин': { dim: 'rpm', f: 1 }, 'rpm': { dim: 'rpm', f: 1 },
  // полная мощность (база: ВА). Отдельно от активной намеренно: кВт и кВА
  // не взаимозаменяемы без коэффициента мощности, и складывать их нельзя
  'ва': { dim: 'apparentPower', f: 1 }, 'va': { dim: 'apparentPower', f: 1 },
  'ква': { dim: 'apparentPower', f: 1000 }, 'kva': { dim: 'apparentPower', f: 1000 },
  // температура (база: °C). Голая «с» отсюда убрана — см. AMBIGUOUS ниже
  '°c': { dim: 'temp', f: 1 }, '°с': { dim: 'temp', f: 1 }, 'град': { dim: 'temp', f: 1 },
  // длительность (база: с)
  'сек': { dim: 'duration', f: 1 }, 'сек.': { dim: 'duration', f: 1 }, 's': { dim: 'duration', f: 1 },
  'мин': { dim: 'duration', f: 60 }, 'min': { dim: 'duration', f: 60 },
  'ч': { dim: 'duration', f: 3600 }, 'час': { dim: 'duration', f: 3600 }, 'h': { dim: 'duration', f: 3600 },
  // масса (база: кг)
  'кг': { dim: 'mass', f: 1 }, 'г': { dim: 'mass', f: 0.001 }, 'т': { dim: 'mass', f: 1000 },
  // длина (база: м)
  'мм': { dim: 'length', f: 0.001 }, 'см': { dim: 'length', f: 0.01 }, 'м': { dim: 'length', f: 1 },
  // прочее
  'м/с': { dim: 'speed', f: 1 }, 'м/c': { dim: 'speed', f: 1 },
  'дб': { dim: 'noise', f: 1 }, 'дб(а)': { dim: 'noise', f: 1 }, 'дба': { dim: 'noise', f: 1 },
};

/**
 * Единицы, у которых нет одного смысла без контекста.
 *
 * «с» и «c» — это и градусы Цельсия, и секунды. В бланке ВЕРОСА написано
 * «нагрев 300 с», и таблица, где «с» означала температуру, превращала
 * длительность нагрева в 300 градусов — с высокой уверенностью, потому что
 * само число читалось прекрасно. Ошибка тихая: 300 — правдоподобная
 * температура для ТЭНа, и глазами её не поймать.
 *
 * Поэтому голая буква не решается таблицей. `unitInfo` для неё отвечает
 * «не знаю», а разрешает её только тот, кто знает ожидаемую размерность поля.
 */
const AMBIGUOUS: Record<string, Partial<Record<Dimension, number>>> = {
  'с': { temp: 1, duration: 1 },
  'c': { temp: 1, duration: 1 },
};

function unitKey(u: string): string {
  return (u || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

/** Единица → { dim, factor } или null, если не распознана или неоднозначна */
export function unitInfo(unit: string): { dim: Dimension; f: number } | null {
  const key = unitKey(unit);
  if (AMBIGUOUS[key]) return null;
  return UNIT_TABLE[key] || null;
}

/** Размерности, которые может означать единица. Пусто — не распознана. */
export function unitDimensions(unit: string): Dimension[] {
  const key = unitKey(unit);
  const many = AMBIGUOUS[key];
  if (many) return Object.keys(many) as Dimension[];
  const one = UNIT_TABLE[key];
  return one ? [one.dim] : [];
}

/**
 * Разрешить единицу, зная ожидаемую размерность поля.
 *
 * Это единственный законный способ прочитать «300 с»: поле «длительность
 * нагрева» ждёт duration и получает секунды, поле «температура» — градусы.
 * Если поле ждёт другую размерность, ответ `null` — и это отказ, а не повод
 * подставить ближайшее.
 */
export function unitInfoFor(unit: string, expected?: Dimension): { dim: Dimension; f: number } | null {
  const key = unitKey(unit);
  const many = AMBIGUOUS[key];
  if (many) {
    if (expected && many[expected] !== undefined) return { dim: expected, f: many[expected]! };
    return null;
  }
  const one = UNIT_TABLE[key];
  if (!one) return null;
  if (expected && one.dim !== expected) return null;
  return one;
}

/**
 * Перевести значение из одной единицы в другую.
 *
 * Разные размерности не переводятся — возвращается `null`, и это ошибка
 * подготовки выгрузки, а не повод выписать число как есть. Именно так в
 * столбце «Расход воздуха, м³/ч» оказывались рядом 3600 и 1: второе было
 * в м³/с, и никто его не пересчитал.
 */
export function convert(value: number, from: string, to: string): number | null {
  const a = unitInfo(from);
  const b = unitInfo(to);
  if (!a || !b || a.dim !== b.dim || !Number.isFinite(value)) return null;
  return (value * a.f) / b.f;
}

/** Приводит число+единицу к базовой размерности; null, если единица не из онтологии */
export function toBase(value: number, unit: string): { dim: Dimension; base: number } | null {
  const info = unitInfo(unit);
  if (!info || isNaN(value)) return null;
  return { dim: info.dim, base: value * info.f };
}

// ── Устойчивый разбор чисел ───────────────────────────────────────────────────

export interface NumericParse {
  ok: boolean;
  /** Представительное число для проверок (диапазон→середина, кратность→произведение) */
  value: number;
  kind: 'single' | 'range' | 'multiplier' | 'tolerance' | 'list' | 'none';
  approx?: boolean;
}

const NONE: NumericParse = { ok: false, value: NaN, kind: 'none' };

// «5 000,5» / «42 860» / «42'860» → 5000.5 / 42860 / 42860
function toNum(s: string): number {
  let t = s.replace(/[’' \s]/g, '');   // разделители тысяч (пробел/апостроф)
  // Десятичная запятая: если есть и «,» и «.», последний из них — десятичный
  if (t.includes(',') && t.includes('.')) {
    if (t.lastIndexOf(',') > t.lastIndexOf('.')) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/,/g, '');
  } else {
    t = t.replace(',', '.');
  }
  const m = t.match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

/**
 * Разбирает значение любой типовой записи в число для проверок.
 * Оставляет исходную строку как есть — возвращает лишь представителя.
 */
export function parseNumericValue(raw: string): NumericParse {
  const s0 = (raw || '').trim();
  if (!s0) return NONE;
  const approx = /[~≈]|не менее|не более|около/i.test(s0);
  const thousands = /тыс/i.test(s0);         // \b не работает с кириллицей
  const s = s0.replace(/[~≈]/g, '').replace(/тыс\.?/gi, '').trim();

  // Допуск: 250±10 → 250
  let m = s.match(/^([-+]?[\d'’.,\s]+)\s*±/);
  if (m) { const v = toNum(m[1]); return finite(v, 'tolerance', approx); }

  // Диапазон: 5000…8000 / 5000-8000 / 5000—8000 (но не «-5» как минус и не код)
  m = s.match(/^([\d'’.,\s]+)\s*(?:\.\.\.|…|—|–|-|÷)\s*([\d'’.,\s]+)$/);
  if (m) {
    const a = toNum(m[1]), b = toNum(m[2]);
    if (isFinite(a) && isFinite(b)) return finite((a + b) / 2, 'range', approx);
  }

  // Кратность: 2×5,5 / 2x5.5 → произведение (напр. суммарная мощность)
  m = s.match(/^(\d+)\s*[x×х*]\s*([\d'’.,]+)/i);
  if (m) {
    const a = toNum(m[1]), b = toNum(m[2]);
    if (isFinite(a) && isFinite(b)) return finite(a * b, 'multiplier', approx);
  }

  // Список через «/»: 400/690 → первый (обычно номинал)
  m = s.match(/^([\d'’.,\s]+)\s*\/\s*([\d'’.,]+)/);
  if (m) { const v = toNum(m[1]); if (isFinite(v)) return finite(v, 'list', approx); }

  // Одиночное число
  let v = toNum(s);
  if (thousands && isFinite(v)) v *= 1000;
  return finite(v, 'single', approx);
}

function finite(v: number, kind: NumericParse['kind'], approx: boolean): NumericParse {
  return isFinite(v) ? { ok: true, value: v, kind, approx } : NONE;
}

// ── Физическая самопроверка ──────────────────────────────────────────────────

export interface FieldValue { fieldId: string; value: string; unit?: string; }

/**
 * Для вентиляторов: аэродинамическая мощность N = Q·ΔP; потребляемая с КПД
 * лежит в разумном коридоре. Грубая проверка (широкие границы) — ловит
 * порядковые ошибки OCR/мис-мэппинга, не давая ложных тревог.
 * Возвращает предупреждение или null.
 */
export function crossCheckFan(fields: FieldValue[]): string | null {
  const get = (id: string) => fields.find(f => f.fieldId === id);
  const q = get('airflow'), p = get('pressure'), n = get('power');
  if (!q || !p || !n) return null;

  const qb = toBase(parseNumericValue(q.value).value, q.unit || 'м³/ч');   // → м³/с
  const pb = toBase(parseNumericValue(p.value).value, p.unit || 'па');     // → Па
  const nb = toBase(parseNumericValue(n.value).value, n.unit || 'квт');    // → Вт
  if (!qb || !pb || !nb || qb.dim !== 'flow' || pb.dim !== 'pressure' || nb.dim !== 'power') return null;
  if (qb.base <= 0 || pb.base <= 0 || nb.base <= 0) return null;

  const aero = qb.base * pb.base;              // Вт, идеальная (без КПД)
  const shaftMin = aero / 0.85;               // при высоком КПД
  const shaftMax = aero / 0.25;               // при низком КПД + запас двигателя
  // Разрешаем широкий коридор ×0.5…×3, чтобы не ловить нормальные конфигурации
  if (nb.base < shaftMin * 0.5 || nb.base > shaftMax * 3) {
    const kw = (aero / 0.6 / 1000);
    return `Проверьте расход/давление/мощность: по расходу ${Math.round(qb.base * 3600)} м³/ч и давлению ${Math.round(pb.base)} Па ожидаемая мощность ~${kw.toFixed(kw < 10 ? 1 : 0)} кВт, а указана ${(nb.base / 1000).toFixed(nb.base < 10000 ? 2 : 0)} кВт.`;
  }
  return null;
}

/**
 * Проверка числового значения на правдоподобие в диапазоне поля.
 * range задан в «естественной» единице поля (primaryUnit); если значение в другой
 * единице той же размерности — приводим. Возвращает true, если значение подозрительно.
 */
export function isImplausible(value: string, unit: string | undefined, range: [number, number], primaryUnit?: string): boolean {
  const np = parseNumericValue(value);
  if (!np.ok) return false; // не число — не наша забота
  let v = np.value;
  // Приведение к единице диапазона, если единицы разной кратности одной размерности
  if (unit && primaryUnit) {
    const from = unitInfo(unit), to = unitInfo(primaryUnit);
    if (from && to && from.dim === to.dim) v = (v * from.f) / to.f;
  }
  return v < range[0] || v > range[1];
}
