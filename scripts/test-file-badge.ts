/**
 * Значки файлов и пустые файлы Flux Office.
 *
 * Ошибка в значке тихая: файл открывается, но на столе Word, Excel и PDF
 * снова выглядят одним серым листом, и документ узнают только по подписи.
 * Пустой файл, который не открывается в Word или Excel, — ошибка громкая, но
 * заметная только тогда, когда сотрудник уже отдал его заказчику.
 *
 * Запуск: npx tsx scripts/test-file-badge.ts
 */
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { badgeOf, badgeLabel, recentBadge, BADGE_COLOR } from '../src/lib/fileBadge';
import { blankDocx, blankXlsx, BLANK_NAME } from '../src/lib/blankFiles';
import { openHref } from '../src/lib/fileTypes';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

console.log('Вид значка');
{
  const cases: Array<[string, string]> = [
    ['Записка.docx', 'doc'], ['Бланк.xlsx', 'sheet'], ['Бланк с макросами.xlsm', 'sheet'],
    ['Выгрузка.csv', 'sheet'], ['АР-01.pdf', 'pdf'], ['Заметки.md', 'markdown'],
    ['readme.txt', 'text'], ['Фото.PNG', 'image'], ['Архив.zip', 'archive'],
    ['План.dwg', 'cad'], ['Модель.ifc', 'cad'], ['Непонятное.bin', 'file'], ['Без расширения', 'file'],
  ];
  for (const [name, kind] of cases) check(`${name} → ${kind}`, badgeOf(name) === kind, badgeOf(name));
  check('заметка узнаётся по типу, а не по имени', badgeOf({ id: 'n', name: 'Список', type: 'NOTE' }) === 'note');
  check('у каждого вида свой цвет', new Set(Object.values(BADGE_COLOR)).size === Object.keys(BADGE_COLOR).length);
  check('подпись — само расширение', badgeLabel('Бланк.xlsm') === 'XLSM', badgeLabel('Бланк.xlsm'));
  check('длинное расширение не вылезает с полосы', badgeLabel('Модель.step').length <= 4);
  check('у заметки подпись «ЗАМ»', badgeLabel({ id: 'n', name: 'Список', type: 'NOTE' }) === 'ЗАМ');
}

console.log('Недавние');
{
  check('недавний .xlsx — таблица', recentBadge({ title: 'Смета.xlsx', kind: 'sheet' }) === 'sheet');
  check('старая запись без расширения — по программе', recentBadge({ title: 'Ведомость', kind: 'sheet' }) === 'sheet');
  check('старый документ без расширения — документ', recentBadge({ title: 'Записка', kind: 'text' }) === 'doc');
  check('заметка — заметка', recentBadge({ title: 'Купить.md', kind: 'note' }) === 'note');
}

console.log('Один значок во всех местах');
{
  // Каждое место, где показывают файл, берёт один компонент — иначе значки
  // снова разойдутся, как разошлись пять прежних
  const places = [
    'src/components/desktop/DeskIcon.tsx', 'src/components/explorer/FileItems.tsx',
    'src/components/StartMenu.tsx', 'src/components/office/RecentDocsPanel.tsx',
    'src/components/insight/parts.tsx', 'src/components/explorer/ExplorerMenu.tsx',
  ];
  for (const p of places) check(`${p} берёт FileBadge`, /import FileBadge from/.test(readFileSync(p, 'utf8')));
  const sections = readFileSync('src/workspace/sections.tsx', 'utf8');
  check('программы Flux Office в Пуске — тем же листом', /DocAppIcon/.test(sections) && /SheetAppIcon/.test(sections) && /PdfAppIcon/.test(sections));
}

async function blanks() {
  console.log('Пустые файлы');
  const doc = await JSZip.loadAsync(blankDocx());
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
    check(`в пустом документе есть ${part}`, !!doc.file(part));
  }
  check('документ открывается Документом', openHref({ id: 'x', name: BLANK_NAME.doc }).startsWith('/office-doc?file='), openHref({ id: 'x', name: BLANK_NAME.doc }));

  const book = XLSX.read(await blankXlsx(), { type: 'array' });
  check('в пустой книге один лист «Лист1»', book.SheetNames.length === 1 && book.SheetNames[0] === 'Лист1', book.SheetNames);
  check('книга открывается Таблицей', openHref({ id: 'x', name: BLANK_NAME.sheet }).startsWith('/office-sheet?file='), openHref({ id: 'x', name: BLANK_NAME.sheet }));
  check('имена как у Word и Excel', BLANK_NAME.doc.endsWith('.docx') && BLANK_NAME.sheet.endsWith('.xlsx'));
}

blanks().then(() => {
  if (failed) { console.error(`\nПровалов: ${failed}`); process.exit(1); }
  console.log('\nВсё верно');
});
