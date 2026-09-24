/**
 * Правила каталога: что с чем сочетается.
 *
 * Одни и те же правила работают в трёх местах, и потому живут здесь, а не в
 * интерфейсе: мастер серит недопустимые коды и пишет причину, подбор отбрасывает
 * варианты, противоречащие каталогу, проверка ведомости сообщает об ошибке до
 * того, как бланк уйдёт заводу.
 */
import {
  type Cond, type Family, type Rule, type ValveValues, type ParamValue,
  factsOfConfig, shapeOf, num, withDefaults, paramOf,
} from './model';

export function evalCond(f: Family, c: Cond | undefined, values: ValveValues): boolean {
  if (!c) return true;
  if (c.all && !c.all.every((x) => evalCond(f, x, values))) return false;
  if (c.any && !c.any.some((x) => evalCond(f, x, values))) return false;
  if (c.not && evalCond(f, c.not, values)) return false;
  if (c.shape && shapeOf(values) !== c.shape) return false;
  if (c.fact !== undefined) {
    const facts = factsOfConfig(f, values);
    const v = facts[c.fact];
    if (c.eq !== undefined && v !== c.eq) return false;
    if (c.eq === undefined && !v) return false;
  }
  if (c.param !== undefined) {
    const v = values[c.param];
    const empty = v === undefined || v === '' || (typeof v === 'number' && !v);
    if (c.set === true && empty) return false;
    if (c.set === false && !empty) return false;
    if (c.in && (empty || !c.in.map(String).includes(String(v)))) return false;
    const n = num(v);
    if (c.gt !== undefined && !(n > c.gt)) return false;
    if (c.gte !== undefined && !(n >= c.gte)) return false;
    if (c.lt !== undefined && !(n < c.lt)) return false;
    if (c.lte !== undefined && !(n <= c.lte)) return false;
  }
  return true;
}

export interface Violation {
  ruleId: string;
  level: 'error' | 'warning';
  message: string;
  /** Какой параметр виноват — чтобы мастер показал ошибку у нужного шага */
  param?: string;
  source?: string;
}

/** Нарушено ли правило при этих значениях */
export function violationOf(f: Family, r: Rule, values: ValveValues): Violation | null {
  if (!evalCond(f, r.when, values)) return null;
  const t = r.then as any;
  const base = { ruleId: r.id, message: r.message, source: r.source };
  if (t.allow) {
    const v = values[t.allow.param];
    if (v === undefined || v === '') return null;
    return t.allow.values.includes(String(v)) ? null : { ...base, level: 'error', param: t.allow.param };
  }
  if (t.forbid) {
    const v = values[t.forbid.param];
    if (v === undefined) return null;
    return t.forbid.values.includes(String(v)) ? { ...base, level: 'error', param: t.forbid.param } : null;
  }
  if (t.range) {
    const { param, min, max, step, series } = t.range;
    const n = num(values[param]);
    if (!n) return null;
    if (min !== undefined && n < min) return { ...base, level: 'error', param };
    if (max !== undefined && n > max) return { ...base, level: 'error', param };
    if (series?.length && !series.includes(n)) return { ...base, level: 'error', param };
    if (step && min !== undefined && (n - min) % step !== 0) return { ...base, level: 'warning', param };
    return null;
  }
  if (t.require) {
    const v = values[t.require.param];
    return v === undefined || v === '' ? { ...base, level: 'error', param: t.require.param } : null;
  }
  if (t.warn) return { ...base, level: 'warning' };
  return null;
}

