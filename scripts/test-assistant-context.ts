/**
 * Помощник видит, что открыто.
 *
 * Проверка написана по §17.3: помощник знал только свой раздел и на «а этот
 * срок когда?» переспрашивал «какой именно?», хотя нужный документ был открыт
 * перед человеком и виден программе. Переспрашивать очевидное — самый быстрый
 * способ показать, что помощник не понимает, где он находится.
 *
 * Ошибиться тут можно тихо и обидно: посчитать передним планом свёрнутое окно
 * и ответить не про тот документ. Такую ошибку человек замечает не сразу, а
 * доверие к помощнику теряет навсегда.
 *
 * Запуск: npx tsx scripts/test-assistant-context.ts
 */
import {
  frontOf, openDocs, needsContext, asksAboutContext, describeContext,
  contextHint, rememberInto, RECENT_KEPT, type OpenThing, type WorkContext,
} from '../src/assistant/context';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const win = (path: string, section: string, title: string, z: number, minimized = false): OpenThing =>
  ({ path, section, title, z, minimized });

console.log('Передний план');
{
  const open = [
    win('/sheet', 'Таблица', 'Смета.xlsx', 3),
    win('/pdf', 'Просмотр', 'Паспорт АХУ.pdf', 5),
    win('/registry', 'Теги', '', 1),
  ];
  check('самое верхнее окно и есть передний план', frontOf(open)?.title === 'Паспорт АХУ.pdf', frontOf(open));

  // Свёрнутое человек не видит: считать его «этим документом» — ответить не про то
  const withMin = [win('/pdf', 'Просмотр', 'Паспорт АХУ.pdf', 9, true), ...open];
  check('свёрнутое окно передним планом не считается',
    frontOf(withMin)?.title === 'Паспорт АХУ.pdf' && frontOf(withMin)?.z === 5, frontOf(withMin));

  check('когда ничего не открыто — честный пустой ответ', frontOf([]) === null);
  check('все свёрнуты — тоже пусто', frontOf([win('/pdf', 'Просмотр', 'а', 2, true)]) === null);
}

console.log('Открытые документы');
{
  const open = [
    win('/sheet', 'Таблица', 'Смета.xlsx', 3),
    win('/registry', 'Теги', '', 7),
    win('/pdf', 'Просмотр', 'Паспорт.pdf', 5),
  ];
  const docs = openDocs(open);
  check('раздел без имени документа в список документов не попадает', docs.length === 2, docs.map((d) => d.section));
  check('свежие первыми', docs[0].title === 'Паспорт.pdf', docs.map((d) => d.title));
  check('пробел вместо имени — это не имя',
    openDocs([win('/pdf', 'Просмотр', '   ', 1)]).length === 0);
}

console.log('Когда вопросу нужна обстановка');
{
  check('«а этот срок когда?»', needsContext('а этот срок когда?'));
  check('«что тут за поля?»', needsContext('что тут за поля?'));
  check('«кто его правил?»', needsContext('кто его правил?'));
  check('«покажи текущий документ»', needsContext('покажи текущий документ'));
  // Самодостаточный вопрос: подмешивать в него открытый документ незачем
  check('«сколько тегов в проекте» обстановки не требует', !needsContext('сколько тегов в проекте'));
  check('«создай событие на завтра» — тоже', !needsContext('создай событие на завтра'));
  check('пустая строка не роняет', !needsContext(''));
}

console.log('Когда спрашивают прямо про обстановку');
{
  check('«что открыто?»', asksAboutContext('что открыто?'));
  check('«где я»', asksAboutContext('где я'));
  check('«что я делал»', asksAboutContext('что я делал'));
  check('«покажи теги» — не про обстановку', !asksAboutContext('покажи теги'));
}

console.log('Обстановка словами');
{
  const ctx: WorkContext = {
    route: '/sheet',
    section: 'Таблица',
    projectName: 'Альфа',
    open: [
      win('/sheet', 'Таблица', 'Смета.xlsx', 3),
      win('/registry', 'Теги', '', 1),
    ],
    recent: ['открыл «Смета.xlsx»', 'создал тег AHU-1'],
  };
  const said = describeContext(ctx);
  check('раздел назван по переднему плану', said.startsWith('Раздел: Смета.xlsx'), said);
  check('проект назван', said.includes('Альфа'), said);
  check('документ назван', said.includes('Смета.xlsx'), said);
  check('прочие окна названы разделом', said.includes('Теги'), said);
  // Передний план уже назван первой строкой — во «ещё открыто» ему не место
  check('передний план не повторяется',
    said.split('Ещё открыто')[1] === undefined || !said.split('Ещё открыто')[1].includes('Таблица'), said);
  check('последние дела перечислены', said.includes('создал тег AHU-1'), said);

  // Пустое место не выдумываем: «Проект: —» читается как поломка, а не «пусто»
  const bare: WorkContext = { route: '/', section: 'Главная', projectName: '', open: [], recent: [] };
  const bareSaid = describeContext(bare);
  check('без проекта про проект молчим', !bareSaid.includes('Проект'), bareSaid);
  check('без открытого молчим про документы', !/документ/i.test(bareSaid), bareSaid);
  // Окон нет — значит говорим по адресу: это единственный случай, когда
  // раздел берётся из адреса, а не с переднего плана
  check('без окон раздел берётся из адреса', bareSaid.includes('Главная'), bareSaid);
}

console.log('Подсказка к ответу');
{
  const ctx: WorkContext = {
    route: '/pdf', section: 'Просмотр', projectName: '',
    open: [win('/pdf', 'Просмотр', 'Паспорт.pdf', 2)], recent: [],
  };
  check('называет то, что перед глазами', contextHint(ctx).includes('Паспорт.pdf'), contextHint(ctx));
  // Молчание честнее приписки «ничего не открыто» под каждым ответом
  check('когда нечего сказать — молчит',
    contextHint({ ...ctx, open: [] }) === '', contextHint({ ...ctx, open: [] }));
  // Окно без документа — тоже обстановка: про раздел говорить можно
  check('раздел без документа назван разделом',
    contextHint({ ...ctx, open: [win('/registry', 'Теги', '', 1)] }).includes('Теги'));
}

console.log('Короткая память');
{
  let mem: string[] = [];
  mem = rememberInto(mem, 'открыл «Смета.xlsx»');
  mem = rememberInto(mem, 'создал тег AHU-1');
  check('дела копятся, свежие первыми', mem[0] === 'создал тег AHU-1', mem);

  const same = rememberInto(mem, 'создал тег AHU-1');
  check('повтор подряд не двоится', same.length === mem.length, same);

  // Возврат к прежнему делу поднимает его наверх, а не заводит второе
  const back = rememberInto(mem, 'открыл «Смета.xlsx»');
  check('прежнее дело поднимается, а не двоится',
    back[0] === 'открыл «Смета.xlsx»' && back.length === 2, back);

  let many: string[] = [];
  for (const w of ['а', 'б', 'в', 'г', 'д']) many = rememberInto(many, w);
  check(`помним не больше ${RECENT_KEPT}`, many.length === RECENT_KEPT, many);
  check('и это самые свежие', many.join('') === 'дгв', many);

  check('пустое дело не запоминается', rememberInto([], '   ').length === 0);
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки обстановки помощника пройдены');
