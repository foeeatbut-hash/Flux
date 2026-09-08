/**
 * Выгрузка в Word отдаёт настоящий документ, а не страницу с расширением .doc.
 *
 * Проверка написана потому, что убедиться в обратном можно было только на чужой
 * машине: раньше выгрузка отдавала HTML, названный `.doc`, и Word открывал его
 * с предупреждением «формат не соответствует расширению». Человек, отправивший
 * такой файл заказчику, узнавал об этом от заказчика.
 *
 * Здесь собранный документ читается ТЕМ ЖЕ разбором, которым программа читает
 * чужие docx (mammoth). Если бы байты архива разъехались хоть на один, разбор
 * бы не открылся — а глазами этого не увидеть.
 *
 * Запуск: npx tsx scripts/test-docx.ts
 */
import { buildDocx, partsFromHtml, partsFromText, xmlEscape } from '../src/lib/docxWrite';
import { zip, crc32 } from '../src/lib/zipWrite';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

console.log('Архив собирается по правилам');
{
  const out = zip([{ name: 'a.txt', data: 'привет' }]);
  check('начинается подписью локального заголовка',
    out[0] === 0x50 && out[1] === 0x4b && out[2] === 0x03 && out[3] === 0x04, [...out.slice(0, 4)]);
  // Конец архива ищут с хвоста — без этой подписи файл не откроет никто
  const tail = out.slice(-22);
  check('заканчивается подписью конца архива',
    tail[0] === 0x50 && tail[1] === 0x4b && tail[2] === 0x05 && tail[3] === 0x06, [...tail.slice(0, 4)]);
  check('одинаковое содержимое даёт одинаковые байты',
    Buffer.from(zip([{ name: 'a.txt', data: 'привет' }])).equals(Buffer.from(out)));

  // Контрольная сумма — не наша выдумка, у неё есть общеизвестные значения
  check('контрольная сумма считается как у всех',
    crc32(new TextEncoder().encode('123456789')) === 0xcbf43926,
    crc32(new TextEncoder().encode('123456789')).toString(16));
}

console.log('Опасные символы не ломают XML');
{
  check('амперсанд', xmlEscape('Иванов & сыновья').includes('&amp;'));
  check('угловые скобки', xmlEscape('<b>') === '&lt;b&gt;');
  check('обычный текст не портится', xmlEscape('Смета № 12') === 'Смета № 12');
}

console.log('Текст документа превращается в куски');
{
  const parts = partsFromText('Заголовок\n\nПервый абзац\nа\tб\nв\tг\nПоследний');
  check('пустая строка осталась абзацем', parts.some((p) => p.kind === 'para' && p.text === ''));
  const table = parts.find((p) => p.kind === 'table') as any;
  check('строки с табуляцией собрались в таблицу', !!table, parts.map((p) => p.kind));
  check('в таблице две строки', table?.rows.length === 2, table?.rows);
  check('и две колонки', table?.rows[0].length === 2, table?.rows[0]);
  check('текст после таблицы не потерялся',
    parts.some((p) => p.kind === 'para' && (p as any).text === 'Последний'));
}

