import { canApplyOfficePlan, evaluateOfficeParts, officeEntityId, planOfficeFill, type OfficeHeaderAnchor, type OfficeEntityRow } from '../src/lib/officeModel';

let ok = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) ok++;
  else { fail++; console.error(`  ✗ ${name}\n      получили ${JSON.stringify(got)}\n      ждали    ${JSON.stringify(want)}`); }
}
const binding = (fieldKey: string, unit?: string) => ({ fieldKey, sourceId: 'equipment', entityType: 'element', entityId: null, sourceRevision: 'R4', anchorId: `anchor-${fieldKey}`, ...(unit ? { unit } : {}) });
const row: OfficeEntityRow = { entityId: 'EQ-1', entityType: 'element', sourceId: 'equipment', values: { p: { value: '1,25', unit: 'кВт', revision: 'R4' }, q: { value: 750, unit: 'W', revision: 'R4' }, count: { value: 2 } } };

console.log('1. Безопасное выражение шапки');
eq('tag и equipment с одинаковым raw ID имеют разные стабильные IDs', officeEntityId('tags', 'tag', '42') === officeEntityId('equipment', 'element', '42'), false);
eq('сложение кВт и W выполняется точно', evaluateOfficeParts([
  { kind: 'field', binding: binding('p') }, { kind: 'operator', operator: '+' }, { kind: 'field', binding: binding('q') },
], row), { value: { value: '2', unit: 'кВт' } });
eq('формула начинается со знака равно и складывает два параметра', evaluateOfficeParts([
  { kind: 'text', text: '=' }, { kind: 'field', binding: binding('p') }, { kind: 'text', text: ' + ' }, { kind: 'field', binding: binding('q') },
], row), { value: { value: '2', unit: 'кВт' } });
eq('курсору доступны начало, скобки и числовой множитель формулы', evaluateOfficeParts([
  { kind: 'text', text: '= (' }, { kind: 'field', binding: binding('p') }, { kind: 'text', text: '+' }, { kind: 'field', binding: binding('q') }, { kind: 'text', text: ') × 2' },
], row), { value: { value: '4', unit: 'кВт' } });
eq('в формуле сохраняется контроль деления на ноль', evaluateOfficeParts([
  { kind: 'text', text: '=' }, { kind: 'field', binding: binding('p') }, { kind: 'text', text: '÷0' },
], row), { error: 'Деление на ноль' });
eq('один знак равно не даёт пустой успешный результат', !!evaluateOfficeParts([{ kind: 'text', text: '=' }], row).error, true);

