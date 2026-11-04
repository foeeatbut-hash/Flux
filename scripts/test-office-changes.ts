/**
 * Сверка документа с источниками (server/officeChanges.ts): что устарело, где
 * лежит и что было → стало. Без сервера и базы: источник подменён таблицей строк.
 */
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { makeDocx, makeXlsx } from './officeHarness';
import { writeOfficeBindings, officeRowMarker, type OfficePackageBindings } from '../server/officeBindings';
import { officeChangesOfContent } from '../server/officeChanges';
import { insertRowAbove, setCellText } from './officeExternalEdit';
import type { OfficeEntityRow } from '../src/lib/officeModel';
import { isRewritten } from '../src/components/office/FluxChangesList';
import { changeKey, groupChanges, pendingCount, refreshOperations, undoWithoutManual } from '../src/components/office/officeRefreshPreview';

const ANCHOR = '0b1b8a50-9999-4a4a-8a8a-aaaaaaaaaaa1';
const E1 = 'office:equipment:element:EQ-1', E2 = 'office:equipment:element:EQ-2', E3 = 'office:equipment:element:EQ-3';
const binding = { fieldKey: 'param:Блок|Масса', sourceId: 'equipment', entityType: 'element', entityId: null, sourceRevision: 'R1', unit: 'кг', anchorId: ANCHOR };
const row = (entityId: string, raw: string, address: string, value: string) => ({
  entityId, entityType: 'element', sourceId: 'equipment', sourceRevision: 'R1', anchorIds: [ANCHOR], cells: { [ANCHOR]: address }, values: { [ANCHOR]: value }, raw,
});
const schema: OfficePackageBindings = {
  version: 1, schemaVersion: 1, sourceRevision: 'R1',
  anchors: [{ id: ANCHOR, kind: 'excel-range', sheet: 'Перечень', address: 'B1', parts: [{ kind: 'field', binding }] }],
  rows: [row(E1, 'EQ-1', 'B2', '3'), row(E2, 'EQ-2', 'B3', '4'), row(E3, 'EQ-3', 'B4', '7')].map(({ raw: _raw, ...r }) => r),
};

/** Источник: значения параметра по позициям; позиции без записи в карте в источнике нет */
const source = (values: Record<string, string | null>) => async (_projectId: string, body: any): Promise<{ rows: OfficeEntityRow[]; sourceRevision: string }> => {
  assert.equal(body.entity, 'element', 'запрос идёт по источнику строк документа');
  assert.ok(body.columns.includes('param:Блок|Масса'), 'колонки запроса — поля шапки');
  const label = (id: string) => ({ tag: { value: id.slice(-4) }, name: { value: `Позиция ${id.slice(-4)}` } });
  return { sourceRevision: 'R2', rows: Object.entries(values).map(([id, value]) => ({ entityId: id, entityType: 'element', sourceId: 'equipment', values: { ...label(id), 'param:Блок|Масса': { value, unit: 'кг' } } })) as OfficeEntityRow[] };
};

