import assert from 'node:assert/strict';
import { resolveEquipmentSourceTargets, type EquipmentSourceTargetElement } from '../server/equipmentSourceTargets.js';
import type { ParsedUnit } from '../server/equipmentParser.js';

const specs = (value: string, key = 'Расход воздуха') => JSON.stringify({ groups: [{ title: 'Аэродинамика', params: [{ key, value, unit: 'м³/ч' }] }] });
const element = (id: string, itemCode: string, name: string, options: Partial<EquipmentSourceTargetElement> = {}): EquipmentSourceTargetElement => ({
  id, itemCode, name, monoblockName: 'Вентиляторный блок', version: 1, specs: specs('100'), tags: [], ...options,
});
const unit: ParsedUnit = {
  name: 'AHU-1', title: 'Установка', tags: ['AHU-1'], groups: [],
  monoblocks: [{ name: 'Вентиляторный блок', title: 'Вентиляторный блок', blocks: [
    { name: 'fan-1', title: 'Вентилятор №1', equipType: 'Вентилятор', groups: [{ title: 'Аэродинамика', params: [{ key: 'Расход воздуха', value: '120', unit: 'м³/ч' }] }], tags: ['FAN-1'] },
  ] }],
};
const root = element('unit-root', '__unit__', 'Установка', { monoblockName: '__unit__', specs: JSON.stringify({ groups: [] }), tags: ['AHU-1'] });

{
  const result = resolveEquipmentSourceTargets(unit, root, [element('fan-id', 'fan-1', 'Вентилятор'), root]);
  const fan = result.targets.find(target => target.elementId === 'fan-id');
  assert.equal(result.targets.find(target => target.elementId === 'unit-root')?.changes.length, 0, 'unchanged unit root remains unchanged');
  assert.equal(fan?.changes.length, 1, 'changed nested fan produces a target despite unchanged root');
  assert.equal(fan?.changes[0].id, 'fan-id\u0001Аэродинамика\u0000Расход воздуха');
  assert.equal(fan?.changes[0].rawId, 'Аэродинамика\u0000Расход воздуха');
}

{
  const twinUnit: ParsedUnit = { ...unit, monoblocks: [{ ...unit.monoblocks[0], blocks: [
    { ...unit.monoblocks[0].blocks[0], name: 'fan-1', title: 'Вентилятор №1', tags: ['FAN-1'] },
    { ...unit.monoblocks[0].blocks[0], name: 'fan-2', title: 'Вентилятор №2', tags: ['FAN-2'] },
  ] }] };
  const result = resolveEquipmentSourceTargets(twinUnit, root, [
    element('fan-one', 'fan-1', 'Вентилятор №1', { tags: ['FAN-1'] }),
    element('fan-two', 'fan-2', 'Вентилятор №2', { tags: ['FAN-2'] }),
  ]);
  const targetIds = result.targets.filter(target => target.elementId !== root.id).map(target => target.elementId).sort();
  assert.deepEqual(targetIds, ['fan-one', 'fan-two'], 'same parameter key on separate fans stays separately addressed');
  assert.notEqual(result.targets.find(target => target.elementId === 'fan-one')?.changes[0].id, result.targets.find(target => target.elementId === 'fan-two')?.changes[0].id);
}

{
  const result = resolveEquipmentSourceTargets(unit, root, [
    element('duplicate-one', 'fan-1', 'Вентилятор 1', { tags: ['FAN-1'] }),
    element('duplicate-two', 'fan-1', 'Вентилятор 1 дубль', { tags: ['FAN-1'] }),
  ]);
  assert.equal(result.targets.some(target => target.elementId.startsWith('duplicate-')), false, 'ambiguous identity must never become a write target');
  assert.ok(result.structuralActions.some(action => action.kind === 'ambiguous' && action.elementIds.length === 2));
}

{
  const unitWithAdd: ParsedUnit = { ...unit, monoblocks: [{ ...unit.monoblocks[0], blocks: [
    ...unit.monoblocks[0].blocks,
    { name: 'fan-new', title: 'Новый вентилятор', equipType: 'Вентилятор', role: 'ВЕНТИЛЯТОР', sourceKind: 'cadFan', instanceNo: 1, instanceCount: 2, groups: [], tags: ['FAN-NEW'] },
  ] }] };
  const result = resolveEquipmentSourceTargets(unitWithAdd, root, [element('existing-fan', 'old-fan', 'Старый вентилятор'), root]);
  const added = result.structuralActions.find(action => action.kind === 'added' && action.parsedKey?.includes('fan-new'));
  const removed = result.structuralActions.find(action => action.kind === 'removed' && action.elementIds.includes('existing-fan'));
  assert.ok(added?.id.startsWith('xml-struct-'));
  assert.equal(added?.proposed?.code, 'fan-new');
  assert.equal(added?.proposed?.monoblockName, 'Вентиляторный блок');
  assert.equal(added?.proposed?.sourceKind, 'cadFan');
  assert.equal(added?.proposed?.role, 'ВЕНТИЛЯТОР');
  assert.equal(added?.proposed?.instanceNo, 1);
  assert.equal(added?.proposed?.instanceCount, 2);
  assert.ok(removed?.id.startsWith('xml-struct-'));
  assert.equal((removed?.before as any)?.code, 'old-fan');
  assert.equal(added?.id, resolveEquipmentSourceTargets(unitWithAdd, root, [element('existing-fan', 'old-fan', 'Старый вентилятор'), root]).structuralActions.find(action => action.kind === 'added' && action.parsedKey?.includes('fan-new'))?.id, 'action id is deterministic');
}

