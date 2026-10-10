import assert from 'node:assert/strict';
import type { Family } from '../catalog/model';
import { setPrisma } from '../server/context';
import { bindingKey, familyMatchesEquipment, sourceInfo, type EquipmentCatalog } from '../server/equipmentCatalog';
import {
  catalogSnapshotIsStale, familySpecs, matchPublishedFamily, resolveCatalogSpecs, snapshotForBinding,
} from '../equipment/catalogSpecs';

const family = (id: string, manufacturerId: string): Family => ({
  id, classId: 'dampers', manufacturerId, code: 'ABC', title: { ru: 'Заслонка' }, kind: 'damper',
  typeLabel: { ru: 'Заслонка' }, shapes: ['rect'],
  params: [
    { key: 'width', label: { ru: 'Ширина' }, kind: 'number', size: 'W' },
    { key: 'variant', label: { ru: 'Исполнение' }, kind: 'choice', values: [{ code: 'Q', label: { ru: 'Q' } }, { code: 'R', label: { ru: 'R' } }] },
  ],
  positions: [{ key: 'designation', label: { ru: 'Обозначение' }, formats: ['ABC-{width}-{variant}'] }],
  rules: [], match: { kinds: ['damper'] },
  specs: [{ key: 'type', label: { ru: 'Тип' }, value: { ru: 'базовый' }, cases: [{ when: { param: 'variant', in: ['Q'] }, value: { ru: 'вариант Q' } }] }],
  tables: [{ id: 'capacity', title: 'Производительность', columns: [
    { key: 'width', label: 'Ширина', unit: 'мм', role: 'input' },
    { key: 'variant', label: 'Исполнение', role: 'input' },
    { key: 'capacity', label: 'Расход', unit: 'м³/ч', role: 'output' },
  ], rows: [
    { id: 'one', values: { width: 600, variant: 'Q', capacity: 1200 }, verified: true },
    { id: 'two', values: { width: 600, variant: 'Q', capacity: 1300 }, verified: false },
    { id: 'three', values: { width: 600, variant: 'Q', capacity: 1400 }, verified: true },
  ] }],
  status: 'partial', aliases: ['ABC'],
});

const a = family('family-a', 'maker-a');
const b = family('family-b', 'maker-b');
assert.equal(familyMatchesEquipment({ role: 'Клапан' }, a, { classes: [], manufacturers: [], families: [a], components: [], tagRules: [] }), true, 'legacy damper family kind remains an exact valve-family match without the class dictionary');
assert.equal(familyMatchesEquipment({ role: 'Вентилятор' }, a, { classes: [], manufacturers: [], families: [a], components: [], tagRules: [] }), false, 'legacy kind fallback still rejects a family for the wrong equipment type');
const both = matchPublishedFamily([a, b], 'ABC-600-Q');
assert.equal(both.length, 2, 'same complete designation across makers remains ambiguous');
assert.equal(matchPublishedFamily([a, b], 'ABC-600-Q', 'maker-a')[0]?.family.id, 'family-a', 'exact maker disambiguates');
assert.equal(matchPublishedFamily([a, b], 'ABC-600-Z').length, 0, 'partial or unknown codes do not bind');

const parsed = matchPublishedFamily([a], 'ABC-600-Q')[0];
assert.ok(parsed?.values);
const derived = familySpecs(a, parsed.values);
assert.equal(derived.find(spec => spec.label.ru === 'Тип')?.value, 'вариант Q', 'case values use parsed configuration');
assert.equal(derived.find(spec => spec.label.ru === 'Расход'), undefined, 'two verified exact table rows stay ambiguous');
assert.equal(familySpecs(a, { ...parsed.values, variant: 'R' }).find(spec => spec.label.ru === 'Тип')?.value, 'базовый');

const exactTable = { ...a, tables: [{ ...a.tables![0], rows: [a.tables![0].rows[0]] }] };
assert.equal(familySpecs(exactTable, parsed.values).find(spec => spec.label.ru === 'Расход')?.value, '1200');
assert.equal(familySpecs(exactTable, { width: 600 }).find(spec => spec.label.ru === 'Расход'), undefined, 'all table input axes are required');

const raw = [{ title: 'Параметры', params: [{ key: 'Тип', value: 'согласовано', unit: '' }] }];
const resolved = resolveCatalogSpecs(raw, { 'Параметры||Тип': 'ручное' }, 'hybrid', a, { values: parsed.values, revision: 'catalog-rev-7', sourceRef: { file: 'Каталог.pdf', pages: '8' } });
assert.equal(resolved.effective[0].value, 'ручное', 'manual edit stays ahead of the catalogue');
assert.equal(resolved.effective[0].source, 'manual');
const catalogValue = resolveCatalogSpecs([], {}, 'catalog', exactTable, { values: parsed.values, revision: 'catalog-rev-7', sourceRef: { file: 'Каталог.pdf', pages: '8' } }).effective.find(spec => spec.key === 'Расход');
assert.equal(catalogValue?.revision, 'catalog-rev-7', 'per-field source carries the published revision');
assert.equal(catalogValue?.sourceRef?.pages, '8');

