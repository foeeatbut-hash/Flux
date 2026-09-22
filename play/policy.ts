/**
 * Правило доступа к встроенным программам — одно на окно и на сервер.
 *
 * Лежит в корне, рядом с `feedback/` и `diagnostics/`, по той же причине:
 * решение принимают двое — окно (показать ли раздел) и сервер (ответить ли на
 * запрос), — и если правило написать дважды, две копии разойдутся. Разойдутся
 * они молча и в худшую сторону: окно спрячет, сервер отдаст.
 *
 * Модуль чистый: ни React, ни express, ни обращений к базе. На вход —
 * разобранные карты прав и состояние платформы, на выход — решение и причина.
 *
 * Порядок проверок задан ТЗ §3.1 и повторён здесь дословно, потому что от
 * него зависит смысл: личный запрет сильнее прав роли, а общий выключатель
 * сильнее любых личных выдач. И ни одна из проверок не делает исключения для
 * администратора: доступ к платформе выдаётся явно, должность его не даёт.
 */

/** Запись права. `mode` — «сказано явно»; его отсутствие читается по `enabled`. */
export interface PolicyEntry {
  enabled?: boolean;
  until?: string | null;
  mode?: 'ALLOW' | 'DENY';
}

export type PolicyMap = Record<string, PolicyEntry>;

/** Состояние платформы целиком — общее для всех сотрудников. */
export interface PlatformState {
  /** Платформа включена администратором компании */
  enabled: boolean;
  /**
   * База умеет держать инварианты платформы.
   *
   * На них стоит весь смысл: «одна активная группа на человека», «один
   * незавершённый матч на лобби». Держит их частичный уникальный индекс, а его
   * нет в MariaDB. Включать там платформу молча нельзя — она развалится не
   * сразу, а на втором десятке матчей, и разбирать это будет некому.
   */
  supported: boolean;
  /** Обслуживание: зайти можно, начать новый матч — нет */
  maintenance?: boolean;
  /**
   * Версия политики. Растёт при любой правке прав или общего выключателя; по
   * её смене окно перечитывает свой доступ, не дожидаясь нового входа.
   */
  version?: number;
  /** Почему платформа недоступна — для Настроек, а не для сотрудника */
  note?: string;
}

/** Пока сервер не ответил, платформы нет. Умолчание — отказ, не разрешение. */
export const PLATFORM_OFF: PlatformState = { enabled: false, supported: false };

/** Всё, что нужно знать о человеке, чтобы ответить. */
export interface PolicySubject {
  /** Профиль включён администратором */
  active: boolean;
  /** Срок действия профиля; пусто — бессрочный */
  validUntil: string | null;
  /** Личные права */
  personal: PolicyMap;
  /** Права роли */
  fromRole: PolicyMap;
}

export type PolicySource = 'profile' | 'platform' | 'personal' | 'role' | 'default';

export interface PolicyVerdict {
  allowed: boolean;
  source: PolicySource;
  /** Причина словами — для карточки сотрудника и Настроек, не для отказа */
  note: string;
}

const expired = (until: string | null | undefined): boolean =>
  !!until && new Date(until).getTime() < Date.now();

/**
 * Что сказано в одной записи.
 *
 * Запись с истёкшим сроком равна её отсутствию: временная выдача кончилась —
 * значит, ответ снова ищется в правах роли. То же и с временным запретом.
 */
export function entryMode(e: PolicyEntry | undefined | null): 'ALLOW' | 'DENY' | 'INHERIT' {
  if (!e) return 'INHERIT';
  if (expired(e.until)) return 'INHERIT';
  if (e.mode === 'ALLOW' || e.mode === 'DENY') return e.mode;
  return e.enabled ? 'ALLOW' : 'DENY';
}

/** Карта прав из строки JSON или уже разобранного объекта. */
export function toMap(raw: string | PolicyMap | null | undefined): PolicyMap {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as PolicyMap;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

export interface DecideOpts {
  /**
   * Общий выключатель не применяется.
   *
   * Нужно ровно одному праву — управлению платформой. Иначе выключенную
   * платформу было бы некому включить обратно: выключатель отнимал бы право,
   * которым его и двигают. Неподдержанную базу это НЕ обходит — там включать
   * действительно нечего.
   */
  ignoreSwitch?: boolean;
}

/**
 * Главное решение:
 *
 *   профиль отключён или истёк → платформа выключена или не поддержана →
 *   личный запрет → личная выдача → право роли → отказ по умолчанию.
 */
export function decide(
  subject: PolicySubject | null | undefined,
  platform: PlatformState,
  key: string,
  opts: DecideOpts = {},
): PolicyVerdict {
  if (!subject) return { allowed: false, source: 'profile', note: 'Вход не выполнен' };
  if (!subject.active) return { allowed: false, source: 'profile', note: 'Профиль отключён' };
  if (expired(subject.validUntil)) {
    return { allowed: false, source: 'profile', note: 'Срок действия профиля истёк' };
  }

  const p = platform || PLATFORM_OFF;
  if (!p.supported) {
    return { allowed: false, source: 'platform', note: p.note || 'База не поддерживает платформу' };
  }
  if (!p.enabled && !opts.ignoreSwitch) {
    return { allowed: false, source: 'platform', note: p.note || 'Платформа выключена в настройках компании' };
  }

  const own = entryMode(subject.personal[key]);
  if (own === 'DENY') return { allowed: false, source: 'personal', note: 'Запрещено этому сотруднику' };
  if (own === 'ALLOW') return { allowed: true, source: 'personal', note: 'Выдано лично' };

  const byRole = entryMode(subject.fromRole[key]);
  if (byRole === 'DENY') return { allowed: false, source: 'role', note: 'Запрещено роли' };
  if (byRole === 'ALLOW') return { allowed: true, source: 'role', note: 'Выдано роли' };

  // Должность сама по себе доступа не даёт — в том числе должность
  // администратора. Иначе платформа «сама включилась» бы руководителю
  return { allowed: false, source: 'default', note: 'Не выдано' };
}

export const allows = (
  subject: PolicySubject | null | undefined,
  platform: PlatformState,
  key: string,
  opts: DecideOpts = {},
): boolean => decide(subject, platform, key, opts).allowed;
