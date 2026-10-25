/**
 * Круг «Flux → xlsx → правка во внешнем редакторе → обратно во Flux»: привязки
 * параметров (флаги) остаются на своих ячейках, что бы с книгой ни сделали.
 *
 * Внешнюю правку имитируют двое:
 *   - «Excel»: меняет значение, вставляет строку над шапкой (имена ячеек Excel
 *     сдвигает сам), переименовывает заголовок, переписывает строки листов в общую
 *     таблицу строк — и может выбросить часть customXml, о которой не знает;
 *   - библиотека чтения таблиц (SheetJS): читает книгу и пишет заново, часть
 *     customXml при этом теряется всегда.
 * Схема переживает обоих: она лежит ещё и на скрытом листе FLUX_SCHEMA.
 *
 * Без сервера и базы: проверяется то, что делает сервер с байтами пакета.
 */
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { makeXlsx } from './officeHarness';
import { excelSaves, insertRowAbove, setCellText } from './officeExternalEdit';
import { readOfficeBindings, writeOfficeBindings, carryOfficeBindings, type OfficePackageBindings } from '../server/officeBindings';
import { FLUX_SHEET, readFluxSheet } from '../office/fluxPart';

const ID = {
  tag: '0b1b8a50-1111-4a4a-8a8a-aaaaaaaaaaa1',
  mass: '0b1b8a50-2222-4a4a-8a8a-aaaaaaaaaaa2',
  merged: '0b1b8a50-3333-4a4a-8a8a-aaaaaaaaaaa3',
};
const binding = (anchorId: string, fieldKey: string, extra: object = {}) => ({ fieldKey, sourceId: 'equipment', entityType: 'element', entityId: null, sourceRevision: 'R1', anchorId, ...extra });
const schema: OfficePackageBindings = {
  version: 1, schemaVersion: 1, sourceRevision: 'R1',
  anchors: [
    { id: ID.tag, kind: 'excel-range', sheet: 'Перечень', address: 'A1', parts: [{ kind: 'field', binding: binding(ID.tag, 'tag', { label: 'Тег' }) }] },
    { id: ID.mass, kind: 'excel-range', sheet: 'Перечень', address: 'B1', parts: [{ kind: 'field', binding: binding(ID.mass, 'param:Блок|Масса', { unit: 'кг', label: 'Масса, кг' }) }] },
    { id: ID.merged, kind: 'excel-range', sheet: 'Перечень', address: 'C1', parts: [{ kind: 'union', mode: 'first-match', label: 'Мощность', alternatives: [
      { ...binding(ID.merged, 'param:Двигатель|Мощность', { unit: 'кВт' }), priority: 1 }, { ...binding(ID.merged, 'param:Блок|Установленная мощность', { unit: 'кВ·А' }), priority: 2 },
    ] }] },
  ],
  rows: [{ entityId: 'office:equipment:element:EQ-1', entityType: 'element', sourceId: 'equipment', sourceRevision: 'R1', anchorIds: [ID.tag, ID.mass], cells: { [ID.tag]: 'A2', [ID.mass]: 'B2' }, values: { [ID.tag]: 'BL-1', [ID.mass]: '635' } }],
};
const nameOf = (id: string) => `FLUX_ANCHOR_${id.replaceAll('-', '_')}`;

/** Книга так, как её оставляет редактор Flux: имена ячеек шапки на месте, схема записана */
async function fluxBook(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await makeXlsx());
  const names = [['A', ID.tag], ['B', ID.mass], ['C', ID.merged]].map(([col, id]) => `<definedName name="${nameOf(id!)}">'Перечень'!$${col}$1</definedName>`).join('');
  const wb = await zip.file('xl/workbook.xml')!.async('string');
  zip.file('xl/workbook.xml', wb.replace('</definedNames>', `${names}</definedNames>`));
  return writeOfficeBindings(await zip.generateAsync({ type: 'nodebuffer' }), schema);
}

