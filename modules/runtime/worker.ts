import * as logic from 'module-logic';
import type { ModuleApi, ReadData, Resource } from '../contract';
import type { ConnectCall } from '../connections/model';
import { checkedOutput } from './output';

let nextId = 0;
let initialized = false;
const listeners = new Set<() => void | Promise<void>>();
const pending = new Map<string, {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}>();
/** Короткие обёртки над одним сквозным вызовом: адрес и права проверяет главный процесс, здесь только форма вызова */
function connectApi(): ModuleApi['connect'] {
  const call = (connection: string, body: ConnectCall): Promise<any> => {
    const id = `connect-${++nextId}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      postMessage({ type: 'connect', id, connection, call: body });
    });
  };
  return {
    call,
    http: (connection, request) => call(connection, { op: 'http', ...request }),
    ws: {
      open: async (connection, path) => (await call(connection, { op: 'ws-open', path })).socket,
      send: async (connection, socket, data, encoding) => { await call(connection, { op: 'ws-send', socket, data, ...(encoding ? { encoding } : {}) }); },
      recv: (connection, socket, timeoutMs) => call(connection, { op: 'ws-recv', socket, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }),
      close: async (connection, socket) => { await call(connection, { op: 'ws-close', socket }); },
    },
    com: {
      open: async connection => (await call(connection, { op: 'com-open' })).handle,
      call: async (connection, handle, name, args) => (await call(connection, { op: 'com-call', handle, name, ...(args ? { args } : {}) })).value,
      get: async (connection, handle, name, args) => (await call(connection, { op: 'com-get', handle, name, ...(args ? { args } : {}) })).value,
      set: async (connection, handle, name, value, args) => { await call(connection, { op: 'com-set', handle, name, value, ...(args ? { args } : {}) }); },
      release: async (connection, handle) => { await call(connection, { op: 'com-release', handle }); },
    },
  };
}
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
  connect: connectApi(),
  log: {
    info: text => postMessage({ type: 'log', level: 'info', text: String(text).slice(0, 200) }),
    warn: text => postMessage({ type: 'log', level: 'warn', text: String(text).slice(0, 200) }),
    error: text => postMessage({ type: 'log', level: 'error', text: String(text).slice(0, 200) }),
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
  if (data?.type === 'read-result' || data?.type === 'connect-result') {
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
