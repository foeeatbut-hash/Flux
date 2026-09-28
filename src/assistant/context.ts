/**
 * Что сейчас открыто у человека — обстановка, которую помощник обязан видеть.
 *
 * До этого помощник знал ровно одно: в каком он разделе. На «а этот срок
 * когда?» он переспрашивал «какой именно?», хотя нужный документ был открыт
 * прямо перед человеком и виден программе. Переспрашивать очевидное — самый
 * быстрый способ показать, что помощник не понимает, где находится.
 *
 * Здесь только правила: что считать передним планом, когда вопрос вообще
 * нуждается в обстановке и как её назвать словами. Ни React, ни хранилищ —
 * у всего этого есть правильный ответ, и его проверяет scripts/test-assistant-context.ts.
 *
 * Короткая память намеренно короткая: три последних дела. Длинная история —
 * это уже журнал (§32), у него своё место и своё право доступа.
 */

export interface OpenThing {
  /** Раздел окна: /doc, /pdf, /registry… */
  path: string;
  /** Название раздела человеческим словом */
  section: string;
  /** Имя открытого документа, если раздел его объявил */
  title: string;
  /** Порядок наложения: больше — ближе к человеку */
  z: number;
  /** Свёрнутое окно на переднем плане не стоит, даже если оно самое верхнее */
  minimized?: boolean;
}

export interface WorkContext {
  /** Раздел, в котором человек сейчас работает */
  route: string;
  section: string;
  projectName: string;
  open: OpenThing[];
  /** Последние дела, свежие первыми */
  recent: string[];
}

/** Три дела — столько человек и держит в голове, говоря «то, что я делал» */
export const RECENT_KEPT = 3;

/**
 * Что на переднем плане.
 *
 * Свёрнутые окна пропускаем: свёрнутое окно человек не видит, и считать его
 * «этим документом» — верный способ ответить не про то. Окно без имени
 * документа тоже годится: это раздел, и говорить о нём можно.
 */
export function frontOf(open: OpenThing[]): OpenThing | null {
  const live = open.filter((w) => !w.minimized);
  if (!live.length) return null;
  return live.reduce((top, w) => (w.z > top.z ? w : top), live[0]);
}

/** Открытые документы (у окна есть имя документа), свежие первыми */
export function openDocs(open: OpenThing[]): OpenThing[] {
  return open
    .filter((w) => !w.minimized && w.title.trim())
    .sort((a, b) => b.z - a.z);
}

/**
 * Нуждается ли вопрос в обстановке.
 *
 * Указательные слова — «этот», «здесь», «тут», «сейчас», «его» — только и
 * значат «то, что перед глазами». Вопрос без них самодостаточен, и
 * подмешивать в него открытый документ незачем: человек спросил про другое.
 */
// Границу слова здесь нельзя брать через \W и \b: в JS они считают буквами
// только латиницу, и «тегов» подходит под «его» — вопрос «сколько тегов в
// проекте» вдруг становится вопросом про открытый документ. Поэтому границы
// заданы явно, с кириллицей внутри
const EDGE = '[^А-Яа-яЁёA-Za-z]';
const POINTERS = new RegExp(
  `(^|${EDGE})(эт(от|о|а|и|ом|ого|ой)|тут|здесь|отсюда|сейчас|его|её|их|текущ[а-яё]*|открыт[а-яё]*)(${EDGE}|$)`,
  'i',
);

export function needsContext(text: string): boolean {
  return POINTERS.test(String(text || ''));
}

/** Спрашивают ли прямо про обстановку: «что открыто», «где я» */
const ABOUT_CONTEXT = /(что.{0,10}открыт|где я|что я делал|чем я занимал|последние действия|что сейчас открыто)/i;

export function asksAboutContext(text: string): boolean {
  return ABOUT_CONTEXT.test(String(text || ''));
}

/**
 * Обстановка словами — так, как её описал бы сидящий рядом коллега.
 *
 * Пустое место не выдумываем: нет проекта — не пишем «проект: —», а молчим
 * про него. Строка с прочерками читается как поломка, а не как «пусто».
 */
export function describeContext(ctx: WorkContext): string {
  const lines: string[] = [];
  // В оконной оболочке адрес остаётся на «Главной», пока человек работает в
  // окне: назвать разделом «Главную» — значит сказать неправду о том, что он
  // видит. Спрашиваем передний план, а адрес берём, только когда окон нет
  const front = frontOf(ctx.open);
  const where = front ? (front.title.trim() || front.section) : ctx.section;
  lines.push(`Раздел: ${where || 'не открыт'}.`);
  if (ctx.projectName) lines.push(`Проект: ${ctx.projectName}.`);

  const docs = openDocs(ctx.open);
  if (docs.length === 1) {
    lines.push(`Открыт документ: ${docs[0].title}.`);
  } else if (docs.length > 1) {
    lines.push(`Открыто документов: ${docs.length} — ${docs.map((d) => d.title).join(', ')}.`);
  }

  // Прочие окна — те, что не на переднем плане и без имени документа: про
  // передний план уже сказано первой строкой, повторять его незачем
  const others = ctx.open.filter((w) => !w.minimized && !w.title.trim() && w !== front);
  if (others.length) {
    lines.push(`Ещё открыто: ${[...new Set(others.map((w) => w.section))].join(', ')}.`);
  }

  if (ctx.recent.length) {
    lines.push(`Последнее: ${ctx.recent.slice(0, RECENT_KEPT).join('; ')}.`);
  }
  return lines.join('\n');
}

/**
 * Чем помощник дополняет ответ, когда в вопросе есть указательное слово.
 *
 * Возвращает пустую строку, когда дополнять нечем: молчание честнее, чем
 * приписка «ничего не открыто» под каждым ответом.
 */
export function contextHint(ctx: WorkContext): string {
  const front = frontOf(ctx.open);
  if (!front) return '';
  const what = front.title.trim() || front.section;
  return `Считаю, что речь про то, что открыто сейчас: ${what}.`;
}

/**
 * Записать дело в короткую память.
 *
 * Повтор подряд не двоится: человек, трижды открывший один раздел, сделал
 * одно дело, а не три, — иначе память забивается одним и тем же и перестаёт
 * что-либо значить.
 */
export function rememberInto(list: string[], what: string): string[] {
  const item = String(what || '').trim();
  if (!item) return list;
  if (list[0] === item) return list;
  return [item, ...list.filter((x) => x !== item)].slice(0, RECENT_KEPT);
}
