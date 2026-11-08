/**
 * Контрольные примеры: «вход → ожидаемый выход с допуском».
 *
 * Лежат в пакете (`examples/controls.json`), поэтому входят в подпись выпуска:
 * владелец подписывает и код, и то, с чем его сверяют. Studio прогоняет их
 * перед выпуском; Flux — при первом запуске выпуска на этом компьютере
 * (электрон/moduleControls.ts) и ловит расхождения именно этого компьютера:
 * другая сборка движка, чужая библиотека, нестандартный процессор.
 *
 * Сравнение: числа — с допуском (абсолютным и/или относительным), остальное —
 * точно. Ключи в ожидаемом выходе, которых нет в полученном, — расхождение;
 * лишние ключи в полученном — тоже: «вернул больше» значит другой договор.
 */
import { LIMITS } from './types';

export interface Tolerance { abs?: number; rel?: number }
export interface ControlCase { name: string; input: unknown; expect: unknown; tolerance?: Tolerance }
export interface Controls { version: 1; cases: ControlCase[] }
export interface ControlFailure { name: string; path: string; expected: unknown; actual: unknown }
export interface ControlsReport { ok: boolean; passed: number; failures: ControlFailure[] }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const tol = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** Строгий разбор файла; строка с причиной вместо исключения — ею владелец видит, что не так */
export function parseControls(text: string): Controls | string {
  if (new TextEncoder().encode(text).byteLength > LIMITS.controlsFileBytes) return 'Контрольные примеры больше 64 КиБ';
  let value: unknown;
  try { value = JSON.parse(text); } catch { return 'Контрольные примеры: не JSON'; }
  if (!isObject(value) || value.v !== undefined || value.version !== 1 || Object.keys(value).length !== 2 || !Array.isArray(value.cases)) {
    return 'Контрольные примеры: ожидается {"version":1,"cases":[…]}';
  }
  if (value.cases.length < 1 || value.cases.length > LIMITS.controlCases) return `Контрольных примеров должно быть от 1 до ${LIMITS.controlCases}`;
  const names = new Set<string>();
  for (const c of value.cases) {
    if (!isObject(c) || typeof c.name !== 'string' || !c.name || c.name.length > 80 || names.has(c.name)
      || !('input' in c) || !('expect' in c) || Object.keys(c).some(k => !['name', 'input', 'expect', 'tolerance'].includes(k))) {
      return 'Контрольный пример: нужны уникальные name, input, expect';
    }
    names.add(c.name);
    const t = c.tolerance;
    if (t !== undefined && (!isObject(t) || Object.keys(t).some(k => k !== 'abs' && k !== 'rel')
      || (t.abs !== undefined && !tol(t.abs)) || (t.rel !== undefined && !tol(t.rel)))) return `Допуск примера «${c.name}»: abs и rel — числа от 0 до 1`;
  }
  return value as unknown as Controls;
}

function compare(expected: unknown, actual: unknown, t: Tolerance, path: string, out: Array<{ path: string; expected: unknown; actual: unknown }>) {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const diff = Math.abs(expected - actual);
    // Без допуска числа равны только точно: «одинаковый результат» на всех языках — по умолчанию побитовый
    if (!(diff <= (t.abs ?? 0) || diff <= (t.rel ?? 0) * Math.abs(expected))) out.push({ path, expected, actual });
  } else if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) out.push({ path: `${path}.length`, expected: expected.length, actual: actual.length });
    else expected.forEach((x, i) => compare(x, actual[i], t, `${path}[${i}]`, out));
  } else if (isObject(expected) && isObject(actual)) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (!(key in actual)) out.push({ path: `${path}.${key}`, expected: expected[key], actual: undefined });
      else if (!(key in expected)) out.push({ path: `${path}.${key}`, expected: undefined, actual: actual[key] });
      else compare(expected[key], actual[key], t, `${path}.${key}`, out);
    }
  } else if (expected !== actual) out.push({ path, expected, actual });
}

export function compareWithTolerance(expected: unknown, actual: unknown, tolerance: Tolerance = {}) {
  const out: Array<{ path: string; expected: unknown; actual: unknown }> = [];
  compare(expected, actual, tolerance, '$', out);
  return out;
}

/**
 * Прогон набора. `run` — тот же путь, каким идёт настоящий расчёт (мост,
 * пределы, проверка выхода): иначе набор проверял бы не то, что работает.
 * Ошибка расчёта — расхождение примера, а не падение прогона.
 */
export async function runControls(controls: Controls, run: (input: unknown) => Promise<unknown>): Promise<ControlsReport> {
  const failures: ControlFailure[] = [];
  let passed = 0;
  for (const c of controls.cases) {
    let actual: unknown;
    try { actual = await run(c.input); } catch (e: any) {
      failures.push({ name: c.name, path: '$', expected: c.expect, actual: `ошибка ${e?.code || e?.message || 'расчёта'}` });
      continue;
    }
    const diffs = compareWithTolerance(c.expect, actual, c.tolerance);
    if (diffs.length) failures.push(...diffs.slice(0, 3).map(d => ({ name: c.name, ...d })));
    else passed++;
  }
  return { ok: failures.length === 0, passed, failures };
}
