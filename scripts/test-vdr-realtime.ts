import assert from 'node:assert/strict';
import express from 'express';
import { registerVdrRoutes } from '../server/routes/vdr.ts';
import { setBroadcaster, setPrisma } from '../server/context.ts';

const events: Array<{ event: string; payload: any }> = [];
let failItemUpdate = false;
const register = { id: 'register-1', projectId: 'project-1', name: 'ВДР', revision: 'A', revisions: '[]', columnsConfig: '[]' };
const item = { id: 'item-1', projectId: 'project-1', registerId: 'register-1', status: 'DRAFT', extra: '{}' };

setBroadcaster((event, payload) => events.push({ event, payload }));
setPrisma({
  docStandard: {
    count: async () => 1,
    create: async ({ data }: any) => ({ id: 'standard-1', ...data }),
  },
  docRegister: {
    findUnique: async () => register,
    update: async ({ data }: any) => ({ ...register, ...data }),
  },
  docRegisterItem: {
    findUnique: async () => item,
    update: async ({ data }: any) => {
      if (failItemUpdate) throw new Error('write failed');
      return { ...item, ...data };
    },
  },
} as any);

const app = express();
registerVdrRoutes(app as any, { chunkBytes: async () => 1024 });

async function call(method: string, path: string, req: any = {}) {
  const layer = (app as any)._router.stack.find((entry: any) =>
    entry.route?.path === path && entry.route.methods[method.toLowerCase()]);
  assert.ok(layer, `route exists: ${method} ${path}`);
  const res: any = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; },
  };
  await layer.route.stack[0].handle({ params: {}, body: {}, authUser: null, ...req }, res);
  return res;
}

async function main() {
  const created = await call('post', '/api/vdr/standards', { body: { name: 'Стандарт' } });
  assert.equal(created.statusCode, 200);
  assert.deepEqual(events.splice(0), [{ event: 'vdr:changed', payload: {} }], 'global standard write notifies without project scope');

  const updated = await call('put', '/api/vdr/items/:id', {
    params: { id: item.id }, body: { titleRu: 'Изменённый документ' },
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(events.splice(0), [{
    event: 'vdr:changed', payload: { projectId: 'project-1', registerId: 'register-1' },
  }], 'item write includes its project and register');

  failItemUpdate = true;
  const failed = await call('put', '/api/vdr/items/:id', { params: { id: item.id }, body: { titleRu: 'Не записано' } });
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(events, [], 'failed write does not notify other windows');

  setBroadcaster(() => undefined);
  setPrisma(null);
  console.log('3 проверки пройдены, 0 провалено');
}

main().catch((error) => {
  setBroadcaster(() => undefined);
  setPrisma(null);
  console.error(error);
  process.exit(1);
});
