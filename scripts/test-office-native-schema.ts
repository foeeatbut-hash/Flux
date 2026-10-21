import assert from 'node:assert/strict';
import { schemaFromNativeHeaders } from '../src/components/office/officeNativeSchema';
import type { OfficeHeaderSchema } from '../src/lib/officeModel';
import { cleanOfficeTemplate } from '../server/officeTemplates.js';

const id = 'f513fb5a-0d9d-4e35-81d3-637a85b74445';
const binding = { anchorId: id, sourceId: 'equipment', entityType: 'equipment', entityId: null, fieldKey: 'power', sourceRevision: '1' };
const schema: OfficeHeaderSchema = { version: 1, anchors: [{ id, kind: 'word-row', parts: [{ kind: 'field', binding }] }] };
const ordered = [{ kind: 'text', text: 'Итого: ' }, { kind: 'field', binding }, { kind: 'operator', operator: '+' }, { kind: 'field', binding }, { kind: 'text', text: ' кВт' }];
assert.deepEqual(schemaFromNativeHeaders(schema, { ok: true, headers: [{ anchorId: id, parts: ordered }] }).anchors[0].parts, ordered);
assert.deepEqual(schemaFromNativeHeaders(schema, { ok: true, headers: [{ anchorId: id, parts: [{ kind: 'text', text: 'Итого:  кВт' }] }] }).anchors[0].parts, [{ kind: 'text', text: 'Итого:  кВт' }]);
assert.throws(() => schemaFromNativeHeaders(schema, { ok: false, error: 'Нет якоря' }), /Нет якоря/);
assert.throws(() => schemaFromNativeHeaders(schema, { ok: true, headers: [{ anchorId: id, parts: [{ kind: 'field', fieldKey: 'power' }] }] }), /привязки/);
assert.throws(() => schemaFromNativeHeaders(schema, { ok: true, headers: [{ anchorId: id, parts: [{ kind: 'field', binding: { ...binding, anchorId: 'foreign' } }] }] }), /привязки/);
const sheetSchema: OfficeHeaderSchema = { version: 1, anchors: [{ ...schema.anchors[0], kind: 'excel-range', sheetName: 'До', address: 'A1' }] };
const moved = schemaFromNativeHeaders(sheetSchema, { ok: true, headers: [{ anchorId: id, sheetName: 'После', address: 'c4' }] }).anchors[0];
assert.equal(moved.sheetName, 'После');
assert.equal(moved.address, 'C4');
assert.deepEqual(moved.parts, sheetSchema.anchors[0].parts);
assert.throws(() => schemaFromNativeHeaders(sheetSchema, { ok: true, headers: [{ anchorId: id, sheetName: 'После', address: 'C0' }] }), /адрес/);
console.log('✓ Native header order, explicit removal and unresolved binding rejection');

// Своё имя параметра, исключения объединения и отметка «выбор сделан» живут в схеме Flux, а не в документе
const named = { ...binding, label: 'Мощность, кВт' };
const namedSchema: OfficeHeaderSchema = { version: 1, anchors: [{ id, kind: 'word-row', parts: [{ kind: 'field', binding: named }] }] };
assert.equal((schemaFromNativeHeaders(namedSchema, { ok: true, headers: [{ anchorId: id, parts: [{ kind: 'field', binding }] }] }).anchors[0].parts[0] as any).binding.label, 'Мощность, кВт');
const unionOf = (extra: object) => ({ kind: 'union' as const, mode: 'first-match' as const, alternatives: [{ ...binding, priority: 0 }, { ...binding, fieldKey: 'motor', priority: 1 }], ...extra });
const unionSchema: OfficeHeaderSchema = { version: 1, anchors: [{ id, kind: 'word-row', parts: [unionOf({ label: 'Мощность', picks: { 'EQ-1': 'motor' }, resolved: true })] }] };
const unionBack: any = schemaFromNativeHeaders(unionSchema, { ok: true, headers: [{ anchorId: id, parts: [unionOf({})] }] }).anchors[0].parts[0];
assert.deepEqual([unionBack.label, unionBack.picks, unionBack.resolved], ['Мощность', { 'EQ-1': 'motor' }, true]);
console.log('✓ Own name, picks and resolved mark survive a native header read');
// Сервер (schemaFromBody) оставляет своё имя, исключения и отметку, но не пропускает чужие ключи в исключениях
const cleaned: any = cleanOfficeTemplate({ name: 'x', schema: { version: 1, anchors: [{ id, kind: 'word-row', parts: [{ kind: 'field', binding: { ...named, displayName: 'не хранится' } }, unionOf({ label: 'Мощность', picks: { 'EQ-1': 'motor', 'EQ-2': 'чужой' }, resolved: true }) ] }] } }, 'u').schema.anchors[0].parts;
assert.equal(cleaned[0].binding.label, 'Мощность, кВт');
assert.equal(cleaned[0].binding.displayName, undefined);
assert.deepEqual([cleaned[1].label, cleaned[1].picks, cleaned[1].resolved], ['Мощность', undefined, undefined]);
console.log('✓ Server template cleaning keeps labels but drops row-specific union choices');
