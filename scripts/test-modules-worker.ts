import assert from 'node:assert/strict';
import { Worker as Thread } from 'node:worker_threads';
import { build } from 'esbuild';
import { createModuleWorker, MODULE_IDLE_PING_MS, MODULE_IDLE_TIMEOUT_MS, MODULE_WORKER_LEASE_MS } from '../modules/runtime/runner';
import { checkedOutput, MODULE_STATE_BYTES } from '../modules/runtime/output';

let complete = false;
process.on('exit', () => { if (!complete) process.exitCode = 1; });
let passed = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`✓ ${name}`); };
const sources = new Map<string, string>();
let terminated = 0;
const workers: RealWorker[] = [];
const OriginalBlob = globalThis.Blob;
const OriginalWorker = globalThis.Worker;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
class SourceBlob { constructor(public parts: string[]) {} }
class RealWorker {
  onmessage?: (event: { data: any }) => void;
  onerror?: () => void;
  thread: Thread;
  constructor(url: string) {
    workers.push(this);
    this.thread = new Thread(`
      const {parentPort} = require('node:worker_threads');
      globalThis.postMessage = value => parentPort.postMessage(value);
      parentPort.on('message', data => globalThis.onmessage({data}));
      // В браузере Worker и SharedWorker есть в любом Worker'е; здесь они подставные, чтобы проверить пролог
      globalThis.Worker = class {}; globalThis.SharedWorker = class {};
      ${sources.get(url)}
    `, { eval: true });
    this.thread.on('message', data => this.onmessage?.({ data }));
    this.thread.on('error', () => this.onerror?.());
  }
  postMessage(value: unknown) { this.thread.postMessage(value); }
  terminate() { terminated++; void this.thread.terminate(); }
}
async function source(logic: string) {
  return (await build({
    entryPoints: ['modules/runtime/worker.ts'], bundle: true, write: false, format: 'iife', platform: 'browser',
    plugins: [{ name: 'fixture-logic', setup(plugin) {
      plugin.onResolve({ filter: /^module-logic$/ }, () => ({ path: 'fixture', namespace: 'logic' }));
      plugin.onLoad({ filter: /.*/, namespace: 'logic' }, () => ({ contents: logic, loader: 'js' }));
    } }],
  })).outputFiles[0].text;
}
async function main() {
  globalThis.Blob = SourceBlob as any;
  globalThis.Worker = RealWorker as any;
  URL.createObjectURL = blob => {
    const id = `blob:${sources.size}`;
    sources.set(id, (blob as any).parts.join('')); return id;
  };
  URL.revokeObjectURL = () => {};
  const clients: Array<ReturnType<typeof createModuleWorker>> = [];
  const client = (text: string, onRestart?: (reason: string) => void) => {
    const value = createModuleWorker(text, { read: async () => null, onRestart }); clients.push(value); return value;
  };
  try {
    const once = client(await source('export function setup({state}) { state.count = (state.count||0)+1; }'));
    const before = terminated;
    const first = await once.run();
    check('Worker без подписчиков завершается после done', terminated === before + 1 && first.state.count === 1);
    check('новый setup восстанавливает снимок после завершения Worker', (await once.run()).state.count === 2);
    const limits = client(await source(`export function setup({state}) { state.big = 'я'.repeat(${MODULE_STATE_BYTES}); }`));
    await assert.rejects(limits.run(), /STATE_LIMIT/);
    check('слишком большой state останавливает расчёт', true);
    assert.throws(() => checkedOutput({ state: {}, calc: { out: { big: 'я'.repeat(MODULE_STATE_BYTES) } } }), /STATE_LIMIT/);
    check('выход calc не обходит предел снимка', true);

    // Настоящий поток, не имитация done: зависший timer блокирует и ping.
    const malicious = await source(`export function setup({flux}) {
      flux.on('changed', () => {});
      setInterval(() => { for (;;) {} }, 5);
    }`);
    const start = Date.now();
    let reason = '';
    let signal!: () => void;
    const stopped = new Promise<void>(resolve => { signal = resolve; });
    const bad = client(malicious, code => { reason = code; signal(); });
    await bad.run();
    const badThread = workers.at(-1)!.thread;
    const cutoff = setTimeout(signal, MODULE_IDLE_PING_MS + MODULE_IDLE_TIMEOUT_MS + 1800);
    await stopped;
    clearTimeout(cutoff);
    check('бесконечный setInterval в setup остановлен сторожем вне run', reason === 'BACKGROUND_TIMEOUT'
      && Date.now() - start < MODULE_IDLE_PING_MS + MODULE_IDLE_TIMEOUT_MS + 1800);
    await new Promise(resolve => setTimeout(resolve, 100));
    check('поток зависшего модуля действительно завершён', badThread.threadId === -1);
    const healthy = client(await source(`export function setup({flux,state}) {
      state.count ??= 0; flux.on('changed', () => { state.count++; });
    }`));
    await healthy.run();
    await new Promise(resolve => setTimeout(resolve, MODULE_IDLE_PING_MS + 200));
    check('отвечающий на ping Worker сохраняет подписки и состояние', (await healthy.run()).state.count === 2);
    let growthSignal!: () => void;
    const growthStopped = new Promise<void>(resolve => { growthSignal = resolve; });
    let growthReason = '';
    const growth = client(await source(`export function setup({flux,state}) {
      flux.on('changed', () => {});
      setTimeout(() => { state.big = 'я'.repeat(${MODULE_STATE_BYTES}); }, 5);
    }`), code => { growthReason = code; growthSignal(); });
    await growth.run();
    const growthCutoff = setTimeout(growthSignal, MODULE_IDLE_PING_MS + 2000);
    await growthStopped; clearTimeout(growthCutoff);
    check('рост state между событиями обнаруживается на ping', growthReason === 'STATE_LIMIT');
    const originalTimeout = globalThis.setTimeout;
    let recycledReason = '';
    let expireLease: (() => void) | undefined;
    const leaseSource = await source(`export function setup({flux,state,calc}) {
      globalThis.ownHeap = (globalThis.ownHeap||0)+1;
      state.starts = (state.starts||0)+1;
      flux.on('changed', () => { calc.out.heap = globalThis.ownHeap; });
    }`);
    let recycled!: ReturnType<typeof createModuleWorker>;
    try {
      // Виртуализируем только длинный срок жизни; Worker и его код настоящие.
      globalThis.setTimeout = ((fn: any, ms: number, ...args: any[]) => {
        if (ms === MODULE_WORKER_LEASE_MS) expireLease = () => fn(...args);
        return originalTimeout(fn, ms, ...args);
      }) as any;
      recycled = client(leaseSource, code => { recycledReason = code; });
      await recycled.run();
      assert.ok(expireLease, 'срок жизни должен быть назначен');
      expireLease();
    } finally { globalThis.setTimeout = originalTimeout; }
    const restored = await recycled.run();
    check('срок жизни очищает globalThis с восстановлением только state', recycledReason === 'WORKER_RECYCLED'
      && restored.state.starts === 2 && restored.calc.out.heap === 1);
    // Пролог убирает конструкторы Worker до кода модуля: вложенные потоки вне очереди и пределов не запустить
    const nested = client(await source(`export function setup({state}) {
      try { new Worker('x'); state.worker = 'created'; } catch (e) { state.worker = 'blocked'; }
      try { new SharedWorker('x'); state.shared = 'created'; } catch (e) { state.shared = 'blocked'; }
      try { globalThis.Worker = class {}; new globalThis.Worker('x'); state.restored = 'created'; } catch (e) { state.restored = 'blocked'; }
    }`));
    const probe = (await nested.run()).state;
    check('из Worker подпрограммы нельзя создать Worker, SharedWorker и вернуть конструктор', probe.worker === 'blocked' && probe.shared === 'blocked' && probe.restored === 'blocked');
    complete = true;
    console.log(`${passed} проверок пройдено`);
  } finally {
    clients.forEach(item => item.dispose());
    await Promise.all(workers.map(item => item.thread.terminate()));
    globalThis.Blob = OriginalBlob; globalThis.Worker = OriginalWorker;
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
