import assert from 'node:assert/strict';
import { kitErrors, normalizeKits } from '../shared/docflow/kits';
import { normalizeDocflowConfig, mergeSections, diffSections } from '../shared/docflow/config';
const item = { docType: 'E02', stage: '', unit: 'tag', necessity: 'required', responsibleRole: '', milestone: '', workdays: 0, condition: null };
const legacy = [{ classId: 'fan', types: ['E02', 'C32'] }];
assert.deepEqual(normalizeKits(legacy), [{ classId: 'fan', items: [item, { ...item, docType: 'C32' }] }]);
assert.deepEqual(kitErrors(legacy), []);
const valid = [{ classId: 'fan', items: [{ ...item, condition: { parameter: 'Двигатель||Мощность', operator: 'equals', value: '1' } }] }];
assert.deepEqual(kitErrors(valid), []);
for (const bad of [
 [{ classId: '', items: [] }], [{ classId: 'fan', items: [item, { ...item, stage: 'Р' }] }],
 [{ classId: 'fan', items: [{ ...item, stage: 'X' }] }], [{ classId: 'fan', items: [{ ...item, unit: 'x' }] }],
 [{ classId: 'fan', items: [{ ...item, necessity: 'x' }] }], [{ classId: 'fan', items: [{ ...item, workdays: 1.5 }] }],
 [{ classId: 'fan', items: [{ ...item, condition: { parameter: '', operator: 'exists', value: '' } }] }],
 [{ classId: 'fan', items: [{ ...item, condition: { parameter: 'A'.repeat(241), operator: 'equals', value: 'x' } }] }],
 [{ classId: 'fan', items: [{ ...item, condition: { parameter: 'A', operator: 'equals', value: 'x'.repeat(501) } }] }],
 [{ classId: 'fan', items: [{ ...item, workdays: 3651 }] }],
 [{ classId: 'fan', items: [{ ...item, docType: 'A'.repeat(201) }] }],
 [{ classId: 'fan', items: [{ ...item, unknown: 1 }] }], [{ classId: 'fan', items: [] }, { classId: 'fan', items: [] }],
]) assert.ok(kitErrors(bad).length, JSON.stringify(bad));
assert.ok(kitErrors(Array.from({ length: 501 }, (_, i) => ({ classId: String(i), items: [] }))).length);
assert.ok(kitErrors([{ classId: 'fan', items: Array.from({ length: 101 }, (_, i) => ({ ...item, docType: String(i) })) }]).length);
const many = Array.from({ length: 51 }, (_, i) => ({ classId: `class${i}`, items: Array.from({ length: 100 }, (_, n) => ({ ...item, docType: String(n) })) }));
assert.ok(kitErrors(many).some(error => error.includes('5000')));
assert.equal(normalizeKits(many).reduce((count, kit) => count + kit.items.length, 0), 5000);
const source = normalizeDocflowConfig({ kits: valid }); const target = normalizeDocflowConfig({ kits: legacy });
const copied = mergeSections(target, source, ['kits']);
assert.deepEqual(copied.kits, source.kits);
assert.ok(diffSections(target, copied, ['kits'])[0].lines.includes('изменится fan'));
assert.deepEqual(mergeSections(target, source, ['statuses']).kits, target.kits);
console.log('Комплекты: совместимость, ошибки, перенос и различия проверены');