console.log('1a. Функции формул Flux (SUM/AVG/MIN/MAX/COUNT/CONCAT)');
const T = (text: string) => ({ kind: 'text' as const, text });
const F = (key: string) => ({ kind: 'field' as const, binding: binding(key) });
eq('SUM складывает параметры в разных единицах', evaluateOfficeParts([T('=SUM('), F('p'), T(', '), F('q'), T(')')], row), { value: { value: '2', unit: 'кВт' } });
eq('русское СУММ и «;» как разделитель равны SUM', evaluateOfficeParts([T('=СУММ('), F('p'), T(';'), F('q'), T(')')], row), { value: { value: '2', unit: 'кВт' } });
eq('AVG берёт среднее', evaluateOfficeParts([T('=AVG('), F('p'), T(', '), F('q'), T(')')], row), { value: { value: '1', unit: 'кВт' } });
eq('MAX и MIN выбирают крайнее', [evaluateOfficeParts([T('=MAX('), F('p'), T(', '), F('q'), T(')')], row).value?.value, evaluateOfficeParts([T('=МИН('), F('p'), T(', '), F('q'), T(')')], row).value?.value], ['1.25', '0.75']);
eq('функция входит в арифметику: SUM(...) × 2', evaluateOfficeParts([T('=SUM('), F('p'), T(', '), F('q'), T(')×2')], row), { value: { value: '4', unit: 'кВт' } });
eq('COUNT считает непустые аргументы', evaluateOfficeParts([T('=COUNT('), F('p'), T(', '), F('nothing'), T(', '), F('count'), T(')')], row), { value: { value: '2' } });
eq('SUM без закрывающей скобки — ошибка, а не молчаливый ноль', !!evaluateOfficeParts([T('=SUM('), F('p')], row).error, true);
eq('запятая сразу после «)» — разделитель аргументов, а не дробь «.1»', evaluateOfficeParts([T('=SUM(SUM('), F('p'), T(', '), F('q'), T('),1)')], row), { error: 'Нельзя складывать поля с разными единицами' });
eq('обычный текст «Sum(1,2)» без знака равно остаётся текстом', evaluateOfficeParts([T('Sum(1,2)')], row), { value: { value: 'Sum(1,2)' } });
eq('приоритет умножения и скобки', evaluateOfficeParts([
  { kind: 'operator', operator: '(' }, { kind: 'field', binding: binding('p') }, { kind: 'operator', operator: '+' }, { kind: 'field', binding: binding('q') },
  { kind: 'operator', operator: ')' }, { kind: 'operator', operator: '*' }, { kind: 'field', binding: binding('count') },
], row), { value: { value: '4', unit: 'кВт' } });
eq('унарный минус поля применяется до умножения', evaluateOfficeParts([
  { kind: 'text', text: '2' }, { kind: 'operator', operator: '*' }, { kind: 'operator', operator: '-' }, { kind: 'field', binding: binding('p') },
], row), { value: { value: '-2.5', unit: 'кВт' } });
eq('отрицание скобочного выражения работает', evaluateOfficeParts([
  { kind: 'operator', operator: '-' }, { kind: 'operator', operator: '(' }, { kind: 'field', binding: binding('p') }, { kind: 'operator', operator: '+' }, { kind: 'field', binding: binding('q') }, { kind: 'operator', operator: ')' },
], row), { value: { value: '-2', unit: 'кВт' } });
eq('текстовый suffix переводит результат в указанную единицу и не дублирует её', evaluateOfficeParts([
  { kind: 'text', text: 'Итого: ' }, { kind: 'field', binding: binding('p') }, { kind: 'operator', operator: '+' }, { kind: 'field', binding: binding('q') }, { kind: 'text', text: ' кВт' },
], row), { value: { value: 'Итого: 2 кВт' } });
eq('деление на ноль не превращается в ноль', evaluateOfficeParts([{ kind: 'field', binding: binding('p') }, { kind: 'operator', operator: '/' }, { kind: 'text', text: '0' }], row), { error: 'Деление на ноль' });

