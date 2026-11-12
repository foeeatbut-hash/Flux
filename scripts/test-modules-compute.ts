/**
 * Оркестратор расчётов окна (этап 3а, шаг 4): ошибки и счётчики сбоев,
 * проверка выхода до показа, выгрузка по простою без опроса, контрольные
 * примеры. Движки подставные — настоящие проверяются в других наборах.
 *
 * Запуск: npx tsx scripts/test-modules-compute.ts
 */
import assert from 'node:assert/strict';
import { ModuleCompute, type ComputeDeps } from '../src/services/moduleCompute';
import { ComputeScheduler } from '../modules/engine/scheduler';
import { ComputeError } from '../modules/engine/types';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; };
const enc = (s: string) => new TextEncoder().encode(s);
const good = '{"state":{},"calc":{"out":{"x":1}}}';
const target = { moduleId: 'm', version: '1.0.0', language: 'wasm' as const };
const pyTarget = { moduleId: 'p', version: '1.0.0', language: 'python' as const };

function setup(over: { wasm?: () => Promise<string>; py?: () => Promise<string>; controls?: string } = {}) {
  const failures: string[] = [], timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  let unloaded = 0, stopped = 0, pyLoaded = false, workers = 0;
  const deps: ComputeDeps = {
    scheduler: new ComputeScheduler({ slots: 2, laneLimits: { python: 1 } }),
    wasm: { get workers() { return workers; }, stopAll() { stopped++; workers = 0; }, keepOnly() {},
      async run() { workers = 1; return { output: await (over.wasm ? over.wasm() : Promise.resolve(good)), from: 'cache' as const }; } },
    python: { get loaded() { return pyLoaded; }, unload() { unloaded++; pyLoaded = false; },
      async run() { pyLoaded = true; return { output: await (over.py ? over.py() : Promise.resolve(good)), bootMs: 0 }; } },
    fetchFile: async (_id, file) => enc(file === 'controls.json' ? over.controls ?? JSON.stringify({ version: 1, cases: [{ name: 'a', input: { v: 1 }, expect: { state: {}, calc: { out: { x: 1 } } } }] }) : 'x'),
    sha256: async () => 'f'.repeat(64),
    pythonIdleMinutes: () => 5,
    onFailure: (id, version, kind) => failures.push(`${id}@${version}:${kind}`),
    setTimer: (fn, ms) => { const t = { fn: () => { t.live = false; fn(); }, ms, live: true }; timers.push(t); return t; },
    clearTimer: h => { (h as any).live = false; },
  };
  return { c: new ModuleCompute(deps), failures, timers, get unloaded() { return unloaded; }, get stopped() { return stopped; } };
}
const code = async (p: Promise<unknown>) => p.then(() => '', e => (e as ComputeError).code);

