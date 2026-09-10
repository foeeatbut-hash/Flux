/**
 * Нижняя панель: из чего она складывается и как сжимается.
 *
 * Логика вынесена из разметки, потому что ломается она незаметно: панель должна
 * оставаться читаемой и когда открыто ноль разделов, и когда четырнадцать. Здесь
 * только данные внутрь и данные наружу — это и позволяет проверить её скриптом.
 */

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
}

export interface TaskbarView {
  buttons: TaskbarButton[];
  /** Те, что помещаются в полосу */
  visible: TaskbarButton[];
  /** Хвост, ушедший под кнопку «ещё»: он не потерян, он свёрнут */
  hidden: TaskbarButton[];
  /** Показывать ли подписи: после порога от кнопки остаётся значок */
  labels: boolean;
  /** Панель предлагает прибраться */
  tidy: boolean;
}

/**
 * Пока кнопок не больше восьми — с подписями. Дальше подписи уходят: резать
 * названия по буквам нельзя, два обрубка «Спецификация…» неразличимы.
 */
export const LABELS_UNTIL = 8;

/** После двенадцати панель мягко предлагает прибраться. Предложение, не запрет. */
export const TIDY_FROM = 12;

/** Значок, отступы, счётчик и промежуток до соседа — кнопка без подписи */
const BTN_BASE = 44;
/** Ширина буквы подписи: замерено на живой панели, с запасом вверх */
const CHAR_W = 8;
/** Кнопка «ещё» с числом свёрнутых: под неё место резервируется заранее */
const MORE_W = 44;

/**
 * Влезут ли подписи в полосу кнопок.
 *
 * Одного счёта кнопок мало. Шесть кнопок с подписями требуют больше 700 точек,
 * и на ноутбуке ряд не помещался — а полоса обрезана по краю, так что лишние
 * кнопки просто исчезали: ни многоточия, ни прокрутки, ни следа.
 *
 * Ширина здесь — самой полосы кнопок, а не всей панели. Полоса тянется по
 * остатку от Пуска и трея, и её ширина от содержимого не зависит: значит,
 * подписи не могут то влезать, то не влезать от собственного исчезновения.
 * Считать же по буквам приходится оттого, что мерить надо ДО отрисовки.
 */
export function labelsFit(titles: string[], width: number): boolean {
  if (!width || !titles.length) return true; // нечего мерить — не мигаем подписями
  return titles.reduce((sum, t) => sum + BTN_BASE + t.length * CHAR_W, 0) <= width;
}

/**
 * Сколько кнопок помещается в полосу.
 *
 * Раньше полоса просто прокручивалась, и на краю панели вырастал скроллбар во
 * всю её высоту — та самая полоса, про которую спрашивают «откуда она». Хуже
 * скроллбара было другое: без него кнопки обрезались по краю и исчезали без
 * следа. Теперь хвост честно сворачивается под кнопку «ещё» — место под неё
 * резервируется заранее, иначе она сама окажется за краем.
 */
export function fitButtons(titles: string[], width: number, labels: boolean): number {
  if (!width || !titles.length) return titles.length;
  const widthOf = (t: string) => BTN_BASE + (labels ? t.length * CHAR_W : 0);
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
  },
): TaskbarView {
  const openSet = new Set(opts.open);
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
  }));

  const labels = buttons.length <= LABELS_UNTIL
    && labelsFit(buttons.map((b) => b.title), opts.width || 0);
  const shown = fitButtons(buttons.map((b) => b.title), opts.width || 0, labels);

  return {
    buttons,
    visible: buttons.slice(0, shown),
    hidden: buttons.slice(shown),
    labels,
    tidy: opts.open.length >= TIDY_FROM,
  };
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
