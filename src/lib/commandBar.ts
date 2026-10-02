/**
 * Строка «Спросить или найти»: что показать на набранное.
 *
 * Строк было две: Ctrl+K звал помощника, Ctrl+Shift+F искал по проекту. Человек
 * же не знает заранее, чем окажется его мысль — вопросом, поиском или командой:
 * «3700-K02» это поиск, «покажи дубли» — вопрос, «открой почту» — команда. Две
 * строки заставляли выбирать до того, как есть что выбирать.
 *
 * Здесь одна строка и один разбор. Сначала — команда (со слэша или словом),
 * потом разделы и статьи руководства (они известны сразу, без сети), потом
 * найденное в проекте (приходит с сервера), и последней строкой — вопрос
 * помощнику: он отвечает на то, что не разобралось ничем другим.
 *
 * Здесь только счёт, без React и без DOM: что делать с выбранной строкой,
 * решает оболочка, а этот разбор проверяется скриптом (scripts/test-command-bar).
 */

/** Что произойдёт по Enter. Оболочка исполняет, модель только называет */
export type BarRun =
  | { kind: 'navigate'; route: string }
  | { kind: 'newWindow'; route: string }
  | { kind: 'handbook'; articleId: string; at?: string }
  | { kind: 'ask'; query: string }
  | { kind: 'where'; usageKind: string; id: string }
  | { kind: 'check' }
  | { kind: 'changes' }
  | { kind: 'remind'; at: number; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'fill'; text: string }
  | { kind: 'translate'; text: string }
  | { kind: 'meeting'; at: number; title: string };

/** Группа задаёт порядок и подпись; порядок здесь — порядок в списке */
export type BarGroup = 'команда' | 'раздел' | 'справка' | 'проект' | 'помощник';

export interface BarItem {
  key: string;
  group: BarGroup;
  title: string;
  subtitle: string;
  /** Имя значка: строка знает про смысл, а не про библиотеку значков */
  icon: string;
  run: BarRun;
}

export interface SlashCmd {
  /** Слово команды без слэша */
  name: string;
  /** Как подсказать, что писать дальше */
  hint: string;
  /** Что команда делает — одной строкой */
  about: string;
  icon: string;
  /** Нужен ли остаток строки: команда без него только подставляется в поле */
  needsRest: boolean;
}

export const SLASH: SlashCmd[] = [
  { name: 'открой', hint: 'раздел или программу', about: 'Открыть программу', icon: 'open', needsRest: true },
  { name: 'окно', hint: 'раздел', about: 'Ещё одно окно программы', icon: 'window', needsRest: true },
  { name: 'найди', hint: 'что искать', about: 'Искать по проекту', icon: 'search', needsRest: true },
  { name: 'справка', hint: 'о чём', about: 'Найти в руководстве', icon: 'book', needsRest: true },
  { name: 'напомни', hint: 'когда и о чём', about: 'Напоминание придёт уведомлением', icon: 'bell', needsRest: true },
  { name: 'встреча', hint: 'когда и о чём', about: 'Откроется окно события — останется позвать людей', icon: 'calendar', needsRest: true },
  { name: 'заметка', hint: 'текст', about: 'Новая заметка в Блокноте', icon: 'note', needsRest: true },
  { name: 'переведи', hint: 'текст', about: 'Перевести в Переводчике', icon: 'translate', needsRest: true },
  { name: 'проверка', hint: '', about: 'Проверка проекта перед выпуском', icon: 'check', needsRest: false },
  { name: 'изменения', hint: '', about: 'Что изменилось в оборудовании', icon: 'history', needsRest: false },
];

/** Разбор строки на команду и остаток. Не команда — null */
export function parseSlash(text: string): { cmd: SlashCmd; rest: string; exact: boolean } | null {
  const t = text.trimStart();
  if (!t.startsWith('/')) return null;
  const body = t.slice(1);
  const space = body.indexOf(' ');
  const word = (space < 0 ? body : body.slice(0, space)).toLowerCase();
  const rest = space < 0 ? '' : body.slice(space + 1).trim();
  const cmd = SLASH.find((c) => c.name === word);
  if (!cmd) return null;
  return { cmd, rest, exact: space >= 0 };
}

