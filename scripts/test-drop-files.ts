/**
 * Приём файлов из Windows: что принимаем, под каким именем и что говорим.
 *
 * Проверка написана по поломке: стол не принимал файлы Windows вообще. Он читал
 * только своё содержимое переноса и молча выходил, если пришло чужое, — а для
 * человека это выглядело как «перетащил, и ничего не случилось». Ни значка, ни
 * ошибки, ни объяснения.
 *
 * Здесь проверяется вторая половина того же: отказ должен звучать ДО переноса.
 * Файл, который «загрузился» без содержимого, потом не открывается, и человек
 * считает сломанной программу, а не свой файл на 200 МБ.
 *
 * Запуск: npx tsx scripts/test-drop-files.ts
 */
import {
  planDrop, uniqueName, typeOf, dropLabel, dropResult, heavyOnes, WARN_FILE_BYTES,
} from '../src/lib/dropFiles';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const f = (name: string, size = 1024) => ({ name, size });

console.log('Имя, которого ещё нет в папке');
{
  check('свободное имя не меняется', uniqueName('Смета.xlsx', new Set()) === 'Смета.xlsx');
  check('занятое получает номер',
    uniqueName('Смета.xlsx', new Set(['Смета.xlsx'])) === 'Смета (2).xlsx',
    uniqueName('Смета.xlsx', new Set(['Смета.xlsx'])));
  // Номер приписывается перед расширением: «Смета.xlsx (2)» Windows откроет
  // не тем, чем нужно — программу определяет расширение
  check('расширение остаётся последним',
    uniqueName('Смета.xlsx', new Set(['Смета.xlsx'])).endsWith('.xlsx'));
  check('счёт идёт дальше, пока имя занято',
    uniqueName('Смета.xlsx', new Set(['Смета.xlsx', 'Смета (2).xlsx'])) === 'Смета (3).xlsx');
  check('имя без расширения тоже нумеруется',
    uniqueName('Чертежи', new Set(['Чертежи'])) === 'Чертежи (2)');
  check('точка в начале расширением не считается',
    uniqueName('.gitignore', new Set(['.gitignore'])) === '.gitignore (2)',
    uniqueName('.gitignore', new Set(['.gitignore'])));
}

console.log('Тип по расширению');
{
  check('Excel', typeOf('Смета.xlsx') === 'XLSX');
  check('Word', typeOf('Пояснительная.docx') === 'DOCX');
  check('чертёж', typeOf('Схема.pdf') === 'PDF');
  check('картинка', typeOf('Фото.JPG') === 'IMAGE');
  check('неизвестное расширение не выдумывается', typeOf('данные.dwg') === 'DWG');
  // Раньше здесь возвращалось «README»: расширением считался хвост после
  // последней точки, а без точки — всё имя целиком. В свойствах файла это
  // выглядело как тип «README», и у каждого безымянного файла тип был свой
  check('файл без расширения — просто файл', typeOf('README') === 'FILE', typeOf('README'));
  check('точка в начале имени расширением не считается', typeOf('.gitignore') === 'FILE', typeOf('.gitignore'));
}

console.log('Что принимаем');
{
  const plan = planDrop([f('Смета.xlsx'), f('Смета.xlsx'), f('Пояснительная.docx')]);
  check('приняты все три', plan.accepted.length === 3, plan.accepted.map((a) => a.name));
  check('второй одноимённый переименован',
    plan.accepted[1].name === 'Смета (2).xlsx', plan.accepted[1].name);
  check('в одном переносе имена не совпадают',
    new Set(plan.accepted.map((a) => a.name)).size === 3);

  const busy = planDrop([f('Смета.xlsx')], ['Смета.xlsx']);
  check('занятое в папке имя учитывается', busy.accepted[0].name === 'Смета (2).xlsx', busy.accepted[0].name);
}

console.log('Что отклоняем — и говорим об этом');
{
  // Предела на размер больше нет: содержимое едет в базу кусками, и «сколько
  // влезает в пакет» стало свойством куска. Двести мегабайт — обычный файл
  const big = planDrop([f('Огромный.xlsx', 200 * 1024 * 1024)]);
  check('большой файл принимается', big.accepted.length === 1 && big.refused.length === 0, big.refused);

  // Но молчать про полгигабайта нельзя: он ляжет в общую базу и в резервную
  // копию. Программа спрашивает один раз, а не запрещает
  const heavy = heavyOnes([f('Малый.xlsx'), f('Тяжёлый.zip', WARN_FILE_BYTES + 1)]);
  check('про очень тяжёлый спрашиваем', heavy.length === 1 && heavy[0].name === 'Тяжёлый.zip', heavy);
  check('а про обычный — нет', heavyOnes([f('Смета.xlsx', 40 * 1024 * 1024)]).length === 0);

  // Папка приезжает из Windows как файл нулевого размера — самый частый
  // случай «перенос не работает»
  const dir = planDrop([{ name: 'Проект', size: 0 }]);
  check('папка не принята', dir.accepted.length === 0);
  check('и сказано, что папки нельзя', dir.refused[0].why.includes('папк'), dir.refused[0]);

  const noname = planDrop([{ name: '   ', size: 10 }]);
  check('файл без имени не принят', noname.accepted.length === 0 && noname.refused.length === 1);

  const mixed = planDrop([f('Хороший.docx'), { name: 'Папка', size: 0 }]);
  check('годное принимается, даже если рядом негодное', mixed.accepted.length === 1);
  check('и негодное не теряется молча', mixed.refused.length === 1);
}

console.log('Что человек читает');
{
  check('один файл назван по имени', dropLabel([f('Смета.xlsx')]).includes('Смета.xlsx'));
  check('и сказано, куда он ляжет', dropLabel([f('Смета.xlsx')]).includes('на ваш стол'));
  check('два файла — «2 файла»', dropLabel([f('а'), f('б')]).startsWith('2 файла'), dropLabel([f('а'), f('б')]));
  check('пять файлов — «5 файлов»',
    dropLabel([f('а'), f('б'), f('в'), f('г'), f('д')]).startsWith('5 файлов'));
  check('двадцать один файл — «21 файл»',
    dropLabel(Array.from({ length: 21 }, (_, i) => f(`ф${i}`))).startsWith('21 файл'),
    dropLabel(Array.from({ length: 21 }, (_, i) => f(`ф${i}`))));
  check('пустой перенос не подписывается', dropLabel([]) === '');

  const said = dropResult(2, [{ name: 'Огромный.xlsx', why: '200 МБ — больше предела в 25 МБ' }], []);
  check('итог называет и принятое, и отклонённое',
    said.includes('2') && said.includes('Огромный.xlsx'), said);
  check('удачный перенос не поминает неудач', dropResult(1, [], []) === 'Файл на вашем столе');
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки приёма файлов пройдены');
