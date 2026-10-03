import { catalogDifferences } from '../catalog/review';

let ok = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) ok++;
  else { fail++; console.error(`✗ ${name}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`); }
}
const before = { code: 'ФАН', _draftVersion: 'a', params: [{ key: 'voltage', label: { ru: 'Напряжение' }, min: 24 }, { key: 'power', max: 40 }] };
eq('служебная версия не выдаётся за изменение модели', catalogDifferences(before, { ...before, _draftVersion: 'b' }), []);
eq('изменение параметра привязано к ключу, а не номеру строки', catalogDifferences(before, { ...before, params: [{ ...before.params[0], min: 48 }, before.params[1]] }), [{ path: 'params[voltage].min', before: '24', after: '48' }]);
const swapped = catalogDifferences(before, { ...before, params: [...before.params].reverse() });
eq('перестановка сегментов маркировки видна проверяющему', swapped.map(d => d.path), ['params.Порядок']);
eq('перестановка не представляется ложными правками характеристик', swapped.length, 1);
eq('удалённое значение отличается от пустого', catalogDifferences({ unit: 'В' }, {}), [{ path: 'unit', before: 'В', after: 'Не указано' }]);
eq('числовой ноль не пропадает при сравнении', catalogDifferences({ min: 1 }, { min: 0 })[0].after, '0');
eq('нет изменения между одинаковыми документами', catalogDifferences(before, structuredClone(before)), []);
eq('большой пакет ограничивает вывод сравнения', catalogDifferences({ a: 1, b: 2, c: 3 }, { a: 2, b: 3, c: 4 }, 2).length, 2);
eq('длинное примечание не раздувает таблицу сравнения', catalogDifferences({ note: '' }, { note: 'Я'.repeat(2000) })[0].after.length, 800);
console.log(`${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
