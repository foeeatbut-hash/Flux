/**
 * Проверки командной строки оболочки.
 *
 * Опаснее всего здесь разбор времени: напоминание, поставленное не на тот час,
 * приходит тогда, когда уже поздно, и человек об этом узнаёт последним. Поэтому
 * время проверяется от заданного «сейчас», а не от настоящего, — иначе проверка
 * ведёт себя по-разному утром и вечером.
 *
 * Запуск: npx tsx scripts/test-command-bar.ts
 */
import {
  SLASH, parseSlash, slashPrefix, parseWhen, whenLabel, suggest, sectionByWord,
} from '../src/lib/commandBar';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const SECTIONS = [
  { path: '/mail', title: 'Почта' },
  { path: '/registry', title: 'Теги' },
  { path: '/sheet', title: 'Таблица', multi: true },
  { path: '/explorer', title: 'Проводник', multi: true },
];
const ARTICLES = [{ id: 'windows', title: 'Окна, доли экрана и столы', hint: 'оболочка' }];
const HITS = [{ kind: 'tag', id: 't1', title: '3700-K02', subtitle: 'тег', route: '/registry?focus=t1' }];
const SRC = { sections: SECTIONS, articles: ARTICLES, hits: HITS };

// Среда, 27 августа 2026, 14:00
const NOW = new Date(2026, 7, 27, 14, 0, 0, 0).getTime();

console.log('Команды');
{
  check('команд не меньше семи', SLASH.length >= 7, SLASH.length);
  check('имена команд не повторяются', new Set(SLASH.map((c) => c.name)).size === SLASH.length);
  check('у каждой команды есть значок и объяснение',
    SLASH.every((c) => c.icon && c.about));

  check('«/открой почта» разбирается', parseSlash('/открой почта')?.cmd.name === 'открой');
  check('остаток строки достаётся целиком',
    parseSlash('/напомни завтра в 9 позвонить')?.rest === 'завтра в 9 позвонить');
  check('обычный текст командой не считается', parseSlash('покажи дубли') === null);
  check('несуществующая команда — не команда', parseSlash('/абракадабра что-то') === null);
  check('начатая команда подсказывается', slashPrefix('/на').some((c) => c.name === 'напомни'));
  check('«/переведи» разбирается и отдаёт текст',
    parseSlash('/переведи опросный лист')?.rest === 'опросный лист');
  check('дописанная команда уже не подсказка', slashPrefix('/напомни завтра').length === 0);
}

console.log('Когда напомнить');
{
  const t1 = parseWhen('завтра в 9 позвонить поставщику', NOW);
  const d1 = new Date(t1.at!);
  check('«завтра в 9» — следующий день, девять утра',
    d1.getDate() === 28 && d1.getHours() === 9 && d1.getMinutes() === 0, d1.toString());
  check('время из текста убрано', t1.rest === 'позвонить поставщику', t1.rest);

  const t2 = parseWhen('через 15 минут отправить письмо', NOW);
  check('«через 15 минут» считается от сейчас', t2.at === NOW + 15 * 60000, t2.at! - NOW);
  check('и остаток тоже чистый', t2.rest === 'отправить письмо', t2.rest);

  const t3 = parseWhen('в 17:30 совещание', NOW);
  const d3 = new Date(t3.at!);
  check('«в 17:30» — сегодня', d3.getDate() === 27 && d3.getHours() === 17 && d3.getMinutes() === 30, d3.toString());

  // 14:00 сейчас, «в 9» уже прошло — значит завтра
  const t4 = parseWhen('в 9 планёрка', NOW);
  check('прошедший час переносится на завтра', new Date(t4.at!).getDate() === 28, new Date(t4.at!).toString());

  const t5 = parseWhen('в пятницу сдать ведомость', NOW);
  const d5 = new Date(t5.at!);
  check('«в пятницу» — ближайшая пятница', d5.getDay() === 5 && d5.getDate() === 28, d5.toString());
  check('день недели тоже убран из текста', t5.rest === 'сдать ведомость', t5.rest);

  const t6 = parseWhen('позвонить поставщику', NOW);
  check('без времени не выдумываем час', t6.at === null, t6.at);
  check('и текст остаётся целым', t6.rest === 'позвонить поставщику');

  const t7 = parseWhen('через 2 часа', NOW);
  check('«через 2 часа» — два часа', t7.at === NOW + 2 * 3600000);

  check('подпись «завтра»', whenLabel(new Date(2026, 7, 28, 9, 0).getTime(), NOW) === 'завтра в 09:00',
    whenLabel(new Date(2026, 7, 28, 9, 0).getTime(), NOW));
  check('подпись «сегодня»', whenLabel(new Date(2026, 7, 27, 18, 5).getTime(), NOW) === 'сегодня в 18:05');
  check('дальняя дата — числом', /сентября в 10:00/.test(whenLabel(new Date(2026, 8, 3, 10, 0).getTime(), NOW)),
    whenLabel(new Date(2026, 8, 3, 10, 0).getTime(), NOW));
}