// Единицы в формулах: результат — в единице первого слагаемого, а не в основной (кВт + кВт — это кВт, а не ватты)
const unitRow: OfficeEntityRow = { entityId: 'EQ-2', entityType: 'element', sourceId: 'equipment', values: {
  kw: { value: '2,5', unit: 'кВт' }, w: { value: 200, unit: 'Вт' }, m1: { value: '635', unit: 'кг' }, m2: { value: '405', unit: 'кг' }, l: { value: '1365', unit: 'мм' }, h: { value: '2550', unit: 'мм' },
  kva: { value: '33.71', unit: 'кВ·А' }, kva2: { value: '2.4', unit: 'кВ·А' }, none: { value: null }, word: { value: 'слева' },
} };
const U = (...parts: any[]) => evaluateOfficeParts(parts.map((part) => typeof part === 'string' ? (/^[-+*/()]$/.test(part) ? { kind: 'operator' as const, operator: part } : { kind: 'text' as const, text: part }) : { kind: 'field' as const, binding: binding(part.key) }), unitRow);
const K = (key: string) => ({ key });
eq('кВт + кВт остаётся в кВт', U('=', K('kw'), '+', K('kw')), { value: { value: '5', unit: 'кВт' } });
eq('кВт + Вт (русское «Вт» известно) — в единице первого слагаемого', U('=', K('kw'), '+', K('w')), { value: { value: '2.7', unit: 'кВт' } });
eq('Вт + кВт — в Вт', U('=', K('w'), '+', K('kw')), { value: { value: '2700', unit: 'Вт' } });
eq('масса + масса в килограммах', U('=', K('m1'), '+', K('m2')), { value: { value: '1040', unit: 'кг' } });
eq('высота − длина в миллиметрах', U('=', K('h'), '-', K('l')), { value: { value: '1185', unit: 'мм' } });
eq('умножение на число не меняет единицу', U('=', K('m1'), '*', '2'), { value: { value: '1270', unit: 'кг' } });
eq('деление на число не меняет единицу', U('=', K('m1'), '/', '5'), { value: { value: '127', unit: 'кг' } });
eq('кВ·А + кВ·А — полная мощность', U('=', K('kva'), '+', K('kva2')), { value: { value: '36.11', unit: 'кВ·А' } });
eq('кг + мм не складываются', U('=', K('m1'), '+', K('l')), { error: 'Нельзя складывать поля с разными единицами' });
eq('кВт + кВ·А не складываются (разные величины)', U('=', K('kw'), '+', K('kva')), { error: 'Нельзя складывать поля с разными единицами' });
eq('операнда нет в источнике — «значения нет» (ячейка не пишется), а не ноль и не ошибка плана', U('=', K('m1'), '+', K('none')), { error: 'Источник не вернул значение' });
eq('в плане такая строка пропускается, а подтверждение не блокируется ошибкой', (() => {
  const plan = planOfficeFill({ baseHash: 'h', sourceRevision: 'r', selectedEntityIds: ['EQ-2'], rows: [unitRow], anchors: [{ id: 'a', kind: 'excel-range', sheetName: 'Л', address: 'A1', parts: [{ kind: 'text', text: '=' }, { kind: 'field', binding: binding('m1') }, { kind: 'operator', operator: '+' }, { kind: 'field', binding: binding('none') }] }] });
  return [plan.writes.length, plan.errors.length, plan.skips.length];
})(), [0, 0, 1]);
eq('текст вместо числа — тоже ошибка', U('=', K('m1'), '+', K('word')).error?.startsWith('Поле «word»'), true);
eq('несовместимые размерности не складываются', evaluateOfficeParts([
  { kind: 'field', binding: binding('p') }, { kind: 'operator', operator: '+' }, { kind: 'text', text: '1' },
], row), { error: 'Нельзя складывать поля с разными единицами' });
eq('текст рядом с меткой остаётся частью результата', evaluateOfficeParts([{ kind: 'text', text: 'Итого: ' }, { kind: 'field', binding: binding('p') }, { kind: 'text', text: ' кВт' }], row), { value: { value: 'Итого: 1,25 кВт' } });

