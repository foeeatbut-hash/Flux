import { AppError } from './context.js';

// Числовые параметры запроса, которые идут в `take`/`limit`.
//
// Number('1.5') и Number('1e9') — валидные числа, но Prisma принимает в take
// только целое: дробное падало ошибкой проверки и превращалось в 500. Здесь
// значение приводится к целому и зажимается в пределы.

/** Целое из параметра запроса: мусор и пусто → def, дробное усекается, итог в [min, max] */
export function intParam(value: unknown, def: number, min: number, max: number): number {
  const n = Math.trunc(Number(Array.isArray(value) ? value[0] : value));
  const v = Number.isFinite(n) && n !== 0 ? n : def;
  return Math.min(max, Math.max(min, v));
}

/**
 * Дата из тела запроса: пусто → null, нечитаемая → 400. `new Date('мусор')`
 * молча давала Invalid Date, которую Prisma отвергала ошибкой с текстом
 * запроса и кодом 500.
 */
export function dateParam(value: unknown, what = 'Дата'): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value as any);
  if (Number.isNaN(d.getTime())) throw new AppError(400, `${what}: некорректное значение`);
  return d;
}
