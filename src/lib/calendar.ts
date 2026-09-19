/**
 * Календарь: счёт времени, повторов и сроков.
 *
 * Без React и без DOM — как геометрия окон и раскладка стола, и по той же
 * причине. Ошибка здесь не падает и не мигает: встреча, посчитанная на час
 * раньше, выглядит как обычная встреча, и человек узнаёт о ней, когда его
 * ждали двадцать минут назад.
 *
 * Три вещи, в которых легко ошибиться и которые поэтому живут здесь:
 *
 *   — СЕТКА МЕСЯЦА. Неделя начинается с понедельника, а не с воскресенья, и
 *     в сетке всегда шесть строк: пять хватает не каждому месяцу, а прыгающая
 *     высота сетки при листании читается как подёргивание.
 *
 *   — ПОВТОРЫ. Правило записывается по RFC 5545 (подмножество), потому что
 *     своё правило повторов люди начинают ломать на второй неделе: «каждый
 *     второй вторник месяца» просят раньше, чем успеваешь дописать своё.
 *
 *   — СРОКИ ВДР. Они не события, а проекция реестра. Здесь только превращение
 *     строки реестра в то, что рисуется на сетке; изменить срок отсюда нельзя,
 *     и это не забывчивость, а решение (см. docs/os-design.md §15.2).
 *
 * Проверяется scripts/test-calendar.ts.
 */

export type EventKind = 'meeting' | 'deadline' | 'reminder' | 'note';
export type GuestState = 'invited' | 'yes' | 'no' | 'maybe';

export interface CalEvent {
  id: string;
  projectId: string | null;
  kind: EventKind;
  title: string;
  description: string;
  /** Начало и конец в миллисекундах */
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  /** Правило повтора; пусто — событие одно */
  rrule: string;
  place: string;
  /** Ссылка на встречу: Телемост, МТС Линк, Teams — что угодно */
  joinUrl: string;
  createdBy: string;
  /** Откуда взялось: рукой, из реестра ВДР, из письма, от помощника */
  source: 'hand' | 'vdr' | 'mail' | 'assistant';
  sourceId: string;
  /** Личное событие видит только его создатель — включая администратора */
  visibility: 'project' | 'private';
  /** За сколько минут напомнить; 0 — не напоминать */
  remindMin: number;
  guests: { userId: string; name: string; state: GuestState }[];
}