export function checkConfig(f: Family, rawValues: ValveValues): Violation[] {
  const values = withDefaults(f, rawValues);
  const out: Violation[] = [];
  for (const r of f.rules) {
    const v = violationOf(f, r, values);
    if (v) out.push(v);
  }
  // Размер обязателен всегда: без него обозначения нет
  const shape = shapeOf(values);
  if (!shape) out.push({ ruleId: 'size', level: 'error', message: 'Не задан размер', param: 'W' });
  else if (!f.shapes.includes(shape)) {
    out.push({
      ruleId: 'shape', level: 'error', param: shape === 'round' ? 'D' : 'W',
      message: shape === 'round' ? 'Семейство не бывает круглым' : 'Семейство не бывает прямоугольным',
    });
  } else if (shape === 'rect' && (!num(values.W) || !num(values.H))) {
    out.push({ ruleId: 'size', level: 'error', message: 'Нужны и ширина, и высота', param: num(values.W) ? 'H' : 'W' });
  }
  return out;
}

export interface OptionState {
  value: ParamValue;
  allowed: boolean;
  /** Почему нельзя — первое нарушенное правило */
  reason?: string;
}

/**
 * Какие коды параметра допустимы при остальных значениях.
 *
 * Код недопустим, если с ним появляется ошибка, которой без него не было.
 * Так правило, записанное один раз в любую сторону («ВН ⇔ стеновой»), серит
 * коды в обоих шагах мастера, и отдельно описывать обратную сторону не нужно.
 */
export function optionsFor(f: Family, key: string, rawValues: ValveValues): OptionState[] {
  const p = paramOf(f, key);
  if (!p?.values) return [];
  const values = withDefaults(f, rawValues);
  const without = { ...values };
  delete without[key];
  const baseErrors = new Set(f.rules.map((r) => violationOf(f, r, without)).filter((v) => v?.level === 'error').map((v) => v!.ruleId));
  return p.values.filter((v) => !v.deprecated || values[key] === v.code).map((v) => {
    const trial = { ...values, [key]: v.code };
    for (const r of f.rules) {
      const viol = violationOf(f, r, trial);
      if (viol?.level === 'error' && !baseErrors.has(r.id)) return { value: v, allowed: false, reason: viol.message };
    }
    return { value: v, allowed: true };
  });
}

/** Пределы размера при текущих значениях: пересечение всех сработавших правил */
export function sizeLimits(f: Family, rawValues: ValveValues): Record<'W' | 'H' | 'D', { min?: number; max?: number; step?: number; series?: number[] }> {
  const values = withDefaults(f, rawValues);
  const out: Record<string, { min?: number; max?: number; step?: number; series?: number[] }> = { W: {}, H: {}, D: {} };
  for (const r of f.rules) {
    const t = r.then as any;
    if (!t.range || !evalCond(f, r.when, values)) continue;
    const cur = out[t.range.param];
    if (t.range.min !== undefined) cur.min = Math.max(cur.min ?? -Infinity, t.range.min);
    if (t.range.max !== undefined) cur.max = Math.min(cur.max ?? Infinity, t.range.max);
    if (t.range.step) cur.step = t.range.step;
    if (t.range.series) cur.series = t.range.series;
  }
  return out as any;
}

/** Ближайший допустимый размер: из ряда или по шагу, в пределах */
export function nearestSize(limit: { min?: number; max?: number; step?: number; series?: number[] }, n: number): number {
  if (limit.series?.length) {
    const up = limit.series.filter((x) => x >= n).sort((a, b) => a - b)[0];
    return up ?? Math.max(...limit.series);
  }
  let v = n;
  if (limit.min !== undefined && v < limit.min) v = limit.min;
  if (limit.max !== undefined && v > limit.max) v = limit.max;
  if (limit.step && limit.min !== undefined) v = limit.min + Math.ceil((v - limit.min) / limit.step) * limit.step;
  return v;
}

/** Площадь проходного сечения по габариту, м² — для справки в бланке и сводке */
export function areaOf(values: ValveValues): number {
  const d = num(values.D);
  if (d) return Math.round((Math.PI * d * d) / 4 / 1e6 * 1000) / 1000;
  return Math.round((num(values.W) * num(values.H)) / 1e6 * 1000) / 1000;
}
