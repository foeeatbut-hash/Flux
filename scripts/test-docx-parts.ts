/**
 * Части документа Word, из-за которых ворды открывались пустыми.
 *
 * Владелец жаловался: «файлы открывает, но текста нету». Причина оказалась не
 * в том, что программа не умеет Word, а в том, ГДЕ в этих документах лежит
 * текст. В бланках по ГОСТ, в опросных листах и в заданиях содержимое сидит в
 * колонтитуле, в надписи поверх страницы и в сносках — а библиотека разбора
 * отдаёт только основной поток и молча возвращает пустоту.
 *
 * Здесь документ собирается ТЕМ ЖЕ сборщиком, которым программа выгружает в
 * Word (src/lib/zipWrite.ts), и читается разбором (src/import/docxParts.ts).
 * Проверка держит обе стороны: и чтение архива, и вылавливание частей.
 *
 * Запуск: npx tsx scripts/test-docx-parts.ts
 */
import { zip } from '../src/lib/zipWrite';
import { unzip, docxOuterText } from '../src/import/docxParts';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const para = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const part = (inner: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<w:document xmlns:w="${W}"><w:body>${inner}</w:body></w:document>`;

(async () => {
  console.log('Архив читается по центральному каталогу');
  {
    const bytes = zip([
      { name: 'word/document.xml', data: 'первый' },
      { name: 'word/header1.xml', data: 'второй' },
    ]);
    const files = await unzip(bytes);
    check('оба файла найдены', files.size === 2, [...files.keys()]);
    check('содержимое не перепутано',
      new TextDecoder().decode(files.get('word/document.xml')!) === 'первый',
      new TextDecoder().decode(files.get('word/document.xml') || new Uint8Array()));
    // Не архив вообще — не повод падать: человек мог переименовать что угодно
    check('чужие байты не роняют разбор', (await unzip(new Uint8Array([1, 2, 3]))).size === 0);
  }

  console.log('Колонтитул, надпись и сноска доезжают до текста');
  {
    const docXml = part(
      para('Основной текст записки')
      + '<w:p><w:r><mc:AlternateContent xmlns:mc="x"><w:txbxContent>'
      + para('Шифр из надписи ПЗ-042')
      + '</w:txbxContent></mc:AlternateContent></w:r></w:p>',
    );
    const bytes = zip([
      { name: 'word/document.xml', data: docXml },
      { name: 'word/header1.xml', data: part(para('Штамп: лист 1 из 12')) },
      { name: 'word/footer1.xml', data: part(para('Инв. № подл.')) },
      { name: 'word/footnotes.xml', data: part(para('Сноска про допуски')) },
    ]);
    const outer = (await docxOuterText(bytes)).join('\n');

    check('штамп из верхнего колонтитула на месте', outer.includes('Штамп: лист 1 из 12'), outer);
    check('нижний колонтитул на месте', outer.includes('Инв. № подл.'), outer);
    check('сноска на месте', outer.includes('Сноска про допуски'), outer);
    check('надпись поверх страницы на месте', outer.includes('Шифр из надписи ПЗ-042'), outer);
    // Каждая часть подписана: иначе человек читает мешанину и не понимает,
    // откуда взялся «лист 1 из 12» посреди записки
    check('части подписаны, откуда они', /Колонтитул \(верх\)/.test(outer) && /Надписи/.test(outer), outer);
    check('основной текст сюда не попадает — он приходит своим путём',
      !outer.includes('Основной текст записки'), outer);
  }

  console.log('Сжатые записи — те, что кладёт настоящий Word');
  {
    // Наш сборщик пишет архив без сжатия, а Word — со сжатием. Разбор обязан
    // читать оба: иначе проверка была бы зелёной, а чужой документ — пустым.
    // Поэтому сжатую запись собираем здесь руками, по правилам формата
    const zlib = await import('node:zlib');
    const enc = new TextEncoder();
    const name = enc.encode('word/header1.xml');
    const plain = enc.encode(part(para('Штамп из сжатой записи')));
    const packed = new Uint8Array(zlib.deflateRawSync(Buffer.from(plain)));
    const crc = (await import('../src/lib/zipWrite')).crc32(plain);

    const put = (arr: number[], n: number, bytes: number) => {
      for (let i = 0; i < bytes; i++) arr.push((n >>> (i * 8)) & 0xff);
    };
    const local: number[] = [];
    put(local, 0x04034b50, 4); put(local, 20, 2); put(local, 0, 2); put(local, 8, 2);
    put(local, 0, 2); put(local, 0, 2); put(local, crc, 4);
    put(local, packed.length, 4); put(local, plain.length, 4);
    put(local, name.length, 2); put(local, 0, 2);
    const head = new Uint8Array([...local, ...name, ...packed]);

    const central: number[] = [];
    put(central, 0x02014b50, 4); put(central, 20, 2); put(central, 20, 2); put(central, 0, 2);
    put(central, 8, 2); put(central, 0, 2); put(central, 0, 2); put(central, crc, 4);
    put(central, packed.length, 4); put(central, plain.length, 4);
    put(central, name.length, 2); put(central, 0, 2); put(central, 0, 2);
    put(central, 0, 2); put(central, 0, 2); put(central, 0, 4); put(central, 0, 4);
    const dir = new Uint8Array([...central, ...name]);

    const tail: number[] = [];
    put(tail, 0x06054b50, 4); put(tail, 0, 2); put(tail, 0, 2); put(tail, 1, 2); put(tail, 1, 2);
    put(tail, dir.length, 4); put(tail, head.length, 4); put(tail, 0, 2);

    const bytes = new Uint8Array([...head, ...dir, ...tail]);
    const outer = (await docxOuterText(bytes)).join('\n');
    check('сжатая запись разжата и прочитана', outer.includes('Штамп из сжатой записи'), outer);
  }

  console.log('Документ без частей вне потока не добавляет ничего');
  {
    const bytes = zip([{ name: 'word/document.xml', data: part(para('Только текст')) }]);
    check('лишних строк нет', (await docxOuterText(bytes)).length === 0, await docxOuterText(bytes));
  }

  if (failed) {
    console.error(`\nПровалено проверок: ${failed}`);
    process.exit(1);
  }
  console.log('\nВсе проверки частей документа Word пройдены');
})();
