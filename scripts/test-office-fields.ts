/**
 * Поля и блоки данных проекта в файлах Flux Office — без сервера и редактора.
 *
 * Что стережёт (office/fieldKeys.ts, server/officeFields.ts):
 *   - ключ поля записывается в файл и читается обратно одинаково — иначе поле,
 *     вставленное в окне, сервер бы не узнал и оставил старое значение;
 *   - «обновить» правит только результат поля Word и ячейку имени Excel:
 *     остальной XML части и остальные части файла — байт в байт;
 *   - неизменившееся значение не переписывает файл вовсе;
 *   - чужие поля (DATE, REF), поле со сложным содержимым и ключ без значения
 *     не трогаются;
 *   - блок растягивает и сжимает свой диапазон, очищая ставшее лишним, и не
 *     задевает соседей.
 *
 * Запуск: npx tsx scripts/test-office-fields.ts
 */
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { makeDocx, makeXlsx } from './officeHarness';
import {
  cellValue, decodeKeyName, docInstr, encodeKeyName, keyAllowed, keyOfInstr, keyOfSheetName, parseKey, sheetName,
} from '../office/fieldKeys';
import {
  docxFieldXml, fillDocxMarkers, insertXlsxBlock, insertXlsxField, listDocxFields, listXlsxAnchors,
  updateDocxFields, updateXlsxFields, writeXlsxBlock,
} from '../server/officeFields';

