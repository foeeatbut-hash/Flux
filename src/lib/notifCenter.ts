/**
 * Центр уведомлений: счёт без React и без DOM.
 *
 * Уведомление в программе умеет ровно две вещи: появиться и быть прочитанным.
 * Этого мало. Пришло письмо посреди сверки ведомости — прочитать его сейчас
 * нельзя, а закрыть значит забыть; поэтому здесь есть «отложить» и «не
 * беспокоить», и оба считаются тут, а не на глаз в разметке.
 *
 * Отложенное и тихий режим — личные и хранятся на этом рабочем месте: это
 * настройка внимания, а не событие проекта, и в общей базе ей делать нечего.
 * Сказано об этом честно и в руководстве.
 */

export interface NotifLike {
  id: string;
  category: string;
  title: string;
  body?: string;
  targetRoute?: string;
  isRead: boolean;
  createdAt: string;
}

const MIN = 60000;
const HOUR = 3600000;

/** На сколько отложить: выбор короткий — длинный превращается в раздумье */
export const SNOOZE_CHOICES = [
  { id: '15m', label: '15 минут' },
  { id: '1h', label: 'час' },
  { id: 'evening', label: 'к вечеру' },
  { id: 'tomorrow', label: 'завтра утром' },
] as const;

export type SnoozeId = typeof SNOOZE_CHOICES[number]['id'];