const oldSnapshot = { code: 'ABC-600-Q', value: 'old' };
const binding: any = { mode: 'hybrid', modelId: 'family-a', sourceType: 'family', sourceRevision: 'rev-1', revision: 'binding-1', at: '2026-10-01', snapshot: oldSnapshot };
assert.equal(catalogSnapshotIsStale(binding, 'rev-2'), true, 'published update is visible as stale');
assert.equal(catalogSnapshotIsStale(binding, 'rev-1'), false);
assert.equal(snapshotForBinding(oldSnapshot, { code: 'ABC-600-X', value: 'new' }, false), oldSnapshot, 'reads preserve frozen project snapshot');
assert.deepEqual(snapshotForBinding(oldSnapshot, { code: 'ABC-600-Q', value: 'new' }, true), { code: 'ABC-600-Q', value: 'new' }, 'only explicit apply replaces snapshot');

// Exercise first-read persistence and subsequent publication proposal with a
// small Prisma-shaped store. The resolver must always read the saved Family.
async function verifyFirstReadSnapshot() {
const settings = new Map<string, any>();
const fakePrisma = { appSetting: {
  async findFirst({ where }: any) { return settings.get(where.key) || null; },
  async upsert({ where, create }: any) {
    if (!settings.has(create.key) && ![...settings.values()].some(row => row.id === where.id)) settings.set(create.key, create);
    return settings.get(create.key);
  },
} };
setPrisma(fakePrisma);
const equipment = { id: 'element-1', role: 'Клапан', equipType: '', specs: JSON.stringify([{ title: 'Маркировка', params: [{ key: 'Марка', value: 'ABC-600-Q' }] }]), overrides: { 'Характеристики из каталога||Тип': 'ручное значение' } };
const makeCatalog = (value: string, updatedAt: string): EquipmentCatalog => ({
  classes: [], manufacturers: [{ id: 'maker-a', name: 'Завод A', shortName: 'A' }], families: [{ ...a, specs: [{ key: 'type', label: { ru: 'Тип' }, value: { ru: value } }] }],
  components: [], tagRules: [], meta: { 'family-a': { updatedAt } },
});
const firstRead = await sourceInfo(equipment, makeCatalog('первая редакция', '2026-10-01T00:00:00.000Z'));
assert.equal(firstRead.binding?.sourceRevision, '2026-10-01T00:00:00.000Z', 'first exact read stores metadata revision');
assert.equal(firstRead.effective.find((spec: any) => spec.key === 'Тип')?.value, 'ручное значение', 'first-use snapshot preserves manual overrides');
assert.equal((settings.get(bindingKey(equipment.id))?.value ? JSON.parse(settings.get(bindingKey(equipment.id)).value).snapshot.specs[0].value.ru : ''), 'первая редакция', 'first exact read stores the actual Family snapshot');
const nextRead = await sourceInfo(equipment, makeCatalog('новая редакция', '2026-10-02T00:00:00.000Z'), settings.get(bindingKey(equipment.id)));
assert.equal(nextRead.effective.find((spec: any) => spec.key === 'Тип')?.value, 'ручное значение', 'later reads retain manual value over the frozen snapshot');
assert.equal(JSON.parse(settings.get(bindingKey(equipment.id)).value).snapshot.specs[0].value.ru, 'первая редакция', 'frozen snapshot itself remains the original revision');
assert.equal(nextRead.updateAvailable?.specs?.[0]?.value, 'новая редакция', 'new published revision is offered for review');
assert.equal(JSON.parse(settings.get(bindingKey(equipment.id)).value).sourceRevision, '2026-10-01T00:00:00.000Z', 'review does not update the saved project binding');
const xmlElement = { ...equipment, id: 'element-xml', overrides: {} };
const xmlBinding = { mode: 'xml', revision: 'xml-revision', at: '2026-10-01', modelId: undefined, snapshot: undefined };
settings.set(bindingKey(xmlElement.id), { id: `ecb-${xmlElement.id}`, key: bindingKey(xmlElement.id), userId: null, value: JSON.stringify(xmlBinding) });
const xmlRead = await sourceInfo(xmlElement, makeCatalog('новая редакция', '2026-10-02T00:00:00.000Z'), settings.get(bindingKey(xmlElement.id)));
assert.equal(xmlRead.mode, 'xml', 'saved XML-only mode remains XML');
assert.equal(xmlRead.binding?.revision, 'xml-revision', 'first-use freeze never overwrites an existing binding');
}

void verifyFirstReadSnapshot().then(() => console.log('Опубликованные семейства, точный разбор, табличные значения, происхождение и снимки оборудования проверены.'));
