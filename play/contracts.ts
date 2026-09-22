/**
 * Договор платформы: имена, коды и числа, одинаковые в окне и на сервере.
 *
 * Лежит в корне рядом с `policy.ts` по той же причине: цифру, написанную в
 * двух местах, однажды правят в одном. Особенно это касается сроков
 * присутствия — окно решает по ним, верить ли показанному, а сервер по ним же
 * решает, считать ли человека ушедшим. Разойдись они на пять секунд — и
 * получится состояние, в котором окно уверено, а сервер уже нет.
 *
 * Модуль чистый: ни React, ни express, ни базы.
 */

// ── Коды ошибок (ТЗ §5.3) ───────────────────────────────────────────────────
//
// Код — для программы, текст — для человека. Текст пишется здесь же, чтобы
// окно не придумывало свой: «ошибка 409» человеку не говорит ничего.

export const PLAY_ERRORS = {
  /** Такого нет — или нет для вас. Различать эти два случая нельзя */
  NOT_FOUND: 'NOT_FOUND',
  /** Состояние изменилось, пока вы думали: перечитайте и повторите */
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  /** Тот же ключ идемпотентности с другим телом — это ошибка, а не повтор */
  IDEMPOTENCY_MISMATCH: 'IDEMPOTENCY_MISMATCH',
  /** Действие не разрешено этому человеку */
  FORBIDDEN: 'FORBIDDEN',
  /** Слишком часто */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Тело запроса не годится */
  INVALID: 'INVALID',
  /** Платформа на обслуживании: зайти можно, начинать новое нельзя */
  MAINTENANCE: 'MAINTENANCE',
  /** Человек уже в другой группе */
  ALREADY_IN_PARTY: 'ALREADY_IN_PARTY',
  /** В группе нет места */
  PARTY_FULL: 'PARTY_FULL',
  /** Приглашение просрочено или отозвано */
  INVITE_GONE: 'INVITE_GONE',
  /** Не все готовы */
  NOT_READY: 'NOT_READY',
  /** Матч уже идёт */
  SESSION_ACTIVE: 'SESSION_ACTIVE',
  /** База не держит правил платформы */
  UNSUPPORTED: 'UNSUPPORTED',
} as const;

export type PlayErrorCode = typeof PLAY_ERRORS[keyof typeof PLAY_ERRORS];

/** Что сказать человеку. Ни одного «внутренняя ошибка сервера». */
export const PLAY_ERROR_TEXT: Record<string, string> = {
  NOT_FOUND: 'Этого больше нет',
  VERSION_CONFLICT: 'Пока вы думали, состояние изменилось. Обновите и повторите',
  IDEMPOTENCY_MISMATCH: 'Этот запрос уже отправлялся с другим содержимым',
  FORBIDDEN: 'Действие недоступно',
  RATE_LIMITED: 'Слишком часто. Подождите немного',
  INVALID: 'Запрос не принят: неверные данные',
  MAINTENANCE: 'Идёт обслуживание: новые матчи временно не начинаются',
  ALREADY_IN_PARTY: 'Человек уже в другой группе',
  PARTY_FULL: 'В группе больше нет мест',
  INVITE_GONE: 'Приглашение больше не действует',
  NOT_READY: 'Готовы не все',
  SESSION_ACTIVE: 'Матч уже идёт',
  UNSUPPORTED: 'На этой базе платформа не работает',
};

/** Код → ответ HTTP. Скрытность здесь не решается: её решает заслон. */
export const PLAY_ERROR_HTTP: Record<string, number> = {
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_MISMATCH: 409,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  INVALID: 400,
  MAINTENANCE: 503,
  ALREADY_IN_PARTY: 409,
  PARTY_FULL: 409,
  INVITE_GONE: 410,
  NOT_READY: 409,
  SESSION_ACTIVE: 409,
  UNSUPPORTED: 501,
};

export const playErrorText = (code: string): string =>
  PLAY_ERROR_TEXT[code] || 'Не получилось. Попробуйте ещё раз';

