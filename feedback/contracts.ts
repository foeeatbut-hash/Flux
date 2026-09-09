/**
 * Договор об обращении: что можно прислать и что считается правильным.
 *
 * Один файл читают трое — окно, сервер и наборы проверок. Смысл в том, чтобы
 * правило было написано один раз: длина заголовка, набор состояний, предел
 * вложений. Разъехавшись, они дают худший вид дефекта — окно разрешает
 * отправить, сервер отказывает, и человек не понимает, что он сделал не так.
 *
 * Проверки здесь строгие и на разрешение, а не на запрет: неизвестное поле не
 * проходит. Присланному не верим ни в чём, кроме содержания текста: автор,
 * статус, приоритет и время создания сервер ставит сам, и в договоре отправки
 * их просто нет.
 *
 * Модуль чистый: ни React, ни node:, ни express.
 */

export const SCHEMA_VERSION = 1;

// ── Перечисления ────────────────────────────────────────────────────────────

export const TYPES = ['IDEA', 'BUG', 'PERFORMANCE', 'QUESTION'] as const;
export type ReportType = (typeof TYPES)[number];

export const TYPE_NAMES: Record<ReportType, string> = {
  IDEA: 'Идея',
  BUG: 'Ошибка',
  PERFORMANCE: 'Тормозит',
  QUESTION: 'Вопрос',
};

