import assert from 'node:assert/strict';
import { claimStagedOfficeTranslation, stageOfficeTranslation } from '../server/officeTranslationStaging.js';

const rows = new Map<string, { id: string; key: string; userId: string; value: string }>();
let failDelete = false;
function prismaView() {
  return {
    appSetting: {
      async findMany({ where, take }: any) {
        return [...rows.values()].filter(r => r.key.startsWith(where.key.startsWith) && r.userId === where.userId).slice(0, take);
      },
      async create({ data }: any) { if (rows.has(data.id)) throw new Error('duplicate'); rows.set(data.id, data); return data; },
      async findUnique({ where }: any) { return rows.get(where.id) || null; },
      async updateMany({ where, data }: any) {
        const row = rows.get(where.id);
        if (!row || row.value !== where.value) return { count: 0 };
        rows.set(where.id, { ...row, ...data }); return { count: 1 };
      },
      async deleteMany({ where }: any) {
        if (failDelete) throw new Error('simulated cleanup failure');
        const row = rows.get(where.id);
        if (!row || (where.value !== undefined && row.value !== where.value)) return { count: 0 };
        rows.delete(where.id); return { count: 1 };
      },
    },
  };
}

void (async () => {
  const delta = { records: [{ key: 'p:1', sourceId: 'p:1', destination: 'ru', revision: 'r1', time: 't1', source: 'hello', target: 'привет' }] } as any;
  const firstServer = prismaView();
  const secondServer = prismaView();
  const token = await stageOfficeTranslation(firstServer, { fileId: 'file-a', userId: 'user-a', baseSha: 'sha-a', delta });

  assert.equal(await claimStagedOfficeTranslation(secondServer, token, 'file-a', 'user-b', 'sha-a'), null, 'another actor cannot consume');
  assert.equal(await claimStagedOfficeTranslation(secondServer, token, 'file-a', 'user-a', 'sha-b'), null, 'changed base cannot consume');
  const claimed = await claimStagedOfficeTranslation(secondServer, token, 'file-a', 'user-a', 'sha-a');
  assert.ok(claimed, 'a second server instance can consume a shared durable stage');
  const competing = await claimStagedOfficeTranslation(firstServer, token, 'file-a', 'user-a', 'sha-a');
  assert.equal(competing, null, 'compare-and-swap prevents a concurrent second claim');
  await claimed!.finish(true);
  assert.equal(await claimStagedOfficeTranslation(firstServer, token, 'file-a', 'user-a', 'sha-a'), null, 'successful save consumes token exactly once');

  const cleanupToken = await stageOfficeTranslation(firstServer, { fileId: 'file-a', userId: 'user-a', baseSha: 'sha-a', delta });
  const cleanupClaim = await claimStagedOfficeTranslation(secondServer, cleanupToken, 'file-a', 'user-a', 'sha-a');
  assert.ok(cleanupClaim);
  failDelete = true;
  await assert.doesNotReject(() => cleanupClaim!.finish(true), 'token cleanup failure cannot turn a committed save into failure');
  failDelete = false;
  assert.equal(await claimStagedOfficeTranslation(firstServer, cleanupToken, 'file-a', 'user-a', 'sha-a'), null, 'failed cleanup leaves a non-replayable token');

  console.log('office translation staging: shared instances, actor/base guards, CAS claim, and one-use consumption passed');
})();
