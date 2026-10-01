import assert from 'node:assert/strict';
import type { Component } from '../catalog/model';
import { resolveCatalogSpecs, sourceGroups } from '../equipment/catalogSpecs';
import { componentKey, matchComponent, modelCode } from '../catalog/componentCatalog';

const actuator = (code: string, manufacturer = 'НЕМАН', specs: Component['specs'] = []): Component => ({
  id: `${manufacturer}-${code}`, classId: 'cls-valve', kind: 'actuator', code, manufacturer,
  title: { ru: code }, specs,
});
const spec = (label: string, value: string, unit?: string) => ({ label: { ru: label }, value, ...(unit ? { unit } : {}) });
const effective = (result: ReturnType<typeof resolveCatalogSpecs>, key: string) => result.effective.find((p) => p.key === key);

const sharedModel = actuator('LM24-SRA', 'НЕМАН', [
  spec('Напряжение питания', '230', 'В'),
  spec('Степень защиты', 'IP66'),
  spec('Температура работы', '-40…+60', '°C'),
  spec('Расчётная мощность', '7', 'ВА'),
  spec('Мощность при работе двигателя', '3', 'Вт'),
  spec('Мощность при удержании', '1', 'Вт'),
  spec('Новая характеристика', '12', 'мм'),
]);
const rawGroups = [{ title: 'Электрика', params: [
  { key: 'Номинальное напряжение', value: '24', unit: 'В' },
  { key: 'Степень защиты корпуса', value: 'IP54' },
  { key: 'Температура окружающей среды', value: '-30…+50', unit: '°C' },
  { key: 'Расчётная мощность', value: '5', unit: 'ВА' },
  { key: 'Мощность при работе двигателя', value: '2', unit: 'Вт' },
  { key: 'Мощность при удержании', value: '0,5', unit: 'Вт' },
] }];
const parsedXml = resolveCatalogSpecs(rawGroups, {}, 'xml', sharedModel);
assert.equal(effective(parsedXml, 'Номинальное напряжение')?.value, '24');
assert.equal(effective(parsedXml, 'Номинальное напряжение')?.source, 'xml');
assert.equal(effective(parsedXml, 'Расчётная мощность')?.value, '5');
assert.equal(parsedXml.groups.some((g) => g.title === 'Характеристики из каталога'), false, 'режим xml не должен добавлять данные каталога');

const catalogMode = resolveCatalogSpecs(rawGroups, {}, 'catalog', sharedModel);
assert.equal(effective(catalogMode, 'Номинальное напряжение')?.value, '230', 'проверенный синоним должен связывать напряжение');
assert.equal(effective(catalogMode, 'Номинальное напряжение')?.source, 'catalog');
assert.equal(effective(catalogMode, 'Степень защиты корпуса')?.value, 'IP66');
assert.equal(effective(catalogMode, 'Температура окружающей среды')?.value, '-40…+60');
assert.equal(effective(catalogMode, 'Расчётная мощность')?.value, '7');
assert.equal(effective(catalogMode, 'Мощность при работе двигателя')?.value, '3');
assert.equal(effective(catalogMode, 'Мощность при удержании')?.value, '1');
assert.equal(catalogMode.effective.find((p) => p.key === 'Новая характеристика')?.group, 'Характеристики из каталога');
assert.equal(catalogMode.effective.find((p) => p.key === 'Новая характеристика')?.source, 'catalog');

const hybridRaw = [{ title: 'Электрика', params: [
  { key: 'Номинальное напряжение', value: '', unit: 'В' },
  { key: 'Расчётная мощность', value: 'ручное значение', unit: 'ВА' },
] }];
const hybrid = resolveCatalogSpecs(hybridRaw, {}, 'hybrid', sharedModel);
assert.equal(effective(hybrid, 'Номинальное напряжение')?.value, '230', 'гибрид должен заполнить пустое XML-значение');
assert.equal(effective(hybrid, 'Номинальное напряжение')?.source, 'catalog');
assert.equal(effective(hybrid, 'Расчётная мощность')?.value, 'ручное значение', 'гибрид должен сохранить заданное значение');
assert.equal(effective(hybrid, 'Расчётная мощность')?.source, 'xml');

