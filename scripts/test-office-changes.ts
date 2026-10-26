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
  assert.equal(r.count, 2);

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
