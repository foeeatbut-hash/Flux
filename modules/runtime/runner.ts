export function runModuleWorker(source: string, handler: string, options: {
  timeoutMs?: number;
  read: (resource: string, entityId?: string) => Promise<unknown>;
}) {
  const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(blob);
  URL.revokeObjectURL(blob);
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  let rejectRun: (error: Error) => void;
  const stop = () => { stopped = true; clearTimeout(timer); worker.terminate(); };
  const result = new Promise<unknown>((resolve, reject) => {
    rejectRun = reject;
    timer = setTimeout(() => { stop(); reject(new Error('TIMEOUT')); }, Math.min(30_000, Math.max(20, options.timeoutMs ?? 30_000)));
    worker.onerror = () => { stop(); reject(new Error('WORKER_FAILED')); };
    worker.onmessage = async ({ data }) => {
      if (stopped) return;
      if (data?.type === 'read' && typeof data.id === 'string') {
        try {
          const value = await options.read(data.resource, data.entityId);
          if (!stopped) worker.postMessage({ type: 'read-result', id: data.id, data: value });
        } catch (_) {
          if (!stopped) worker.postMessage({ type: 'read-result', id: data.id, error: 'READ_FAILED' });
        }
      } else if (data?.type === 'done') { stop(); resolve(data.data); }
      else if (data?.type === 'failed') { stop(); reject(new Error('WORKER_FAILED')); }
    };
    worker.postMessage({ type: 'run', handler });
  });
  return { result, cancel: () => { if (!stopped) { stop(); rejectRun(new Error('CANCELLED')); } } };
}