for (const mode of ['xml', 'catalog', 'hybrid'] as const) {
  const blankOverride = resolveCatalogSpecs(
    [{ title: 'Электрика', params: [{ key: 'Номинальное напряжение', value: '24', unit: 'В' }] }],
    { 'Электрика||Номинальное напряжение': '' }, mode, sharedModel,
  );
  assert.equal(effective(blankOverride, 'Номинальное напряжение')?.value, '', `пустая ручная замена сохраняется в ${mode}`);
  assert.equal(effective(blankOverride, 'Номинальное напряжение')?.source, 'manual');
}

const incompatible = resolveCatalogSpecs(
  [{ title: 'Механика', params: [{ key: 'Момент', value: '', unit: 'Н·м' }] }], {}, 'catalog',
  actuator('NM24', 'НЕМАН', [spec('Момент', '5', 'кгс·м')]),
);
assert.equal(effective(incompatible, 'Момент')?.value, '', 'несовместимая единица не заменяет XML-ячейку');
assert.equal(incompatible.groups.some((g) => g.title === 'Характеристики из каталога'), false, 'несовместимая величина не должна маскироваться новой записью');

const powerAliases = resolveCatalogSpecs(
  [{ title: 'Электрика', params: [
    { key: 'Мощность двигателя', value: 'ручные данные', unit: 'Вт' },
    { key: 'Расчётная мощность', value: 'ручное ВА', unit: 'ВА' },
  ] }], {}, 'catalog', sharedModel,
);
assert.equal(effective(powerAliases, 'Мощность двигателя')?.value, 'ручные данные', 'лейбл мощности двигателя не сливается с расчётной мощностью');
assert.equal(effective(powerAliases, 'Расчётная мощность')?.value, '7');
assert.equal(powerAliases.effective.find((p) => p.key === 'Мощность при работе двигателя')?.value, '3');
assert.equal(powerAliases.effective.find((p) => p.key === 'Мощность при удержании')?.value, '1');

const legacyObject = sourceGroups({ voltage: { value: 24, unit: 'В' }, ip: 'IP54' });
assert.equal(legacyObject.length, 1);
assert.equal(legacyObject[0].title, 'Параметры');
assert.deepEqual(legacyObject[0].params, [
  { key: 'voltage', value: '24', unit: 'В' },
  { key: 'ip', value: 'IP54', unit: '' },
]);
assert.deepEqual(sourceGroups('{broken legacy JSON'), []);
assert.deepEqual(resolveCatalogSpecs('{broken legacy JSON', null, 'hybrid').effective, []);
const legacyJson = sourceGroups(JSON.stringify({ groups: [{ title: 'Старый XML', params: [{ key: 'Код', value: 'A1' }] }] }));
assert.equal(legacyJson[0].title, 'Старый XML');
assert.equal(legacyJson[0].params[0].value, 'A1');

const models = [
  actuator('LM24-SR'), actuator('LM24-SRZ'), actuator('LM24-SRA'),
  actuator('LM24-SR', 'ДРУГОЙ ЗАВОД'),
];
assert.equal(modelCode('LM24–SRZ'), 'LM24-SRZ');
assert.deepEqual(matchComponent(models, 'LM24-SR').map((m) => m.manufacturer), ['НЕМАН', 'ДРУГОЙ ЗАВОД']);
assert.deepEqual(matchComponent(models, 'LM24-SRZ', 'НЕМАН').map((m) => m.code), ['LM24-SRZ']);
assert.deepEqual(matchComponent(models, 'LM24-SRA', 'НЕМАН').map((m) => m.code), ['LM24-SRA']);
assert.equal(matchComponent(models, 'LM24-SRZ', 'НЕСУЩЕСТВУЮЩИЙ').length, 0);
assert.notEqual(componentKey(models[0]), componentKey(models[3]), 'изготовитель входит в ключ модели');
assert.notEqual(componentKey(models[0]), componentKey({ ...models[0], kind: 'box' }), 'тип комплектующего входит в ключ модели');

console.log('Источники характеристик: режимы, ручные замены, единицы, алиасы, legacy и точное сопоставление проверены.');
