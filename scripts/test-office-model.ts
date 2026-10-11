import { canApplyOfficePlan, evaluateOfficeParts, planOfficeFill, type OfficeHeaderAnchor, type OfficeEntityRow } from '../src/lib/officeModel';

let ok = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) ok++;
  else { fail++; console.error(`  ✗ ${name}\n      получили ${JSON.stringify(got)}\n      ждали    ${JSON.stringify(want)}`); }
}
const binding = (fieldKey: string, unit?: string) => ({ fieldKey, sourceId: 'equipment', entityType: 'element', entityId: null, sourceRevision: 'R4', anchorId: `anchor-${fieldKey}`, ...(unit ? { unit } : {}) });
const row: OfficeEntityRow = { entityId: 'EQ-1', entityType: 'element', sourceId: 'equipment', values: { p: { value: '1,25', unit: 'кВт', revision: 'R4' }, q: { value: 750, unit: 'W', revision: 'R4' }, count: { value: 2 } } };

console.log('1. Безопасное выражение шапки');
eq('сложение кВт и W выполняется точно', evaluateOfficeParts([
  { kind: 'field', binding: binding('p') }, { kind: 'operator', operator: '+' }, { kind: 'field', binding: binding('q') },
], row), { value: { value: '2000', unit: 'W' } });
eq('приоритет умножения и скобки', evaluateOfficeParts([
  { kind: 'operator', operator: '(' }, { kind: 'field', binding: binding('p') }, { kind: 'operator', operator: '+' }, { kind: 'field', binding: binding('q') },
  { kind: 'operator', operator: ')' }, { kind: 'operator', operator: '*' }, { kind: 'field', binding: binding('count') },
], row), { value: { value: '4000', unit: 'W' } });
eq('деление на ноль не превращается в ноль', evaluateOfficeParts([{ kind: 'field', binding: binding('p') }, { kind: 'operator', operator: '/' }, { kind: 'text', text: '0' }], row), { error: 'Деление на ноль' });
eq('несовместимые размерности не складываются', evaluateOfficeParts([
  { kind: 'field', binding: binding('p') }, { kind: 'operator', operator: '+' }, { kind: 'text', text: '1' },
], row), { error: 'Нельзя складывать поля с разными единицами' });
eq('текст рядом с меткой остаётся частью результата', evaluateOfficeParts([{ kind: 'text', text: 'Итого: ' }, { kind: 'field', binding: binding('p') }, { kind: 'text', text: ' кВт' }], row), { value: { value: 'Итого: 1,25 кВт' } });

console.log('\n2. Объединение и план заполнения');
eq('равный приоритет двух источников — конфликт', evaluateOfficeParts([{
  kind: 'union', mode: 'first-match', alternatives: [
    { ...binding('p'), priority: 1 }, { ...binding('q'), priority: 1 },
  ],
}], row), { conflict: ['p', 'q'] });
const anchor: OfficeHeaderAnchor = { kind: 'excel-range', id: 'power-column', sheetName: 'Ведомость', address: 'C2', parts: [{ kind: 'field', binding: binding('p') }] };
const plan = planOfficeFill({ baseHash: 'doc-v1', sourceRevision: 'R4', selectedEntityIds: ['EQ-1', 'EQ-2'], rows: [row], anchors: [anchor], existingRows: [{ rowId: 'r1', entityId: 'EQ-1' }, { rowId: 'r-manual', manuallyEdited: true }] });
eq('повторная привязка обновляет ту же сущность, а не добавляет дубль', [plan.adds, plan.replaces], [[], ['EQ-1']]);
eq('ручная строка отдельно сохраняется в плане', plan.manualRows, ['r-manual']);
eq('нет значения выбранной сущности не удаляет старую строку', plan.skips, [{ entityId: 'EQ-2', anchorId: '', reason: 'Сущность отсутствует в текущей выборке' }]);
eq('совпадающий документ и источник позволяют подтвердить план', canApplyOfficePlan(plan, { baseHash: 'doc-v1', sourceRevision: 'R4', selectedEntityIds: ['EQ-2', 'EQ-1'] }), { ok: true });
eq('устаревший хеш блокирует запись', canApplyOfficePlan(plan, { baseHash: 'doc-v2', sourceRevision: 'R4', selectedEntityIds: ['EQ-1', 'EQ-2'] }), { ok: false, reason: 'Документ изменился после предпросмотра' });

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