{
  const metadataUnit: ParsedUnit = { ...unit, monoblocks: [{ ...unit.monoblocks[0], blocks: [
    { ...unit.monoblocks[0].blocks[0], role: 'ВЕНТИЛЯТОР', sourceKind: 'cadFan', instanceNo: 2, instanceCount: 2 },
  ] }] };
  const target = element('metadata-fan', 'fan-1', 'Вентилятор №1', { equipType: 'Вентилятор', role: 'БЛОК', sourceKind: 'old', instanceNo: 1, instanceCount: 1, tags: ['FAN-1'] });
  const result = resolveEquipmentSourceTargets(metadataUnit, root, [target]);
  assert.ok(result.structuralActions.some(action => action.field === 'role' && action.after === 'ВЕНТИЛЯТОР'));
  assert.ok(result.structuralActions.some(action => action.field === 'sourceKind' && action.after === 'cadFan'));
  assert.ok(result.structuralActions.some(action => action.field === 'instanceNo' && action.after === 2));
  assert.ok(result.structuralActions.some(action => action.field === 'instanceCount' && action.after === 2));
}

{
  const manual = element('manual-fan', 'fan-1', 'Вентилятор', { overrides: { 'Аэродинамика||Расход воздуха': '110' } });
  const result = resolveEquipmentSourceTargets(unit, root, [manual]);
  const change = result.targets.find(target => target.elementId === manual.id)?.changes[0];
  assert.equal(change?.manual, true);
  assert.equal(change?.current?.value, '110', 'existing manual value remains visible and is not overwritten by proposed data');
}

{
  const sameSpecsUnit: ParsedUnit = { ...unit, monoblocks: [{ ...unit.monoblocks[0], blocks: [{
    ...unit.monoblocks[0].blocks[0], groups: [{ title: 'Аэродинамика', params: [{ key: 'Расход воздуха', value: '100', unit: 'м³/ч' }] }],
  }] }] };
  const moved = element('moved-fan', 'fan-1', 'Вентилятор №1', { monoblockName: 'Старый моноблок', equipType: 'Вентилятор', tags: ['FAN-1'] });
  const movedResult = resolveEquipmentSourceTargets(sameSpecsUnit, root, [moved]);
  assert.equal(movedResult.targets.find(target => target.elementId === moved.id)?.changes.length, 0, 'metadata-only move does not fabricate parameter differences');
  assert.ok(movedResult.structuralActions.some(action => action.kind === 'moved' && action.field === 'monoblockName'), 'a stable tag still exposes monoblock moves');

  const restored = element('restored-fan', 'fan-1', 'Вентилятор №1', { equipType: 'Вентилятор', status: 'REMOVED', tags: ['FAN-1'] });
  const restoredResult = resolveEquipmentSourceTargets(sameSpecsUnit, root, [restored]);
  assert.ok(restoredResult.structuralActions.some(action => action.kind === 'restored' && action.elementIds.includes(restored.id)));
  assert.equal(restoredResult.structuralActions.some(action => action.kind === 'removed' && action.elementIds.includes(restored.id)), false);
}

{
  const parentChildUnit: ParsedUnit = { ...unit, monoblocks: [{ ...unit.monoblocks[0], blocks: [
    { name: 'parent', title: 'Секция', equipType: 'Секция', groups: [], tags: ['SEC-1'] },
    { ...unit.monoblocks[0].blocks[0], parentName: 'parent', groups: [{ title: 'Аэродинамика', params: [{ key: 'Расход воздуха', value: '100', unit: 'м³/ч' }] }] },
  ] }] };
  const parent = element('parent-id', 'parent', 'Секция', { equipType: 'Секция', tags: ['SEC-1'], specs: JSON.stringify({ groups: [] }) });
  const child = element('child-id', 'fan-1', 'Вентилятор №1', { equipType: 'Вентилятор', tags: ['FAN-1'], parentElementId: 'old-parent' });
  const result = resolveEquipmentSourceTargets(parentChildUnit, root, [parent, child]);
  assert.ok(result.structuralActions.some(action => action.kind === 'moved' && action.field === 'parentElementId' && action.elementIds.includes(child.id)));
}

{
  const manualOnly = element('manual-only', 'manual-position', 'Ручная позиция', { manual: true });
  const result = resolveEquipmentSourceTargets(unit, root, [manualOnly]);
  assert.equal(result.targets.some(target => target.elementId === manualOnly.id), false, 'manual position is never matched to XML');
  assert.equal(result.structuralActions.some(action => action.kind === 'removed' && action.elementIds.includes(manualOnly.id)), false, 'manual position is not treated as omitted by XML');
  assert.equal(result.structuralActions.some(action => action.elementIds.includes(root.id)), false, 'the unit root is never an unmatched removal');
}

console.log('Equipment XML source target mapping: nested diffs, stable identities, ambiguity, structural actions and manual values passed.');
