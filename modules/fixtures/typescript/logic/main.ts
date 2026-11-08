// Контрольный расчёт «статистика числовых параметров» на TypeScript для Flux.
// Тот же расчёт, что в C, C++, Rust, Go, C#, Python (см. modules/fixtures/c/src/main.c):
// сложение по порядку, один корень, число читает Number() после проверки записи.
interface Param { value?: unknown }
interface Input { flux?: { equipment?: { params?: Param[] } | null } }

// [+-]?(цифры[.цифры*]|.цифры)([eE][+-]?цифры)? — ровно то, что принимают все языки примера
const NUMBER = /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/;

export function compute(input: Input) {
  const params = input?.flux?.equipment?.params ?? [];
  let count = 0, sum = 0, sumsq = 0, min = 0, max = 0;
  for (const p of params) {
    const text = p?.value;
    if (typeof text !== 'string' || text.length === 0 || text.length >= 64 || !NUMBER.test(text)) continue;
    const v = Number(text);
    if (!Number.isFinite(v)) continue;
    if (count === 0) { min = v; max = v; }
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumsq += v * v;
    count++;
  }
  const mean = count ? sum / count : 0;
  const rms = count ? Math.sqrt(sumsq / count) : 0;
  if (!Number.isFinite(sum) || !Number.isFinite(mean) || !Number.isFinite(rms)) throw new Error('NUMBER');
  return { state: {}, calc: { out: { count, sum, mean, rms, min, max } } };
}
