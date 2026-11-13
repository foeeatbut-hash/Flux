/**
 * Детерминизм расчёта логики на TypeScript: часы стоят, случайность идёт только от зерна входа, так что тот же вход
 * даёт тот же выход (как у Python и WebAssembly). Один код на два места: `compute` формы (worker.ts) и метод для других
 * программ (modules/compute/tsWorker.ts).
 */
export async function withDeterminism<T>(seed: unknown, run: () => Promise<T> | T): Promise<T> {
  const RealDate = Date, realRandom = Math.random, realNow = performance.now.bind(performance);
  let a = (Number(seed) | 0) >>> 0;
  Math.random = () => { a = (a + 0x9e3779b9) >>> 0; let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad); t ^= t >>> 15; t = Math.imul(t, 0x735a2d97); return ((t ^ (t >>> 15)) >>> 0) / 4294967296; };
  (globalThis as any).Date = class extends RealDate { constructor(...args: any[]) { if (args.length === 0) super(0); else super(...(args as [any])); } static now() { return 0; } };
  performance.now = () => 0;
  try { return await run(); }
  finally { Math.random = realRandom; (globalThis as any).Date = RealDate; performance.now = realNow; }
}
