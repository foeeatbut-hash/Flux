/**
 * Журнал подпрограмм: что они делают во Flux — одна запись на событие, только метаданные.
 *
 * Чистый модуль: форму записи и её проверку читают главный процесс (кольцо на
 * диске), сервер (приём пачек и показ) и окно владельца. Содержимого вызовов,
 * данных проектов и значений параметров здесь нет и быть не может: поля
 * ограничены по длине и по составу, а `detail` — короткая метка («GET /api»,
 * имя метода), а не данные.
 */
export const JOURNAL_CATEGORIES = ['lifecycle', 'compute', 'read', 'permission', 'connection', 'log', 'failure'] as const;
export type JournalCategory = typeof JOURNAL_CATEGORIES[number];
export const JOURNAL_LEVELS = ['info', 'warn', 'error'] as const;
export type JournalLevel = typeof JOURNAL_LEVELS[number];
export const CATEGORY_NAMES: Record<JournalCategory, string> = {
  lifecycle: 'Запуск и закрытие', compute: 'Расчёты', read: 'Чтение данных Flux', permission: 'Разрешения',
  connection: 'Подключения', log: 'Сообщения подпрограммы', failure: 'Сбои',
};

export interface JournalEntry {
  /** Уникален: по нему сервер принимает пачку повторно без дублей */
  id: string;
  /** Время, мс unix */
  at: number;
  moduleId: string;
  version: string;
  /** Кто (идентификатор человека на этом компьютере); имя добавляет сервер по сеансу, разработчику не показывается */
  userId: string;
  category: JournalCategory;
  level: JournalLevel;
  /** Короткое имя события: `open`, `close`, `compute`, `call`, `grant`, `message` … */
  event: string;
  /** Метка без данных: язык, вид данных, «GET /api», имя метода COM, текст сообщения подпрограммы */
  detail: string;
  /** Итог: `ok`, `denied`, `limit`, `timeout`, `failed`, `user-denied`… */
  outcome: string;
  ms: number;
  bytesIn: number;
  bytesOut: number;
}

export const JOURNAL_LIMITS = {
  detail: 200,
  event: 40,
  outcome: 40,
  /** Записей в кольце главного процесса и на сервере в одной пачке */
  ring: 5000,
  batch: 200,
  /** Срок хранения на компьютере и на сервере, дней */
  localDays: 14,
  serverDays: 30,
  /** Предел числа строк на сервере: хранилище не растёт, даже если срок ещё не вышел */
  serverRows: 200_000,
  /** Сообщений подпрограммы через flux.log: в секунду и длина строки */
  logPerSecond: 5,
  logLine: 200,
} as const;

const REF = /^[A-Za-z0-9_.:@-]{1,160}$/;
const MODULE = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const KEYS = ['id', 'at', 'moduleId', 'version', 'userId', 'category', 'level', 'event', 'detail', 'outcome', 'ms', 'bytesIn', 'bytesOut'];
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 2 ** 50;

export function validEntry(raw: unknown): raw is JournalEntry {
  const e = raw as JournalEntry;
  return !!e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).length === KEYS.length && KEYS.every(k => k in e)
    && typeof e.id === 'string' && REF.test(e.id) && count(e.at) && typeof e.moduleId === 'string' && MODULE.test(e.moduleId)
    && typeof e.version === 'string' && VERSION.test(e.version) && typeof e.userId === 'string' && e.userId.length <= 160
    && JOURNAL_CATEGORIES.includes(e.category) && JOURNAL_LEVELS.includes(e.level)
    && typeof e.event === 'string' && e.event.length <= JOURNAL_LIMITS.event && typeof e.detail === 'string' && e.detail.length <= JOURNAL_LIMITS.detail
    && typeof e.outcome === 'string' && e.outcome.length <= JOURNAL_LIMITS.outcome && count(e.ms) && count(e.bytesIn) && count(e.bytesOut);
}

/** Обрезка длинных полей перед записью: подпрограмма не раздует журнал одной строкой */
export const clipText = (value: unknown, max: number) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);

/** Что видит разработчик: те же записи без людей — идентификатор человека убирается */
export function anonymize(entry: Pick<JournalEntry, 'userId'> & Record<string, unknown>): Record<string, unknown> {
  const { userId: _userId, ...rest } = entry;
  return rest;
}
