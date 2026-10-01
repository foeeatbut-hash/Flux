/**
 * Загрузки браузера: имя на диске, личная папка, подписи.
 *
 * Ошибка здесь тихая и дорогая. Плохое имя — файл не создастся вовсе, и
 * человек увидит «не скачалось» без причины. Совпавшее имя — второй файл молча
 * затрёт первый, и пропажу заметят через неделю. Общая папка вместо личной —
 * чужие документы у себя и вопрос «кто это качал», на который никто не
 * ответит.
 *
 * Запуск: npx tsx scripts/test-downloads.ts
 */
import { readFileSync } from 'fs';
// Правила разведены по слоям: имя файла на диске знает главный процесс,
// подписи и полосу — окно. Проверяются здесь вместе: это одна дорога файла
import { safeFileName, uniqueFileName, personFolder } from '../electron/downloadPath';
import { sizeText, progressText, progressRatio } from '../src/lib/downloads';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

console.log('Имя файла на диске');
{
  check('обычное имя не трогаем', safeFileName('Отчёт 2026.pdf') === 'Отчёт 2026.pdf', safeFileName('Отчёт 2026.pdf'));
  check('кириллица сохраняется — по ней файл потом ищут глазами',
    safeFileName('Спецификация вентиляции.xlsx') === 'Спецификация вентиляции.xlsx');
  check('пробел и дефис законны', safeFileName('ТП-1 лист 3.dwg') === 'ТП-1 лист 3.dwg', safeFileName('ТП-1 лист 3.dwg'));
  // Выход из папки — это не имя файла, а попытка записать куда-то ещё
  check('путь наружу срезается до имени', safeFileName('../../etc/passwd') === 'passwd', safeFileName('../../etc/passwd'));
  check('обратные косые тоже', safeFileName('C:\\Windows\\system32\\drivers') === 'drivers');
  check('запрещённые Windows знаки заменяются',
    safeFileName('от:чёт?<1>.pdf') === 'от_чёт__1_.pdf', safeFileName('от:чёт?<1>.pdf'));
  check('точка в начале не делает файл скрытым', !safeFileName('.htaccess').startsWith('.'), safeFileName('.htaccess'));
  // Windows сама срежет точку в конце — тогда имя на диске разойдётся с тем,
  // что показано человеку
  check('точка в конце убирается', safeFileName('файл.') === 'файл', safeFileName('файл.'));
  check('занятое системой имя не берём', safeFileName('CON.txt') === '_CON.txt', safeFileName('CON.txt'));
  check('пустое имя не оставляет файл без имени', safeFileName('') === 'Файл');
  const long = safeFileName('я'.repeat(400) + '.pdf');
  check('слишком длинное укорачивается', long.length <= 120, long.length);
  check('и остаётся с расширением', long.endsWith('.pdf'), long.slice(-8));
}

console.log('Второй такой же файл');
{
  check('свободное имя берётся как есть', uniqueFileName('отчёт.pdf', []) === 'отчёт.pdf');
  check('занятое получает номер', uniqueFileName('отчёт.pdf', ['отчёт.pdf']) === 'отчёт (2).pdf',
    uniqueFileName('отчёт.pdf', ['отчёт.pdf']));
  check('третий — следующий номер',
    uniqueFileName('отчёт.pdf', ['отчёт.pdf', 'отчёт (2).pdf']) === 'отчёт (3).pdf');
  // Windows не различает регистр: «Отчёт.pdf» затёр бы «отчёт.pdf»
  check('регистр не спасает от затирания',
    uniqueFileName('Отчёт.pdf', ['отчёт.pdf']) === 'Отчёт (2).pdf', uniqueFileName('Отчёт.pdf', ['отчёт.pdf']));
  check('файл без расширения тоже нумеруется',
    uniqueFileName('README', ['README']) === 'README (2)');
  check('номер ставится перед расширением, а не в конец',
    !uniqueFileName('чертёж.dwg', ['чертёж.dwg']).endsWith(')'));
}