console.log('\n2. Объединение и план заполнения');
eq('равный приоритет двух источников — конфликт', evaluateOfficeParts([{
  kind: 'union', mode: 'first-match', alternatives: [
    { ...binding('p'), priority: 1 }, { ...binding('q'), priority: 1 },
  ],
}], row), { conflict: ['equipment:element:p', 'equipment:element:q'] });
eq('union не выбирает кандидата из другого source/type', evaluateOfficeParts([{
  kind: 'union', mode: 'first-match', alternatives: [
    { ...binding('count'), sourceId: 'tags', entityType: 'tag', priority: 1 }, { ...binding('p'), sourceId: 'equipment', entityType: 'element', priority: 2 },
  ],
}], row), { value: { value: '1,25', unit: 'кВт', revision: 'R4' } });
eq('обычное поле также проверяет sourceId и entityType', evaluateOfficeParts([
  { kind: 'field', binding: { ...binding('p'), sourceId: 'tags', entityType: 'tag' } },
], row), { error: 'Источник не вернул значение' });
// Оба параметра у позиции заполнены: порядок решает, исключение по позиции перекрывает порядок
const bothRow: OfficeEntityRow = { entityId: 'EQ-9', entityType: 'element', sourceId: 'equipment', values: { p: { value: '10', unit: 'кВт' }, q: { value: '20', unit: 'кВт' } } };
const twoParams = (extra: Record<string, unknown> = {}) => [{ kind: 'union' as const, mode: 'first-match' as const, alternatives: [{ ...binding('p'), priority: 0 }, { ...binding('q'), priority: 1 }], ...extra }];
eq('объединение: у позиции заполнены оба — берётся первый по порядку', evaluateOfficeParts(twoParams(), bothRow), { value: { value: '10', unit: 'кВт' } });
eq('объединение: исключение по позиции берёт названный параметр', evaluateOfficeParts(twoParams({ picks: { 'EQ-9': 'q' } }), bothRow), { value: { value: '20', unit: 'кВт' } });
eq('объединение: исключение чужой позиции ничего не меняет', evaluateOfficeParts(twoParams({ picks: { 'EQ-1': 'q' } }), bothRow), { value: { value: '10', unit: 'кВт' } });
eq('объединение: исключение на пустой параметр не отнимает значения', evaluateOfficeParts(twoParams({ picks: { 'EQ-1': 'zz' } }), row), evaluateOfficeParts(twoParams(), row));
const anchor: OfficeHeaderAnchor = { kind: 'excel-range', id: 'power-column', sheetName: 'Ведомость', address: 'C2', parts: [{ kind: 'field', binding: binding('p') }] };
const plan = planOfficeFill({ baseHash: 'doc-v1', sourceRevision: 'R4', selectedEntityIds: ['EQ-1', 'EQ-2'], rows: [row], anchors: [anchor], existingRows: [{ rowId: 'r1', entityId: 'EQ-1' }, { rowId: 'r-manual', manuallyEdited: true }] });
eq('повторная привязка обновляет ту же сущность, а не добавляет дубль', [plan.adds, plan.replaces], [[], ['EQ-1']]);
eq('ручная строка отдельно сохраняется в плане', plan.manualRows, ['r-manual']);
eq('нет значения выбранной сущности не удаляет старую строку', plan.skips, [{ entityId: 'EQ-2', anchorId: '', reason: 'Сущность отсутствует в текущей выборке' }]);
eq('совпадающий документ и источник позволяют подтвердить план', canApplyOfficePlan(plan, { baseHash: 'doc-v1', sourceRevision: 'R4', selectedEntityIds: ['EQ-2', 'EQ-1'] }), { ok: true });
eq('устаревший хеш блокирует запись', canApplyOfficePlan(plan, { baseHash: 'doc-v2', sourceRevision: 'R4', selectedEntityIds: ['EQ-1', 'EQ-2'] }), { ok: false, reason: 'Документ изменился после предпросмотра' });
const missingFieldAnchor: OfficeHeaderAnchor = { kind: 'excel-range', id: 'note-column', sheetName: 'Ведомость', address: 'D2', parts: [{ kind: 'field', binding: binding('missingField') }] };
const missingFieldPlan = planOfficeFill({ baseHash: 'doc-v1', sourceRevision: 'R4', selectedEntityIds: ['EQ-1'], rows: [row], anchors: [anchor, missingFieldAnchor] });
eq('пустой параметр у выбранной позиции попадает в пропуски, а не в ошибки плана', [missingFieldPlan.errors, missingFieldPlan.skips], [[], [{ entityId: 'EQ-1', anchorId: 'note-column', reason: 'Источник не вернул значение; существующая ячейка сохраняется' }]]);
eq('план с пропущенными пустыми параметрами разрешено подтвердить и заполнить', canApplyOfficePlan(missingFieldPlan, { baseHash: 'doc-v1', sourceRevision: 'R4', selectedEntityIds: ['EQ-1'] }), { ok: true });
const duplicatePlan = planOfficeFill({ baseHash: 'doc-v1', sourceRevision: 'R4', selectedEntityIds: ['EQ-1'], rows: [row], anchors: [anchor], existingRows: [{ rowId: 'r1', entityId: 'EQ-1' }, { rowId: 'r2', entityId: 'EQ-1' }] });
eq('две прежние строки одной сущности требуют разрешения', duplicatePlan.conflicts, [{ entityId: 'EQ-1', anchorId: '', candidates: ['r1', 'r2'] }]);
eq('конфликт запрещает подтверждение плана', canApplyOfficePlan(duplicatePlan, { baseHash: 'doc-v1', sourceRevision: 'R4', selectedEntityIds: ['EQ-1'] }), { ok: false, reason: 'В плане остались ошибки или конфликты' });

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