let ok = 0;
let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { ok++; return; }
  fail++;
  console.error(`  ✗ ${name}\n      получили ${g}\n      ждали    ${w}`);
};
const yes = (name: string, cond: boolean, got?: unknown) => eq(name, cond ? true : got ?? false, true);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function parts(buf: Buffer): Promise<Map<string, string>> {
  const z = await JSZip.loadAsync(buf);
  const out = new Map<string, string>();
  for (const [n, e] of Object.entries(z.files)) if (!e.dir) out.set(n, sha(Buffer.from(await e.async('uint8array'))));
  return out;
}
const partText = async (buf: Buffer, name: string) => (await JSZip.loadAsync(buf)).file(name)!.async('string');
/** Какие части разошлись */
async function diff(a: Buffer, b: Buffer): Promise<string[]> {
  const pa = await parts(a), pb = await parts(b);
  return [...new Set([...pa.keys(), ...pb.keys()])].filter((n) => pa.get(n) !== pb.get(n)).sort();
}
async function withPart(buf: Buffer, name: string, fn: (xml: string) => string): Promise<Buffer> {
  const z = await JSZip.loadAsync(buf);
  z.file(name, fn(await z.file(name)!.async('string')));
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

(async () => {
  console.log('1. Ключ поля');
  eq('поле проекта', parseKey('project.code'), { kind: 'project', path: 'code' });
  eq('незнакомое поле проекта — не поле', parseKey('project.password'), null);
  eq('код тега с точкой разбирается по скобкам', parseKey('tag[TT-1.2].param:Аэродинамика|Расход'),
    { kind: 'tag', id: 'TT-1.2', path: 'param:Аэродинамика|Расход' });
  eq('подпись', parseKey('sign.checked.date'), { kind: 'sign', role: 'checked', path: 'date' });
  eq('чужая роль подписи — не поле', parseKey('sign.boss.name'), null);
  yes('кавычка в ключе запрещена: она ломает инструкцию Word', !keyAllowed('tag[A"B].brand'));
  yes('обычный ключ годен', keyAllowed('el[П-1].name'));
  eq('инструкция поля читается обратно', keyOfInstr(` ${docInstr('tag[AHU-1].brand')} `), 'tag[AHU-1].brand');
  eq('чужое поле DOCPROPERTY — не наше', keyOfInstr('DOCPROPERTY "Title"'), null);
  eq('поле DATE — не наше', keyOfInstr('DATE \\@ "dd.MM.yyyy"'), null);
  for (const key of ['project.code', 'tag[AHU-1].param:Аэродинамика|Расход, м3/ч', 'el[П_1].name', 'vdr[ABC-001-Z].revision', 'tag[Ø-10].brand']) {
    const name = sheetName(key);
    yes(`имя «${key}» — только буквы, цифры, точка и «_»`, /^[\p{L}0-9._]+$/u.test(name), name);
    eq(`имя «${key}» читается обратно`, keyOfSheetName(name), key);
    eq(`второе вхождение «${key}» — тот же ключ`, keyOfSheetName(sheetName(key, 2)), key);
  }
  eq('подчёркивание в ключе не путается с кодом знака', decodeKeyName(encodeKeyName('a_b__c')), 'a_b__c');
  eq('имя блока — не поле', keyOfSheetName('FLUX_BLOCK_3'), null);
  eq('чужое имя — не поле', keyOfSheetName('Итого'), null);
  eq('число в русской записи — число', cellValue('1 250,5'), 1250.5);
  eq('код с ведущим нулём остаётся строкой', cellValue('007'), '007');
  eq('текст остаётся текстом', cellValue('AHU-1'), 'AHU-1');

  console.log('\n2. Документ: вставка по меткам');
  const base = await withPart(await makeDocx(), 'word/document.xml', (x) => x
    .replace('<w:r><w:t>Вторая строка бланка</w:t></w:r>',
      '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Шифр {{project.code}}, тег {{tag[AHU-1].brand}}.</w:t></w:r>'));
  const withFooter = await withPart(base, 'word/footer1.xml', (x) => x.replace('Штамп: Разработал Проба', 'Разработал {{sign.prepared.name}}'));
  const filled = await fillDocxMarkers(withFooter, { 'project.code': 'ПР-001', 'tag[AHU-1].brand': 'Веза', 'sign.prepared.name': 'Иванов И.И.' });
  eq('меток заменено', filled.changed.map((c) => c.key), ['project.code', 'tag[AHU-1].brand', 'sign.prepared.name']);
  const fields = await listDocxFields(filled.bytes);
  eq('поля найдены в теле и колонтитуле', fields.map((f) => [f.part, f.key, f.text]), [
    ['word/document.xml', 'project.code', 'ПР-001'], ['word/document.xml', 'tag[AHU-1].brand', 'Веза'],
    ['word/footer1.xml', 'sign.prepared.name', 'Иванов И.И.'],
  ]);
  const docXml = await partText(filled.bytes, 'word/document.xml');
  yes('текст вокруг поля остался на месте', docXml.includes('>Шифр </w:t>') && docXml.includes('>, тег </w:t>') && docXml.includes('>.</w:t>'), docXml);
  yes('поле унаследовало формат прогона', /<w:r><w:rPr><w:b\/><\/w:rPr><w:fldChar w:fldCharType="begin"\/>/.test(docXml));
  eq('кроме тела и колонтитула — байт в байт', await diff(withFooter, filled.bytes), ['word/document.xml', 'word/footer1.xml']);
  const again = await fillDocxMarkers(filled.bytes, { 'project.code': 'X' });
  yes('без меток файл не переписывается', again.bytes.equals(filled.bytes));

  console.log('\n3. Документ: «Обновить поля»');
  const upd = await updateDocxFields(filled.bytes, { 'project.code': 'ПР-002', 'tag[AHU-1].brand': 'Веза' });
  eq('обновлено только изменившееся', upd.changed.map((c) => [c.key, c.from, c.to]), [['project.code', 'ПР-001', 'ПР-002']]);
  eq('тронуто только тело', await diff(filled.bytes, upd.bytes), ['word/document.xml']);
  const before = await partText(filled.bytes, 'word/document.xml');
  const after = await partText(upd.bytes, 'word/document.xml');
  const f0 = fields[0];
  const fNew = (await listDocxFields(upd.bytes))[0];
  eq('до поля — байт в байт', after.slice(0, fNew.from), before.slice(0, f0.from));
  eq('после поля — байт в байт', after.slice(fNew.to), before.slice(f0.to));
  eq('в поле — новое значение', fNew.text, 'ПР-002');
  const same = await updateDocxFields(upd.bytes, { 'project.code': 'ПР-002' });
  yes('то же значение — файл тот же байт в байт', same.bytes.equals(upd.bytes));
  const unknown = await updateDocxFields(upd.bytes, { 'tag[НЕТ].brand': 'x' });
  yes('ключ без поля в файле ничего не меняет', unknown.bytes.equals(upd.bytes));
  const escaped = await updateDocxFields(upd.bytes, { 'project.code': 'A&B <1>' });
  eq('спецзнаки в значении экранируются', (await listDocxFields(escaped.bytes))[0].text, 'A&B <1>');

  console.log('\n4. Документ: поле, как его пишет редактор, и чужие поля');
  // Ровно так редактор Документа записал вставленное поле (разведка 27.09)
  const editorXml = '<w:p><w:r><w:t xml:space="preserve">Сюда вставка</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DOCPROPERTY "flux:project.name" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t xml:space="preserve">ВСТАВЛЕНО</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
  const foreign = '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> DATE \\@ "dd.MM.yyyy" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>01.01.2026</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
  const complex = `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> ${docInstr('project.customer')} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:bookmarkStart w:id="5" w:name="важная"/><w:r><w:t>Заказчик</w:t></w:r><w:bookmarkEnd w:id="5"/><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  const simple = `<w:p><w:fldSimple w:instr=" DOCPROPERTY &quot;flux:project.status&quot; "><w:r><w:t>в работе</w:t></w:r></w:fldSimple></w:p>`;
  const proof = `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> ${docInstr('doc.name')} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:proofErr w:type="spellStart"/><w:r><w:t>Записка</w:t></w:r><w:proofErr w:type="spellEnd"/><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  const mixed = await withPart(await makeDocx(), 'word/document.xml', (x) => x.replace('<w:body>', `<w:body>${editorXml}${foreign}${complex}${simple}${proof}`));
  eq('все поля Flux найдены, DATE — нет', (await listDocxFields(mixed)).map((f) => [f.key, f.text, f.plain]), [
    ['project.name', 'ВСТАВЛЕНО', true], ['project.customer', 'Заказчик', false], ['project.status', 'в работе', true], ['doc.name', 'Записка', true],
  ]);
  const m2 = await updateDocxFields(mixed, { 'project.name': 'Объект', 'project.customer': 'Новый', 'project.status': 'выпущен', 'doc.name': 'Записка-2' });
  eq('обновлены простые поля', m2.changed.map((c) => c.key), ['project.name', 'project.status', 'doc.name']);
  eq('поле с закладкой внутри не тронуто', m2.skipped.map((c) => c.key), ['project.customer']);
  const m2xml = await partText(m2.bytes, 'word/document.xml');
  yes('закладка внутри поля уцелела', m2xml.includes('w:name="важная"'));
  yes('поле DATE — байт в байт', m2xml.includes(foreign));
  yes('простое поле: инструкция на месте', m2xml.includes('w:instr=" DOCPROPERTY &quot;flux:project.status&quot; "') && m2xml.includes('>выпущен<'));
  const nested = `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> ${docInstr('year')} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  const withNested = await withPart(await makeDocx(), 'word/document.xml', (x) => x.replace('<w:body>', `<w:body>${nested}`));
  const n2 = await updateDocxFields(withNested, { year: '2026' });
  yes('поле с вложенным полем не тронуто', n2.bytes.equals(withNested) && n2.skipped.length === 1, n2);
  yes('поле сервера совпадает с полем редактора', docxFieldXml('project.name', 'ВСТАВЛЕНО').includes('<w:instrText xml:space="preserve"> DOCPROPERTY "flux:project.name" </w:instrText>'));

  console.log('\n5. Таблица: вставка и обновление по именам');
  const book = await makeXlsx();
  const ins = await insertXlsxField(book, 'Перечень', 'C2', 'project.code', 'ПР-001');
  eq('имя поля', ins.name, sheetName('project.code'));
  eq('тронуты лист и книга', await diff(book, ins.bytes), ['xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  const wb1 = await partText(ins.bytes, 'xl/workbook.xml');
  yes('прежнее имя «Итого» на месте', wb1.includes(`<definedName name="Итого">'Перечень'!$B$4</definedName>`));
  yes('новое имя указывает на ячейку', wb1.includes(`<definedName name="${ins.name}">'Перечень'!$C$2</definedName>`), wb1);
  const s1 = await partText(ins.bytes, 'xl/worksheets/sheet1.xml');
  yes('значение в ячейке, строки в общий словарь не добавлены', /<c r="B2"><v>3<\/v><\/c><c r="C2" t="inlineStr"><is><t xml:space="preserve">ПР-001<\/t><\/is><\/c><\/row>/.test(s1), s1);
  const ins2 = await insertXlsxField(ins.bytes, 'Справка', 'B7', 'project.code', 'ПР-001');
  eq('второе вхождение ключа — своё имя', ins2.name, sheetName('project.code', 2));
  const ins3 = await insertXlsxField(ins2.bytes, 'Перечень', 'D3', 'tag[AHU-1].param:Аэродинамика|Расход', '1 250,5');
  const anchors = await listXlsxAnchors(ins3.bytes);
  eq('поля книги найдены', anchors.fields.map((f) => [f.key, f.sheet, f.cell, f.text]), [
    ['project.code', 'Перечень', 'C2', 'ПР-001'], ['project.code', 'Справка', 'B7', 'ПР-001'],
    ['tag[AHU-1].param:Аэродинамика|Расход', 'Перечень', 'D3', '1250.5'],
  ]);
  const s2 = await partText(ins2.bytes, 'xl/worksheets/sheet2.xml');
  yes('новая строка листа встала по порядку', /<row r="1">[\s\S]*<\/row><row r="7"><c r="B7"/.test(s2), s2);
  const up = await updateXlsxFields(ins3.bytes, { 'project.code': 'ПР-002', 'tag[AHU-1].param:Аэродинамика|Расход': '1250,5' });
  eq('обновлены оба вхождения шифра, число не тронуто', up.changed.map((c) => c.where), ['Перечень!C2', 'Справка!B7']);
  eq('тронуты только листы с полями', await diff(ins3.bytes, up.bytes), ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
  const sA = await partText(ins3.bytes, 'xl/worksheets/sheet1.xml');
  const sB = await partText(up.bytes, 'xl/worksheets/sheet1.xml');
  eq('в листе поменялась только ячейка поля', sB.replace('ПР-002', 'ПР-001'), sA);
  const upSame = await updateXlsxFields(up.bytes, { 'project.code': 'ПР-002' });
  yes('то же значение — книга та же байт в байт', upSame.bytes.equals(up.bytes));
  yes('общие строки, стили, customXml — байт в байт', (await diff(book, up.bytes)).every((n) => /^xl\/(workbook|worksheets\/sheet\d)\.xml$/.test(n)), await diff(book, up.bytes));

  console.log('\n6. Таблица: умный блок');
  const rows3 = [['Тег', 'Марка', 'Расход'], ['AHU-1', 'Веза', 1250], ['AHU-2', 'Веза', 900]];
  const bk = await insertXlsxBlock(up.bytes, 'Справка', 'A3', 'FLUX_BLOCK_1', rows3);
  const a1 = await listXlsxAnchors(bk);
  eq('блок заведён на весь диапазон', a1.blocks, [{ name: 'FLUX_BLOCK_1', sheet: 'Справка', from: 'A3', to: 'C5' }]);
  const sb = await partText(bk, 'xl/worksheets/sheet2.xml');
  yes('числа блока — числами', sb.includes('<c r="C4"><v>1250</v></c>'), sb);
  yes('ячейка поля рядом с блоком цела', sb.includes('<c r="B7" t="inlineStr"><is><t xml:space="preserve">ПР-002</t></is></c>'), sb);
  const shrink = await writeXlsxBlock(bk, 'FLUX_BLOCK_1', [['Тег', 'Марка'], ['AHU-1', 'Веза']]);
  eq('блок сжался', shrink.ref, `'Справка'!$A$3:$B$4`);
  eq('лишние ячейки очищены', shrink.cleared, 5);
  const ss = await partText(shrink.bytes, 'xl/worksheets/sheet2.xml');
  yes('очищенная ячейка пуста', ss.includes('<c r="C4"/>') && ss.includes('<c r="A5"/>'), ss);
  yes('первый лист блоком не задет', (await diff(bk, shrink.bytes)).every((n) => n !== 'xl/worksheets/sheet1.xml'));
  const wbS = await partText(shrink.bytes, 'xl/workbook.xml');
  yes('другие имена книги — как были', wbS.includes(`<definedName name="Итого">'Перечень'!$B$4</definedName>`) && wbS.includes(ins.name));
  const grow = await writeXlsxBlock(shrink.bytes, 'FLUX_BLOCK_1', rows3.concat([['AHU-3', 'Арктос', 400]]));
  eq('блок вырос', grow.ref, `'Справка'!$A$3:$C$6`);
  const sameBlock = await writeXlsxBlock(grow.bytes, 'FLUX_BLOCK_1', rows3.concat([['AHU-3', 'Арктос', 400]]));
  yes('те же строки — книга та же байт в байт', sameBlock.bytes.equals(grow.bytes));

  console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  ✗ набор оборвался:', e); process.exit(1); });
