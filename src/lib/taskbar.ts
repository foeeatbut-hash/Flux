/**
 * Нижняя панель: из чего она складывается и как сжимается.
 *
 * Логика вынесена из разметки, потому что ломается она незаметно: панель должна
 * оставаться читаемой и когда открыто ноль разделов, и когда четырнадцать. Здесь
 * только данные внутрь и данные наружу — это и позволяет проверить её скриптом.
 */
import { BAR_BTN } from './metrics';

/** Откуда кнопка берёт счётчик. Счётчик значит «надо разобрать», а не «сколько открыто». */
export type BadgeKind = 'mail' | 'chat' | 'feedback';

export interface TaskbarSource {
  path: string;
  title: string;
  /** Стоит на панели всегда, даже когда не запущен */
  pinned?: boolean;
  badge?: BadgeKind;
  adminOnly?: boolean;
}

export interface Counts {
  mail: number;
  chat: number;
  /** Обращения, ждущие этого человека: свои с ответом и очередь разбора. */
  feedback: number;
}

export interface TaskbarButton {
  path: string;
  title: string;
  /** 0 — не показывать вовсе */
  badge: number;
  /** Раздел открыт хотя бы в одной панели */
  running: boolean;
  /** Активный раздел активной панели */
  active: boolean;
  /** Все окна раздела свёрнуты: метка под кнопкой бледнее и короче */
  minimized: boolean;
}

export interface TaskbarView {
  buttons: TaskbarButton[];
  /** Те, что помещаются в полосу */
  visible: TaskbarButton[];
  /** Хвост, ушедший под кнопку «ещё»: он не потерян, он свёрнут */
  hidden: TaskbarButton[];
  /** Панель предлагает прибраться */
  tidy: boolean;
}

/** После двенадцати панель мягко предлагает прибраться. Предложение, не запрет. */
export const TIDY_FROM = 12;

/** Кнопка панели и промежуток до соседа — кнопка без подписи */
const BTN_BASE = BAR_BTN + 8;
/** Кнопка «ещё» с числом свёрнутых: под неё место резервируется заранее */
const MORE_W = 44;

/**
 * Сколько кнопок помещается в полосу.
 *
 * Раньше полоса просто прокручивалась, и на краю панели вырастал скроллбар во
 * всю её высоту — та самая полоса, про которую спрашивают «откуда она». Хуже
 * скроллбара было другое: без него кнопки обрезались по краю и исчезали без
 * следа. Теперь хвост честно сворачивается под кнопку «ещё» — место под неё
 * резервируется заранее, иначе она сама окажется за краем.
 */
export function fitButtons(titles: string[], width: number): number {
  if (!width || !titles.length) return titles.length;
  const widthOf = (_title: string) => BTN_BASE;
  let sum = 0;
  for (let i = 0; i < titles.length; i++) {
    sum += widthOf(titles[i]);
    if (sum <= width) continue;
    // Не влезла i-я: отступаем назад, пока не освободится место под «ещё»
    let n = i;
    let rest = sum - widthOf(titles[i]);
    while (n > 0 && rest + MORE_W > width) { n--; rest -= widthOf(titles[n]); }
    return n;
  }
  return titles.length;
}

/**
 * Что панель отдаёт первым, когда окно узкое.
 *
 * Пуск, кнопки разделов, часы, уведомления и профиль остаются всегда — это то,
 * ради чего панель существует. Первыми уходят необязательные: подсказка
 * «открыто много», кнопки раскладки панелей и длина названия проекта. Иначе
 * при узком окне трей просто вылезал за край, унося с собой профиль и
 * полоску «показать стол».
 */
export interface TrayFit {
  /** Кнопки раскладки 1/2/4 (только в панельной оболочке) */
  layout: boolean;
  /** Подсказка «открыто много — разложить» */
  hint: boolean;
  /** Предел ширины названия проекта в точках */
  projectMax: number;
}

export function trayFit(barWidth: number): TrayFit {
  if (!barWidth || barWidth >= 1200) return { layout: true, hint: true, projectMax: 200 };
  if (barWidth >= 1000) return { layout: false, hint: true, projectMax: 140 };
  return { layout: false, hint: false, projectMax: 96 };
}

export function badgeCount(kind: BadgeKind | undefined, counts: Counts): number {
  if (kind === 'mail') return Math.max(0, counts.mail | 0);
  if (kind === 'chat') return Math.max(0, counts.chat | 0);
  if (kind === 'feedback') return Math.max(0, counts.feedback | 0);
  return 0;
}

/**
 * Порядок кнопок: сначала закреплённые в порядке реестра, затем открытые, но
 * не закреплённые — в порядке открытия. Закреплённая кнопка не прыгает с места,
 * когда её запустили: место на панели человек запоминает мышцей.
 */
