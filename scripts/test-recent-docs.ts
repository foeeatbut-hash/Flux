/**
 * Недавние вещи, а не разделы.
 *
 * «Недавние разделы» отвечали на вопрос, которого никто не задаёт: человек и
 * так помнит, что работает в «Таблице». Он не помнит другого — как
 * называлась записка, которую правил в пятницу.
 *
 * Три места, где ошибка не видна глазом и портит список: одна вещь двоится в
 * десяти строках; в списке всплывает документ чужого проекта; «сегодня» и
 * «вчера» считаются вычитанием суток, а не по календарю, — и документ,
 * открытый вчера в 23:50, называется сегодняшним.
 *
 * Запуск: npx tsx scripts/test-recent-docs.ts
 */
import {
  addRecent, forgetRecent, visibleRecentDocs, whenLabel, kindName, RECENT_MAX,
  type RecentDoc,
} from '../src/lib/recentDocs';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const doc = (href: string, title: string, over: Partial<RecentDoc> = {}): RecentDoc =>
  ({ href, title, kind: 'sheet', at: Date.now(), ...over });

console.log('Список пополняется');
{
  let list: RecentDoc[] = [];
  list = addRecent(list, doc('/sheet?doc=1', 'Смета.xlsx'));
  list = addRecent(list, doc('/pdf?file=2', 'Паспорт.pdf', { kind: 'pdf' }));
  check('свежее первым', list[0].title === 'Паспорт.pdf', list.map((d) => d.title));

  // Десять строк «Смета.xlsx» — бесполезный список
  const again = addRecent(list, doc('/sheet?doc=1', 'Смета.xlsx'));
  check('повтор не двоится, а всплывает',
    again.length === 2 && again[0].title === 'Смета.xlsx', again.map((d) => d.title));

  check('вещь без имени не запоминается', addRecent([], doc('/x', '   ')).length === 0);
  check('вещь без адреса тоже', addRecent([], doc('  ', 'Имя')).length === 0);

  let many: RecentDoc[] = [];
  for (let i = 0; i < RECENT_MAX + 5; i++) many = addRecent(many, doc(`/d?doc=${i}`, `Д${i}`));
  check(`помещается не больше ${RECENT_MAX}`, many.length === RECENT_MAX, many.length);
  check('и это самые свежие', many[0].title === `Д${RECENT_MAX + 4}`, many[0]);
}

console.log('Забыть вещь');
{
  const list = [doc('/a', 'А'), doc('/b', 'Б')];
  check('удаляется именно она', forgetRecent(list, '/a').map((d) => d.title).join() === 'Б');
  check('чужого адреса не боится', forgetRecent(list, '/нет').length === 2);
}

console.log('Чужой проект в списке не всплывает');
{
  const list = [
    doc('/a', 'Мой', { projectId: 'p1' }),
    doc('/b', 'Чужой', { projectId: 'p2' }),
    doc('/c', 'Общий'),
  ];
  const seen = visibleRecentDocs(list, 'p1').map((d) => d.title);
  check('свой проект виден', seen.includes('Мой'), seen);
  check('чужой проект не виден', !seen.includes('Чужой'), seen);
  check('общее видно всегда', seen.includes('Общий'), seen);
  check('без выбранного проекта видно всё', visibleRecentDocs(list, null).length === 3);
}

console.log('Когда открывали');
{
  const base = new Date(2026, 8, 4, 10, 0).getTime();      // 4 сентября, утро
  const lateYesterday = new Date(2026, 8, 3, 23, 50).getTime();
  // Вычитанием суток это «сегодня» — и человек не найдёт вчерашний документ
  check('вчера в 23:50 — это вчера', whenLabel(lateYesterday, base) === 'вчера', whenLabel(lateYesterday, base));
  check('сегодня — это сегодня', whenLabel(new Date(2026, 8, 4, 1, 0).getTime(), base) === 'сегодня');
  check('три дня назад считаются днями',
    whenLabel(new Date(2026, 8, 1).getTime(), base) === '3 дн. назад', whenLabel(new Date(2026, 8, 1).getTime(), base));
  check('давнее — датой',
    whenLabel(new Date(2026, 7, 20).getTime(), base).includes('августа'), whenLabel(new Date(2026, 7, 20).getTime(), base));
}

console.log('Чем открывается');
{
  check('таблица', kindName('sheet') === 'Таблица');
  check('текст', kindName('text') === 'Документ');
  check('заметка', kindName('note') === 'Заметка');
  check('пдф', kindName('pdf') === 'Просмотр');
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки недавних документов пройдены');
