import assert from 'node:assert/strict';
import { sourceValuesEqual } from '../equipment/sourceValueComparison.ts';

let checks = 0;
const eq = (name: string, a: any, b: any, expected: boolean) => {
  assert.equal(sourceValuesEqual(a, b), expected, name);
  checks++;
};

eq('integer and decimal comma represent the same finite number', { value: '1200' }, { value: '1 200,0' }, true);
eq('decimal dot and comma normalize for numeric values', { value: '1.2', unit: 'кВт' }, { value: '1,2', unit: 'kW' }, true);
eq('kW converts to W', { value: '1.2', unit: 'кВт' }, { value: '1200', unit: 'W' }, true);
eq('mm converts through cm to m', { value: '1000', unit: 'мм' }, { value: '1', unit: 'm' }, true);
eq('Pa converts to kPa', { value: '1000', unit: 'Pa' }, { value: '1', unit: 'кПа' }, true);
eq('m³/h converts to m³/s', { value: '3600', unit: 'm3/h' }, { value: '1', unit: 'м³/с' }, true);
eq('unlisted mass units do not convert', { value: '1', unit: 'кг' }, { value: '1000', unit: 'г' }, false);
eq('unknown units compare after trimming only', { value: '2', unit: 'rpm' }, { value: '2.0', unit: ' rpm ' }, true);
eq('unit spelling case is retained for unknown units', { value: '2', unit: 'mW' }, { value: '2', unit: 'MW' }, false);
eq('unitless number does not match a typed value', { value: '1' }, { value: '1', unit: 'm' }, false);
eq('different dimensions never match', { value: '1', unit: 'm' }, { value: '1', unit: 'Pa' }, false);
eq('Celsius aliases match but Kelvin stays a separate scale', { value: '20', unit: '°C' }, { value: '20', unit: 'K' }, false);
eq('equivalent Celsius spelling normalizes', { value: '20', unit: '°C' }, { value: '20,0', unit: '°С' }, true);
eq('near floating point values use relative epsilon', { value: 1 }, { value: 1 + 5e-10 }, true);
eq('relative epsilon does not blur a real difference', { value: 1 }, { value: 1 + 5e-8 }, false);
eq('relative epsilon stays relative near zero', { value: 0 }, { value: 1e-12 }, false);
eq('zero is not missing', { value: 0 }, { value: '' }, false);
eq('empty and null remain distinct', { value: '' }, { value: null }, false);
eq('null and undefined remain distinct', { value: null }, { value: undefined }, false);
eq('matching missing states remain equal', { value: undefined }, { value: undefined }, true);
eq('blank text ignores surrounding whitespace only', { value: '   ' }, { value: '' }, true);
eq('text compares case and repeated whitespace without changing commas', { value: 'IP54  Class A' }, { value: 'ip54 class a' }, true);
eq('text punctuation is not discarded', { value: 'A, B' }, { value: 'A B' }, false);
eq('numeric prefixes in arbitrary text are not parsed', { value: 'IP54' }, { value: '54' }, false);
eq('numeric suffixes are not parsed as values', { value: '12 mm' }, { value: '12', unit: 'mm' }, false);
eq('nonfinite numeric values are never equal', { value: Number.POSITIVE_INFINITY }, { value: Number.POSITIVE_INFINITY }, false);
eq('matching boolean source values remain equal', { value: true }, { value: true }, true);

console.log(`${checks} checks passed`);