/** Начатая, но ещё не дописанная команда: «/на» → «напомни» */
export function slashPrefix(text: string): SlashCmd[] {
  const t = text.trimStart();
  if (!t.startsWith('/') || t.includes(' ')) return [];
  const word = t.slice(1).toLowerCase();
  return SLASH.filter((c) => c.name.startsWith(word));
}

// ── Когда напомнить ────────────────────────────────────────────────────────

const DAY = 86400000;
const HOUR = 3600000;
const MIN = 60000;

/** Дни недели в том виде, в каком их пишут: «в пятницу», «во вторник» */
const WEEKDAYS: Record<string, number> = {
  воскресенье: 0, понедельник: 1, вторник: 2, среда: 3, среду: 3,
  четверг: 4, пятница: 5, пятницу: 5, суббота: 6, субботу: 6,
};

/**
 * «Завтра в 9», «через 15 минут», «в пятницу», «в 17:30» — во сколько это.
 *
 * Возвращает и время, и остаток строки: «напомни завтра в 9 позвонить
 * поставщику» должно дать напоминание «позвонить поставщику», а не повторить
 * слово «завтра» в тексте. Не разобрали время — говорим об этом честно, а не
 * ставим наугад: напоминание, пришедшее не тогда, хуже неподанного.
 */
export function parseWhen(text: string, now = Date.now()): { at: number | null; rest: string; said: string } {
  let rest = ` ${text.trim()} `;
  const base = new Date(now);
  let day = 0;              // сдвиг в днях
  let hh = -1;
  let mm = 0;
  let said = '';

  const eat = (re: RegExp, take: (m: RegExpMatchArray) => void) => {
    const m = rest.match(re);
    if (!m) return false;
    take(m);
    rest = rest.replace(re, ' ');
    return true;
  };

  // «через N минут / часов / дней» — считается от сейчас и ни с чем не спорит
  let through: number | null = null;
  // Буквы перечисляем сами: \w в регулярных выражениях JavaScript кириллицу не
  // считает буквой, и «минут» после «мин» ему уже не годится
  eat(/\sчерез\s+(\d{1,3})\s*(мин[а-яё]*|час[а-яё]*|дн[а-яё]*|день|недел[а-яё]*)\s/i, (m) => {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    through = unit.startsWith('мин') ? n * MIN
      : unit.startsWith('час') ? n * HOUR
        : unit.startsWith('недел') ? n * 7 * DAY : n * DAY;
    said = `через ${n} ${unit}`;
  });

  eat(/\s(послезавтра)\s/i, () => { day = 2; said = 'послезавтра'; });
  if (!day) eat(/\s(завтра)\s/i, () => { day = 1; said = 'завтра'; });
  eat(/\s(сегодня)\s/i, () => { if (!said) said = 'сегодня'; });

  // День недели: ближайший следующий такой день
  eat(/\s(?:в|во)\s+([а-яё]{5,12})\s/i, (m) => {
    const w = WEEKDAYS[m[1].toLowerCase()];
    if (w === undefined) return;
    const cur = base.getDay();
    day = (w - cur + 7) % 7 || 7;
    said = `в ${m[1].toLowerCase()}`;
  });

  // Время: «в 9», «в 17:30», «9:00»
  eat(/\s(?:в\s+)?(\d{1,2})[:.](\d{2})\s/, (m) => { hh = Number(m[1]); mm = Number(m[2]); });
  if (hh < 0) eat(/\sв\s+(\d{1,2})\s/, (m) => { hh = Number(m[1]); });

  const clean = rest.replace(/\s+/g, ' ').trim();

  if (through !== null) return { at: now + through, rest: clean, said };

  if (hh < 0 && !day && !said) return { at: null, rest: clean, said: '' };

  const at = new Date(now);
  at.setDate(at.getDate() + day);
  at.setHours(hh < 0 ? 9 : hh, hh < 0 ? 0 : mm, 0, 0);
  // «в 9», когда девять уже прошло, значит завтра: напоминание в прошлом
  // не имеет смысла, а переспрашивать про такую мелочь — суета
  let ms = at.getTime();
  if (ms <= now) ms += DAY;
  const time = new Date(ms);
  const clock = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
  return { at: ms, rest: clean, said: said ? `${said} в ${clock}` : `в ${clock}` };
}

