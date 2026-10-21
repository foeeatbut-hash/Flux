import assert from 'node:assert/strict';
import { mapOfficeTemplateToTarget, officeTemplateFieldSelectionKey, seedEmptyOfficeTemplateTarget } from '../src/components/office/officeTemplateMapping';
import type { OfficeField } from '../src/components/office/fluxData';
import type { OfficeBinding, OfficeHeaderSchema } from '../src/lib/officeModel';

const fieldPart = (patch: Partial<OfficeBinding> = {}) => ({
  kind: 'field' as const,
  binding: { fieldKey: 'param:Паспорт|Расход', sourceId: 'equipment', entityType: 'element', entityId: null, sourceRevision: 'rev-old', anchorId: 'source-anchor', ...patch },
});

const template: OfficeHeaderSchema = { version: 1, anchors: [
  { id: 'source-anchor', kind: 'excel-range', sheetName: 'Лист1', address: 'B2', parts: [
    { kind: 'text', text: 'Расход: ' },
    fieldPart(),
    { kind: 'field', binding: { fieldKey: 'unknown.key', sourceId: 'equipment', entityType: 'element', entityId: null, sourceRevision: 'rev-old', anchorId: 'source-anchor' } },
    { kind: 'field', binding: { fieldKey: 'code', sourceId: 'foreign-source', entityType: 'element', entityId: null, sourceRevision: 'rev-old', anchorId: 'source-anchor' } },
  ] },
  { id: 'source-missing', kind: 'excel-range', sheetName: 'Лист1', address: 'Z99', parts: [{ kind: 'text', text: 'missing' }] },
] };
const target: OfficeHeaderSchema = { version: 1, anchors: [
  { id: 'target-anchor-uuid', kind: 'excel-range', sheetName: 'Лист1', address: 'B2', parts: [{ kind: 'text', text: 'target content' }] },
  { id: 'untouched-anchor-uuid', kind: 'excel-range', sheetName: 'Лист1', address: 'C2', parts: [{ kind: 'text', text: 'keep me' }] },
] };
const emptyTarget: OfficeHeaderSchema = { version: 1, anchors: [] };
let nextId = 0;
const seedTemplate: OfficeHeaderSchema = { version: 1, anchors: [{ ...template.anchors[0], parts: template.anchors[0]!.parts.slice(0, 2) }] };
const seeded = seedEmptyOfficeTemplateTarget(seedTemplate, emptyTarget, () => `fresh-${++nextId}`);
assert.deepEqual(seeded.anchors.map(({ id, sheetName, address, parts }) => ({ id, sheetName, address, parts })), [
  { id: 'fresh-1', sheetName: 'Лист1', address: 'B2', parts: [] },
]);
const seededMap = mapOfficeTemplateToTarget(seedTemplate, seeded, [{ sourceId: 'equipment', fieldKey: 'param:Паспорт|Расход', entityType: 'element', displayName: 'Расход' }]);
assert.deepEqual(seededMap.pending, []);
assert.deepEqual(seededMap.schema.anchors.map((anchor) => [anchor.id, anchor.sheetName, anchor.address]), [
  ['fresh-1', 'Лист1', 'B2'],
]);
assert.equal(JSON.stringify(seededMap.schema).includes('source-anchor'), false);
const fields: OfficeField[] = [{ sourceId: 'equipment', fieldKey: 'param:Паспорт|Расход', entityType: 'element', displayName: 'Расход' }];

