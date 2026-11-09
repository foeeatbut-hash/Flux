/**
 * Точность обмена с логикой: JSON по схеме договора, числа float64.
 *
 * Правила (решение владельца 7 ноября 2026):
 * - числа — float64; целое больше 2^53 − 1 передаётся СТРОКОЙ: иначе разные
 *   языки молча округлили бы его по-разному;
 * - NaN и бесконечность — ошибка проверки, а не «null» (JSON.stringify
 *   превращает их в null и скрывает сбой расчёта);
 * - проверка идёт по тексту: JSON.parse уже потерял бы лишние разряды.
 */
import { ComputeError, LIMITS } from './types';

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Обход значения перед отправкой: возвращает текст JSON или бросает ComputeError('NUMBER' | 'BAD_INPUT') */
export function encodeJson(value: unknown, maxBytes: number = LIMITS.inputBytes): string {
  const walk = (v: unknown, depth: number, path: string): void => {
    if (depth > LIMITS.jsonDepth) throw new ComputeError('BAD_INPUT', `глубже ${LIMITS.jsonDepth} уровней: ${path}`);
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new ComputeError('NUMBER', `NaN или бесконечность: ${path}`);
      // Как увидит получатель: от 1e21 JSON.stringify пишет экспоненту — это уже не целое, а float64
      if (!Number.isSafeInteger(v) && /^-?\d+$/.test(JSON.stringify(v))) throw new ComputeError('NUMBER', `целое больше 2^53 нужно передать строкой: ${path}`);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, depth + 1, `${path}[${i}]`)); return; }
    if (isPlain(v)) { for (const [k, x] of Object.entries(v)) walk(x, depth + 1, `${path}.${k}`); return; }
    throw new ComputeError('BAD_INPUT', `значение не JSON: ${path}`);
  };
  walk(value, 0, '$');
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ComputeError('BAD_INPUT', 'вход больше предела');
  return text;
}

/**
 * Разбор текста от логики. Числовые литералы проверяются в тексте: целое
 * больше 2^53 − 1 и число, переполняющее float64, — ошибка 'NUMBER'.
 */
export function parseJson(text: string, maxBytes: number = LIMITS.outputBytes): unknown {
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ComputeError('BAD_OUTPUT', 'результат больше предела');
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '[' || c === '{') {
      if (++depth > LIMITS.jsonDepth) throw new ComputeError('BAD_OUTPUT', `глубже ${LIMITS.jsonDepth} уровней`);
    } else if (c === ']' || c === '}') depth--;
    else if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i + 1;
      while (j < text.length && /[0-9eE+.\-]/.test(text[j])) j++;
      const token = text.slice(i, j);
      const n = Number(token);
      if (!Number.isFinite(n)) throw new ComputeError('NUMBER', `число вне float64: ${token.slice(0, 24)}`);
      if (/^-?\d+$/.test(token) && !Number.isSafeInteger(n)) throw new ComputeError('NUMBER', `целое больше 2^53 нужно передать строкой: ${token.slice(0, 24)}`);
      i = j - 1;
    }
  }
  try { return JSON.parse(text); } catch {
    // NaN, Infinity, обрезанный вывод — всё это не JSON; причина для разработчика одна
    throw new ComputeError('BAD_OUTPUT', 'результат не JSON');
  }
}

/**
 * Выход логики по схеме договора `ModuleOutput`: ровно `state` и `calc.out`,
 * оба — объекты. Лишние поля не показываются и не сохраняются (как и в
 * modules/runtime/output.ts для TypeScript).
 */
export function parseComputeOutput(text: string): { state: Record<string, unknown>; calc: { out: Record<string, unknown> } } {
  const value = parseJson(text) as any;
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!object(value) || Object.keys(value).some(k => k !== 'state' && k !== 'calc')
    || !object(value.state) || !object(value.calc) || Object.keys(value.calc).some(k => k !== 'out') || !object(value.calc.out)) {
    throw new ComputeError('BAD_OUTPUT', 'ожидалось {"state":{},"calc":{"out":{}}}');
  }
  return { state: value.state, calc: { out: value.calc.out } };
}
