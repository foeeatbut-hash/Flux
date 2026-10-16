/**
 * Проектные журналы привязок и независимость импорта от их ошибок.
 * Запуск: npx tsx scripts/test-equipment-document-binding-ledger.ts
 */
import {
  cleanupEquipmentDocumentBindingLedger,
  readEquipmentDocumentBindingLedger,
  upsertEquipmentDocumentBindingInTransaction,
} from '../server/routes/equipmentDocumentBindings';
import { importDraftTransactionOptions } from '../server/routes/equipmentDraft';
import { draftDocumentBindingTargets, importWithBestEffortBinding } from '../equipment/documentBindings';

let failed = 0;
const ok = (name: string, condition: boolean, detail?: unknown) => condition
  ? console.log('  ✓', name)
  : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail)));

type Row = { id: string; key: string; userId: string; value: string };
function mockPrisma(seed: Row[] = []) {
  const rows = [...seed];
  return {
    rows,
    appSetting: {
      findFirst: async ({ where }: any) => rows.find(row => Object.entries(where).every(([key, value]) => (row as any)[key] === value)) || null,
      create: async ({ data }: any) => {
        if (rows.some(row => row.key === data.key && row.userId === data.userId)) throw new Error('unique');
        const row = { id: `setting-${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const row = rows.find(item => Object.entries(where).every(([key, value]) => (item as any)[key] === value));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      deleteMany: async ({ where }: any) => {
        const matching = rows.filter(row => Object.entries(where).every(([key, value]) => (row as any)[key] === value));
        for (const row of matching) rows.splice(rows.indexOf(row), 1);
        return { count: matching.length };
      },
    },
  } as any;
}
const ledger = (revision: number, bindings: any[] = []) => JSON.stringify({ revision, bindings, undo: [] });
const binding = (projectId: string, id: string) => ({
  id, projectId, kind: 'document', equipmentIds: [], fileName: `${id}.pdf`,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});
const input = (id: string) => ({ id, kind: 'document' as const, equipmentIds: [], fileName: `${id}.pdf` });

async function main() {
  const legacy = mockPrisma([{
    id: 'legacy', key: 'equipment_document_bindings:shared:v1', userId: '__shared__',
    value: ledger(7, [binding('project-a', 'a-old'), binding('project-b', 'b-old')]),
  }]);
  const a0 = await readEquipmentDocumentBindingLedger(legacy, 'project-a');
  const b0 = await readEquipmentDocumentBindingLedger(legacy, 'project-b');
  ok('legacy shared ledger migrates only each project’s bindings', a0.bindings.length === 1 && a0.bindings[0].id === 'a-old'
    && b0.bindings.length === 1 && b0.bindings[0].id === 'b-old');
  const a1 = await upsertEquipmentDocumentBindingInTransaction(legacy, 'project-a', input('a-new'), a0.revision);
  const b1 = await upsertEquipmentDocumentBindingInTransaction(legacy, 'project-b', input('b-new'), b0.revision);
  ok('project revisions advance independently from the same legacy revision', a1.ledger.revision === 8 && b1.ledger.revision === 8);
  await cleanupEquipmentDocumentBindingLedger(legacy, 'project-a');
  const bAfterDelete = await readEquipmentDocumentBindingLedger(legacy, 'project-b');
  const old = legacy.rows.find((row: Row) => row.key === 'equipment_document_bindings:shared:v1');
  ok('deleting a project cleans its scoped and legacy rows only', !legacy.rows.some((row: Row) => row.key.includes('project:v2:project-a'))
    && bAfterDelete.bindings.length === 2 && JSON.parse(old!.value).bindings.every((row: any) => row.projectId !== 'project-a'));

  const crowded = Array.from({ length: 450 }, (_, i) => ({
    ...binding('crowded-project', `crowded-${i}`),
    fileName: 'x'.repeat(255), tag: 't'.repeat(120), systemId: 's'.repeat(256),
    latestRevision: { revision: 'r'.repeat(120), sha256: 'a'.repeat(64), updatedAt: '2026-01-01T00:00:00.000Z' },
  }));
  const isolated = mockPrisma([{
    id: 'crowded-ledger', key: 'equipment_document_bindings:project:v2:crowded-project',
    userId: '__shared__', value: ledger(3, crowded),
  }]);
  let overflowStatus = 0;
  try { await upsertEquipmentDocumentBindingInTransaction(isolated, 'crowded-project', input('too-large'), 3); }
  catch (error: any) { overflowStatus = error.status; }
  const other = await upsertEquipmentDocumentBindingInTransaction(isolated, 'other-project', input('other-ok'), 0);
  ok('one project’s active-byte overflow returns 413 without blocking another project', overflowStatus === 413
    && other.ledger.bindings.length === 1 && other.ledger.revision === 1);

  const importedIds = Array.from({ length: 650 }, (_, i) => `component-${i}`);
  const targets = draftDocumentBindingTargets({ systemIds: ['system-root'], equipmentIds: importedIds });
  let importCommitted = false;
  const importFlow = await importWithBestEffortBinding(
    async () => { importCommitted = true; return { associations: { systemIds: ['system-root'], equipmentIds: importedIds } }; },
    async summary => {
      const compact = draftDocumentBindingTargets(summary.associations);
      if (!importCommitted || compact.equipmentIds.length !== 0 || compact.systemId !== 'system-root') throw new Error('root binding was not compacted');
      return { bindingId: 'saved' };
    },
    (summary, saved) => Object.assign(summary, { bindingId: saved.bindingId }),
  );
  ok('650 component IDs import and bind through the installation root only', (importFlow.summary as any).bindingId === 'saved'
    && importFlow.bindingWarning === null && targets.equipmentIds.length === 0 && targets.systemId === 'system-root');

  let persisted = false;
  const failedBinding = await importWithBestEffortBinding(
    async () => { persisted = true; return { batchId: 'committed' }; },
    async () => { throw Object.assign(new Error('ledger full'), { status: 413 }); },
    () => undefined,
  );
  ok('binding failure returns warning while committed import remains successful', persisted
    && failedBinding.summary.batchId === 'committed' && failedBinding.bindingWarning === 'ledger full');

  const sqlite = importDraftTransactionOptions({ _engineConfig: { activeProvider: 'sqlite' } });
  const postgres = importDraftTransactionOptions({ _engineConfig: { activeProvider: 'postgresql' } });
  ok('large draft data transactions use 30s and Serializable outside SQLite', sqlite.timeout === 30_000
    && sqlite.isolationLevel === undefined && postgres.timeout === 30_000 && postgres.isolationLevel === 'Serializable');
}

main().then(() => {
  if (failed) process.exit(1);
  console.log('Все проверки журнала привязок импорта прошли.');
});