export const FREQUENCIES = ['ONCE', 'SOMETIMES', 'ALWAYS', 'UNKNOWN'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const FREQUENCY_NAMES: Record<Frequency, string> = {
  ONCE: 'Один раз',
  SOMETIMES: 'Иногда',
  ALWAYS: 'Каждый раз',
  UNKNOWN: 'Не знаю',
};

export const IMPACTS = ['LOW', 'NORMAL', 'HIGH'] as const;
export type Impact = (typeof IMPACTS)[number];

/** Влияние описывает автор своими словами — это не приоритет очереди. */
export const IMPACT_NAMES: Record<Impact, string> = {
  LOW: 'Есть обход',
  NORMAL: 'Мешает работать',
  HIGH: 'Не могу продолжить',
};

export const STATUSES = [
  'NEW', 'TRIAGE', 'NEEDS_INFO', 'PLANNED', 'IN_PROGRESS',
  'VERIFY', 'DONE', 'REJECTED', 'DUPLICATE', 'WITHDRAWN',
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_NAMES: Record<Status, string> = {
  NEW: 'Новое',
  TRIAGE: 'Разбираем',
  NEEDS_INFO: 'Ждём ответа автора',
  PLANNED: 'Запланировано',
  IN_PROGRESS: 'В работе',
  VERIFY: 'На проверке',
  DONE: 'Готово',
  REJECTED: 'Отклонено',
  DUPLICATE: 'Дубль',
  WITHDRAWN: 'Отозвано',
};

/** Приоритет назначает обработчик; P0 руками, а не признаком. */
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_NAMES: Record<Priority, string> = {
  P0: 'Потеря данных или работа встала у всех',
  P1: 'Блокирует, обхода нет',
  P2: 'Обычный дефект',
  P3: 'Удобство или идея',
};

export const VISIBILITIES = ['PUBLIC', 'INTERNAL'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

// ── Пределы ─────────────────────────────────────────────────────────────────

export const LIMITS = {
  title: { min: 5, max: 160 },
  description: { min: 10, max: 20000 },
  step: 1000,
  steps: 10,
  expected: 4000,
  actual: 4000,
  benefit: 4000,
  comment: 20000,
  reason: 2000,
  /** Вложений на обращение и их общий объём. */
  attachments: 10,
  attachmentsBytes: 25 * 1024 * 1024,
  imageBytes: 8 * 1024 * 1024,
  imagePixels: 16 * 1000 * 1000,
  fileBytes: 10 * 1024 * 1024,
  bundleBytes: 5 * 1024 * 1024,
  /** Сколько обращений и комментариев можно завести за час. */
  reportsPerHour: 20,
  commentsPerHour: 100,
  /** Происшествие можно отметить задним числом, но не глубже суток. */
  incidentBackMs: 24 * 3600 * 1000,
} as const;

/** Что принимаем вложением. Проверяется по содержимому, а не по расширению. */
export const ALLOWED_FILE_MIME = [
  'application/pdf', 'text/plain', 'text/csv', 'application/jsonl', 'application/x-ndjson',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * Что не принимаем никогда.
 *
 * Исполняемое и HTML — потому что вложение открывают, а SVG — потому что это
 * тот же HTML со скриптом внутри. Макросные книги и документы Word — потому
 * что макрос выполняется при открытии, а вложение к обращению открывают, не
 * задумываясь: его же прислал коллега.
 */
export const REFUSED_EXTENSIONS = [
  'exe', 'com', 'bat', 'cmd', 'scr', 'ps1', 'vbs', 'js', 'jse', 'wsf', 'msi', 'dll',
  'html', 'htm', 'svg', 'xlsm', 'docm', 'pptm', 'zip', 'rar', '7z',
] as const;

// ── Коды ошибок ─────────────────────────────────────────────────────────────

export const ERRORS = {
  VALIDATION: 'VALIDATION',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  CHUNK_CONFLICT: 'CHUNK_CONFLICT',
  TOO_LARGE: 'TOO_LARGE',
  UNSUPPORTED_TYPE: 'UNSUPPORTED_TYPE',
  RATE_LIMITED: 'RATE_LIMITED',
  UPLOAD_EXPIRED: 'UPLOAD_EXPIRED',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;
export type ErrorCode = (typeof ERRORS)[keyof typeof ERRORS];

// ── Договор отправки ────────────────────────────────────────────────────────

export interface SubmitFeedbackV1 {
  schemaVersion: 1;
  /** Один ключ на подтверждённую отправку: повтор вернёт ту же карточку. */
  clientRequestId: string;
  deploymentId: string;
  type: ReportType;
  title: string;
  description: string;
  sectionKey: string;
  projectId?: string;
  incidentAt: string;
  appVersion: string;
  reproduction?: string[];
  expected?: string;
  actual?: string;
  benefit?: string;
  frequency: Frequency;
  impact: Impact;
  uploadIds: string[];
  consent: { technicalEvents: boolean; appContext: boolean; reviewedAt: string };
}

/**
 * Результат проверки.
 *
 * Не размеченное объединение, а один вид с необязательными полями: в проекте
 * выключен строгий режим TypeScript, и различение объединения по булеву полю
 * там не сужает тип — `return проверка` переставало собираться. Дисциплину
 * держит соглашение: при `ok: false` смотрят `error`, при `ok: true` — `value`.
 */
export interface Checked<T> { ok: boolean; value?: T; error?: string }

const isString = (v: unknown): v is string => typeof v === 'string';
const trimmed = (v: unknown): string => (isString(v) ? v.trim() : '');
const oneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] =>
  isString(v) && (list as readonly string[]).includes(v);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => isString(v) && UUID.test(v);

/** Длина считается по знакам после обрезки пробелов — как её видит человек. */
export function checkText(value: unknown, name: string, min: number, max: number): Checked<string> {
  const text = trimmed(value);
  if (text.length < min) return { ok: false, error: `${name}: не короче ${min} знаков` };
  if (text.length > max) return { ok: false, error: `${name}: не длиннее ${max} знаков` };
  return { ok: true, value: text };
}

function optionalText(value: unknown, name: string, max: number): Checked<string> {
  if (value === undefined || value === null) return { ok: true, value: '' };
  const text = trimmed(value);
  if (text.length > max) return { ok: false, error: `${name}: не длиннее ${max} знаков` };
  return { ok: true, value: text };
}

/**
 * Разбор отправки.
 *
 * Возвращает НОВЫЙ объект, собранный по одному полю: пришедшее нельзя просто
 * пропустить дальше, иначе вместе с ним поедут поля, которых в договоре нет.
 * Автора, статуса и приоритета здесь нет вовсе — их ставит сервер.
 */
export function validateSubmit(raw: unknown, now = Date.now()): Checked<SubmitFeedbackV1> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Ожидался объект' };
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== SCHEMA_VERSION) return { ok: false, error: 'Неизвестная версия договора' };
  if (!isUuid(r.clientRequestId)) return { ok: false, error: 'clientRequestId: ожидался UUID' };
  if (!isString(r.deploymentId) || !r.deploymentId) return { ok: false, error: 'deploymentId обязателен' };
  if (!oneOf(TYPES, r.type)) return { ok: false, error: 'Неизвестный вид обращения' };
  if (!oneOf(FREQUENCIES, r.frequency)) return { ok: false, error: 'Неизвестная частота' };
  if (!oneOf(IMPACTS, r.impact)) return { ok: false, error: 'Неизвестное влияние' };

  const title = checkText(r.title, 'Заголовок', LIMITS.title.min, LIMITS.title.max);
  if (!title.ok) return { ok: false, error: title.error };
  const description = checkText(r.description, 'Описание', LIMITS.description.min, LIMITS.description.max);
  if (!description.ok) return { ok: false, error: description.error };

  const expected = optionalText(r.expected, 'Ожидание', LIMITS.expected);
  if (!expected.ok) return { ok: false, error: expected.error };
  const actual = optionalText(r.actual, 'Результат', LIMITS.actual);
  if (!actual.ok) return { ok: false, error: actual.error };
  const benefit = optionalText(r.benefit, 'Польза', LIMITS.benefit);
  if (!benefit.ok) return { ok: false, error: benefit.error };

  const steps: string[] = [];
  if (r.reproduction !== undefined) {
    if (!Array.isArray(r.reproduction)) return { ok: false, error: 'Шаги: ожидался список' };
    if (r.reproduction.length > LIMITS.steps) return { ok: false, error: `Шагов не больше ${LIMITS.steps}` };
    for (const step of r.reproduction) {
      const one = optionalText(step, 'Шаг', LIMITS.step);
      if (!one.ok) return { ok: false, error: one.error };
      if (one.value) steps.push(one.value);
    }
  }

  const incident = Date.parse(String(r.incidentAt ?? ''));
  if (!Number.isFinite(incident)) return { ok: false, error: 'incidentAt: ожидалось время' };
  // Задним числом — не глубже суток, и не из будущего: расхождение часов на
  // минуту допустимо, на день — это уже не опечатка
  if (incident > now + 60000) return { ok: false, error: 'incidentAt: время из будущего' };
  if (incident < now - LIMITS.incidentBackMs) return { ok: false, error: 'incidentAt: глубже суток' };

  const uploadIds: string[] = [];
  if (r.uploadIds !== undefined) {
    if (!Array.isArray(r.uploadIds)) return { ok: false, error: 'Вложения: ожидался список' };
    if (r.uploadIds.length > LIMITS.attachments) {
      return { ok: false, error: `Вложений не больше ${LIMITS.attachments}` };
    }
    for (const upload of r.uploadIds) {
      if (!isUuid(upload)) return { ok: false, error: 'Вложение: ожидался UUID' };
      if (!uploadIds.includes(upload)) uploadIds.push(upload);
    }
  }

  const consent = (r.consent || {}) as Record<string, unknown>;

  return {
    ok: true,
    value: {
      schemaVersion: SCHEMA_VERSION,
      clientRequestId: r.clientRequestId,
      deploymentId: String(r.deploymentId).slice(0, 64),
      type: r.type,
      title: title.value,
      description: description.value,
      sectionKey: trimmed(r.sectionKey).slice(0, 64),
      ...(isString(r.projectId) && r.projectId ? { projectId: r.projectId.slice(0, 64) } : {}),
      incidentAt: new Date(incident).toISOString(),
      appVersion: trimmed(r.appVersion).slice(0, 32),
      reproduction: steps,
      expected: expected.value,
      actual: actual.value,
      benefit: benefit.value,
      frequency: r.frequency,
      impact: r.impact,
      uploadIds,
      consent: {
        technicalEvents: consent.technicalEvents === true,
        appContext: consent.appContext !== false,
        reviewedAt: isString(consent.reviewedAt) ? consent.reviewedAt : new Date(now).toISOString(),
      },
    },
  };
}

/** Номер обращения так, как его называет человек. */
export const reportNumber = (n: number): string => `ОБР-${String(n).padStart(6, '0')}`;

/** Расширение файла в нижнем регистре, без точки. */
export function extensionOf(name: string): string {
  const dot = String(name || '').lastIndexOf('.');
  return dot > 0 ? String(name).slice(dot + 1).toLowerCase() : '';
}

/** Отказ по расширению — первый и самый дешёвый рубеж, но не единственный. */
export function refusedByName(name: string): boolean {
  return (REFUSED_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}