(async () => {
  console.log('Собранный документ читается разбором Word');
  {
    const text = 'Пояснительная записка\n\nСистема П1 обслуживает офисные помещения.\n'
      + 'Наименование\tКоличество\nВентилятор\t2\nКлапан\t4\n\nКонец «документа» & проверка <тегов>';
    const bytes = buildDocx(partsFromText(text));
    check('документ не пуст', bytes.length > 1000, bytes.length);

    const mammoth: any = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const back = String(r?.value || '');
    check('Word-разбор открыл документ', back.length > 0, back.slice(0, 80));
    check('абзац на месте', back.includes('Система П1 обслуживает офисные помещения'), back.slice(0, 200));
    check('таблица на месте', back.includes('Вентилятор') && back.includes('Клапан'));
    check('кавычки и амперсанд вернулись как были',
      back.includes('«документа»') && back.includes('&') && back.includes('<тегов>'),
      back.slice(-60));

    // То же, что делает программа при открытии чужого docx: html → блоки
    const html = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
    const { htmlToBlocks } = await import('../src/import/extractors');
    const blocks = htmlToBlocks(String(html?.value || ''));
    check('в разобранном есть таблица', blocks.some((b: any) => b.kind === 'table'), blocks.map((b: any) => b.kind));
  }

  console.log('Заголовки и таблицы отдельными кусками');
  {
    const bytes = buildDocx([
      { kind: 'head', text: 'Раздел 1', level: 1 },
      { kind: 'para', text: 'Текст раздела' },
      { kind: 'table', rows: [['А', 'Б'], ['1', '2']] },
    ]);
    const mammoth: any = await import('mammoth');
    const html = String((await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }))?.value || '');
    check('заголовок остался заголовком', /<h1[^>]*>Раздел 1<\/h1>/.test(html), html.slice(0, 160));
    check('таблица осталась таблицей', html.includes('<table'), html.slice(0, 200));
  }

  console.log('Страница документа: стили не текст, лист не всегда A4');
  {
    // Ровно то, что отдаёт сборка документа для Word: голова со стилями,
    // титул с меткой разрыва, подпись картинкой, потом текст
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const html = '<!doctype html><html><head><meta charset="utf-8">'
      + '<style>@page WordSection1 { size:297mm 210mm; margin:20.1mm 15.2mm 20.1mm 30mm; }</style></head>'
      + '<body><div style="page-break-after:always"><p>ПОЯСНИТЕЛЬНАЯ ЗАПИСКА</p>'
      + `<p>Разработал: <img src="data:image/png;base64,${png}" style="height:10mm"></p></div>`
      + '<div data-page-break="1"></div><p>Первая строка записки</p></body></html>';
    const parts = partsFromHtml(html, () => []);

    // Разрез по тегам оставлял СОДЕРЖИМОЕ <style>: страница CSS уезжала
    // получателю как первый абзац документа
    const texts = parts.filter((p: any) => p.kind === 'para' || p.kind === 'head').map((p: any) => p.text);
    check('правил CSS в тексте документа нет', !texts.some((t: string) => /WordSection1|margin:/.test(t)), texts.slice(0, 3));
    check('текст титула на месте', texts.some((t: string) => /ПОЯСНИТЕЛЬНАЯ ЗАПИСКА/.test(t)), texts.slice(0, 3));
    check('подпись стала рисунком, а не пропала', parts.some((p: any) => p.kind === 'image'), parts.map((p: any) => p.kind));
    check('титул отделён разрывом страницы', parts.some((p: any) => p.kind === 'break'), parts.map((p: any) => p.kind));

    const bytes = buildDocx(parts, {
      widthMm: 297, heightMm: 210, topMm: 20.1, rightMm: 15.2, bottomMm: 20.1, leftMm: 30,
    });
    const zipText = Buffer.from(bytes).toString('latin1');
    check('лист альбомный, как в документе', /w:orient="landscape"/.test(zipText));
    // 30 мм = 1701 двадцатая доля пункта. Раньше здесь всегда стояло 1134
    check('поле слева 30 мм доехало до файла', /w:left="1701"/.test(zipText), (zipText.match(/w:pgMar[^/]*/) || [])[0]);
    check('разрыв страницы записан по-вордовски', /w:br w:type="page"/.test(zipText));
    check('рисунок лежит в архиве', zipText.includes('word/media/img1.png'));
    check('и объявлен типом', /Extension="png"/.test(zipText));
    check('и привязан к документу', /rIdImg1/.test(zipText) && /media\/img1\.png/.test(zipText));

    const mammoth: any = await import('mammoth');
    const back = String((await mammoth.extractRawText({ buffer: Buffer.from(bytes) }))?.value || '');
    check('Word-разбор открыл документ с рисунком', /Первая строка записки/.test(back), back.slice(0, 120));
    check('и правил CSS в нём нет', !/WordSection1/.test(back), back.slice(0, 120));
  }

  if (failed) {
    console.error(`\nПровалено проверок: ${failed}`);
    process.exit(1);
  }
  console.log('\nВсе проверки выгрузки в Word пройдены');
})();
