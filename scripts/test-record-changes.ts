/**
 * Перечень «Поле: было → стало» при отказе по версии (решение: .claude/progress/conflict-details.md, раздел 1).
 *
 * Без браузера и службы: общее сравнение (src/lib/recordChanges.ts) и правила оборудования
 * (src/components/equipment/changeRules.ts) на голых объектах. Записи — в том виде, как они приходят
 * на экран: из дерева (характеристики подменены каталогом, сырые — в originalSpecs; теги — { id, identifier })
 * и из отказа (сырая строка базы; теги — { id, code }).
 *
 * Запуск: npx tsx scripts/test-record-changes.ts
 */
import assert from 'node:assert/strict';
import { changesBetween, shownValue, EMPTY_SHOWN } from '../src/lib/recordChanges';
import { equipmentChanges } from '../src/components/equipment/changeRules';

let passed = 0;
const same = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); passed++; console.log(`  ✓ ${name}`); };
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };

const specs = (power: string, extra: Array<{ key: string; value: string; unit?: string }> = []) => JSON.stringify({
  groups: [{ title: 'Основные', params: [{ key: 'Мощность', value: power, unit: 'кВт' }, { key: 'Расход', value: '1000', unit: 'м3/ч' }, ...extra] }],
});

/** Позиция в дереве: specs подменены каталогом (там лишний мусор), сырые — в originalSpecs. */
const shownFan = {
  id: 'c1', version: 1, name: 'Вентилятор А', itemCode: 'FAN-A', status: 'OK', equipClass: '', equipKind: '',
  instanceNo: null, instanceCount: null, hasConflict: false,
  specs: JSON.stringify({ groups: [{ title: 'Из каталога', params: [{ key: 'Масса', value: '99', unit: 'кг' }] }] }),
  originalSpecs: specs('5'), overrides: null, tags: [{ id: 't1', identifier: 'В1' }],
};
/** Текущая запись из отказа: сырая строка базы. */
const currentFan = (patch: Record<string, unknown> = {}) => ({
  id: 'c1', version: 2, name: 'Вентилятор А', itemCode: 'FAN-A', status: 'OK', equipClass: null, equipKind: null,
  instanceNo: null, instanceCount: null, hasConflict: false, updatedAt: '2026-11-15T10:00:00Z',
  specs: specs('5'), overrides: null, tags: [{ id: 't1', code: 'В1' }], ...patch,
});

console.log('1. Общее сравнение');
same('записи равны — перечня нет', changesBetween({ a: 1 }, { a: 1 }, [{ label: 'А', value: (r) => r.a }]), []);
same('простое поле: было и стало', changesBetween({ a: 'x' }, { a: 'y' }, [{ label: 'А', value: (r) => r.a }]), [{ label: 'А', was: 'x', now: 'y' }]);
same('пустое — прочерк, в обе стороны', changesBetween({ a: '' }, { a: 'y' }, [{ label: 'А', value: (r) => r.a }]), [{ label: 'А', was: EMPTY_SHOWN, now: 'y' }]);
same('пробелы вокруг значения — не изменение', changesBetween({ a: ' x ' }, { a: 'x' }, [{ label: 'А', value: (r) => r.a }]), []);
same('число 0 — значение, а не пусто', changesBetween({ a: 0 }, { a: null }, [{ label: 'А', value: (r) => r.a }]), [{ label: 'А', was: '0', now: EMPTY_SHOWN }]);
same('значения для показа', [shownValue(null), shownValue(undefined), shownValue('  '), shownValue(true), shownValue(false), shownValue([1, 'b']), shownValue([])], [EMPTY_SHOWN, EMPTY_SHOWN, EMPTY_SHOWN, 'да', 'нет', '1, b', EMPTY_SHOWN]);
same('нет показанной записи или текущей — сравнивать нечего', [changesBetween(null, { a: 1 }, [{ label: 'А', value: (r) => r.a }]), changesBetween({ a: 1 }, null, [{ label: 'А', value: (r) => r.a }]), changesBetween('x', {}, [])], [[], [], []]);
same('развёрнутое поле: одна строка на изменённую', changesBetween(
  { list: [1, 2] }, { list: [1, 3, 4] },
  [{ label: 'Список', rows: (r) => r.list.map((n: number) => ({ label: `№${n}`, value: 'есть' })) }],
), [{ label: '№2', was: 'есть', now: EMPTY_SHOWN }, { label: '№3', was: EMPTY_SHOWN, now: 'есть' }, { label: '№4', was: EMPTY_SHOWN, now: 'есть' }]);
same('правило без полей не даёт перечня', changesBetween({ a: 1 }, { a: 2 }, []), []);

