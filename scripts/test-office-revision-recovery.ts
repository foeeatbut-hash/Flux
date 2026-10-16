import assert from 'node:assert/strict';
import { OfficeRequestGeneration, previewWithRevisionRecovery, queryWithRevisionRecovery } from '../src/components/office/officeRevisionRecovery';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

void (async () => {
  const sent: Array<{ projectId: string; sourceRevision?: string }> = [];
  const recovered = await queryWithRevisionRecovery({ projectId: 'p1', sourceRevision: 'stale' }, async (query) => {
    sent.push(query);
    if (sent.length === 1) throw Object.assign(new Error('changed'), { status: 409 });
    return { revision: 'fresh', rows: [] };
  });
  assert.equal(recovered.refreshed, true);
  assert.equal(recovered.result.revision, 'fresh');
  assert.deepEqual(sent, [{ projectId: 'p1', sourceRevision: 'stale' }, { projectId: 'p1', sourceRevision: undefined }]);
  let attempts = 0;
  const noRevisionQuery: { projectId: string; sourceRevision?: string } = { projectId: 'p1' };
  await assert.rejects(queryWithRevisionRecovery(noRevisionQuery, async () => {
    attempts++;
    throw Object.assign(new Error('still changed'), { status: 409 });
  }), /still changed/);
  assert.equal(attempts, 2, 'повторный 409 возвращается вызывающему коду без циклов');

  const first = deferred<{ revision: string; rows: Array<{ entityId: string }> }>();
  const second = deferred<{ revision: string; rows: Array<{ entityId: string }> }>();
  const gate = new OfficeRequestGeneration();
  const oldRequest = gate.next();
  const pendingOld = first.promise.then((value) => gate.isCurrent(oldRequest) ? value : null);
  const currentRequest = gate.next(); // форма запроса или источник изменились до ответа
  const pendingCurrent = second.promise.then((value) => gate.isCurrent(currentRequest) ? value : null);
  second.resolve({ revision: 'new-source', rows: [{ entityId: 'new-row' }] });
  first.resolve({ revision: 'old-source', rows: [{ entityId: 'old-row' }] });
  assert.equal((await pendingCurrent)?.revision, 'new-source');
  assert.equal(await pendingOld, null, 'поздний ответ предыдущего запроса не применяется');

  const previewCalls: Array<{ revision: string; ids: string[] }> = [];
  const preview = await previewWithRevisionRecovery({
    sourceRevision: 'stale', selectedIds: ['kept', 'removed'],
    preview: async (revision, ids) => {
      previewCalls.push({ revision, ids });
      if (previewCalls.length === 1) throw Object.assign(new Error('changed'), { status: 409 });
      return { planId: 'new-plan' };
    },
    reload: async () => ({ revision: 'fresh', rows: [{ entityId: 'kept' }] }),
  });
  assert.deepEqual(previewCalls, [{ revision: 'stale', ids: ['kept', 'removed'] }, { revision: 'fresh', ids: ['kept'] }]);
  assert.equal(preview.plan?.planId, 'new-plan');
  assert.deepEqual(preview.refreshed?.selectedIds, ['kept']);

  let previewCount = 0;
  const noSelection = await previewWithRevisionRecovery({
    sourceRevision: 'stale', selectedIds: ['removed'],
    preview: async () => { previewCount++; throw Object.assign(new Error('changed'), { status: 409 }); },
    reload: async () => ({ revision: 'fresh', rows: [] }),
  });
  assert.equal(noSelection.plan, null, 'если выбранных строк больше нет, сотрудник выбирает строки заново');
  assert.equal(previewCount, 1, 'при пустом выборе повторный предпросмотр не запускается');
  console.log('Office revision recovery: повтор чтения, защита старого ответа и свежий предпросмотр проверены');
})().catch((error) => { console.error(error); process.exitCode = 1; });