/** «Сегодня в 14:30», «завтра в 9:00», «в пятницу, 12 сентября» — для показа */
export function whenLabel(at: number, now = Date.now()): string {
  const d = new Date(at);
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
  if (days === 0) return `сегодня в ${clock}`;
  if (days === 1) return `завтра в ${clock}`;
  if (days === 2) return `послезавтра в ${clock}`;
  return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} в ${clock}`;
}

// ── Что показать на набранное ──────────────────────────────────────────────

export interface BarSource {
  /** Разделы, доступные этому человеку */
  sections: { path: string; title: string; multi?: boolean }[];
  /** Статьи руководства, уже отобранные поиском руководства */
  articles: { id: string; title: string; hint: string }[];
  /** Найденное в проекте — приходит с сервера */
  hits: { kind: string; id: string; title: string; subtitle: string; route: string }[];
  /** На чём стоит курсор в оболочке: подпись активного окна */
  context?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim();

/** Раздел по названию: «почт» → Почта. Нужен и команде «/открой» */
export function sectionByWord(word: string, sections: BarSource['sections']) {
  const w = norm(word);
  if (!w) return null;
  return sections.find((s) => norm(s.title) === w)
    || sections.find((s) => norm(s.title).startsWith(w))
    || sections.find((s) => norm(s.title).includes(w))
    || null;
}

/**
 * Строки списка на набранный текст.
 *
 * Порядок групп неизменен: команда, разделы, справка, проект, помощник.
 * Помощник всегда последний — иначе Enter означал бы то одно, то другое в
 * зависимости от того, нашлось ли что-то в проекте.
 */
export function suggest(text: string, src: BarSource, now = Date.now()): BarItem[] {
  const out: BarItem[] = [];
  const raw = text.trim();
  const q = norm(raw);

  // 1. Команда
  const slash = parseSlash(raw);
  if (slash) {
    out.push(...commandItems(slash.cmd, slash.rest, src, now));
    return out;
  }
  for (const c of slashPrefix(raw)) {
    out.push({
      key: `slash-${c.name}`, group: 'команда', icon: c.icon,
      title: `/${c.name}${c.hint ? ` ${c.hint}` : ''}`, subtitle: c.about,
      run: c.needsRest ? { kind: 'fill', text: `/${c.name} ` } : runOf(c, '', src, now),
    });
  }
  if (out.length) return out;

  if (!q) {
    // Пустая строка — не пустой список: показываем, с чего начать
    out.push({
      key: 'hint-slash', group: 'команда', icon: 'open',
      title: 'Наберите / — список команд', subtitle: 'открыть, найти, напомнить, справка',
      run: { kind: 'fill', text: '/' },
    });
    return out;
  }

  // 2. Разделы
  for (const s of src.sections) {
    if (!norm(s.title).includes(q)) continue;
    out.push({
      key: `sec-${s.path}`, group: 'раздел', icon: 'open',
      title: s.title, subtitle: 'программа', run: { kind: 'navigate', route: s.path },
    });
  }

  // 3. Руководство
  for (const a of src.articles.slice(0, 4)) {
    out.push({
      key: `hb-${a.id}`, group: 'справка', icon: 'book',
      title: a.title, subtitle: a.hint || 'статья руководства',
      run: { kind: 'handbook', articleId: a.id },
    });
  }

  // 4. Найденное в проекте
  for (const h of src.hits) {
    out.push({
      key: `hit-${h.kind}-${h.id}`, group: 'проект', icon: h.kind,
      title: h.title, subtitle: h.subtitle, run: { kind: 'navigate', route: h.route },
    });
  }

  // 5. Помощник — последней строкой
  if (q.length >= 2) {
    out.push({
      key: 'ask', group: 'помощник', icon: 'ask',
      title: `Спросить: «${raw}»`,
      subtitle: src.context ? `с учётом того, что открыто: ${src.context}` : 'ответит по данным проекта',
      run: { kind: 'ask', query: raw },
    });
  }
  return out;
}

/** Что делает команда с остатком строки */
function runOf(cmd: SlashCmd, rest: string, src: BarSource, now: number): BarRun {
  switch (cmd.name) {
    case 'проверка': return { kind: 'check' };
    case 'изменения': return { kind: 'changes' };
    case 'найди': return { kind: 'ask', query: rest };
    case 'заметка': return { kind: 'note', text: rest };
    case 'переведи': return { kind: 'translate', text: rest };
    case 'открой': {
      const s = sectionByWord(rest, src.sections);
      return s ? { kind: 'navigate', route: s.path } : { kind: 'ask', query: rest };
    }
    case 'окно': {
      const s = sectionByWord(rest, src.sections);
      return s ? { kind: 'newWindow', route: s.path } : { kind: 'ask', query: rest };
    }
    case 'справка': {
      const a = src.articles[0];
      return a ? { kind: 'handbook', articleId: a.id } : { kind: 'ask', query: rest };
    }
    case 'напомни': {
      const when = parseWhen(rest, now);
      return when.at
        ? { kind: 'remind', at: when.at, text: when.rest }
        : { kind: 'fill', text: `/напомни завтра в 9 ${rest}` };
    }
    case 'встреча': {
      // Время разбирается тем же разборщиком, что и напоминание: два разных
      // понимания «в понедельник» — это два разных понедельника
      const when = parseWhen(rest, now);
      return when.at
        ? { kind: 'meeting', at: when.at, title: when.rest }
        : { kind: 'fill', text: `/встреча завтра в 10 ${rest}` };
    }
    default: return { kind: 'ask', query: rest };
  }
}

/** Строки для набранной команды: что именно случится по Enter */
function commandItems(cmd: SlashCmd, rest: string, src: BarSource, now: number): BarItem[] {
  const items: BarItem[] = [];

  if ((cmd.name === 'открой' || cmd.name === 'окно') && rest) {
    const matches = src.sections.filter((s) => norm(s.title).includes(norm(rest)));
    for (const s of matches.slice(0, 6)) {
      items.push({
        key: `cmd-${cmd.name}-${s.path}`, group: 'команда', icon: cmd.icon,
        title: cmd.name === 'окно' ? `Ещё одно окно: ${s.title}` : `Открыть ${s.title}`,
        subtitle: cmd.name === 'окно' && !s.multi ? 'у этой программы окно одно — поднимется прежнее' : 'программа',
        run: cmd.name === 'окно' ? { kind: 'newWindow', route: s.path } : { kind: 'navigate', route: s.path },
      });
    }
    if (items.length) return items;
  }

  if (cmd.name === 'справка' && rest) {
    for (const a of src.articles.slice(0, 6)) {
      items.push({
        key: `cmd-hb-${a.id}`, group: 'команда', icon: 'book',
        title: a.title, subtitle: a.hint || 'статья руководства',
        run: { kind: 'handbook', articleId: a.id },
      });
    }
    if (items.length) return items;
  }

  if (cmd.name === 'встреча') {
    const when = parseWhen(rest, now);
    items.push({
      key: 'cmd-meeting', group: 'команда', icon: 'calendar',
      title: when.at ? `Встреча ${whenLabel(when.at, now)}` : 'Встреча — когда?',
      subtitle: when.at
        ? (when.rest || 'название допишите — участников позовёте в окне')
        : 'например: /встреча в понедельник в 10 планёрка по АВО-2',
      run: when.at
        ? { kind: 'meeting', at: when.at, title: when.rest }
        : { kind: 'fill', text: `/встреча ${rest}`.trimEnd() + ' ' },
    });
    return items;
  }

  if (cmd.name === 'напомни') {
    const when = parseWhen(rest, now);
    items.push({
      key: 'cmd-remind', group: 'команда', icon: 'bell',
      title: when.at ? `Напомнить ${whenLabel(when.at, now)}` : 'Напомнить — когда?',
      subtitle: when.at
        ? (when.rest || 'о чём напомнить — допишите')
        : 'например: /напомни завтра в 9 позвонить поставщику',
      run: when.at && when.rest
        ? { kind: 'remind', at: when.at, text: when.rest }
        : { kind: 'fill', text: `/напомни ${rest}`.trimEnd() + ' ' },
    });
    return items;
  }

  items.push({
    key: `cmd-${cmd.name}`, group: 'команда', icon: cmd.icon,
    title: rest ? `${cmd.about}: ${rest}` : cmd.about,
    subtitle: cmd.needsRest && !rest ? `допишите: ${cmd.hint}` : 'Enter — выполнить',
    run: cmd.needsRest && !rest ? { kind: 'fill', text: `/${cmd.name} ` } : runOf(cmd, rest, src, now),
  });
  return items;
}
