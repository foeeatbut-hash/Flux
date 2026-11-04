import * as logic from 'module-logic';
import type { ModuleApi, ReadData, Resource } from '../contract';

let nextId = 0;
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const api: ModuleApi = {
  flux: { read<R extends Resource>(resource: R, entityId?: string): Promise<ReadData[R]> {
    const id = `read-${++nextId}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      postMessage({ type: 'read', id, resource, ...(entityId ? { entityId } : {}) });
    });
  } }, state: {}, calc: { out: {} },
};
onmessage = async ({ data }) => {
  if (data?.type === 'read-result') {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error)); else request.resolve(data.data);
  } else if (data?.type === 'run') {
    try {
      const handler = (logic as Record<string, unknown>)[data.handler];
      if (typeof handler !== 'function') throw new Error('Обработчик отсутствует');
      postMessage({ type: 'done', data: await handler(api) });
    } catch (_) { postMessage({ type: 'failed' }); }
  }
};