async function main() {
  const base = await fluxBook();
  const first = await readOfficeBindings(base);
  assert.ok(first, 'схема читается сразу после записи');
  assert.equal(await (await JSZip.loadAsync(base)).file('customXml/itemFluxOffice.xml') !== null, true, 'часть customXml записана');
  const sheetText = await readFluxSheet(await JSZip.loadAsync(base));
  assert.ok(sheetText && sheetText.includes('urn:flux:office:v1'), 'та же схема лежит на скрытом листе');
  assert.match(await (await JSZip.loadAsync(base)).file('xl/workbook.xml')!.async('string'), new RegExp(`<sheet name="${FLUX_SHEET}"[^>]*state="veryHidden"`), 'лист схемы не виден в списке листов Excel');

  // 1. Excel вставил строку над шапкой, переименовал заголовок и поменял значение:
  //    адреса ячеек шапки сдвинулись вместе с именами, а привязки остались на своих ячейках
  const shifted = await setCellText(await setCellText(await insertRowAbove(base, 1), 'B2', 'Масса блока (внеш.)'), 'B3', '999');
  const afterInsert = await readOfficeBindings(shifted);
  assert.deepEqual(afterInsert!.anchors.map((a) => a.address), ['A2', 'B2', 'C2'], 'адреса шапки берутся из имён, которые сдвинул Excel');
  assert.deepEqual(afterInsert!.anchors.map((a) => a.parts), schema.anchors.map((a) => a.parts), 'части шапки (параметры, подписи, единицы, объединение) не изменились');
  assert.ok((await (await JSZip.loadAsync(shifted)).file('xl/worksheets/sheet1.xml')!.async('string')).includes('Масса блока (внеш.)'), 'проверка: заголовок во внешней правке переименован');

  // 2. Excel сохранил книгу и выбросил часть customXml
  const dropped = await excelSaves(shifted, { dropCustomXml: true });
  assert.equal((await JSZip.loadAsync(dropped)).file('customXml/itemFluxOffice.xml'), null, 'проверка: части customXml в файле нет');
  const afterDrop = await readOfficeBindings(dropped);
  assert.ok(afterDrop, 'без части customXml схема читается со скрытого листа');
  assert.deepEqual(afterDrop!.anchors.map((a) => [a.address, a.parts]), [['A2', schema.anchors[0]!.parts], ['B2', schema.anchors[1]!.parts], ['C2', schema.anchors[2]!.parts]], 'привязки на тех же ячейках, параметры целы');
  assert.deepEqual(afterDrop!.rows, schema.rows, 'связи заполненных строк целы');

  // 3. Независимая библиотека: читает и пишет книгу заново (customXml теряется всегда)
  const wbLib = XLSX.read(shifted, { type: 'buffer' });
  const viaLib = Buffer.from(XLSX.write(wbLib, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal((await JSZip.loadAsync(viaLib)).file('customXml/itemFluxOffice.xml'), null, 'проверка: библиотека часть customXml не сохранила');
  const afterLib = await readOfficeBindings(viaLib);
  assert.ok(afterLib, 'после пересохранения библиотекой схема читается со скрытого листа');
  assert.deepEqual(afterLib!.anchors.map((a) => a.parts), schema.anchors.map((a) => a.parts), 'библиотека: параметры шапки целы');
  assert.deepEqual(afterLib!.anchors.map((a) => a.address), ['A2', 'B2', 'C2'], 'библиотека: имена ячеек сохранены, адреса верны');
  const hiddenState = wbLib.Workbook?.Sheets?.find((s) => s.name === FLUX_SHEET)?.Hidden;
  assert.equal(hiddenState, 2, 'библиотека видит лист схемы как «очень скрытый»');

  // 4. Удалили столбец шапки (имя стало #REF!): привязки больше нет, остальные на месте
  const zip = await JSZip.loadAsync(shifted);
  const wb = await zip.file('xl/workbook.xml')!.async('string');
  zip.file('xl/workbook.xml', wb.replace(new RegExp(`(<definedName name="${nameOf(ID.mass)}">)[^<]*`), '$1#REF!'));
  const afterDelete = await readOfficeBindings(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.deepEqual(afterDelete!.anchors.map((a) => a.id), [ID.tag, ID.merged], 'привязка удалённой ячейки снята, остальные остались');
  assert.deepEqual(afterDelete!.rows[0]!.anchorIds, [ID.tag], 'связь строки с удалённым столбцом снята');

  // 5. Сохранение из редактора со старой копией листа не откатывает схему сервера
  const newer: OfficePackageBindings = { ...schema, anchors: [{ ...schema.anchors[0]!, parts: [{ kind: 'text', text: 'Новая шапка' }] }, ...schema.anchors.slice(1)] };
  const serverCopy = await writeOfficeBindings(base, newer);
  const editorBody = await insertRowAbove(base, 99); // редактор несёт прежнюю схему и в части, и на листе
  const carried = await carryOfficeBindings(serverCopy, editorBody);
  assert.equal(((await readOfficeBindings(carried))!.anchors[0]!.parts[0] as { text: string }).text, 'Новая шапка', 'схема сервера не откатилась (часть)');
  const carriedSheet = await readFluxSheet(await JSZip.loadAsync(carried));
  assert.ok(carriedSheet?.includes('Новая шапка'), 'схема сервера не откатилась (скрытый лист)');

  // 6. Большая схема: режется на ячейки столбца A и читается обратно целиком
  const big: OfficePackageBindings = { ...schema, anchors: Array.from({ length: 400 }, (_, i) => ({ id: `0b1b8a50-0000-4a4a-8a8a-${String(i).padStart(12, '0')}`, kind: 'excel-range' as const, sheet: 'Перечень', address: `A${i + 1}`, parts: [{ kind: 'text' as const, text: `Параметр ${i} `.repeat(30) }] })), rows: [] };
  const bigBytes = await writeOfficeBindings(await makeXlsx(), big);
  const viaLibBig = Buffer.from(XLSX.write(XLSX.read(bigBytes, { type: 'buffer' }), { type: 'buffer', bookType: 'xlsx' }));
  assert.equal((await readOfficeBindings(viaLibBig))!.anchors.length, 400, 'схема длиннее ячейки читается целиком после библиотеки');

  console.log('test-office-excel-roundtrip: все проверки пройдены');
}
main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