async function book(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await makeXlsx());
  const rowNames = [[E1, 2], [E2, 3], [E3, 4]].map(([id, at]) => `<definedName name="${officeRowMarker('equipment', 'element', String(id), 'Перечень')}">'Перечень'!$B$${at}</definedName>`).join('');
  const names = `<definedName name="FLUX_ANCHOR_${ANCHOR.replaceAll('-', '_')}">'Перечень'!$B$1</definedName>${rowNames}`;
  zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml')!.async('string')).replace('</definedNames>', `${names}</definedNames>`));
  // Ячейка B4 в фикстуре пуста: кладём записанное Flux значение
  const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  zip.file('xl/worksheets/sheet1.xml', sheet.replace(/<c r="B4"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="B4"><v>7</v></c>'));
  return writeOfficeBindings(await zip.generateAsync({ type: 'nodebuffer' }), schema);
}

async function main() {
  const base = await book();
  // 1. Данные те же — документ актуален
  let r = await officeChangesOfContent(base, 'P', source({ [E1]: '3', [E2]: '4', [E3]: '7' }));
  assert.equal(r.stale, false, 'на тех же данных документ актуален');
  assert.equal(r.changes.length, 0);
  assert.equal(r.rows, 3);

  // 2. Значение в источнике изменилось: где, было, стало, единица
  r = await officeChangesOfContent(base, 'P', source({ [E1]: '5', [E2]: '4', [E3]: '7' }));
  assert.equal(r.stale, true);
  assert.equal(r.count, 1);
  assert.deepEqual({ ...r.changes[0], entityId: undefined }, { kind: 'changed', entityId: undefined, entityLabel: 'EQ-1', anchorId: ANCHOR, column: 'Количество', sheet: 'Перечень', address: 'B2', was: '3', now: '5', unit: 'кг' });

  // 3. Правка внешним редактором сдвинула строки: адрес берётся из имён, а не из записанных
  const shifted = await insertRowAbove(base, 1);
  r = await officeChangesOfContent(shifted, 'P', source({ [E1]: '5', [E2]: '4', [E3]: '7' }));
  assert.equal(r.changes[0]!.address, 'B3', 'после вставки строки значение найдено там, где его теперь держит имя строки');
  assert.equal(r.changes[0]!.column, 'Количество', 'заголовок — тот, что видит человек в ячейке шапки');

  // 4. Ячейку правили руками: «было» — то, что в ячейке, строка не считается устаревшей
  const manual = await setCellText(base, 'B3', '9');
  r = await officeChangesOfContent(manual, 'P', source({ [E1]: '3', [E2]: '4', [E3]: '7' }));
  assert.equal(r.count, 0, 'ручная правка в счёт устаревшего не идёт');
  assert.deepEqual(r.changes.map((c) => [c.address, c.was, c.now, c.manual]), [['B3', '9', '4', true]], 'но видна в списке с пометкой');
  assert.equal(r.stale, false);

  // 5. Значение пропало из источника, позиция исчезла, у позиции появилось значение
  r = await officeChangesOfContent(base, 'P', source({ [E1]: null, [E2]: '4' }));
  assert.deepEqual(r.changes.map((c) => [c.kind, c.address, c.was, c.now]), [['cleared', 'B2', '3', null], ['row-removed', 'B4', null, null]]);
  assert.equal(r.count, 2, "до пометки пропавшее значение и снятая позиция устарели (полоса висит); после применения — см. ниже, решение 4.11.2026");
  // «Изменится значений» и «из них изменилось» в панели считают только то, что «Обновить» перепишет:
  // пропавшее и исчезнувшее документ не стирает, ручную правку не заменяет
  assert.equal(r.changes.filter(isRewritten).length, 0, 'пропавшее значение и исчезнувшая позиция в «изменится» не идут');
  r = await officeChangesOfContent(base, 'P', source({ [E1]: '5', [E2]: '4' }));
  assert.deepEqual(r.changes.map((c) => [c.kind, c.address, isRewritten(c)]), [['changed', 'B2', true], ['row-removed', 'B4', false]], 'из двух устаревших переписывается одно');
  r = await officeChangesOfContent(manual, 'P', source({ [E1]: '3', [E2]: '4', [E3]: '7' }));
  assert.equal(r.changes.filter(isRewritten).length, 0, 'ручную правку «Обновить» не заменит');

  // Исчезнувшую позицию узнают по тому, что осталось в её строке документа (колонка тега), а не по внутреннему номеру
  const LABEL_ANCHOR = '0b1b8a50-9999-4a4a-8a8a-aaaaaaaaaaa2';
  const named = await writeOfficeBindings(base, {
    ...schema,
    anchors: [...schema.anchors, { id: LABEL_ANCHOR, kind: 'excel-range', sheet: 'Перечень', address: 'A1', parts: [{ kind: 'field', binding: { ...binding, fieldKey: 'tag', unit: undefined, anchorId: LABEL_ANCHOR } }] }],
    rows: schema.rows.map((row, at) => ({ ...row, anchorIds: [ANCHOR, LABEL_ANCHOR], cells: { ...row.cells, [LABEL_ANCHOR]: `A${at + 2}` }, values: { ...row.values, [LABEL_ANCHOR]: ['Насос', 'Клапан', 'Итого'][at]! } })),
  });
  r = await officeChangesOfContent(named, 'P', source({ [E1]: '3', [E2]: '4' }));
  assert.equal(r.changes.find((c) => c.kind === 'row-removed')?.entityLabel, 'Итого', 'исчезнувшая позиция названа по ячейке её строки');

  // Решение владельца 4.11.2026 (меняет решение 25.10): «Обновить» не оставляет полосу висеть. До пометки
  // пропавшее значение и снятая позиция считаются устаревшими (count == 2, как раньше) ...
  const gone = source({ [E1]: null, [E2]: '4' });
  // ... после очистки ячейки (в схеме «было» стало пустым) и пометки строки полоса уходит
  const afterApply = await writeOfficeBindings(base, { ...schema, rows: schema.rows.map((x) => x.entityId === E1 ? { ...x, values: { [ANCHOR]: '' } } : x.entityId === E3 ? { ...x, removed: '2026-11-04T10:00:00.000Z' } : x) });
  r = await officeChangesOfContent(afterApply, 'P', gone);
  assert.equal(r.count, 0, 'очищенное значение и помеченная строка в счёт устаревшего не идут');
  assert.equal(r.stale, false, 'полоса уходит после применения');
  assert.deepEqual(r.changes.map((c) => [c.kind, c.marked ?? false]), [['row-removed', true]], 'помеченная строка остаётся в списке как справка');
  // Позиция вернулась в источник: пометка не мешает, значения сверяются как обычно
  r = await officeChangesOfContent(afterApply, 'P', source({ [E1]: '3', [E2]: '4', [E3]: '8' }));
  assert.deepEqual(r.changes.map((c) => [c.kind, c.address, c.was, c.now]), [['changed', 'B4', '7', '8']], 'вернувшаяся позиция сверяется как обычно (B2 в фикстуре осталась со старым значением — оно совпало с источником)');

  // Предпросмотр: группы, галочки, что уйдёт редактору и что вернёт отмена
  const planWrites = [{ entityId: E2, anchorId: ANCHOR, value: '5' }];
  r = await officeChangesOfContent(base, 'P', source({ [E1]: null, [E2]: '5' }));
  const groups = groupChanges(r.changes);
  assert.deepEqual([groups.values.length, groups.cleared.length, groups.removed.length], [1, 1, 1], 'три группы: значения, пропавшие, снятые');
  let ops = refreshOperations(planWrites, groups, new Set());
  assert.deepEqual(ops.writes, [...planWrites, { entityId: E1, anchorId: ANCHOR, value: '' }], 'по умолчанию: значение пишется, пропавшее очищается');
  assert.deepEqual(ops.mark, [E3], 'снятая позиция помечается, а не удаляется');
  assert.deepEqual(ops.undo.writes, [{ entityId: E2, anchorId: ANCHOR, value: '4' }, { entityId: E1, anchorId: ANCHOR, value: '3' }], 'отмена возвращает прежние значения');
  assert.deepEqual(ops.undo.unmark, [E3]);
  assert.equal(pendingCount(groups, new Set()), 3);
  const off = new Set(groups.values.concat(groups.removed).map(changeKey));
  ops = refreshOperations(planWrites, groups, off);
  assert.deepEqual(ops.writes, [{ entityId: E1, anchorId: ANCHOR, value: '' }], 'снятая галочка убирает запись из плана');
  assert.deepEqual(ops.mark, [], 'снятая галочка не метит строку');
  assert.equal(pendingCount(groups, off), 1);
  assert.deepEqual(undoWithoutManual(refreshOperations(planWrites, groups, new Set()).undo, [E1]).writes.map((w) => w.entityId), [E2], 'позицию с ручной правкой отмена не трогает');
  assert.equal(groupChanges((await officeChangesOfContent(manual, 'P', source({ [E1]: '3', [E2]: '4', [E3]: '7' }))).changes).manual.length, 1, 'ручные правки — справка, не действие');

  // 6. Данные не тронуты: проверка ничего не пишет
  assert.deepEqual(await officeChangesOfContent(base, 'P', source({ [E1]: '3', [E2]: '4', [E3]: '7' })).then((x) => x.stale), false);
  // 7. Документ (Word): места нет адреса ячейки — строку держит закладка, переход идёт по ней
  const WORD_ANCHOR = '0b1b8a50-8888-4a4a-8a8a-aaaaaaaaaaa1';
  const wordSchema: OfficePackageBindings = {
    version: 1, schemaVersion: 1, sourceRevision: 'R1',
    anchors: [{ id: WORD_ANCHOR, kind: 'word-row', part: 'word/document.xml', parts: [{ kind: 'field', binding: { ...binding, anchorId: WORD_ANCHOR, label: 'Масса, кг' } }] }],
    rows: [{ entityId: E1, entityType: 'element', sourceId: 'equipment', sourceRevision: 'R1', anchorIds: [WORD_ANCHOR], cells: { [WORD_ANCHOR]: 'FLUXROW_aaaaaaaaaaaaaaaa' }, values: { [WORD_ANCHOR]: '3' } }],
  };
  const word = await writeOfficeBindings(await makeDocx(), wordSchema);
  r = await officeChangesOfContent(word, 'P', source({ [E1]: '5' }));
  assert.equal(r.count, 1, 'Word: устаревшее найдено');
  const c = r.changes[0]!;
  assert.deepEqual([c.kind, c.entityLabel, c.bookmark, c.was, c.now, c.unit], ['changed', 'EQ-1', 'FLUXROW_aaaaaaaaaaaaaaaa', '3', '5', 'кг'], 'Word: место — закладка строки, без адреса ячейки');
  assert.equal(c.column, 'Масса, кг', 'Word: колонка названа по подписи параметра');
  assert.equal(r.changes[0]!.address, undefined);

  console.log('test-office-changes: все проверки пройдены');
}
main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
