/**
 * Что с обращением можно сделать и при каких условиях.
 *
 * Таблица переходов вынесена отдельно и написана данными, а не цепочкой `if`.
 * Причина простая: правил пятнадцать, у половины есть обязательные условия, и
 * в виде кода они расползлись бы по обработчикам маршрутов, где их никто
 * никогда не сверит целиком. Здесь их видно списком, и проверка идёт по этому
 * же списку.
 *
 * Неописанный переход запрещён. Это не строгость ради строгости: «отклонённое»
 * обращение, которое кто-то перевёл сразу в «готово», выглядит для автора как
 * решённое, хотя решением никто не занимался.
 *
 * Модуль чистый: ни базы, ни запросов — только правила.
 */

import type { Status } from './contracts';

/** Кто вправе выполнить переход. */
export type Actor = 'author' | 'triage';

export interface Rule {
  from: Status[];
  to: Status;
  who: Actor[];
  /** Публичная причина или вопрос обязателен. */
  reason?: boolean;
  /** Исполнитель обязателен. */
  assignee?: boolean;
  /** Версия исправления или явное «без выпуска» с объяснением. */
  release?: boolean;
  /** Ссылка на основную карточку. */
  target?: boolean;
  /** Короткое имя действия для кнопки. */
  action: string;
}

const ALL: Status[] = ['NEW', 'TRIAGE', 'NEEDS_INFO', 'PLANNED', 'IN_PROGRESS', 'VERIFY', 'DONE', 'REJECTED', 'WITHDRAWN'];

export const RULES: Rule[] = [
  // Простой просмотр статус не меняет: «разбираем» — это чьё-то решение
  { from: ['NEW'], to: 'TRIAGE', who: ['triage'], action: 'Начать разбор' },

  // Вопрос автору обязан быть задан вслух, иначе человек не знает, чего ждут
  { from: ['NEW', 'TRIAGE', 'IN_PROGRESS'], to: 'NEEDS_INFO', who: ['triage'], reason: true, action: 'Спросить автора' },
  // Ответ автора возвращает работу туда, откуда её увели, — а не в начало
  { from: ['NEEDS_INFO'], to: 'TRIAGE', who: ['author', 'triage'], action: 'Ответ получен' },
  { from: ['NEEDS_INFO'], to: 'IN_PROGRESS', who: ['author', 'triage'], action: 'Вернуться в работу' },

  { from: ['NEW', 'TRIAGE'], to: 'PLANNED', who: ['triage'], reason: true, action: 'Запланировать' },
  { from: ['NEW', 'TRIAGE', 'PLANNED'], to: 'IN_PROGRESS', who: ['triage'], assignee: true, action: 'Взять в работу' },

  // Либо версия, в которой исправлено, либо честное «выпуска не будет» с
  // объяснением: «сделано» без того и другого автору ничего не говорит
  { from: ['IN_PROGRESS'], to: 'VERIFY', who: ['triage'], release: true, action: 'Отдать на проверку' },
  // Закрывает автор. Обработчик тоже может, но с причиной: закрытие чужой
  // жалобы без единого слова — самый быстрый способ отучить людей писать
  { from: ['VERIFY'], to: 'DONE', who: ['author', 'triage'], action: 'Помогло' },
  { from: ['VERIFY', 'DONE'], to: 'TRIAGE', who: ['author', 'triage'], reason: true, action: 'Проблема осталась' },

  { from: ['NEW', 'TRIAGE', 'NEEDS_INFO', 'PLANNED', 'IN_PROGRESS'], to: 'REJECTED', who: ['triage'], reason: true, action: 'Отклонить' },
  { from: ALL, to: 'DUPLICATE', who: ['triage'], target: true, action: 'Связать с похожим' },
  { from: ['NEW', 'TRIAGE', 'NEEDS_INFO', 'PLANNED'], to: 'WITHDRAWN', who: ['author'], action: 'Отозвать' },
  { from: ['REJECTED', 'WITHDRAWN'], to: 'TRIAGE', who: ['author', 'triage'], reason: true, action: 'Вернуть в разбор' },
  // Разъединяет только обработчик: автор дубля не видит основную карточку и не
  // может судить, ошибка это или нет
  { from: ['DUPLICATE'], to: 'TRIAGE', who: ['triage'], reason: true, action: 'Разъединить' },
];

export interface Attempt {
  from: Status;
  to: Status;
  actor: Actor;
  /** Автор своей карточки: часть переходов доступна только ему. */
  reason?: string;
  assigneeId?: string | null;
  resolvedVersion?: string | null;
  noReleaseReason?: string | null;
  targetReportId?: string | null;
  /** Куда возвращаться после ответа автора. */
  resumeStatus?: Status | null;
}

export interface Verdict { ok: boolean; error?: string; rule?: Rule }

/** Правила, ведущие из этого состояния, — для кнопок в карточке. */
export function allowedFrom(from: Status, actor: Actor): Rule[] {
  return RULES.filter((r) => r.from.includes(from) && r.who.includes(actor));
}

/**
 * Можно ли выполнить переход.
 *
 * Проверяется и право, и все обязательные условия сразу: частичная проверка
 * оставила бы карточку в состоянии «в работе без исполнителя», из которого
 * очередь обработчика её больше не покажет.
 */
export function checkTransition(a: Attempt): Verdict {
  if (a.from === a.to) return { ok: false, error: 'Обращение уже в этом состоянии' };
  const rules = RULES.filter((r) => r.from.includes(a.from) && r.to === a.to);
  if (!rules.length) return { ok: false, error: `Из «${a.from}» в «${a.to}» перейти нельзя` };

  const rule = rules.find((r) => r.who.includes(a.actor));
  if (!rule) return { ok: false, error: 'Это действие доступно другой стороне' };

  // Возврат в работу — только если работа действительно шла: иначе обращение
  // оказалось бы «в работе» без единого дня работы над ним
  if (a.to === 'IN_PROGRESS' && a.from === 'NEEDS_INFO' && a.resumeStatus !== 'IN_PROGRESS') {
    return { ok: false, error: 'Вернуть в работу можно только то, что в работе и было' };
  }
  if (rule.reason && !String(a.reason || '').trim()) {
    return { ok: false, error: 'Нужно объяснить причину — её увидит автор' };
  }
  if (rule.assignee && !String(a.assigneeId || '').trim()) {
    return { ok: false, error: 'Нужен исполнитель' };
  }
  if (rule.target && !String(a.targetReportId || '').trim()) {
    return { ok: false, error: 'Нужно указать основное обращение' };
  }
  if (rule.release) {
    const version = String(a.resolvedVersion || '').trim();
    const without = String(a.noReleaseReason || '').trim();
    if (!version && !without) {
      return { ok: false, error: 'Нужна версия с исправлением или объяснение, почему выпуска не будет' };
    }
  }
  return { ok: true, rule };
}

/** Состояния, из которых обращение уже не ждёт работы. */
export const CLOSED: Status[] = ['DONE', 'REJECTED', 'DUPLICATE', 'WITHDRAWN'];

/** Ждёт ли обращение ответа автора. */
export const waitsAuthor = (status: Status): boolean => status === 'NEEDS_INFO' || status === 'VERIFY';
