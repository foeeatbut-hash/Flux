/**
 * Проверки сопоставлений: чем открывается файл.
 *
 * Ошибка здесь тихая: файл открывается — просто не тем. Двойное нажатие по
 * чертежу уводит в предпросмотр вместо редактора пометок, и человек решает, что
 * пометки «не работают».
 *
 * Запуск: npx tsx scripts/test-file-types.ts
 */
import {
  appsFor, openHref, hasChoice, isPdf, isOffice, isConstructorDoc, FILE_APPS,
  faceOf, dbTypeOf, typeLabel, legacyAdvice,
} from '../src/lib/fileTypes';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

console.log('Кого чем открываем');
{
  const pdf = { id: 'f1', name: 'АР-01.pdf', type: 'PDF', folderId: 'd1' };
  check('чертёж открывает Чертёж', appsFor(pdf)[0].id === 'pdf', appsFor(pdf).map((a) => a.id));
  check('и предлагает Проводник вторым', appsFor(pdf)[1]?.id === 'explorer');
  check('у чертежа есть выбор', hasChoice(pdf));

  const oldPdf = { id: 'f2', name: 'Схема.PDF' };
  check('чертёж без типа узнаётся по имени', isPdf(oldPdf) && appsFor(oldPdf)[0].id === 'pdf');
  check('«pdf» посреди имени не делает файл чертежом', !isPdf({ id: 'f3', name: 'pdf-инструкция.docx' }));

  const doc = { id: 'f4', name: 'Ведомость', type: 'CONSTRUCTOR', refId: 'doc-9' };
  check('документ Flux Office открывает Flux Office', appsFor(doc)[0].id === 'docs');
  check('и выбора для него нет', !hasChoice(doc), appsFor(doc).map((a) => a.id));
  check('документ узнаётся и по одной ссылке', isConstructorDoc({ id: 'f5', refId: 'doc-1' }));

  const any = { id: 'f6', name: 'Фото.jpg', folderId: 'd2' };
  check('картинку показывает Проводник', appsFor(any)[0].id === 'explorer');

  // Тупик, из-за которого «не все файлы открываются»: своей программы нет, и
  // раньше человек упирался в значок с подписью «Файл». Теперь есть выход
  const cad = { id: 'f8', name: 'Узел.dwg', folderId: 'd2' };
  check('чертёж САПР предлагает открыть его Windows',
    appsFor(cad).some((a) => a.id === 'windows'), appsFor(cad).map((a) => a.id));
}

console.log('Один список расширений на всю программу');
{
  check('книга Excel — таблица', faceOf('Смета.xlsx') === 'sheet');
  check('старая книга Excel тоже таблица', faceOf('Смета.xls') === 'sheet');
  // SheetJS читает и BIFF: отказывать .xls было нашим упущением, а не
  // свойством формата
  check('и она открывается', isOffice({ id: '1', name: 'Смета.xls' }));
  check('старый .doc не открывается', !isOffice({ id: '2', name: 'Записка.doc' }));
  check('но про него сказано, что делать',
    legacyAdvice('Записка.doc').includes('.docx'), legacyAdvice('Записка.doc'));
  check('про .docx советов нет', legacyAdvice('Записка.docx') === '');
  check('тип для базы прежний', dbTypeOf('Смета.xlsx') === 'XLSX' && dbTypeOf('АР.pdf') === 'PDF');
  check('неизвестное расширение не теряется', dbTypeOf('модель.step') === 'STEP');
  check('тип называется словами', typeLabel('Смета.xlsx') === 'Книга Excel', typeLabel('Смета.xlsx'));
  check('и для незнакомого — тоже', typeLabel('модель.step') === 'Файл .step', typeLabel('модель.step'));
  check('точка в начале имени расширением не считается', faceOf('.gitignore') === 'binary');
}

console.log('Адреса');
{
  check('чертёж открывается по своему файлу',
    openHref({ id: 'f1', type: 'PDF' }) === '/pdf?file=f1', openHref({ id: 'f1', type: 'PDF' }));
  check('документ — по ссылке на документ, а не по файлу',
    openHref({ id: 'f4', refId: 'doc-9' }) === '/sheet?doc=doc-9',
    openHref({ id: 'f4', refId: 'doc-9' }));
  // Зеркало помнит, чем документ открывается: иначе окно текста показывало бы
  // значок таблицы, и человек искал бы на панели задач не ту кнопку
  check('текстовый документ открывает «Документ», а не «Таблицу»',
    openHref({ id: 'f4', refId: 'doc-9', filePath: '/doc/doc-9' }) === '/doc?doc=doc-9',
    openHref({ id: 'f4', refId: 'doc-9', filePath: '/doc/doc-9' }));
  check('принесённая книга открывается Таблицей',
    openHref({ id: 'f9', name: 'Смета.xlsx' }) === '/sheet?fromFile=f9',
    openHref({ id: 'f9', name: 'Смета.xlsx' }));
  check('принесённый ворд — Документом',
    openHref({ id: 'f9', name: 'Записка.docx' }) === '/doc?fromFile=f9',
    openHref({ id: 'f9', name: 'Записка.docx' }));
  check('в Проводнике открывается вместе с папкой',
    openHref({ id: 'f6', folderId: 'd2' }) === '/explorer?file=f6&folder=d2');
  check('без папки — просто файлом',
    openHref({ id: 'f7' }) === '/explorer?file=f7', openHref({ id: 'f7' }));
  check('опасные знаки в имени папки не ломают адрес',
    openHref({ id: 'a b', folderId: 'п/п' }) === '/explorer?file=a%20b&folder=%D0%BF%2F%D0%BF',
    openHref({ id: 'a b', folderId: 'п/п' }));
}

console.log('Список программ опрятен');
{
  for (const [key, app] of Object.entries(FILE_APPS)) {
    check(`${key}: ключ совпадает с именем`, app.id === key);
    const f = { id: 'x', name: 'Смета.xlsx', refId: 'y', folderId: 'z' };
    check(`${key}: у программы есть раздел`, app.path(f).startsWith('/'));
    check(`${key}: адрес ведёт в её же раздел`,
      app.href(f).startsWith(app.path(f) + '?'), app.href(f));
  }
}

console.log(failed === 0 ? '\nВсе проверки сопоставлений пройдены' : `\nПровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