export const playErrorHttp = (code: string): number => PLAY_ERROR_HTTP[code] || 400;

// ── Сроки и пределы ─────────────────────────────────────────────────────────

export const PLAY_LIMITS = {
  /** Как часто окно подтверждает, что оно живо */
  heartbeatMs: 10_000,
  /** Насколько вперёд выдаётся аренда присутствия */
  presenceLeaseMs: 30_000,
  /**
   * После этого показанное состояние считается устаревшим.
   *
   * Больше аренды на один интервал сердцебиения: один потерянный пакет — не
   * повод объявлять человека ушедшим, два подряд — уже повод.
   */
  staleAfterMs: 35_000,
  /** Сколько живёт расписка о выполненной команде */
  receiptTtlMs: 24 * 3600_000,
  /** Сколько живёт приглашение */
  inviteTtlMs: 5 * 60_000,
  /** Сколько живёт билет на подключение к игровому серверу */
  ticketTtlMs: 2 * 60_000,
  /** Команд в минуту с одного человека */
  commandsPerMinute: 120,
  /** Наибольший размер тела команды, байт */
  commandBytes: 16 * 1024,
} as const;

// ── Присутствие ─────────────────────────────────────────────────────────────
//
// Четыре состояния, и они независимы: «в сети» — про соединение, «занят» —
// про то, чем человек занят, «невидимый» — про его выбор. Слияние их в одно
// `isOnline` и было той ложью, из-за которой в чате все всегда были не в сети.

export const PLAY_STATUS = ['ONLINE', 'AWAY', 'INVISIBLE', 'OFFLINE'] as const;
export type PlayStatus = typeof PLAY_STATUS[number];

export const PLAY_ACTIVITY = ['IDLE', 'LOBBY', 'MATCH'] as const;
export type PlayActivity = typeof PLAY_ACTIVITY[number];

export const PLAY_STATUS_TEXT: Record<PlayStatus, string> = {
  ONLINE: 'в сети',
  AWAY: 'отошёл',
  INVISIBLE: 'не показывается',
  OFFLINE: 'не в сети',
};

export const PLAY_ACTIVITY_TEXT: Record<PlayActivity, string> = {
  IDLE: 'свободен',
  LOBBY: 'в лобби',
  MATCH: 'в матче',
};

// ── Команды ─────────────────────────────────────────────────────────────────

/**
 * Ответ на команду.
 *
 * `repeated` говорит окну, что это тот же ответ, а не второе действие: без
 * него «Приглашение отправлено» показалось бы дважды, и человек решил бы, что
 * отправил два.
 */
export interface PlayCommandReceipt<T = unknown> {
  ok: boolean;
  /** Ответ выдан по расписке: действие уже было выполнено раньше */
  repeated: boolean;
  code?: PlayErrorCode | string;
  message?: string;
  result?: T;
}

/** Состояние агрегата всегда приезжает с версией: по ней и спорят. */
export interface PlayVersioned {
  id: string;
  revision: number;
}

/**
 * Снимок состояния для клиента после переподключения.
 *
 * Порядок из ТЗ: переавторизоваться → подписаться с буферизацией → получить
 * снимок → применить события новее его версий. Наоборот нельзя: события,
 * пришедшие до снимка, снимок бы затёр.
 */
export interface PlaySnapshot {
  at: number;
  /** Версии агрегатов на момент снимка: всё, что новее, применяется поверх */
  versions: Record<string, number>;
  party: unknown | null;
  lobby: unknown | null;
  session: unknown | null;
  /**
   * Итог прошлого матча — пока не начался следующий.
   *
   * Лежит здесь, а не добирается окном отдельным запросом: после матча запись
   * о нём уходит из `session`, и окно, которое помнило бы его само, теряло бы
   * счёт при первой же перезагрузке страницы.
   */
  result: { sessionId: string; payload: Record<string, unknown> } | null;
  invites: unknown[];
  presence: unknown[];
}