console.log('2. Правила оборудования: позиция');
same('сырой specs из отказа против originalSpecs дерева: подмена каталогом не шумит', equipmentChanges('component', shownFan, currentFan()), []);
same('служебное (версия, дата) в перечень не входит', equipmentChanges('component', shownFan, currentFan({ version: 9, updatedAt: 'иначе', id: 'c1' })), []);
same('название и обозначение', equipmentChanges('component', shownFan, currentFan({ name: 'Вентилятор Б', itemCode: 'FAN-B' })), [
  { label: 'Название', was: 'Вентилятор А', now: 'Вентилятор Б' }, { label: 'Обозначение', was: 'FAN-A', now: 'FAN-B' },
]);
{
  const t = equipmentChanges('component', shownFan, currentFan({ equipClass: 'ФИЛЬТР', equipKind: 'Карманный' }));
  same('тип: класс и вид одной строкой, было — «—» (определялся сам)', [t.length, t[0]?.label, t[0]?.was, /Карманный/.test(t[0]?.now || '')], [1, 'Тип', EMPTY_SHOWN, true]);
}
same('состояние', equipmentChanges('component', shownFan, currentFan({ status: 'CONFLICT' })), [{ label: 'Состояние', was: 'OK', now: 'CONFLICT' }]);
same('число экземпляров', equipmentChanges('component', shownFan, currentFan({ instanceNo: 2, instanceCount: 3 })), [
  { label: 'Номер экземпляра', was: EMPTY_SHOWN, now: '2' }, { label: 'Количество', was: EMPTY_SHOWN, now: '3' },
]);
same('характеристики: одна строка на изменённую, неизменённые молчат', equipmentChanges('component', shownFan, currentFan({ specs: specs('7') })), [
  { label: 'Основные · Мощность', was: '5 кВт', now: '7 кВт' },
]);
same('характеристики: две правки — две строки, добавленная и убранная', equipmentChanges('component', shownFan, currentFan({
  specs: JSON.stringify({ groups: [{ title: 'Основные', params: [{ key: 'Мощность', value: '8', unit: 'кВт' }, { key: 'Давление', value: '300', unit: 'Па' }] }] }),
})), [
  { label: 'Основные · Мощность', was: '5 кВт', now: '8 кВт' },
  { label: 'Основные · Расход', was: '1000 м3/ч', now: EMPTY_SHOWN },
  { label: 'Основные · Давление', was: EMPTY_SHOWN, now: '300 Па' },
]);
same('ручное значение: появилось, затем поменялось', equipmentChanges('component', { ...shownFan, overrides: JSON.stringify({ 'Основные||Расход': '2000' }) }, currentFan({ overrides: JSON.stringify({ 'Основные||Расход': '2500', 'Основные||Мощность': '9' }) })), [
  { label: 'Основные · Расход (вручную)', was: '2000', now: '2500' },
  { label: 'Основные · Мощность (вручную)', was: EMPTY_SHOWN, now: '9' },
]);
same('теги: привязан и отвязан — по строке на тег (в дереве identifier, в отказе code)', equipmentChanges('component', shownFan, currentFan({ tags: [{ id: 't2', code: 'В2' }] })), [
  { label: 'Тег В1', was: 'привязан', now: EMPTY_SHOWN }, { label: 'Тег В2', was: EMPTY_SHOWN, now: 'привязан' },
]);
same('повреждённый JSON не роняет разбор', equipmentChanges('component', shownFan, currentFan({ specs: '{не json', overrides: '[[' })).map((c) => c.label), ['Основные · Мощность', 'Основные · Расход']);

console.log('3. Правила оборудования: блок и установка');
same('блок', equipmentChanges('monoblock', { name: 'М1', version: 1 }, { name: 'М2', version: 2 }), [{ label: 'Название', was: 'М1', now: 'М2' }]);
same('установка', equipmentChanges('system', { name: 'УВ-1', category: 'AHU', fileName: null, version: 1 }, { name: 'УВ-1а', category: 'FAN', fileName: 'a.xml', version: 2, createdAt: 'x' }), [
  { label: 'Название', was: 'УВ-1', now: 'УВ-1а' }, { label: 'Категория', was: 'AHU', now: 'FAN' }, { label: 'Файл', was: EMPTY_SHOWN, now: 'a.xml' },
]);
ok('сравнение не меняет записи', (() => { const before = JSON.stringify(shownFan); equipmentChanges('component', shownFan, currentFan({ name: 'Z' })); return JSON.stringify(shownFan) === before; })());

console.log(`\nПройдено проверок: ${passed}`);