async function main() {
  console.log('Результат проверяется до показа');
  {
    const t = setup();
    ok('обычный расчёт', (await t.c.compute(target, { v: 1 }, 'active')).calc.out.x === 1);
    ok('NaN на входе отклонён до очереди', await code(t.c.compute(target, { a: NaN }, 'active')) === 'NUMBER');
    ok('целое > 2^53 на входе отклонено', await code(t.c.compute(target, { a: 2 ** 60 }, 'active')) === 'NUMBER');
    for (const [name, out, expect] of [
      ['не JSON', 'oops', 'BAD_OUTPUT'], ['не по схеме договора', '{"x":1}', 'BAD_OUTPUT'], ['целое > 2^53 в выходе', '{"state":{},"calc":{"out":{"x":9007199254740993}}}', 'NUMBER'],
      ['переполнение float64', '{"state":{},"calc":{"out":{"x":1e999}}}', 'NUMBER'], ['больше 256 КиБ', `{"state":{},"calc":{"out":{"x":"${'a'.repeat(300000)}"}}}`, 'BAD_OUTPUT'],
    ] as const) {
      const s = setup({ wasm: async () => out });
      ok(`выход «${name}» отклонён`, await code(s.c.compute(target, { v: 1 }, 'active')) === expect);
      ok(`  и записан как сбой`, s.failures.length === 1 && s.failures[0] === 'm@1.0.0:crash');
    }
  }
  console.log('Сбои попадают в счётчики видом, а не текстом');
  {
    const t = setup({ wasm: async () => { throw new ComputeError('TIMEOUT', 'секретные данные проекта'); } });
    await code(t.c.compute(target, {}, 'active'));
    const m = setup({ py: async () => { throw new ComputeError('MEMORY'); } });
    await code(m.c.compute(pyTarget, {}, 'active'));
    const b = setup({ wasm: async () => { throw new ComputeError('BUSY'); } });
    await code(b.c.compute(target, {}, 'active'));
    ok('время → timeout, память → memory, занятость — не сбой', t.failures[0] === 'm@1.0.0:timeout' && m.failures[0] === 'p@1.0.0:memory' && b.failures.length === 0);
    ok('в событие не попадает текст ошибки', !t.failures.join().includes('секрет'));
    const next = setup();
    ok('после сбоя другой расчёт идёт', (await code(t.c.compute(target, {}, 'active'))) === 'TIMEOUT' && (await next.c.compute(target, {}, 'active')).calc.out.x === 1);
  }
  console.log('Простой: выгрузка одним отложенным вызовом, без опроса');
  {
    const t = setup();
    ok('до первого расчёта таймеров нет', t.timers.length === 0);
    await t.c.compute(pyTarget, { v: 1 }, 'active');
    ok('после Python стоит один таймер на 5 минут', t.timers.filter(x => x.live).length === 1 && t.timers.at(-1)!.ms === 5 * 60_000);
    await t.c.compute(pyTarget, { v: 1 }, 'active');
    ok('новый вызов переставляет таймер, а не копит их', t.timers.filter(x => x.live).length === 1);
    t.timers.at(-1)!.fn();
    ok('по истечении среда Python выгружена', t.unloaded === 1);
    ok('и таймеров не осталось', t.timers.filter(x => x.live).length === 0);
    await t.c.compute(target, { v: 1 }, 'active');
    const wasm = t.timers.filter(x => x.live);
    ok('Worker WebAssembly тоже выгружается по простою', wasm.length === 1 && (wasm[0].fn(), t.stopped === 1));
  }
  console.log('Контрольные примеры при первом запуске');
  {
    const t = setup();
    const r = await t.c.controls(target);
    ok('сошлись — события нет', r.ok && t.failures.length === 0);
    const bad = setup({ wasm: async () => '{"state":{},"calc":{"out":{"x":2}}}' });
    const rb = await bad.c.controls(target);
    ok('не сошлись — отчёт и ровно одно событие «controls»', !rb.ok && JSON.stringify(bad.failures) === '["m@1.0.0:controls"]');
    const slow = setup({ wasm: async () => { throw new ComputeError('TIMEOUT'); } });
    const rs = await slow.c.controls(target);
    ok('ошибка расчёта в наборе — не расхождение: событие «controls» не пишется, итог «повторить»', !rs.ok && !rs.mismatch && slow.failures.length === 0);
    const broken = setup({ controls: '{"version":1,"cases":[]}' });
    ok('повреждённый набор — отказ CONTROLS', await code(broken.c.controls(target)) === 'CONTROLS');
  }
  console.log('Устаревшие выпуски и закрытая программа');
  {
    const kept: string[][] = [];
    let fetches = 0, release!: () => void;
    const hold = new Promise<void>(r => { release = r; });
    const t = setup({ wasm: () => hold.then(() => good) });
    const deps = (t.c as any).deps;
    deps.fetchFile = async () => { fetches++; return enc('x'); };
    deps.sha256 = async (b: Uint8Array) => `fp-${fetches}`;
    deps.wasm.keepOnly = (f: string[]) => kept.push(f);
    const other = { moduleId: 'o', version: '2.0.0', language: 'wasm' as const };
    const first = t.c.compute(target, { v: 1 }, 'active'), second = t.c.compute(other, { v: 1 }, 'active');
    await new Promise(r => setTimeout(r, 5));
    release(); await Promise.all([first, second]);
    await t.c.retain(new Set(['m@1.0.0']));
    ok('в кэше компиляции остаётся только живой выпуск', kept.length === 1 && kept[0].length === 1);
    await t.c.compute(other, { v: 1 }, 'active');
    ok('источник ушедшего выпуска забыт: файл читается заново', fetches === 3);
    // Закрытая программа не оставляет расчёты в очереди
    const busy = setup({ wasm: () => new Promise<string>(() => {}) });
    (busy.c as any).deps.scheduler = new ComputeScheduler({ slots: 1 });
    const running = busy.c.compute(target, { v: 1 }, 'active').catch(() => '');
    const queued = code(busy.c.compute({ ...target, moduleId: 'closing' }, { v: 1 }, 'active'));
    await new Promise(r => setTimeout(r, 5));
    busy.c.cancel('closing');
    ok('ожидающий расчёт закрытой программы снят с очереди (DENIED)', await Promise.race([queued, new Promise(r => setTimeout(() => r('висит'), 100))]) === 'DENIED');
    void running;
  }

  console.log('Закрытие окна');
  {
    const t = setup();
    t.c.dispose();
    ok('после закрытия расчёты отклоняются', await code(t.c.compute(target, {}, 'active')) === 'DENIED');
  }
  console.log(`Оркестратор расчётов: проверок ${passed}`);
}
main().catch(e => { console.error('✗', e); process.exit(1); });
