/** Широкая матрица отдельных маркировок и ограничений, с независимым оракулом по PDF. */
import assert from 'node:assert/strict';
import { veza2026Pack } from '../catalog/packs/veza2026';
import { buildDesignation, parseWithFamily, parseDesignation } from '../catalog/designation';
import { checkConfig } from '../catalog/rules';
import { seedCatalog } from '../catalog/seed';
import type { Family } from '../catalog/model';
let cases = 0;
const sizes = ['040','045','050','056','063','071','080','090','100','112','125'];
for (const f of veza2026Pack.families.filter(f => f.classId === 'fan')) {
  for (const fanSize of sizes) for (const poles of ['2','4','6']) for (const body of ['01','02']) for (const wheelMod of ['А','Б','И','Т']) for (const wheelIndex of ['40','50','70']) {
    const values = { fanSize, poles, body, wheelMod, wheelIndex, execution:'Н', motorIndex:'00400', climate:'У1' };
    const expected = `${f.code}-${fanSize}/${wheelMod}-${wheelIndex}-Н-00400/${poles}-У1-${body}`;
    const built = buildDesignation(f, values);
    assert.equal(built.text, expected); assert.deepEqual(built.missing, []);
    const parsed = parseWithFamily(f, expected);
    assert.equal(parsed.complete, true, expected); assert.deepEqual(parsed.values, values);
    const permissible = poles === '4' || (poles === '2' && sizes.indexOf(fanSize) <= 4) || (poles === '6' && sizes.indexOf(fanSize) >= 5);
    assert.equal(checkConfig(f, values).some(v => v.level === 'error'), !permissible, `${expected}: правила PDF 6`);
    assert.equal(parseDesignation(veza2026Pack.families, expected).filter(r => r.complete).length, 1);
    cases++;
  }
}
const baseline = seedCatalog().families[0];
const pressure: Family = { ...baseline, id:'pressure-model', code:'P', params:[{ key:'pressure', label:{ru:'Давление'}, kind:'number' }], positions:[{key:'code',label:{ru:'Модель'},formats:['P']},{key:'pressure',label:{ru:'Давление'},formats:['{pressure}']}], designationSeparator:':', rules:[], specs:[] };
for (const value of [-10, 0, 10.25]) { const text = `P:${value}`; assert.equal(buildDesignation(pressure,{pressure:value}).text,text); assert.equal(parseWithFamily(pressure,text).values.pressure,value); cases++; }
const indexed: Family = { ...pressure, code:'M', params:[{key:'index',label:{ru:'Индекс'},kind:'text'},{key:'poles',label:{ru:'Полюсы'},kind:'number'}], positions:[{key:'model',label:{ru:'Модель'},formats:['M']},{key:'motor',label:{ru:'Двигатель'},formats:['{index}/{poles}']}] };
assert.deepEqual(parseWithFamily(indexed,'M:00400/2').values,{index:'00400',poles:2}); cases++;
const article: Family = { ...pressure, designationMode:'article', code:'ART-001', article:'ART-001', aliases:['Арт.001'], params:[],positions:[] };
assert.equal(buildDesignation(article,{}).text,'ART-001'); assert.equal(parseWithFamily(article,'ART-001').complete,true); assert.equal(parseWithFamily(article,'ART-001-extra').complete,false); cases++;
console.log(`✓ ${cases} сочетаний: маркировки ОСА 300/301, допустимость полюсов, независимый разделитель, нуль/отрицательные величины, текстовый индекс и точный артикул`);
