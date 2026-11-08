import assert from 'node:assert/strict';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { emptyDocflowFile } from '../src/lib/docflowEmptyFile';

(async () => {
  const docx = await emptyDocflowFile('docx');
  assert.deepEqual([...docx.slice(0, 4)], [0x50, 0x4b, 3, 4]);
  const word = await mammoth.extractRawText({ buffer: Buffer.from(docx) });
  assert.equal(word.value.trim(), '', 'Пустой документ Word не содержит текста');
  const zip = await JSZip.loadAsync(docx);
  assert.ok(zip.file('word/document.xml'), 'В документе есть основной раздел');

  const xlsx = await emptyDocflowFile('xlsx');
  assert.deepEqual([...xlsx.slice(0, 4)], [0x50, 0x4b, 3, 4]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(xlsx) as any);
  assert.equal(workbook.worksheets.length, 1, 'Книга содержит один лист');
  workbook.worksheets[0].eachRow(row => row.eachCell(cell => assert.equal(cell.value, null, 'Лист не содержит данных')));

  const pdfBytes = await emptyDocflowFile('pdf');
  assert.equal(Buffer.from(pdfBytes.slice(0, 5)).toString('ascii'), '%PDF-');
  const pdf = await getDocument({ data: pdfBytes, useSystemFonts: true }).promise;
  assert.equal(pdf.numPages, 1, 'PDF содержит одну страницу');
  const page = await pdf.getPage(1);
  assert.equal((await page.getTextContent()).items.length, 0, 'Страница PDF не содержит текста');
  assert.ok(page.getViewport({ scale: 1 }).width > 0, 'Размер страницы задан');
  await pdf.cleanup();

  assert.equal((await emptyDocflowFile('txt')).length, 0, 'Текстовый файл не содержит байтов');
  console.log('Пустые файлы Word, Excel, PDF и TXT проверены');
})().catch(error => { console.error(error); process.exitCode = 1; });