console.log('Личная папка');
{
  check('папка названа логином', personFolder('test.user') === 'test.user');
  check('негодные знаки в логине не ломают путь', !/[\\/:*?"<>|]/.test(personFolder('a/b:c*')), personFolder('a/b:c*'));
  check('без логина файлы всё равно куда-то ложатся', personFolder('') === 'Общая');
}

console.log('Размеры и подписи');
{
  check('байты', sizeText(500) === '500 Б', sizeText(500));
  check('килобайты без долей', sizeText(2048) === '2 КБ', sizeText(2048));
  check('мегабайты с одной долей', sizeText(5 * 1024 * 1024) === '5.0 МБ', sizeText(5 * 1024 * 1024));
  check('гигабайты', sizeText(3 * 1024 ** 3) === '3.00 ГБ', sizeText(3 * 1024 ** 3));
  check('ноль не показывается вовсе', sizeText(0) === '');

  check('идёт — видно, сколько из скольких',
    progressText({ state: 'progress', size: 1024 * 1024, received: 512 * 1024 }) === '512 КБ из 1.0 МБ',
    progressText({ state: 'progress', size: 1024 * 1024, received: 512 * 1024 }));
  // Сервер не всегда говорит размер. Тогда честно: «идёт», а не выдуманный процент
  check('без общего размера процента не выдумываем',
    progressText({ state: 'progress', size: 0, received: 4096 }).includes('идёт'),
    progressText({ state: 'progress', size: 0, received: 4096 }));
  check('и полосы тоже нет', progressRatio({ state: 'progress', size: 0, received: 4096 }) === 0);
  check('готово — просто размер', progressText({ state: 'done', size: 2048, received: 2048 }) === '2 КБ');
  check('полоса готового полна', progressRatio({ state: 'done', size: 0, received: 0 }) === 1);
  check('обрыв назван обрывом', progressText({ state: 'failed', size: 10, received: 1 }) === 'не скачалось');
  check('полоса не вылезает за край',
    progressRatio({ state: 'progress', size: 10, received: 99 }) === 1);
}

console.log('Скачивание идёт в личную папку, а не куда покажет диалог');
{
  const el = readFileSync(new URL('../electron/browser.ts', import.meta.url), 'utf8');
  check('путь сохранения задаёт программа', el.includes('item.setSavePath('));
  check('папка личная — по логину', el.includes('personFolder(owner)'));
  check('имя проверено и не задваивается',
    el.includes('uniqueFileName(safeFileName('), '');
  // Слушатель на вкладке означал бы столько же событий на один файл, сколько
  // открыто вкладок: сессия у вкладок общая
  check('слушатель висит на сессии один раз',
    el.includes('downloadsWatched') && !/wc\.session\.on\('will-download'/.test(el));
  check('открыть можно только своё, а не любой файл на машине',
    el.includes('insideDownloads(p)'));

  const panel = readFileSync(new URL('../src/components/browser/DownloadsPanel.tsx', import.meta.url), 'utf8');
  check('видно, куда всё складывается', panel.includes('Всё скачивается сюда'));
  check('есть «открыть» и «показать в папке»',
    panel.includes('Открыть файл') && panel.includes('Показать в папке'));
  // Очистка списка не должна трогать сами файлы: человек за ними и приходил
  check('очистка списка не удаляет файлы', panel.includes('Сами файлы останутся на месте'));

  const screen = readFileSync(new URL('../src/screens/BrowserScreen.tsx', import.meta.url), 'utf8');
  check('раздел открывается из браузера', screen.includes('<DownloadsPanel'));
  check('страница уступает разделу — иначе он окажется под ней',
    screen.includes('if (blank || panel || overlays > 0)'));
  check('список привязан к вошедшему', screen.includes('setWho(me?.id'));
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки загрузок пройдены');
