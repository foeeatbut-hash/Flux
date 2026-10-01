import assert from 'node:assert/strict';
import { NEMAN_COMPONENTS, NEMAN_MANUFACTURER } from '../catalog/actuator/neman';

const components = NEMAN_COMPONENTS as unknown as Array<Record<string, any>>;
const byCode = new Map(components.map((item) => [item.code, item]));
const spec = (code: string, label: string) => {
  const found = byCode.get(code);
  assert.ok(found, `нет модели ${code}`);
  const row = found.specs?.find((entry: any) => entry.label?.ru === label);
  assert.ok(row, `нет параметра «${label}» у ${code}`);
  return row.value;
};

assert.equal(NEMAN_MANUFACTURER.id, 'mf-neman');
assert.equal(NEMAN_MANUFACTURER.name, 'НЕМАН');
assert.equal(components.length, 76, 'в seed должно быть 76 моделей');
assert.equal(byCode.size, 76, 'обозначения моделей должны быть уникальными');
assert.equal(new Set(components.map((item) => item.id)).size, 76, 'id моделей должны быть уникальными');
for (const item of components) {
  assert.equal(item.classId, 'cls-valve');
  assert.equal(item.kind, 'actuator');
  assert.equal(item.manufacturer, 'НЕМАН');
  assert.equal(item.catalog?.edition, '2026');
  assert.equal(item.catalog?.file, 'HEMAH_Каталог основных видов_2026 [lUHZBf].pdf');
  assert.ok(item.sourcePdfPage >= 1, `нет PDF-страницы ${item.code}`);
  assert.ok(item.specs.some((entry: any) => entry.label?.ru === 'Время поворота двигателя'), `нет времени поворота ${item.code}`);
  assert.ok(item.specs.some((entry: any) => entry.label?.ru === 'Масса'), `нет массы ${item.code}`);
  assert.ok(item.specs.some((entry: any) => entry.label?.ru === 'Расчётная мощность' && entry.unit === 'ВА'), `нет расчётной мощности ${item.code}`);
  assert.ok(item.specs.some((entry: any) => entry.label?.ru === 'Температура хранения'), `нет температуры хранения ${item.code}`);
  if (item.facts.springReturn) assert.ok(item.specs.some((entry: any) => entry.label?.ru === 'Время пружинного возврата'), `нет времени пружинного возврата ${item.code}`);
  assert.equal(item.catalog?.pages, `${2 * (item.sourcePdfPage - 1)}–${2 * (item.sourcePdfPage - 1) + 1}`, `ошибка печатной страницы ${item.code}`);
  assert.equal(item.status, 'partial');
  assert.ok(!Object.values(item.facts ?? {}).some((value) => value === null), `null не допускается вместо неизвестного факта: ${item.code}`);
}

assert.equal(spec('LM24', 'Номинальное напряжение'), '24');
assert.equal(spec('LM230', 'Номинальное напряжение'), '230');
assert.equal(byCode.get('LM24').facts.supplyType, 'AC/DC');
assert.equal(byCode.get('LM230').facts.supplyType, 'AC');
assert.equal(byCode.get('LM24-S2').facts.auxSwitches, 2);
assert.equal(byCode.get('LM24').facts.auxSwitches, undefined);
assert.equal(byCode.get('LF24-SR-5').facts.signal, '2…10 В DC');
assert.equal(byCode.get('LF24-SRZ-5').facts.signal, '0…10 В DC');
assert.notEqual(byCode.get('LF24-SR-5').facts.signal, byCode.get('LF24-SRZ-5').facts.signal);
assert.equal(spec('BLE24-10', 'Мощность при работе двигателя'), '5,5');
assert.equal(spec('BLE230-10', 'Мощность при работе двигателя'), '4');
assert.equal(spec('BLE24-10', 'Расчётная мощность'), '7');
assert.equal(spec('BLE230-10', 'Расчётная мощность'), '5');
assert.equal(spec('BLE24-10', 'Мощность при удержании'), '0,8');
assert.equal(spec('BLE230-10', 'Мощность при удержании'), '0,6');
assert.equal(spec('BFG24-20', 'Расчётная мощность'), '40');
assert.equal(spec('BFG230-20', 'Мощность при работе двигателя'), '20');
assert.equal(spec('BLF24-3', 'Мощность при удержании'), '3,5');
for (const code of ['LM230-SRA', 'LM230-SRA-S2', 'BLF24-5-T', 'BLF230-5-T']) {
  assert.equal(byCode.get(code)?.specs.some((entry: any) => entry.label?.ru === 'Мощность при работе двигателя'), false, `неоднозначная единица не должна угадываться: ${code}`);
}

console.log('НЕМАН: 76 уникальных моделей, изготовитель и печатные страницы проверены; различия напряжения, SR/SRZ и BLE24/BLE230 сохранены.');