/** Одно появление события на сетке: у повторяющегося их много */
export interface Occurrence {
  event: CalEvent;
  startsAt: number;
  endsAt: number;
  /** Появление повторяющегося события — не само событие */
  repeated: boolean;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Понедельник первым: так считают неделю здесь, и так стоит в производственном календаре */
export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export const MONTHS = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

export const MONTHS_OF = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

/** Начало суток по местному времени: с него считается вся сетка */
export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** День недели с понедельника: 0 — понедельник, 6 — воскресенье */
export function weekday(t: number): number {
  return (new Date(t).getDay() + 6) % 7;
}

export const startOfWeek = (t: number): number => startOfDay(t) - weekday(t) * DAY;

export function startOfMonth(t: number): number {
  const d = new Date(t);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Шаг на месяц вперёд или назад.
 *
 * Казалось бы, `setMonth(getMonth() + 1)` — и всё. Но день при этом
 * сохраняется, а в коротком месяце такого дня нет: 31 января плюс месяц даёт
 * 3 МАРТА, потому что «31 февраля» перетекает через конец месяца. Человек
 * нажимал «вперёд» и проскакивал февраль целиком.
 *
 * Поэтому сначала встаём на первое число, и только потом меняем месяц. Якорем
 * показываемого периода становится его начало — это и честнее: лист календаря
 * показывает месяц, а не выбранный день.
 */
export function stepMonth(t: number, dir: number): number {
  const d = new Date(startOfMonth(t));
  d.setMonth(d.getMonth() + dir);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Какой отрезок показывает вид «Сроки».
 *
 * Считался от `Date.now()`, а заголовок — от выбранного якоря. Стрелки
 * «вперёд/назад» меняли надпись и не меняли список: человек листал, видел
 * другой месяц в заголовке и те же самые строки под ним.
 *
 * Тридцать дней назад и сто восемьдесят вперёд — прежняя ширина окна, просто
 * теперь она считается от того месяца, который человек выбрал.
 */
export function dueRange(anchor: number): [number, number] {
  const from = startOfMonth(anchor);
  return [from - 30 * DAY, from + 180 * DAY];
}

/**
 * Сетка месяца: шесть недель по семь дней, начиная с понедельника.
 *
 * Всегда шесть строк — даже когда месяц укладывается в пять. Иначе высота
 * сетки прыгает при листании, и это читается как подёргивание, а не как
 * «в этом месяце меньше недель».
 *
 * Складывать дни прибавлением суток нельзя: в марте и октябре сутки не по
 * 24 часа, и сетка уезжает на час, а на границе — на день. Поэтому шаг
 * делается календарным.
 */
export function monthGrid(t: number): number[] {
  const first = startOfMonth(t);
  const from = startOfWeek(first);
  const out: number[] = [];
  const d = new Date(from);
  for (let i = 0; i < 42; i++) {
    out.push(startOfDay(d.getTime()));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

export const sameDay = (a: number, b: number): boolean => startOfDay(a) === startOfDay(b);

export const inMonth = (t: number, month: number): boolean =>
  new Date(t).getMonth() === new Date(month).getMonth()
  && new Date(t).getFullYear() === new Date(month).getFullYear();

// ── Повторы ─────────────────────────────────────────────────────────────────

export interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  /** Каждые сколько: 2 при WEEKLY — через неделю */
  interval: number;
  /** Дни недели для WEEKLY: 0 — понедельник */
  byDay: number[];
  /** До какой даты включительно; 0 — без конца */
  until: number;
  /** Сколько раз всего; 0 — без счёта */
  count: number;
}

const RU_DAY: Record<string, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };
const DAY_RU = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** Разобрать правило. Непонятное правило — не повтор: молча выдумывать нельзя */
export function parseRule(rrule: string): Rule | null {
  const text = String(rrule || '').trim().toUpperCase().replace(/^RRULE:/, '');
  if (!text) return null;
  const parts: Record<string, string> = {};
  for (const chunk of text.split(';')) {
    const [k, v] = chunk.split('=');
    if (k && v) parts[k] = v;
  }
  const freq = parts.FREQ as Rule['freq'];
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  const interval = Math.max(1, Number(parts.INTERVAL || 1) || 1);
  const byDay = (parts.BYDAY || '').split(',').map((d) => RU_DAY[d.trim()]).filter((n) => n !== undefined);
  let until = 0;
  if (parts.UNTIL) {
    // Формат 20260907T100000Z и 20260907
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(parts.UNTIL);
    if (m) until = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).getTime();
  }
  const count = Math.max(0, Number(parts.COUNT || 0) || 0);
  return { freq, interval, byDay, until, count };
}

export function buildRule(rule: Partial<Rule> & { freq: Rule['freq'] }): string {
  const bits = [`FREQ=${rule.freq}`];
  if (rule.interval && rule.interval > 1) bits.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay?.length) bits.push(`BYDAY=${rule.byDay.map((d) => DAY_RU[d]).join(',')}`);
  if (rule.count) bits.push(`COUNT=${rule.count}`);
  if (rule.until) {
    const d = new Date(rule.until);
    const p = (n: number) => String(n).padStart(2, '0');
    bits.push(`UNTIL=${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`);
  }
  return bits.join(';');
}

/** Человеческое имя правила — его и показываем в окне события */
export function ruleLabel(rrule: string): string {
  const r = parseRule(rrule);
  if (!r) return 'не повторяется';
  const every = r.interval > 1 ? `каждые ${r.interval} ` : 'каждый ';
  if (r.freq === 'DAILY') return r.interval > 1 ? `${every}дня` : 'каждый день';
  if (r.freq === 'WEEKLY') {
    const days = r.byDay.length ? r.byDay.map((d) => WEEKDAYS[d].toLowerCase()).join(', ') : '';
    const base = r.interval > 1 ? `каждые ${r.interval} недели` : 'каждую неделю';
    return days ? `${base}: ${days}` : base;
  }
  if (r.freq === 'MONTHLY') return r.interval > 1 ? `каждые ${r.interval} месяца` : 'каждый месяц';
  return r.interval > 1 ? `каждые ${r.interval} года` : 'каждый год';
}

/**
 * Раскрыть событие в появления внутри окна [from, to).
 *
 * Предел появлений жёсткий: правило «каждый день без конца», раскрытое на
 * десять лет вперёд, — это не календарь, а зависшая программа. За окном
 * месяца больше сорока двух появлений не нужно никому.
 */
export function expand(ev: CalEvent, from: number, to: number, limit = 400): Occurrence[] {
  const out: Occurrence[] = [];
  const length = Math.max(0, ev.endsAt - ev.startsAt);
  const rule = parseRule(ev.rrule);

  if (!rule) {
    if (ev.startsAt < to && ev.endsAt > from) {
      out.push({ event: ev, startsAt: ev.startsAt, endsAt: ev.endsAt, repeated: false });
    }
    return out;
  }

  const start = new Date(ev.startsAt);
  const hours = start.getHours();
  const minutes = start.getMinutes();
  let made = 0;
  let step = 0;
  const cursor = new Date(ev.startsAt);

  // Шагаем календарно, а не сутками: в переход на летнее время сутки не по
  // 24 часа, и встреча уезжала бы на час
  while (out.length < limit && step < 5000) {
    step++;
    const at = cursor.getTime();
    if (rule.until && at > rule.until) break;
    if (rule.count && made >= rule.count) break;
    if (at >= to) break;

    const fits = rule.freq !== 'WEEKLY' || !rule.byDay.length || rule.byDay.includes(weekday(at));
    if (fits && at >= ev.startsAt) {
      made++;
      if (at + length > from) {
        out.push({ event: ev, startsAt: at, endsAt: at + length, repeated: at !== ev.startsAt });
      }
    }

    if (rule.freq === 'DAILY') cursor.setDate(cursor.getDate() + rule.interval);
    else if (rule.freq === 'WEEKLY') {
      // По дням недели шагаем сутками, но неделю целиком считаем интервалом:
      // «через неделю по вторникам и четвергам» — это два дня одной недели
      if (rule.byDay.length) {
        cursor.setDate(cursor.getDate() + 1);
        if (weekday(cursor.getTime()) === 0 && rule.interval > 1) {
          cursor.setDate(cursor.getDate() + 7 * (rule.interval - 1));
        }
      } else cursor.setDate(cursor.getDate() + 7 * rule.interval);
    } else if (rule.freq === 'MONTHLY') cursor.setMonth(cursor.getMonth() + rule.interval);
    else cursor.setFullYear(cursor.getFullYear() + rule.interval);
    cursor.setHours(hours, minutes, 0, 0);
  }

  return out;
}

/** Все появления списка событий в окне, по времени начала */
export function occurrences(events: CalEvent[], from: number, to: number): Occurrence[] {
  const out: Occurrence[] = [];
  for (const ev of events) out.push(...expand(ev, from, to));
  out.sort((a, b) => a.startsAt - b.startsAt || a.event.title.localeCompare(b.event.title, 'ru'));
  return out;
}

/** Появления одного дня */
export const dayOccurrences = (list: Occurrence[], day: number): Occurrence[] =>
  list.filter((o) => o.startsAt < startOfDay(day) + DAY && o.endsAt > startOfDay(day));

// ── Подписи ─────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

export const timeLabel = (t: number): string => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const dateLabel = (t: number): string => {
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS_OF[d.getMonth()]}`;
};

export const monthLabel = (t: number): string => {
  const d = new Date(t);
  const name = MONTHS[d.getMonth()];
  return `${name[0].toUpperCase()}${name.slice(1)} ${d.getFullYear()}`;
};

/** «10:00 – 10:30» или «весь день» */
export function rangeLabel(o: { startsAt: number; endsAt: number }, allDay: boolean): string {
  if (allDay) return 'весь день';
  const same = sameDay(o.startsAt, o.endsAt) || o.endsAt - o.startsAt <= DAY;
  return same
    ? `${timeLabel(o.startsAt)} – ${timeLabel(o.endsAt)}`
    : `${dateLabel(o.startsAt)} ${timeLabel(o.startsAt)} – ${dateLabel(o.endsAt)} ${timeLabel(o.endsAt)}`;
}

/**
 * Сколько осталось до начала. Отвечает на единственный вопрос, который человек
 * задаёт списку сегодняшних дел: «бежать сейчас или ещё можно работать».
 */
export function untilLabel(startsAt: number, now = Date.now()): string {
  const min = Math.round((startsAt - now) / MINUTE);
  if (min < -60) return 'уже прошло';
  if (min < 0) return 'идёт сейчас';
  if (min === 0) return 'сейчас';
  if (min < 60) return `через ${min} мин.`;
  if (min < 60 * 8) {
    const h = Math.floor(min / 60);
    return `через ${h} ч.`;
  }
  if (sameDay(startsAt, now)) return `сегодня в ${timeLabel(startsAt)}`;
  if (sameDay(startsAt, now + DAY)) return `завтра в ${timeLabel(startsAt)}`;
  return `${dateLabel(startsAt)} в ${timeLabel(startsAt)}`;
}

/** Пора ли напоминать: за remindMin до начала и не позже самого начала */
export function isDue(startsAt: number, remindMin: number, now = Date.now()): boolean {
  if (!remindMin) return false;
  const at = startsAt - remindMin * MINUTE;
  return now >= at && now < startsAt + 5 * MINUTE;
}

// ── Сроки ВДР ───────────────────────────────────────────────────────────────

export interface VdrRow {
  id: string;
  title: string;
  dueAt: number;
  code: string;
  register: string;
  projectId: string;
}

/**
 * Срок реестра как событие сетки.
 *
 * Именно проекция, а не запись: событие собирается на лету и в базу не
 * попадает. Иначе появился бы второй источник правды о сроке, и он разошёлся
 * бы с реестром в первую же неделю — а разошедшись, солгал бы обеим сторонам.
 */
export function deadlineEvent(row: VdrRow): CalEvent {
  return {
    id: `vdr:${row.id}`,
    projectId: row.projectId,
    kind: 'deadline',
    title: row.code ? `${row.code} · ${row.title}` : row.title,
    description: row.register ? `Реестр: ${row.register}` : '',
    startsAt: row.dueAt,
    endsAt: row.dueAt,
    allDay: true,
    rrule: '',
    place: '',
    joinUrl: '',
    createdBy: '',
    source: 'vdr',
    sourceId: row.id,
    visibility: 'project',
    remindMin: 0,
    guests: [],
  };
}

/** Срок ВДР нельзя перетащить мышью: его меняют в реестре, а не в календаре */
export const isReadOnly = (ev: CalEvent): boolean => ev.source === 'vdr';

/** Цвет полоски события — по виду, а не по проекту: видов четыре, проектов много */
export const KIND_TONE: Record<EventKind, string> = {
  meeting: 'emerald',
  deadline: 'amber',
  reminder: 'sky',
  note: 'slate',
};

export const KIND_LABEL: Record<EventKind, string> = {
  meeting: 'встреча',
  deadline: 'срок ВДР',
  reminder: 'напоминание',
  note: 'заметка',
};
