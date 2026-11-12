/**
 * Очередь расчётов (этап 3а, шаг 4): ядра − 1 (не больше 4), открытое окно
 * раньше фонового, предел очереди, простой без таймеров.
 *
 * Запуск: npx tsx scripts/test-modules-scheduler.ts
 */
import assert from 'node:assert/strict';
import { ComputeScheduler, MAX_PER_KEY, MAX_QUEUE, slotsFor } from '../modules/engine/scheduler';
import { ComputeError } from '../modules/engine/types';
import { SerialLane } from '../modules/engine/serial';
import { PythonEnvironment, type PyodideApi } from '../modules/engine/python';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const gate = () => { let open!: () => void; const wait = new Promise<void>(r => { open = r; }); return { wait, open }; };
const timers = () => process.getActiveResourcesInfo().filter(x => x === 'Timeout').length;

async function main() {
  console.log('Сколько расчётов разом');
  ok('на 1 и 2 ядрах — один', slotsFor(1) === 1 && slotsFor(2) === 1);
  ok('ядра − 1', slotsFor(4) === 3 && slotsFor(3) === 2);
  ok('но не больше 4', slotsFor(8) === 4 && slotsFor(64) === 4);
  ok('нелепые значения не ломают', slotsFor(0) === 1 && slotsFor(NaN) === 1 && slotsFor(-3) === 1);

  {
    const s = new ComputeScheduler({ slots: 3 });
    let now = 0, peak = 0;
    const task = async () => { now++; peak = Math.max(peak, now); await sleep(5); now--; return 1; };
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.run('active', `m${i % 5}`, task)));
    ok('одновременно идёт не больше слотов, всё выполнено', peak === 3 && s.stats.running === 0 && s.stats.queued === 0);
  }

  console.log('Открытое окно уступать не должно');
  {
    const s = new ComputeScheduler({ slots: 2 });
    const g = gate(); const order: string[] = [];
    const slow = (name: string) => async () => { order.push(name); await g.wait; };
    const a = s.run('active', 'a', slow('a1')), b = s.run('active', 'b', slow('a2'));
    const c = s.run('background', 'c', slow('bg1')), d = s.run('active', 'd', slow('a3'));
    await sleep(5);
    ok('идут два открытых, остальные ждут', JSON.stringify(order) === '["a1","a2"]' && s.stats.queued === 2);
    g.open();
    await Promise.all([a, b, c, d]);
    ok('освободившийся слот получает открытое окно, хотя фоновый пришёл раньше', order.indexOf('a3') < order.indexOf('bg1'));
  }
  {
    const s = new ComputeScheduler({ slots: 3 });
    const g = gate(); let backgroundNow = 0, backgroundPeak = 0;
    const bg = async () => { backgroundNow++; backgroundPeak = Math.max(backgroundPeak, backgroundNow); await g.wait; backgroundNow--; };
    const all = Array.from({ length: 6 }, (_, i) => s.run('background', `bg${i}`, bg));
    await sleep(5);
    ok('фоновые занимают не больше слотов − 1', backgroundPeak === 2 && s.stats.running === 2 && s.stats.queued === 4);
    let activeStarted = false;
    const act = s.run('active', 'ui', async () => { activeStarted = true; });
    await sleep(5);
    ok('открытому окну слот остался свободным: оно стартует сразу', activeStarted);
    g.open();
    await Promise.all([...all, act]);
  }
  {
    const s = new ComputeScheduler({ slots: 1 });
    const g = gate(); const order: string[] = [];
    const p1 = s.run('background', 'x', async () => { order.push('bg1'); await g.wait; });
    const p2 = s.run('background', 'y', async () => { order.push('bg2'); });
    const p3 = s.run('active', 'z', async () => { order.push('act'); });
    g.open();
    await Promise.all([p1, p2, p3]);
    ok('при одном слоте активный обгоняет ожидающий фоновый', JSON.stringify(order) === '["bg1","act","bg2"]');
  }
  {
    let idleCalls = 0;
    const s = new ComputeScheduler({ slots: 2, waitIdle: async () => { idleCalls++; } });
    await s.run('background', 'a', async () => 1); await s.run('active', 'a', async () => 1);
    ok('фоновый расчёт ждёт свободного окна, открытый — нет', idleCalls === 1);
  }

  console.log('Полоса Python: одна среда на все программы');
  {
    const s = new ComputeScheduler({ slots: 3, laneLimits: { python: 1 } });
    const g = gate(); let py = 0, pyPeak = 0, other = 0;
    const python = async () => { py++; pyPeak = Math.max(pyPeak, py); await g.wait; py--; };
    const all = [1, 2, 3].map(i => s.run('active', `py${i}`, python, 'python'));
    const wasm = s.run('active', 'w', async () => { other++; });
    await sleep(5);
    ok('Python идёт по одному, остальные слоты свободны для WebAssembly', py === 1 && other === 1 && s.stats.running === 1 && s.stats.queued === 2);
    g.open();
    await Promise.all([...all, wasm]);
    ok('все Python-расчёты выполнены, пик — один', pyPeak === 1 && s.stats.running === 0);
  }

  console.log('Python: два расчёта в одной среде никогда не идут одновременно');
  {
    const lane = new SerialLane();
    let inside = 0, peak = 0; const order: string[] = [];
    const job = (name: string, ms: number, fail = false) => lane.run(async () => {
      inside++; peak = Math.max(peak, inside); order.push(`+${name}`);
      await sleep(ms); inside--; order.push(`-${name}`);
      if (fail) throw new ComputeError('TIMEOUT');
    }).catch(e => (e as ComputeError).code);
    const results = await Promise.all([job('a', 30, true), job('b', 5), job('c', 5), job('d', 1)]);
    ok('никогда не больше одной задачи внутри, порядок прихода сохранён', peak === 1 && order.join(' ') === '+a -a +b -b +c -c +d -d');
    ok('остановка по времени первой не пропускает вторую вперёд и не ломает цепочку', results[0] === 'TIMEOUT' && results.slice(1).every(r => r === undefined) && lane.pending === 0);

    // Среда с настоящими точками await (загрузка пакета): без обёртки расчёт B вклинился бы в расчёт A
    const events: string[] = [];
    const fake: PyodideApi = {
      runPython: () => undefined,
      loadPackage: async () => { await sleep(20); },
      globals: { get: (name: string) => name === 'flux_call' ? (key: string) => { events.push(`call ${key}`); return '{"state":{},"calc":{"out":{}}}'; } : () => undefined },
    };
    const env = new PythonEnvironment(fake);
    const withNumpy = 'import numpy\ndef compute(i):\n    return {}\n', plain = 'def compute(i):\n    return {}\n';
    const wait: number[] = []; const started = Date.now();
    await Promise.all([env.run('A', withNumpy, '{}').then(() => events.push('done A')), env.run('B', plain, '{}').then(() => { wait.push(Date.now() - started); events.push('done B'); })]);
    ok('расчёт B начинается только после полного окончания A, включая загрузку пакета', events.join(' | ') === 'call A | done A | call B | done B' && env.queued === 0);
  }

  console.log('Пределы очереди');
  {
    const s = new ComputeScheduler({ slots: 1 });
    const g = gate();
    const held = Array.from({ length: MAX_PER_KEY }, () => s.run('active', 'hog', () => g.wait));
    const over = await s.run('active', 'hog', async () => 1).then(() => '', e => (e as ComputeError).code);
    ok(`одна программа не держит больше ${MAX_PER_KEY} расчётов`, over === 'BUSY');
    ok('другая программа при этом принимается', typeof (await Promise.race([s.run('active', 'other', async () => 'ok').then(() => 'done'), sleep(20).then(() => 'wait')])) === 'string');
    g.open(); await Promise.all(held);
    const s2 = new ComputeScheduler({ slots: 1 });
    const g2 = gate();
    const many = Array.from({ length: MAX_QUEUE + 2 }, (_, i) => s2.run('active', `k${i}`, () => g2.wait).then(() => 'done', e => (e as ComputeError).code));
    await sleep(5);
    ok('в очереди ждут ровно MAX_QUEUE расчётов (ещё один идёт)', s2.stats.queued === MAX_QUEUE && s2.stats.running === 1);
    g2.open();
    const results = await Promise.all(many);
    ok('лишний расчёт получает BUSY, остальные выполнены', results.filter(r => r === 'BUSY').length === 1 && results.filter(r => r === 'done').length === MAX_QUEUE + 1);
  }
  {
    const s = new ComputeScheduler({ slots: 1 });
    const failed = await s.run('active', 'a', async () => { throw new ComputeError('CRASH'); }).catch(e => (e as ComputeError).code);
    const after = await s.run('active', 'a', async () => 'жив');
    ok('сбой расчёта освобождает слот, следующий идёт', failed === 'CRASH' && after === 'жив' && s.stats.running === 0);
    const g = gate();
    const running = s.run('active', 'gone', () => g.wait);
    const queued = s.run('active', 'gone', async () => 1).then(() => '', e => (e as ComputeError).code);
    await sleep(2);
    s.cancelQueued('gone');
    ok('закрытая программа снимает свои ожидающие расчёты, идущий не трогается', (await queued) === 'DENIED' && s.stats.running === 1);
    g.open(); await running;
    ok('учёт по программе обнуляется', s.stats.running === 0);
  }

  console.log('Простой');
  {
    const s = new ComputeScheduler({ slots: 2 });
    const before = timers();
    await Promise.all(Array.from({ length: 5 }, (_, i) => s.run(i % 2 ? 'background' : 'active', `m${i}`, async () => i)));
    await sleep(10);
    ok('после работы очередь не оставляет таймеров и не опрашивает', timers() === before && s.stats.running === 0 && s.stats.queued === 0);
  }

  console.log(`Очередь расчётов: проверок ${passed}`);
}
main().catch(e => { console.error('✗', e); process.exit(1); });