console.log('Что предлагает строка');
{
  const empty = suggest('', SRC, NOW);
  check('пустая строка подсказывает слэш', empty.length === 1 && empty[0].run.kind === 'fill', empty);

  const s = suggest('почт', SRC, NOW);
  check('раздел находится по началу слова', s[0].run.kind === 'navigate' && (s[0].run as any).route === '/mail', s[0]);
  check('помощник — последняя строка', s[s.length - 1].group === 'помощник', s.map((x) => x.group));

  const withHits = suggest('3700', SRC, NOW);
  check('найденное в проекте показывается', withHits.some((x) => x.group === 'проект'), withHits.map((x) => x.group));
  check('статья руководства тоже', withHits.some((x) => x.group === 'справка'));

  const cmd = suggest('/открой почт', SRC, NOW);
  check('команда «открой» ведёт в раздел',
    cmd[0].run.kind === 'navigate' && (cmd[0].run as any).route === '/mail', cmd[0]);
  const win = suggest('/окно таблица', SRC, NOW);
  check('команда «окно» просит ещё одно окно', win[0].run.kind === 'newWindow', win[0]);
  const single = suggest('/окно почта', SRC, NOW);
  check('у единичной программы честно сказано про одно окно',
    /окно одно/.test(single[0].subtitle), single[0].subtitle);

  const tr = suggest('/переведи опросный лист', SRC, NOW);
  check('перевод уходит в Переводчик, а не отвечает строкой',
    tr[0].run.kind === 'translate' && (tr[0].run as any).text === 'опросный лист', tr[0]);

  const rem = suggest('/напомни завтра в 9 позвонить', SRC, NOW);
  check('напоминание собирается', rem[0].run.kind === 'remind', rem[0]);
  check('в подписи видно, когда придёт', /завтра в 09:00/.test(rem[0].title), rem[0].title);
  const remBad = suggest('/напомни позвонить', SRC, NOW);
  check('без времени напоминание не ставится', remBad[0].run.kind === 'fill', remBad[0]);

  const ctx = suggest('сколько строк', { ...SRC, context: 'Ведомость В-2' }, NOW);
  const ask = ctx[ctx.length - 1];
  check('помощник говорит, что учтёт открытое', /Ведомость В-2/.test(ask.subtitle), ask.subtitle);
}

console.log('Раздел по слову');
{
  check('точное имя', sectionByWord('Почта', SECTIONS)?.path === '/mail');
  check('начало слова', sectionByWord('провод', SECTIONS)?.path === '/explorer');
  check('чужое слово — ничего', sectionByWord('вертолёт', SECTIONS) === null);
  check('пустое слово — ничего', sectionByWord('', SECTIONS) === null);
}

console.log(failed === 0 ? '\nВсе проверки командной строки пройдены' : `\nПровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
