import type { ModuleOutput } from '../contract';

interface WorkerOptions {
  timeoutMs?: number;
  read: (resource: string, entityId?: string) => Promise<unknown>;
  initial?: ModuleOutput;
}

export function createModuleWorker(source: string, options: WorkerOptions) {
  const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(blob);
  URL.revokeObjectURL(blob);
  let stopped = false;
  let firstRun = true;
  let active: {
    resolve: (value: ModuleOutput) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  function dispose(reason = 'CANCELLED') {
    if (stopped) return;
    stopped = true;
    const operation = active;
    active = null;
    if (operation) {
      clearTimeout(operation.timer);
      operation.reject(new Error(reason));
    }
    worker.terminate();
  }
  worker.onerror = () => dispose('WORKER_FAILED');
  worker.onmessage = async ({ data }) => {
    if (stopped || !active) return;
    const operation = active;
    if (data?.type === 'read' && typeof data.id === 'string') {
      try {
        const value = await options.read(data.resource, data.entityId);
        if (!stopped && active === operation) {
          worker.postMessage({ type: 'read-result', id: data.id, data: value });
        }
      } catch (_) {
        if (!stopped && active === operation) {
          worker.postMessage({ type: 'read-result', id: data.id, error: 'READ_FAILED' });
        }
      }
    } else if (data?.type === 'done') {
      clearTimeout(operation.timer);
      active = null;
      operation.resolve(data.data);
    } else if (data?.type === 'failed') {
      dispose('WORKER_FAILED');
    }
  };

  function run(handler?: string): Promise<ModuleOutput> {
    if (stopped) return Promise.reject(new Error('WORKER_STOPPED'));
    if (active) return Promise.reject(new Error('WORKER_BUSY'));
    return new Promise((resolve, reject) => {
      // Таймер находится вне исполняемого кода: бесконечный цикл не может
      // отложить terminate(). Квота CPU/памяти между событиями — задача PR 2.
      const timeout = Math.min(30_000, Math.max(20, options.timeoutMs ?? 30_000));
      const timer = setTimeout(() => dispose('TIMEOUT'), timeout);
      active = { resolve, reject, timer };
      worker.postMessage({
        type: 'run', handler,
        ...(firstRun ? { initial: options.initial } : {}),
      });
      firstRun = false;
    });
  }
  return { run, dispose, get busy() { return !!active; } };
}

export function runModuleWorker(source: string, handler: string, options: WorkerOptions) {
  const client = createModuleWorker(source, options);
  const result = client.run(handler).finally(() => client.dispose());
  return { result, cancel: () => client.dispose() };
}