export function buildTaskbar(
  sections: TaskbarSource[],
  opts: {
    open: string[];
    activePath: string;
    counts: Counts;
    isAdmin?: boolean;
    /** Ширина полосы кнопок в точках; 0 — ещё не измерена */
    width?: number;
    /** Разделы, у которых свёрнуты все окна */
    minimized?: string[];
  },
): TaskbarView {
  const openSet = new Set(opts.open);
  const minSet = new Set(opts.minimized || []);
  const allowed = sections.filter((s) => !s.adminOnly || opts.isAdmin);

  const pinned = allowed.filter((s) => s.pinned);
  const pinnedPaths = new Set(pinned.map((s) => s.path));
  const extra = opts.open
    .filter((p) => !pinnedPaths.has(p))
    .map((p) => allowed.find((s) => s.path === p))
    .filter((s): s is TaskbarSource => !!s);

  const buttons = [...pinned, ...extra].map((s) => ({
    path: s.path,
    title: s.title,
    badge: badgeCount(s.badge, opts.counts),
    running: openSet.has(s.path),
    active: s.path === opts.activePath,
    minimized: openSet.has(s.path) && minSet.has(s.path),
  }));

  // Имена остаются доступными метками, а ширина считается по компактным кнопкам значков.
  const shown = fitButtons(buttons.map((b) => b.title), opts.width || 0);

  return {
    buttons,
    visible: buttons.slice(0, shown),
    hidden: buttons.slice(shown),
    tidy: opts.open.length >= TIDY_FROM,
  };
}

/** Как рисовать метку под кнопкой: активная — длинная акцентная, свёрнутая — бледная и короткая */
export function runState(b: Pick<TaskbarButton, 'running' | 'active' | 'minimized'>): 'active' | 'open' | 'min' | null {
  if (!b.running) return null;
  if (b.active) return 'active';
  return b.minimized ? 'min' : 'open';
}

/** Сколько ждать, прежде чем показать карточки окон: быстрое движение мимо кнопки ничего не открывает */
export const PEEK_DELAY = 400;
/** Пауза при уходе: мышь пересекает зазор между кнопкой и карточкой, и карточка не должна успеть погаснуть */
export const PEEK_GRACE = 60;
/** Ширина карточки окна и промежуток между карточками */
export const PEEK_CARD_W = 188;
export const PEEK_GAP = 8;
export const PEEK_PAD = 8;
/** Больше окон — карточки с картинками перестают помещаться, и список переходит в строки */
export const PEEK_MAX_THUMBS = 5;
/** Ширина списка строк */
export const PEEK_LIST_W = 280;
/** Отступ карточек от края панели */
export const PEEK_EDGE = 8;

export interface PeekPlan {
  mode: 'thumbs' | 'list';
  width: number;
  /** Отступ слева в точках от левого края панели */
  left: number;
}

/**
 * Где встанут карточки: по центру над своей кнопкой, но не за краем панели.
 * `center` — середина кнопки от левого края панели.
 */
export function peekPlan(count: number, center: number, barWidth: number): PeekPlan {
  const n = Math.max(1, count);
  const mode = n > PEEK_MAX_THUMBS ? 'list' : 'thumbs';
  const natural = mode === 'list' ? PEEK_LIST_W : n * PEEK_CARD_W + (n - 1) * PEEK_GAP + PEEK_PAD * 2;
  const width = barWidth > 0 ? Math.min(natural, Math.max(0, barWidth - PEEK_EDGE * 2)) : natural;
  const max = Math.max(PEEK_EDGE, (barWidth || width + PEEK_EDGE * 2) - width - PEEK_EDGE);
  const left = Math.round(Math.min(max, Math.max(PEEK_EDGE, center - width / 2)));
  return { mode, width, left };
}

/** Время «12:47» — двузначные часы и минуты, без секунд */
export function clockLabel(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Число дней между датами без учёта времени суток */
function daysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export function dateLabel(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/**
 * Строка под часами. Дату показывает системный трей двумя сантиметрами ниже,
 * поэтому здесь полезнее ближайший срок — то, чего в системе нет.
 * Срока нет — возвращаем дату: пустое место под часами выглядит поломкой.
 */
export function deadlineLabel(due: Date | null, now: Date): string {
  if (!due) return dateLabel(now);
  const d = daysBetween(now, due);
  if (d < 0) return d === -1 ? 'ВДР просрочен на день' : `ВДР просрочен на ${d * -1} дн.`;
  if (d === 0) return 'ВДР сегодня';
  if (d === 1) return 'ВДР завтра';
  if (d <= 6) return `ВДР через ${d} дн.`;
  return `ВДР ${dateLabel(due)}`;
}

/** Счётчик на значке: трёхзначное число не влезает, поэтому «99+» */
export function badgeLabel(n: number): string {
  return n > 99 ? '99+' : String(n);
}
