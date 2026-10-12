import assert from 'node:assert/strict';
import { resolveOfficeUnit } from '../server/officeData.js';

const element = { specs: { groups: [{ title: 'Электрика', params: [{ key: 'Мощность', value: '2,4', unit: 'кВт' }] }] } };
assert.equal(resolveOfficeUnit('param:Электрика|Мощность', element, []), 'кВт');
assert.equal(resolveOfficeUnit('param:@Power', element, [{ name: 'Power', unit: 'кВт' }]), 'кВт');
assert.equal(resolveOfficeUnit('param:@Missing', element, []), undefined);
assert.equal(resolveOfficeUnit('equipType', element, []), undefined);
console.log('4 проверки единиц данных Office пройдены');
