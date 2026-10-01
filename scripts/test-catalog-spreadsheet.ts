import assert from 'node:assert/strict';
import type { Catalog, Component } from '../catalog/model';
import { planCatalogSpreadsheet, type CatalogSheet } from '../catalog/spreadsheet';

const classId = 'cls-valve';
const catalog = (components: Component[] = []): Catalog => ({
  classes: [
    { id: classId, title: { ru: 'Клапаны' } },
    { id: 'cls-damper', title: { ru: 'Заслонки' } },
  ] as Catalog['classes'],
  manufacturers: [],
  families: [{ id: 'fam-smoke', code: 'SMOKE', classId: 'cls-valve' }] as Catalog['families'],
  components,
  tagRules: [],
});

const rowsForThreeModels: CatalogSheet[] = [
  {
    name: 'Models',
    rows: [
      ['Ключ модели', 'Модель', 'Изготовитель', 'Тип комплектующего', 'Название', 'Источник', 'Редакция', 'Страницы', 'Напряжение [В]', 'Крутящий момент [Н·м]'],
      ['row-srz', 'LF24-SRZ-5', 'НЕМАН', 'Привод', 'LF24 с сигналом SRZ', 'NEMAN 2026.pdf', '2026', '52–53', 24, 5],
      ['row-sra', 'LM24-SRA', 'НЕМАН', 'Привод', 'LM24 с сигналом SRA', 'NEMAN 2026.pdf', '2026', '14–15', 24, 5],
      ['row-sr', 'LF24-SR-5', 'НЕМАН', 'Привод', 'LF24 с сигналом SR', 'NEMAN 2026.pdf', '2026', '52–53', 24, 5],
    ],
  },
  {
    name: 'Details',
    rows: [
      ['Ключ модели', 'Параметр', 'Значение', 'Единица'],
      ['row-sr', 'Управляющий сигнал', '2…10', 'В DC'],
      ['row-srz', 'Управляющий сигнал', '0…10', 'В DC'],
      ['row-sra', 'Управление', 'плавное', undefined],
      ['row-sr', 'Примечание длинного листа', 'Сверено отдельно', undefined],
    ],
  },
  {
    name: 'Applicability',
    rows: [
      ['Ключ модели', 'Класс оборудования', 'Семейство изделия ВЕЗА'],
      ['row-srz', 'cls-damper', 'fam-smoke'],
      ['row-sr', 'cls-damper', 'fam-smoke'],
    ],
  },
];

const result = planCatalogSpreadsheet(rowsForThreeModels, catalog(), { classId, policy: 'add' });
const modelRows = result.filter((row) => row.sheet === 'Models');
assert.equal(modelRows.length, 3);
assert.ok(modelRows.every((row) => row.action === 'new'));
const byCode = new Map(modelRows.map((row) => [row.code, row.component!]));
assert.equal(byCode.size, 3);
for (const code of ['LF24-SR-5', 'LF24-SRZ-5', 'LM24-SRA']) {
  const component = byCode.get(code)!;
  assert.equal(component.code, code);
  assert.equal(component.manufacturer, 'НЕМАН');
  assert.equal(component.kind, 'actuator');
  assert.equal(component.classId, classId);
  assert.ok(component.id.startsWith('cmp-import-'));
  assert.ok(component.specs?.some((s) => s.label.ru === 'Напряжение' && s.value === '24' && s.unit === 'В'));
  assert.ok(component.specs?.some((s) => s.label.ru === 'Крутящий момент' && s.value === '5' && s.unit === 'Н·м'));
  assert.equal(component.catalog?.file, 'NEMAN 2026.pdf');
  assert.equal(component.catalog?.edition, '2026');
}
assert.equal(byCode.get('LF24-SR-5')?.specs?.find((s) => s.label.ru === 'Управляющий сигнал')?.value, '2…10');
assert.equal(byCode.get('LF24-SRZ-5')?.specs?.find((s) => s.label.ru === 'Управляющий сигнал')?.value, '0…10');
assert.ok(byCode.get('LF24-SR-5')?.classIds?.includes('cls-damper'));
assert.ok(byCode.get('LF24-SR-5')?.familyIds?.includes('fam-smoke'));
assert.ok(byCode.get('LF24-SRZ-5')?.classIds?.includes('cls-damper'));
assert.ok(byCode.get('LF24-SRZ-5')?.familyIds?.includes('fam-smoke'));
assert.equal(byCode.get('LM24-SRA')?.familyIds, undefined);

const duplicate = planCatalogSpreadsheet([{
  name: 'Duplicate rows',
  rows: [
    ['Модель', 'Изготовитель', 'Тип'],
    ['SR230', 'НЕМАН', 'Привод'],
    ['SR230', 'НЕМАН', 'Привод'],
  ],
}], catalog(), { classId, policy: 'add' });
assert.deepEqual(duplicate.map((row) => row.action), ['conflict', 'conflict']);
assert.ok(duplicate.every((row) => row.error?.includes('повторяется')));
const existingDuplicate = catalog([
  { id: 'a', classId, kind: 'actuator', code: 'SR230', manufacturer: 'НЕМАН', title: { ru: 'A' } },
  { id: 'b', classId, kind: 'actuator', code: 'SR230', manufacturer: 'НЕМАН', title: { ru: 'B' } },
]);
const conflict = planCatalogSpreadsheet([{ name: 'Model', rows: [['Модель', 'Изготовитель'], ['SR230', 'НЕМАН']] }], existingDuplicate, { classId, policy: 'update' });
assert.equal(conflict[0].action, 'conflict');
assert.ok(conflict[0].error?.includes('несколько моделей'));

