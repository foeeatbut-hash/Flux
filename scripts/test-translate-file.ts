/**
 * Английская версия файла Word и Excel: что переводится и что остаётся как было.
 *
 *   - Документ: абзацы тела и колонтитула находятся, абзац с полем данных
 *     проекта (DOCPROPERTY "flux:…") — нет; перевод ложится в первый
 *     текстовый прогон, его оформление (w:rPr) цело, прочие части файла —
 *     байт в байт; знаки < & > экранируются;
 *   - Таблица: общие строки находятся, числа и пустые — нет; перевод на месте;
 *   - отпечаток меняется от правки текста и не меняется без неё.
 *
 * Без сервера. Запуск: npx tsx scripts/test-translate-file.ts
 */
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { listFileSegments, applyFileTranslation, englishName, kindOfName } from '../server/translateFile';
import { buildDocx } from '../src/lib/docxWrite';
import { fillDocxMarkers } from '../server/officeFields';

let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 300))));

const withHeader = async (docx: Uint8Array): Promise<Buffer> => {
  const zip = await JSZip.loadAsync(docx);
  zip.file('word/header1.xml', '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Шифр проекта и штамп</w:t></w:r></w:p></w:hdr>');
  zip.file('customXml/item1.xml', '<a>не трогать</a>');
  return zip.generateAsync({ type: 'nodebuffer' });
};

(async () => {
  console.log('1. Документ');
  const base = buildDocx([
    { kind: 'head', text: 'Пояснительная записка' },
    { kind: 'para', text: 'Установка приточная, расход воздуха' },
    { kind: 'para', text: '12345' },
  ] as any);
  const doc = await withHeader(base);
  const { segments, fingerprint } = await listFileSegments(doc, 'docx');
  const texts = segments.map((s) => s.text);
  ok('заголовок и абзац найдены', texts.includes('Пояснительная записка') && texts.includes('Установка приточная, расход воздуха'), texts);
  ok('колонтитул найден', texts.includes('Шифр проекта и штамп'), texts);
  ok('число не переводится', !texts.includes('12345'), texts);

  // Поле данных проекта: абзац с полем не трогается
  const marked = await withHeader(buildDocx([
    { kind: 'head', text: 'Пояснительная записка' }, { kind: 'para', text: 'Шифр {{project.code}}' },
  ] as any));
  const filled: any = await fillDocxMarkers(marked, { 'project.code': 'П-01' });
  const withField: Buffer | null = filled?.bytes ? Buffer.from(filled.bytes) : null;
  if (withField) {
    const s2 = await listFileSegments(withField, 'docx');
    const zip = await JSZip.loadAsync(withField);
    const xml = await zip.file('word/document.xml')!.async('string');
    ok('в пробе есть поле flux:', xml.includes('flux:project.code'));
    ok('абзац с полем не переводится', !s2.segments.some((s) => s.text.includes('П-01')), s2.segments.map((s) => s.text));
  } else {
    console.log('  · поле вставить не вышло — проверка поля пропущена');
  }

  const pairs: Record<string, string> = {};
  for (const s of segments) pairs[s.key] = s.text === 'Установка приточная, расход воздуха' ? 'Supply unit, air flow <m3/h> & more' : `EN ${s.text}`;
  const out = await applyFileTranslation(doc, 'docx', pairs);
  ok('переводов применено столько, сколько кусочков', out.applied === segments.length, out.applied);
  const a = await JSZip.loadAsync(doc);
  const b = await JSZip.loadAsync(out.bytes);
  const bodyXml = await b.file('word/document.xml')!.async('string');
  ok('перевод на месте, знаки экранированы', bodyXml.includes('Supply unit, air flow &lt;m3/h&gt; &amp; more'), bodyXml.slice(0, 300));
  ok('русского абзаца больше нет', !bodyXml.includes('Установка приточная'));
  const rPrBefore = ((await a.file('word/document.xml')!.async('string')).match(/<w:rPr>/g) || []).length;
  const rPrAfter = (bodyXml.match(/<w:rPr>/g) || []).length;
  ok('оформление прогонов цело', rPrBefore === rPrAfter, [rPrBefore, rPrAfter]);
  ok('колонтитул переведён', (await b.file('word/header1.xml')!.async('string')).includes('EN Шифр проекта и штамп'));
  for (const p of Object.keys(a.files).filter((n) => !a.files[n].dir && !/^word\/(document|header1)\.xml$/.test(n))) {
    const x = await a.file(p)!.async('uint8array');
    const y = await b.file(p)?.async('uint8array');
    ok(`${p} — байт в байт`, !!y && Buffer.compare(Buffer.from(x), Buffer.from(y!)) === 0);
  }
  ok('без переводов файл тот же', (await applyFileTranslation(doc, 'docx', {})).applied === 0);

  console.log('2. Отпечаток');
  ok('без правки — тот же', (await listFileSegments(doc, 'docx')).fingerprint === fingerprint);
  const other = await withHeader(buildDocx([{ kind: 'head', text: 'Пояснительная записка, ред. 2' }] as any));
  ok('от правки текста — другой', (await listFileSegments(other, 'docx')).fingerprint !== fingerprint);

  console.log('3. Таблица');
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Наименование', 'Кол-во'], ['Вентилятор канальный', 4], ['', 7]]), 'Лист1');
  // Excel кладёт строки в общий список (sharedStrings), SheetJS и другие
  // программы — прямо в ячейку (inlineStr): проверяем оба вида
  for (const bookSST of [true, false]) {
  const xlsx = Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx', bookSST }));
  const xs = await listFileSegments(xlsx, 'xlsx');
  ok(`строки найдены (${bookSST ? 'общие' : 'в ячейке'})`, xs.segments.map((s) => s.text).join('|') === 'Наименование|Кол-во|Вентилятор канальный', xs.segments);
  const tp: Record<string, string> = {};
  for (const s of xs.segments) tp[s.key] = s.text === 'Вентилятор канальный' ? 'Duct fan' : s.text === 'Наименование' ? 'Name' : 'Qty';
  const xo = await applyFileTranslation(xlsx, 'xlsx', tp);
  const wb = XLSX.read(xo.bytes, { type: 'buffer' });
  const sh = wb.Sheets[wb.SheetNames[0]];
  ok('перевод в ячейках', sh.A1?.v === 'Name' && sh.A2?.v === 'Duct fan' && sh.B1?.v === 'Qty', [sh.A1?.v, sh.A2?.v, sh.B1?.v]);
  ok('числа не тронуты', sh.B2?.v === 4 && sh.B3?.v === 7, [sh.B2?.v, sh.B3?.v]);
  }

  console.log('4. Имена');
  ok('копия называется «(EN)»', englishName('Смета.xlsx') === 'Смета (EN).xlsx' && englishName('Записка') === 'Записка (EN)');
  ok('вид по имени', kindOfName('a.docx') === 'docx' && kindOfName('b.xlsm') === 'xlsx' && kindOfName('c.pdf') === null);

  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВсё верно');
  process.exit(f ? 1 : 0);
})();
