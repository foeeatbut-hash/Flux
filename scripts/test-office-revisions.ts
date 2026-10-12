import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { claimOfficeDocument, makeRevisionRow, officeSha256 } from '../server/officeRevisions';
import { compareOfficeBindings, compareTextParts, officeTextParts } from '../server/routes/officeRevisions';

async function main() {
  const bytes = Buffer.from('issued office snapshot');
  const row = makeRevisionRow({ documentId: 'doc-a', fileId: 'file-a', revision: 1, status: 'ISSUED', data: bytes, sourceSha: 'source-a', userId: 'user-a' });
  bytes.fill(0);
  assert.equal(row.status, 'ISSUED');
  assert.equal(row.sha256, officeSha256(Buffer.from('issued office snapshot')));
  assert.equal(Buffer.from(row.data).toString(), 'issued office snapshot', 'saved snapshot owns a copy of the source bytes');
  assert.equal(row.createdById, 'user-a');
  assert.ok(row.createdAt instanceof Date);

  const file = { id: 'file-a', updatedAt: new Date('2026-10-12T00:00:00.000Z') };
  let claimArgs: any;
  const claimed = await claimOfficeDocument({ fileNode: { updateMany: async (args: any) => { claimArgs = args; return { count: 1 }; } } }, file);
  assert.equal(claimed, true);
  assert.deepEqual(claimArgs.where, { id: 'file-a', updatedAt: file.updatedAt, deletedAt: null });
  assert.ok(claimArgs.data.updatedAt.getTime() > file.updatedAt.getTime(), 'revision issue claims the exact file version');
  assert.equal(await claimOfficeDocument({ fileNode: { updateMany: async () => ({ count: 0 }) } }, file), false, 'stale document cannot be issued');

  const before = { rows: [
    { entityId: 'EQ-1', entityType: 'element', sourceId: 'equipment', sourceRevision: 'R15', values: { name: 'Fan A', power: 1.1 } },
    { entityId: 'EQ-2', entityType: 'element', sourceId: 'equipment', sourceRevision: 'R15', values: { name: 'Fan B' } },
  ] };
  const after = { rows: [
    { entityId: 'EQ-1', entityType: 'element', sourceId: 'equipment', sourceRevision: 'R16', values: { name: 'Fan A', power: 1.5 } },
    { entityId: 'EQ-3', entityType: 'element', sourceId: 'equipment', sourceRevision: 'R16', values: { name: 'Fan C' } },
  ] };
  const diff = compareOfficeBindings(before, after);
  assert.deepEqual(diff.added.map((item) => item.entityId), ['EQ-3']);
  assert.deepEqual(diff.removed.map((item) => item.entityId), ['EQ-2']);
  assert.deepEqual(diff.changed[0].fields, [{ anchorId: 'power', before: 1.1, after: 1.5 }]);
  assert.deepEqual(diff.changed[0].sourceRevision, { before: 'R15', after: 'R16' });

  const wordBefore = new JSZip().file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Existing text</w:t></w:r></w:p></w:body></w:document>');
  const wordAfter = new JSZip().file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Changed text</w:t></w:r></w:p></w:body></w:document>');
  const beforeText = await officeTextParts(await wordBefore.generateAsync({ type: 'nodebuffer' }));
  const afterText = await officeTextParts(await wordAfter.generateAsync({ type: 'nodebuffer' }));
  assert.deepEqual(compareTextParts(beforeText, afterText), { added: ['Changed text'], removed: ['Existing text'] }, 'comparison reports manual text edits');
  console.log('Office revision snapshot, CAS, row diff, and document text checks passed');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