const manual: Component = {
  id: 'manual-1', classId, classIds: [classId, 'cls-damper'], familyIds: ['fam-smoke'], kind: 'actuator',
  code: 'LM24-SRA', manufacturer: 'НЕМАН', title: { ru: 'Ручное название' }, equipmentType: 'Ручной тип',
  facts: { manuallyVerified: true },
  specs: [
    { label: { ru: 'Напряжение' }, value: '24', unit: 'В' },
    { label: { ru: 'Момент' }, value: 'ручное значение', unit: 'Н·м' },
    { label: { ru: 'Пустой параметр' }, value: '', unit: 'мм' },
    { label: { ru: 'Ручная пометка' }, value: 'не трогать' },
  ],
};
const policySheet: CatalogSheet[] = [{
  name: 'Models',
  rows: [
    ['Модель', 'Изготовитель', 'Тип комплектующего', 'Название', 'Источник', 'Редакция', 'Страницы', 'Напряжение [В]', 'Момент [Н·м]', 'Пустой параметр [мм]', 'Новый параметр [шт]'],
    ['LM24-SRA', 'НЕМАН', 'Привод', 'Импортированное имя', 'new.pdf', '2026', '14–15', '230', '10', '8', '4'],
  ],
}];
const runPolicy = (policy: 'add' | 'fill' | 'update') => planCatalogSpreadsheet(policySheet, catalog([{ ...manual, specs: manual.specs?.map((s) => ({ ...s })) }]), { classId, policy })[0];
const added = runPolicy('add');
assert.equal(added.action, 'same');
assert.equal(added.component, added.before, 'режим add должен оставить существующую запись без изменений');
assert.equal(added.component?.title.ru, 'Ручное название');
assert.equal(added.component?.facts?.manuallyVerified, true);
const filled = runPolicy('fill');
assert.equal(filled.action, 'update');
assert.equal(filled.component?.title.ru, 'Ручное название');
assert.equal(filled.component?.equipmentType, 'Ручной тип');
assert.equal(filled.component?.catalog?.file, 'new.pdf');
assert.equal(filled.component?.specs?.find((s) => s.label.ru === 'Напряжение')?.value, '24');
assert.equal(filled.component?.specs?.find((s) => s.label.ru === 'Момент')?.value, 'ручное значение');
assert.equal(filled.component?.specs?.find((s) => s.label.ru === 'Пустой параметр')?.value, '8');
assert.equal(filled.component?.specs?.find((s) => s.label.ru === 'Ручная пометка')?.value, 'не трогать');
assert.equal(filled.component?.specs?.find((s) => s.label.ru === 'Новый параметр')?.value, '4');
assert.equal(filled.component?.facts?.manuallyVerified, true);
const updated = runPolicy('update');
assert.equal(updated.action, 'update');
assert.equal(updated.component?.title.ru, 'Импортированное имя');
assert.equal(updated.component?.equipmentType, 'Привод');
assert.equal(updated.component?.specs?.find((s) => s.label.ru === 'Напряжение')?.value, '230');
assert.equal(updated.component?.specs?.find((s) => s.label.ru === 'Момент')?.value, '10');
assert.equal(updated.component?.specs?.find((s) => s.label.ru === 'Ручная пометка')?.value, 'не трогать');
assert.equal(updated.component?.facts?.manuallyVerified, true);
assert.ok(updated.component?.classIds?.includes('cls-damper'));
assert.ok(updated.component?.familyIds?.includes('fam-smoke'));
assert.equal(manual.title.ru, 'Ручное название', 'план не должен изменять исходную запись');
assert.equal(manual.specs?.find((s) => s.label.ru === 'Напряжение')?.value, '24');

const formulaWide = planCatalogSpreadsheet([{
  name: 'Formula', rows: [['Модель', 'Изготовитель', 'Напряжение [В]'], ['LM24', 'НЕМАН', '__FORMULA_NO_RESULT__']],
}], catalog(), { classId, policy: 'add' });
assert.equal(formulaWide[0].action, 'error');
assert.ok(formulaWide[0].error?.includes('формулы'));
const formulaLong = planCatalogSpreadsheet([
  { name: 'Models', rows: [['Ключ модели', 'Модель', 'Изготовитель'], ['formula-row', 'LM24', 'НЕМАН']] },
  { name: 'Details', rows: [['Ключ модели', 'Параметр', 'Значение'], ['formula-row', 'Напряжение', '__FORMULA_NO_RESULT__']] },
], catalog(), { classId, policy: 'add' });
assert.equal(formulaLong[0].action, 'error');
assert.ok(formulaLong.some((row) => row.sheet === 'Details' && row.action === 'error'));

console.log('Табличный каталог: wide/long, ссылки по ID, точные ключи, повторы, политики, применяемость, формулы и metadata проверены.');
