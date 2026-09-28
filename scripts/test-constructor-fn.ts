/**
 * Проверка сводных функций Конструктора. Запуск:
 *   npx tsx scripts/test-constructor-fn.ts
 *
 * Проверяем отбор и арифметику на подставном срезе проекта — без базы:
 * ошибка здесь молча даёт неверный итог в книге, а это хуже пустой ячейки.
 */
import { findElement, filterElements, resolveValue } from '../server/projectSlice';
import { parseRuNumber } from '../server/normalize';

let ok = 0, fail = 0;
const eq = (name: string, got: any, want: any) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { ok++; return; }
  fail++;
  console.log(`  ✗ ${name}\n      получено: ${a}\n      ожидалось: ${b}`);
};

const el = (
  itemCode: string, equipType: string, sys: string, mono: string,
  specs: Record<string, Record<string, string>>, extra: any = {},
) => ({
  itemCode, name: itemCode, equipType, status: 'OK', version: 1, hasConflict: false,
  tags: [],
  specs: JSON.stringify({
    groups: Object.entries(specs).map(([title, params]) => ({
      title,
      params: Object.entries(params).map(([key, value]) => ({ key, value })),
    })),
  }),
  _system: { id: 's-' + sys, name: sys, category: 'AHU' },
  _monoblock: { id: 'm-' + mono, name: mono },
  ...extra,
});

const ELEMENTS = [
  el('бл1.1', 'ВЕНТИЛЯТОР', 'у1', 'мн1', { 'Аэродинамика': { 'Расход воздуха': '1250' } }),
  el('бл1.2', 'ВЕНТИЛЯТОР', 'у1', 'мн1', { 'Аэродинамика': { 'Расход воздуха': '2 500,5' } }),
  el('бл2.1', 'КЛАПАН', 'у1', 'мн2', { 'Аэродинамика': { 'Расход воздуха': '800' } },
     { hasConflict: true, conflictType: 'TYPE_MISMATCH', version: 3 }),
  el('бл3.1', 'КЛАПАН', 'у2', 'мн1', { 'Аэродинамика': { 'Расход воздуха': '' } }),
];

console.log('Поиск элемента');
{
  eq('по коду', findElement(ELEMENTS, 'бл2.1')?.itemCode, 'бл2.1');
  eq('без учёта регистра', findElement(ELEMENTS, 'БЛ2.1')?.itemCode, 'бл2.1');
  eq('несуществующий', findElement(ELEMENTS, 'бл9.9'), null);
  eq('пустой довод', findElement(ELEMENTS, ''), null);
}

console.log('Отбор для сводов');
{
  eq('без условия — все', filterElements(ELEMENTS).length, 4);
  eq('по типу', filterElements(ELEMENTS, 'equipType', 'КЛАПАН').length, 2);
  // Регистр не должен расходиться: в бланках тип пишут как придётся
  eq('регистр не мешает', filterElements(ELEMENTS, 'equipType', 'клапан').length, 2);
  eq('по установке', filterElements(ELEMENTS, 'system.name', 'у1').length, 3);
  eq('по моноблоку', filterElements(ELEMENTS, 'monoblock.name', 'мн1').length, 3);
  eq('условие без совпадений', filterElements(ELEMENTS, 'equipType', 'НАСОС').length, 0);
}

console.log('Своды по параметру');
{
  const nums = (field?: string, value?: string) =>
    filterElements(ELEMENTS, field, value)
      .map(e => resolveValue('element', e, 'param:Аэродинамика|Расход воздуха'))
      .filter(v => v !== '')
      .map(v => parseRuNumber(v))
      .filter((n): n is number => n != null && Number.isFinite(n));

  eq('сумма по всем', nums().reduce((a, b) => a + b, 0), 4550.5);
  eq('сумма по вентиляторам', nums('equipType', 'ВЕНТИЛЯТОР').reduce((a, b) => a + b, 0), 3750.5);
  eq('максимум', Math.max(...nums()), 2500.5);
  eq('минимум', Math.min(...nums()), 800);
  // Пустое значение в свод не идёт — иначе среднее поехало бы
  eq('сколько заполнено числом', nums().length, 3);
  eq('русское число с пробелом разобрано', nums().includes(2500.5), true);
}

console.log('Состояние элемента');
{
  const c = findElement(ELEMENTS, 'бл2.1')!;
  eq('конфликт виден', c.hasConflict ? String(c.conflictType) : '', 'TYPE_MISMATCH');
  eq('ревизия', Number(c.version), 3);
  const clean = findElement(ELEMENTS, 'бл1.1')!;
  eq('без конфликта — пусто', clean.hasConflict ? String(clean.conflictType) : '', '');
}

console.log('Свод по установке');
{
  const inSys = ELEMENTS.filter(e => String(e._system?.name).toLowerCase() === 'у1');
  eq('элементов в у1', inSys.length, 3);
  eq('моноблоков в у1', new Set(inSys.map(e => e._monoblock?.id)).size, 2);
}

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