/** До какого времени прячем отложенное */
export function snoozeUntil(id: SnoozeId, now = Date.now()): number {
  if (id === '15m') return now + 15 * MIN;
  if (id === '1h') return now + HOUR;
  const d = new Date(now);
  if (id === 'evening') {
    // «К вечеру» — это 18:00 сегодня; если уже вечер, то завтра в 18:00
    d.setHours(18, 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

/** Тихий режим: те же слова, что у отложенного, но про весь поток сразу */
export const QUIET_CHOICES = [
  { id: '1h', label: 'на час' },
  { id: 'today', label: 'до конца дня' },
  { id: 'tomorrow', label: 'до завтра' },
] as const;

export type QuietId = typeof QUIET_CHOICES[number]['id'];

export function quietUntil(id: QuietId, now = Date.now()): number {
  if (id === '1h') return now + HOUR;
  const d = new Date(now);
  if (id === 'today') { d.setHours(23, 59, 0, 0); return d.getTime(); }
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

/** Тихо ли сейчас. Просроченный тихий режим сам себя не продлевает */
export const isQuiet = (until: number | null | undefined, now = Date.now()): boolean =>
  !!until && until > now;

/** «до 15:40», «до завтра, 09:00» — подпись на кнопке тихого режима */
export function untilLabel(at: number, now = Date.now()): string {
  const d = new Date(at);
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay ? `до ${clock}` : `до завтра, ${clock}`;
}

/** Что показывать сейчас: отложенное прячется, пока не вышло время */
export function visibleNow<T extends NotifLike>(
  list: T[], snoozed: Record<string, number>, now = Date.now(),
): T[] {
  return list.filter((n) => !(snoozed[n.id] && snoozed[n.id] > now));
}

/** Отложенное, которому пора вернуться */
export function dueSnoozed(snoozed: Record<string, number>, now = Date.now()): string[] {
  return Object.entries(snoozed).filter(([, until]) => until <= now).map(([id]) => id);
}

/**
 * Что нового по сравнению с прошлым опросом.
 *
 * Всплывашку показываем только настоящей новинке. Иначе после каждого опроса
 * (раз в пятнадцать секунд) человеку заново показывали бы всё непрочитанное —
 * лучший способ добиться, чтобы уведомления начали закрывать не глядя.
 */
export function freshOnes<T extends NotifLike>(prevIds: Set<string>, next: T[]): T[] {
  return next.filter((n) => !n.isRead && !prevIds.has(n.id));
}

/** Группы по дням: «Сегодня», «Вчера», дальше датой */
export function groupByDay<T extends { createdAt?: string }>(
  list: T[], now = Date.now(),
): { title: string; items: T[] }[] {
  const groups: { title: string; items: T[] }[] = [];
  const today = new Date(now).toDateString();
  const yesterday = new Date(now - 86400000).toDateString();
  for (const item of list) {
    const d = item.createdAt ? new Date(item.createdAt) : null;
    const key = !d || Number.isNaN(d.getTime()) ? 'Ранее'
      : d.toDateString() === today ? 'Сегодня'
        : d.toDateString() === yesterday ? 'Вчера'
          : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    const g = groups.find((x) => x.title === key);
    if (g) g.items.push(item); else groups.push({ title: key, items: [item] });
  }
  return groups;
}

/**
 * Один список вместо двух вкладок.
 *
 * Вкладки «Общие» и «Личные» заставляли человека помнить, где что лежит, и
 * искать пропущенное дважды. Событие приходит во времени, а не по вкладкам —
 * поэтому лента одна, по дням, а вкладки превратились в фильтр из трёх слов:
 * посмотреть только своё можно, но по умолчанию видно всё.
 */
export type FeedFilter = 'all' | 'personal' | 'system' | 'windows';

export interface FeedItem {
  id: string;
  /** Личное адресовано мне, системное — событие программы или проекта */
  kind: 'personal' | 'system' | 'windows';
  title: string;
  body: string;
  targetRoute?: string;
  /** Кто это сделал — только у системных: у личных отправитель в тексте */
  who?: string;
  category: string;
  isRead: boolean;
  createdAt: string;
}

export interface SystemLogLike {
  id: string;
  description: string;
  userName?: string;
  targetRoute?: string;
  createdAt?: string;
}

/** Личные уведомления и события программы → одна лента, свежие сверху */
export function mergeFeed(
  personal: NotifLike[],
  logs: SystemLogLike[],
  filter: FeedFilter = 'all',
): FeedItem[] {
  if (filter === 'windows') return [];
  const items: FeedItem[] = [];
  if (filter !== 'system') {
    for (const n of personal) {
      items.push({
        id: `p:${n.id}`,
        kind: 'personal',
        title: n.title,
        body: n.body || '',
        targetRoute: n.targetRoute,
        category: n.category,
        isRead: n.isRead,
        createdAt: n.createdAt,
      });
    }
  }
  if (filter !== 'personal') {
    for (const l of logs) {
      items.push({
        id: `s:${l.id}`,
        kind: 'system',
        title: l.description,
        body: '',
        targetRoute: l.targetRoute,
        who: l.userName,
        category: 'СИСТЕМА',
        // Событие программы прочитанным не бывает: его не адресовали лично
        isRead: true,
        createdAt: l.createdAt || '',
      });
    }
  }
  const at = (s: string) => {
    const t = new Date(s).getTime();
    return Number.isNaN(t) ? 0 : t;
  };
  return items.sort((a, b) => at(b.createdAt) - at(a.createdAt));
}

/** Сколько непрочитанного в ленте — по нему и горит счётчик */
export const unreadIn = (items: FeedItem[]): number => items.filter((i) => !i.isRead).length;

/** Порядок и названия подразделов личных уведомлений */
export const PERSONAL_GROUPS: { key: string; title: string }[] = [
  { key: 'ДОКУМЕНТЫ', title: 'Мои документы' },
  { key: 'ЧАТ', title: 'Мессенджер' },
  { key: 'ДОСТУП', title: 'Доступ' },
  { key: 'ПРОЕКТЫ', title: 'Проекты' },
  { key: 'ОБОРУДОВАНИЕ', title: 'Оборудование' },
  { key: 'СИСТЕМА', title: 'Система' },
];

/** Личные уведомления по подразделам; пустые подразделы не показываем */
export function personalGroups<T extends NotifLike>(list: T[]): { key: string; title: string; items: T[] }[] {
  const known = new Set(PERSONAL_GROUPS.map((g) => g.key));
  const groups = PERSONAL_GROUPS
    .map((g) => ({ ...g, items: list.filter((n) => n.category === g.key) }))
    .filter((g) => g.items.length > 0);
  const other = list.filter((n) => !known.has(n.category));
  if (other.length) groups.push({ key: 'ПРОЧЕЕ', title: 'Прочее', items: other });
  return groups;
}

/**
 * Какая программа отвечает за уведомление.
 *
 * По адресу перехода, а не по категории: категория отвечает на вопрос «о чём»,
 * а кнопке на панели задач нужен ответ на вопрос «где это открывать».
 */
export function appOf(n: NotifLike): string {
  const route = (n.targetRoute || '').split('?')[0];
  if (route && route !== '#') return route;
  if (n.category === 'ЧАТ') return '/chat';
  if (n.category === 'ДОКУМЕНТЫ') return '/management';
  return '/';
}
