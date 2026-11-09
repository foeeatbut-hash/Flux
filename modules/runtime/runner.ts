import type { ModuleOutput } from '../contract';
import { checkedOutput } from './output';
import { WORKER_PROLOGUE } from './prologue';

export const MODULE_IDLE_PING_MS = 1000;
export const MODULE_IDLE_TIMEOUT_MS = 3000;
export const MODULE_WORKER_LEASE_MS = 60_000;
interface WorkerOptions {
  timeoutMs?: number;
  read: (resource: string, entityId?: string) => Promise<unknown>;
  initial?: ModuleOutput;
  onRestart?: (reason: string) => void;
}
export function createModuleWorker(source: string, options: WorkerOptions) {
  let worker: Worker | null = null;
  let disposed = false;
  let snapshot = checkedOutput(options.initial || { state: {}, calc: { out: {} } });
  let idle: ReturnType<typeof setTimeout> | undefined;
  let pong: ReturnType<typeof setTimeout> | undefined;
  let lease: ReturnType<typeof setTimeout> | undefined;
  let pingId = 0;
  let active: {
    resolve: (value: ModuleOutput) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  function clearIdle() { clearTimeout(idle); clearTimeout(pong); }
  function stop(reason: string, notify = false) {
    clearIdle(); clearTimeout(lease);
    const operation = active;
    active = null;
    if (operation) { clearTimeout(operation.timer); operation.reject(new Error(reason)); }
    worker?.terminate(); worker = null;
    if (notify && !operation) options.onRestart?.(reason);
  }
  function watchIdle() {
    clearIdle();
    const owner = worker;
    idle = setTimeout(() => {
      if (!owner || owner !== worker || active) return;
      const id = ++pingId;
      // Таймер живёт в iframe: зависший setInterval внутри Worker не может
      // отложить terminate(). До нового события неисправный код не запускается.
      pong = setTimeout(() => stop('BACKGROUND_TIMEOUT', true), MODULE_IDLE_TIMEOUT_MS);
      owner.postMessage({ type: 'ping', id });
    }, MODULE_IDLE_PING_MS);
  }
  function spawnWorker() {
    const blob = URL.createObjectURL(new Blob([WORKER_PROLOGUE, source], { type: 'text/javascript' }));
    const owner = new Worker(blob);
    URL.revokeObjectURL(blob);
    worker = owner;
    // Даже отвечающий на ping код периодически теряет globalThis. Это срок
    // жизни процесса, а не обещание жёсткой квоты heap в браузерном Worker.
    lease = setTimeout(() => stop('WORKER_RECYCLED', true), MODULE_WORKER_LEASE_MS);
    owner.onerror = () => { if (worker === owner) stop('WORKER_FAILED', true); };
    owner.onmessage = async ({ data }) => {
      if (worker !== owner) return;
      if (data?.type === 'pong' && !active && data.id === pingId) { watchIdle(); return; }
      if (data?.type === 'failed') { stop(data.code === 'STATE_LIMIT' ? 'STATE_LIMIT' : 'WORKER_FAILED', true); return; }
      const operation = active;
      if (!operation) return;
      if (data?.type === 'read' && typeof data.id === 'string') {
        try {
          const value = await options.read(data.resource, data.entityId);
          if (worker === owner && active === operation) owner.postMessage({ type: 'read-result', id: data.id, data: value });
        } catch (_) {
          if (worker === owner && active === operation) owner.postMessage({ type: 'read-result', id: data.id, error: 'READ_FAILED' });
        }
      } else if (data?.type === 'done') {
        try { snapshot = checkedOutput(data.data); }
        catch (_) { stop('STATE_LIMIT', true); return; }
        clearTimeout(operation.timer); active = null;
        // Без подписчиков сохранять процесс незачем; состояние остаётся
        // в ограниченном снимке и передаётся новому setup при следующем run.
        if (Number.isInteger(data.listeners) && data.listeners > 0) watchIdle();
        else stop('IDLE');
        operation.resolve(snapshot);
      }
    };
    return owner;
  }
  function run(handler?: string): Promise<ModuleOutput> {
    if (disposed) return Promise.reject(new Error('WORKER_STOPPED'));
    if (active) return Promise.reject(new Error('WORKER_BUSY'));
    clearIdle();
    const fresh = !worker;
    const owner = worker || spawnWorker();
    return new Promise((resolve, reject) => {
      const timeout = Math.min(30_000, Math.max(20, options.timeoutMs ?? 30_000));
      const timer = setTimeout(() => stop('TIMEOUT'), timeout);
      active = { resolve, reject, timer };
      owner.postMessage({ type: 'run', handler, ...(fresh ? { initial: snapshot } : {}) });
    });
  }
  return {
    run, get busy() { return !!active; },
    dispose(reason = 'CANCELLED') { disposed = true; stop(reason); },
  };
}
export function runModuleWorker(source: string, handler: string, options: WorkerOptions) {
  const client = createModuleWorker(source, options);
  return { result: client.run(handler).finally(() => client.dispose()), cancel: () => client.dispose() };
}
