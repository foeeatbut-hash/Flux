import * as logic from 'module-logic';
import type { ModuleApi, ReadData, Resource } from '../contract';
import { checkedOutput } from './output';

let nextId = 0;
let initialized = false;
const listeners = new Set<() => void | Promise<void>>();
const pending = new Map<string, {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}>();
const api: ModuleApi = {
  flux: {
    read<R extends Resource>(resource: R, entityId?: string): Promise<ReadData[R]> {
      const id = `read-${++nextId}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        postMessage({ type: 'read', id, resource, ...(entityId ? { entityId } : {}) });
      });
    },
    on(event, listener) {
      if (event !== 'changed') throw new Error('UNKNOWN_EVENT');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
  state: {},
  calc: { out: {} },
};

/**
 * Единый вызов для всех языков (modules/engine): `compute(input) -> output`, JSON туда и обратно.
 * На время расчёта часы стоят, а случайность идёт только от зерна: тот же вход даёт тот же выход.
 */
async function computeOnce(data: { id?: string; input: string; seed?: number }) {
  const RealDate = Date, realRandom = Math.random, realNow = performance.now.bind(performance);
  let a = (Number(data.seed) | 0) >>> 0;
  Math.random = () => { a = (a + 0x9e3779b9) >>> 0; let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad); t ^= t >>> 15; t = Math.imul(t, 0x735a2d97); return ((t ^ (t >>> 15)) >>> 0) / 4294967296; };
  (globalThis as any).Date = class extends RealDate { constructor(...args: any[]) { if (args.length === 0) super(0); else super(...(args as [any])); } static now() { return 0; } };
  performance.now = () => 0;
  try {
    const compute = (logic as Record<string, unknown>).compute;
    if (typeof compute !== 'function') throw new Error('HANDLER_MISSING');
    const output = await compute(JSON.parse(data.input));
    postMessage({ type: 'computed', id: data.id, output: JSON.stringify(output) });
  } catch (error) {
    postMessage({ type: 'failed', id: data.id, code: 'WORKER_FAILED' });
  } finally { Math.random = realRandom; (globalThis as any).Date = RealDate; performance.now = realNow; }
}

onmessage = async ({ data }) => {
  if (data?.type === 'compute') { await computeOnce(data); return; }
  if (data?.type === 'ping') {
    try {
      checkedOutput({ state: api.state, calc: api.calc });
      postMessage({ type: 'pong', id: data.id });
    } catch (_) { postMessage({ type: 'failed', code: 'STATE_LIMIT' }); }
    return;
  }
  if (data?.type === 'read-result') {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.data);
    return;
  }
  if (data?.type !== 'run') return;
  try {
    const handlers = logic as Record<string, unknown>;
    if (!initialized) {
      // Состояние живёт в окне модуля; после отмены занятого Worker оно
      // восстанавливается из последнего законченного, а не частичного расчёта.
      Object.assign(api.state, data.initial?.state || {});
      api.calc.out = data.initial?.calc?.out || {};
      if (typeof handlers.setup === 'function') await handlers.setup(api);
      initialized = true;
    }
    if (data.handler) {
      const handler = handlers[data.handler];
      if (typeof handler !== 'function') throw new Error('HANDLER_MISSING');
      await handler(api);
    }
    for (const listener of [...listeners]) await listener();
    // Возврат обработчика не становится данными Flux: наружу выходят только
    // собственное состояние и результаты, указанные в договоре API модуля.
    const output = checkedOutput({ state: api.state, calc: api.calc });
    postMessage({ type: 'done', data: output, listeners: listeners.size });
  } catch (error) {
    postMessage({ type: 'failed', code: error instanceof Error && error.message === 'STATE_LIMIT' ? 'STATE_LIMIT' : 'WORKER_FAILED' });
  }
};