const mapped = mapOfficeTemplateToTarget(template, target, fields);
assert.deepEqual(mapped.schema.anchors.map((anchor) => anchor.id), ['target-anchor-uuid', 'untouched-anchor-uuid']);
assert.deepEqual(mapped.schema.anchors[0].parts, [
  { kind: 'text', text: 'Расход: ' },
  { kind: 'field', binding: { fieldKey: 'param:Паспорт|Расход', sourceId: 'equipment', entityType: 'element', entityId: null, sourceRevision: 'rev-old', anchorId: 'target-anchor-uuid' } },
]);
assert.deepEqual(mapped.schema.anchors[1].parts, [{ kind: 'text', text: 'keep me' }]);
assert.deepEqual(mapped.pending, [
  { kind: 'field', sourceAnchorIndex: 0, partIndex: 2, sourceId: 'equipment', fieldKey: 'unknown.key', reason: 'unavailable-field' },
  { kind: 'field', sourceAnchorIndex: 0, partIndex: 3, sourceId: 'foreign-source', fieldKey: 'code', reason: 'unavailable-field' },
  { kind: 'anchor', sourceAnchorIndex: 1, candidateTargetIds: ['target-anchor-uuid', 'untouched-anchor-uuid'], reason: 'missing-target' },
]);
assert.equal(JSON.stringify(mapped.schema).includes('source-anchor'), false);

const ambiguousWord: OfficeHeaderSchema = { version: 1, anchors: [
  { id: 'old-row', kind: 'word-row', documentPart: 'word/document.xml', parts: [{ kind: 'text', text: 'heading' }] },
] };
assert.deepEqual(seedEmptyOfficeTemplateTarget(ambiguousWord, emptyTarget, () => 'nope'), emptyTarget);

const ambiguousTarget: OfficeHeaderSchema = { version: 1, anchors: [
  { id: 'row-a', kind: 'word-row', documentPart: 'word/document.xml', parts: [] },
  { id: 'row-b', kind: 'word-row', documentPart: 'word/document.xml', parts: [] },
] };
const ambiguous = mapOfficeTemplateToTarget(ambiguousWord, ambiguousTarget, fields);
assert.deepEqual(ambiguous.pending, [{ kind: 'anchor', sourceAnchorIndex: 0, candidateTargetIds: ['row-a', 'row-b'], reason: 'ambiguous-target' }]);
assert.deepEqual(ambiguous.schema, ambiguousTarget);

const twoWordRows: OfficeHeaderSchema = { version: 1, anchors: [
  { id: 'source-row-a', kind: 'word-row', documentPart: 'word/document.xml', parts: [{ kind: 'text', text: 'A' }] },
  { id: 'source-row-b', kind: 'word-row', documentPart: 'word/document.xml', parts: [{ kind: 'text', text: 'B' }] },
] };
const oneWordRow: OfficeHeaderSchema = { version: 1, anchors: [
  { id: 'target-row', kind: 'word-row', documentPart: 'word/document.xml', parts: [] },
] };
const collision = mapOfficeTemplateToTarget(twoWordRows, oneWordRow, fields);
assert.deepEqual(collision.pending, [
  { kind: 'anchor', sourceAnchorIndex: 0, candidateTargetIds: ['target-row'], reason: 'target-already-used' },
  { kind: 'anchor', sourceAnchorIndex: 1, candidateTargetIds: ['target-row'], reason: 'target-already-used' },
]);
const selected = mapOfficeTemplateToTarget(twoWordRows, oneWordRow, fields, { 0: 'target-row' });
assert.deepEqual(selected.pending, [{ kind: 'anchor', sourceAnchorIndex: 1, candidateTargetIds: ['target-row'], reason: 'target-already-used' }]);
assert.deepEqual(selected.schema.anchors[0].parts, [{ kind: 'text', text: 'A' }]);

const rebound = mapOfficeTemplateToTarget(template, target, fields, {}, {
  [officeTemplateFieldSelectionKey(0, 2)]: { sourceId: 'equipment', fieldKey: 'param:Паспорт|Расход', entityType: 'element', displayName: 'Расход' },
});
assert.equal(rebound.pending.length, 2);
assert.equal(rebound.schema.anchors[0].parts.filter((part) => part.kind === 'field').length, 2);

console.log('Структурная привязка шаблона использует UUID текущего документа и явно сообщает о потерянных полях/якорях');
