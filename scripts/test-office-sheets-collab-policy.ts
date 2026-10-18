import assert from 'node:assert/strict';
import { isLocalOnlyCollabMutation, mapDefinedNameScope, resolveDefinedNameMutation } from '../tools/genoffice/inject/sheets-collab-policy';

assert.equal(isLocalOnlyCollabMutation('formula.mutation.set-defined-name'), false);
assert.equal(isLocalOnlyCollabMutation('formula.mutation.remove-defined-name'), false);
assert.equal(isLocalOnlyCollabMutation('formula-ui.mutation.set-formula-bar'), true);
assert.equal(isLocalOnlyCollabMutation('formula.mutation.calculate'), true);
assert.equal(isLocalOnlyCollabMutation('sheet.mutation.set-range-values'), false);

const receiverNames = [
  { id: 'receiver-workbook-id', name: 'Итого', localSheetId: 'AllDefaultWorkbook' },
  { id: 'receiver-local-id', name: 'LocalTotal', localSheetId: 'receiver-sheet-id' },
];
const updated = resolveDefinedNameMutation('formula.mutation.set-defined-name', {
  id: 'sender-workbook-id', name: 'Итого', localSheetId: 'AllDefaultWorkbook', formulaOrRefString: "'Перечень'!$B$5",
}, receiverNames);
assert.equal(updated.ok, true);
if (updated.ok) assert.equal(updated.params.id, 'receiver-workbook-id');

const removed = resolveDefinedNameMutation('formula.mutation.remove-defined-name', {
  id: 'sender-workbook-id', name: 'Итого', localSheetId: 'AllDefaultWorkbook', formulaOrRefString: "'Перечень'!$B$4",
}, receiverNames);
assert.equal(removed.ok, true);
if (removed.ok) assert.equal(removed.params.id, 'receiver-workbook-id');

const created = resolveDefinedNameMutation('formula.mutation.set-defined-name', {
  id: 'sender-new-id', name: 'NewTotal', localSheetId: 'AllDefaultWorkbook', formulaOrRefString: "'Перечень'!$B$5",
}, []);
assert.equal(created.ok, true);
if (created.ok) {
  const afterCreate = [{ id: String(created.params.id), name: 'NewTotal', localSheetId: 'AllDefaultWorkbook' }];
  const repeatedSet = resolveDefinedNameMutation('formula.mutation.set-defined-name', {
    id: 'sender-new-id', name: 'NewTotal', localSheetId: 'AllDefaultWorkbook', formulaOrRefString: "'Перечень'!$B$5",
  }, afterCreate);
  assert.equal(repeatedSet.ok, true);
  if (repeatedSet.ok) assert.equal(repeatedSet.params.id, afterCreate[0]!.id);
  assert.equal(afterCreate.length, 1);

  const firstRemove = resolveDefinedNameMutation('formula.mutation.remove-defined-name', {
    id: 'sender-new-id', name: 'NewTotal', localSheetId: 'AllDefaultWorkbook',
  }, afterCreate);
  assert.equal(firstRemove.ok, true);
  const secondRemove = resolveDefinedNameMutation('formula.mutation.remove-defined-name', {
    id: 'sender-new-id', name: 'NewTotal', localSheetId: 'AllDefaultWorkbook',
  }, []);
  assert.deepEqual(secondRemove, { ok: false, reason: 'remove-target-missing' });
}

const missingRemove = resolveDefinedNameMutation('formula.mutation.remove-defined-name', {
  id: 'sender-local-id', name: 'LocalTotal', localSheetId: 'other-sheet-id',
}, receiverNames);
assert.deepEqual(missingRemove, { ok: false, reason: 'remove-target-missing' });

const localUpdate = resolveDefinedNameMutation('formula.mutation.set-defined-name', {
  id: 'sender-local-id', name: 'LocalTotal', localSheetId: 'receiver-sheet-id', formulaOrRefString: 'B2',
}, receiverNames);
assert.equal(localUpdate.ok, true);
if (localUpdate.ok) assert.equal(localUpdate.params.id, 'receiver-local-id');

const localSheetIds = new Map([['Перечень', 'receiver-sheet-id']]);
assert.equal(mapDefinedNameScope('sender-sheet-id', { 'sender-sheet-id': 'Перечень' }, localSheetIds), 'receiver-sheet-id');
assert.equal(mapDefinedNameScope('AllDefaultWorkbook', { 'sender-sheet-id': 'Перечень' }, localSheetIds), 'AllDefaultWorkbook');

assert.deepEqual(resolveDefinedNameMutation('formula.mutation.remove-defined-name', {
  id: 'sender-id', formulaOrRefString: 'A1',
}, receiverNames), { ok: false, reason: 'missing-name' });

console.log('Sheets collaboration command policy passed');
