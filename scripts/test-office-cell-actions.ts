import assert from 'node:assert/strict';
import { collectOfficeCellMergeAlternatives, type FluxCellActionAnchor } from '../src/components/office/FluxCellActionsDialog';
import type { OfficeBinding, OfficeHeaderSchema, OfficeUnionPart } from '../src/lib/officeModel';
import { applyUnionChoice, defaultUnionLabel, partName, renamePart, takeFirst } from '../src/components/office/fluxMergeChoice';
import type { OfficeField } from '../src/components/office/fluxData';

function binding(sourceId: string, fieldKey: string, anchorId: string): OfficeBinding {
  return { sourceId, fieldKey, entityType: 'tag', entityId: null, sourceRevision: 'r1', anchorId };
}

function anchor(anchorId: string, parts: FluxCellActionAnchor['parts']): FluxCellActionAnchor {
  return { anchorId, kind: 'excel-range', sheetName: 'Лист1', address: anchorId, parts };
}

const first = binding('project-a', 'drive_power', 'a1');
const second = binding('project-b', 'motor_power', 'b1');
const selections = [
  anchor('a1', [{ kind: 'text', text: 'Мощность привода: ' }, { kind: 'field', binding: first }]),
  anchor('b1', [{ kind: 'field', binding: second }]),
];
const frozenSelection = Object.freeze(selections.map((item) => Object.freeze({ ...item, parts: Object.freeze(item.parts.map((part) => Object.freeze({ ...part }))) as unknown as FluxCellActionAnchor['parts'] })));
const plan = collectOfficeCellMergeAlternatives(frozenSelection as unknown as FluxCellActionAnchor[]);
assert.equal(plan.error, undefined);
assert.deepEqual(plan.alternatives.map((item) => [item.sourceId, item.fieldKey, item.anchorId, item.priority]), [
  ['project-a', 'drive_power', 'a1', 0],
  ['project-b', 'motor_power', 'a1', 1],
]);
assert.deepEqual(selections[0].parts[0], { kind: 'text', text: 'Мощность привода: ' });
assert.equal(selections.length, 2);

const prioritizedUnion = collectOfficeCellMergeAlternatives([
  anchor('a1', [{ kind: 'union', mode: 'first-match', alternatives: [
    { ...binding('project-a', 'later', 'a1'), priority: 8 },
    { ...binding('project-a', 'earlier', 'a1'), priority: 2 },
  ] }]),
  anchor('b1', [{ kind: 'field', binding: second }]),
]);
assert.deepEqual(prioritizedUnion.alternatives.map((item) => [item.fieldKey, item.priority]), [
  ['earlier', 0], ['later', 1], ['motor_power', 2],
]);

const duplicate = collectOfficeCellMergeAlternatives([
  anchor('a1', [{ kind: 'field', binding: first }]),
  anchor('b1', [{ kind: 'field', binding: { ...first, anchorId: 'b1' } }]),
]);
assert.equal(duplicate.alternatives.length, 0);
assert.match(duplicate.error || '', /один параметр/);

const ambiguous = collectOfficeCellMergeAlternatives([
  anchor('a1', [{ kind: 'field', binding: first }, { kind: 'text', text: ' / ' }, { kind: 'field', binding: binding('project-a', 'other', 'a1') }]),
  anchor('b1', [{ kind: 'field', binding: second }]),
]);
assert.equal(ambiguous.alternatives.length, 0);
assert.match(ambiguous.error || '', /одну привязку/);

const leadingFormula = collectOfficeCellMergeAlternatives([
  anchor('a1', [{ kind: 'text', text: ' = ' }, { kind: 'field', binding: first }, { kind: 'text', text: ' / 2' }]),
  anchor('b1', [{ kind: 'field', binding: second }]),
]);
assert.equal(leadingFormula.alternatives.length, 0);
assert.match(leadingFormula.error || '', /формулу нельзя преобразовать/);

const operatorFormula = collectOfficeCellMergeAlternatives([
  anchor('a1', [{ kind: 'field', binding: first }, { kind: 'operator', operator: '+' }, { kind: 'field', binding: binding('project-a', 'other', 'a1') }]),
  anchor('b1', [{ kind: 'field', binding: second }]),
]);
assert.equal(operatorFormula.alternatives.length, 0);
assert.match(operatorFormula.error || '', /формулу нельзя преобразовать/);

const conflicted = collectOfficeCellMergeAlternatives([
  { ...selections[0], manualConflict: 'both cells contain user values' },
  selections[1],
]);
assert.equal(conflicted.alternatives.length, 0);
assert.match(conflicted.error || '', /ручные данные/);

// Объединение одним действием: имя по умолчанию, выбор «Брать …», исключения по позициям
const catalog: OfficeField[] = [
  { sourceId: 'project-a', entityType: 'tag', fieldKey: 'drive_power', displayName: 'Мощность привода' },
  { sourceId: 'project-b', entityType: 'tag', fieldKey: 'motor_power', displayName: 'Мощность двигателя' },
];
assert.equal(defaultUnionLabel(plan.alternatives, catalog), 'Мощность привода / Мощность двигателя');
const union: OfficeUnionPart = { kind: 'union', mode: 'first-match', label: 'Мощность', alternatives: plan.alternatives };
const taken = takeFirst(union, 'motor_power');
assert.deepEqual(taken.alternatives.map((item) => [item.fieldKey, item.priority]), [['motor_power', 0], ['drive_power', 1]]);
assert.equal(taken.resolved, true);
assert.equal(taken.picks, undefined);
const eachChoice = applyUnionChoice(union, ['drive_power', 'motor_power'], { 'EQ-1': 'motor_power', 'EQ-2': 'drive_power' });
assert.deepEqual(eachChoice.picks, { 'EQ-1': 'motor_power' }); // совпавшее с общим порядком исключение не храним

// Своё имя: хранится в binding.label, «сбросить» возвращает программное; у объединения — «<имя1> / <имя2>»
const nameSchema: OfficeHeaderSchema = { version: 1, anchors: [{ id: 'a1', kind: 'excel-range', sheetName: 'Лист1', address: 'A1', parts: [{ kind: 'field', binding: first }] }, { id: 'u1', kind: 'excel-range', sheetName: 'Лист1', address: 'B1', parts: [union] }] };
const renamed = renamePart(nameSchema, 'a1', 0, '  Привод, кВт ', catalog);
assert.equal((renamed.anchors[0].parts[0] as any).binding.label, 'Привод, кВт');
assert.equal(partName(renamed.anchors[0].parts[0], catalog), 'Привод, кВт');
assert.equal((renamePart(renamed, 'a1', 0, null, catalog).anchors[0].parts[0] as any).binding.label, undefined);
assert.equal((renamePart(renamed, 'a1', 0, 'Мощность привода', catalog).anchors[0].parts[0] as any).binding.label, undefined);
assert.equal(partName(renamePart(nameSchema, 'u1', 0, 'Мощность, кВт', catalog).anchors[1].parts[0], catalog), 'Мощность, кВт');
assert.equal(partName(renamePart(nameSchema, 'u1', 0, null, catalog).anchors[1].parts[0], catalog), 'Мощность привода / Мощность двигателя');

console.log('Office cell actions: 11 contract cases passed');
