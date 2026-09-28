/**
 * Выгрузки — настоящие файлы Flux, а не скачивание мимо программы.
 *
 * Правило: любая выгрузка для человека (ВДР, ведомость и бланк заказа
 * Конструктора, ответ Помощника) кладётся файлом через saveNewFile /
 * createFileFromBytes и сразу открывается — а не скачивается браузером и не
 * пишется одним JSON-полем `content` мимо кусков. Проверка статическая (по
 * исходникам, без сервера): что каждое перечисленное место и правда зовёт
 * общий путь, что «в Word» не отдаёт HTML под именем .doc и что «в Excel»
 * не отдаёт CSV под именем .xlsx.
 *
 * Запуск: npx tsx scripts/test-exports.ts
 */
import { readFileSync } from 'node:fs';

let failed = 0;
const check = (name: string, cond: boolean) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}`);
};

const src = (p: string) => readFileSync(p, 'utf8');

console.log('ВДР — «Выгрузить»');
{
  const server = src('server/routes/vdr.ts');
  check('сервер сам кладёт книгу через createFileFromBytes', /createFileFromBytes\(/.test(server));
  check('книга ложится в «Выгрузки» (exportsHome)', /exportsHome\(/.test(server));
  check('маршрут экспорта отвечает {id,name}, а не байтами книги', /res\.json\(\{\s*id:\s*file\.id,\s*name:\s*file\.name\s*\}\)/.test(server));
  check('старой отдачи buf браузеру не осталось', !/res\.send\(buf\)/.test(server));

  const panel = src('src/screens/VdrPanel.tsx');
  check('окно открывает получившийся файл (editorHref)', /editorHref\(/.test(panel) && /navigate\(editorHref/.test(panel));
  check('скачивания через <a download> не осталось', !/a\.download\s*=/.test(panel.slice(panel.indexOf('exportXlsx'), panel.indexOf('exportXlsx') + 700)));
}

console.log('Конструктор — список ведомости');
{
  const screen = src('src/screens/BuilderScreen.tsx');
  const at = screen.indexOf('const exportList');
  const body = screen.slice(at, at + 500);
  check('список кладётся saveNewFile', /saveNewFile\(/.test(body));
  check('и сразу открывается', /navigate\(editorHref/.test(body));
  check('сохранения на диск (saveBytes) в этой ветке не осталось', !/saveBytes\(/.test(body));
}

console.log('Конструктор — бланк заказа');
{
  const blank = src('src/lib/blankXlsx.ts');
  check('бланк в Проводник — через saveNewFile, не JSON-полем content', /saveNewFile\(/.test(blank) && !/content:\s*toBase64/.test(blank));
  check('ревизия передаётся в карточку файла', /revision/.test(blank));

  const issue = src('src/components/builder/IssuePanel.tsx');
  const at = issue.indexOf("excel('explorer')");
  check('кнопка «В Проводник» найдена', at >= 0);
  const body = issue.slice(issue.indexOf('const excel'), issue.indexOf('const excel') + 800);
  check('положенный бланк сразу открывается', /navigate\(editorHref/.test(body));
}

console.log('Помощник — «выгрузить в Excel/Word»');
{
  const table = src('src/assistant/tableExport.ts');
  check('Excel собирается книгой (xlsx), а не CSV под её именем', /XLSX\.write\(/.test(table) && !/toCsv|text\/csv/.test(table));
  check('Word — настоящий .docx (buildDocx), а не HTML под .doc', /buildDocx\(/.test(table));
  check('HTML под видом .doc не осталось', !/application\/msword/.test(table) && !table.includes(".doc'"));
  check('модуль без DOM-скачивания — только байты и имя наружу', !/document\.createElement\('a'\)/.test(table));

  const store = src('src/store/assistantStore.ts');
  const at = store.indexOf('export-excel');
  const body = store.slice(Math.max(0, at - 900), at + 400);
  check('файл кладётся saveNewFile и открывается editorHref', /saveNewFile\(/.test(body) && /editorHref\(/.test(body));
}

console.log(failed ? `\nПровалов: ${failed}` : '\nВсё верно');
process.exit(failed ? 1 : 0);
