/**
 * Должности и уровень доступа сотрудника — одни правила на окно и сервер.
 *
 * Два разных понятия, которые раньше смешивались в одном поле `role`:
 *  - должность — кем человек работает (инженер, менеджер…), справочник `Role`;
 *    у человека одна основная и сколько угодно дополнительных;
 *  - уровень доступа — владелец, администратор или сотрудник; администратором
 *    человека делает только владелец.
 *
 * Хранение без миграции данных: уровень остаётся в `User.role`
 * ('OWNER' | 'ADMIN' | иначе сотрудник, и тогда там код основной должности —
 * так всё, что читает `role`, продолжает работать), а должность лежит в
 * `positionCode` и `extraPositions`. У записей, заведённых до этого разделения,
 * этих полей нет — основная должность тогда берётся из `role`.
 *
 * Чистый модуль (ни React, ни express, ни базы): серверу нужно отказать, а
 * экрану — не предлагать невозможное, и две копии правил разошлись бы молча.
 */

/** Коды Role, которые означают уровень доступа, а не должность. */
export const ACCESS_ROLE_CODES = ['OWNER', 'ADMIN'] as const;
/** Служебная учётная запись (Flux Guide): не сотрудник и без должности. */
export const SERVICE_ROLE_CODE = 'SERVICE';
/** Сколько дополнительных должностей можно назначить — защита от мусора в теле запроса. */
export const MAX_EXTRA_POSITIONS = 20;

export type AccessLevel = 'OWNER' | 'ADMIN' | 'EMPLOYEE';

export interface PositionUser {
  role?: string | null;
  positionCode?: string | null;
  extraPositions?: string | string[] | null;
}

/** Код означает уровень доступа или служебную запись, а не должность. */
export const isNonPositionCode = (code: unknown): boolean =>
  code === 'OWNER' || code === 'ADMIN' || code === SERVICE_ROLE_CODE;

export function accessLevelOf(user: { role?: string | null } | null | undefined): AccessLevel {
  return user?.role === 'OWNER' ? 'OWNER' : user?.role === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE';
}

/**
 * Основная должность: сохранённая, а у старых записей — код из `role`
 * (если там не уровень доступа). Нет ни того ни другого — null.
 */
export function primaryPositionCode(user: PositionUser | null | undefined): string | null {
  if (!user) return null;
  const saved = typeof user.positionCode === 'string' ? user.positionCode.trim() : '';
  if (saved && !isNonPositionCode(saved)) return saved;
  const legacy = typeof user.role === 'string' ? user.role.trim() : '';
  return legacy && !isNonPositionCode(legacy) ? legacy : null;
}

/** Разбор JSON-массива из колонки; не массив и мусор дают пустой список. */
export function parseExtraPositions(raw: unknown): string[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  for (const item of list) {
    const code = typeof item === 'string' ? item.trim() : '';
    if (code && !isNonPositionCode(code)) seen.add(code);
  }
  return [...seen];
}

/** Дополнительные должности человека: без дублей и без основной. */
export function extraPositionCodes(user: PositionUser | null | undefined): string[] {
  if (!user) return [];
  const primary = primaryPositionCode(user);
  return parseExtraPositions(user.extraPositions).filter((code) => code !== primary);
}

/** Все должности человека: основная первой. */
export function allPositionCodes(user: PositionUser | null | undefined): string[] {
  const primary = primaryPositionCode(user);
  return [...(primary ? [primary] : []), ...extraPositionCodes(user)];
}

export type PositionsCheck =
  | { ok: true; primary: string; extras: string[] }
  | { ok: false; error: string };

/**
 * Проверка набора должностей перед записью. `known` — коды справочника.
 * Дополнительные должности без дублей и без основной; уровни доступа
 * должностью не бывают.
 */
export function checkPositions(primaryRaw: unknown, extrasRaw: unknown, known: ReadonlySet<string>): PositionsCheck {
  const primary = typeof primaryRaw === 'string' ? primaryRaw.trim().toUpperCase() : '';
  if (!primary) return { ok: false, error: 'Укажите основную должность сотрудника.' };
  if (isNonPositionCode(primary)) return { ok: false, error: 'Администратор и владелец — это уровень доступа, а не должность. Выберите должность.' };
  if (!known.has(primary)) return { ok: false, error: 'Выберите существующую должность.' };
  if (extrasRaw === undefined || extrasRaw === null) return { ok: true, primary, extras: [] };
  let list: unknown = extrasRaw;
  if (typeof extrasRaw === 'string') {
    try { list = JSON.parse(extrasRaw); } catch { return { ok: false, error: 'Дополнительные должности переданы неверно.' }; }
  }
  if (!Array.isArray(list)) return { ok: false, error: 'Дополнительные должности переданы неверно.' };
  if (list.length > MAX_EXTRA_POSITIONS) return { ok: false, error: `Дополнительных должностей не больше ${MAX_EXTRA_POSITIONS}.` };
  const extras: string[] = [];
  for (const item of list) {
    const code = typeof item === 'string' ? item.trim().toUpperCase() : '';
    if (!code) return { ok: false, error: 'Дополнительные должности переданы неверно.' };
    if (isNonPositionCode(code)) return { ok: false, error: 'Администратор и владелец — это уровень доступа, а не должность.' };
    if (!known.has(code)) return { ok: false, error: 'Выберите существующую дополнительную должность.' };
    if (code === primary) return { ok: false, error: 'Основная должность не повторяется среди дополнительных.' };
    if (extras.includes(code)) return { ok: false, error: 'Дополнительная должность указана дважды.' };
    extras.push(code);
  }
  return { ok: true, primary, extras };
}

// ── Права должностей ────────────────────────────────────────────────────────

interface PermEntryLike { enabled?: boolean; until?: string | null; mode?: string }
type PermMapLike = Record<string, PermEntryLike>;

const parseMap = (raw: unknown): PermMapLike => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as PermMapLike;
  try {
    const obj = JSON.parse(String(raw));
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
};

/** Полномочия администратора выдаёт лично владелец: должность их не хранит и не наследует. */
export function stripAdminPermissions(raw: unknown): PermMapLike {
  const out: PermMapLike = {};
  for (const [feature, entry] of Object.entries(parseMap(raw))) {
    if (!feature.startsWith('admin.')) out[feature] = entry;
  }
  return out;
}

const allowed = (e: PermEntryLike | undefined): boolean => !!e && e.enabled === true && e.mode !== 'DENY';

/**
 * Права, которые даёт набор должностей: основная целиком, дополнительные —
 * только включённым. Запрет в основной (и личный, он накладывается позже)
 * дополнительная должность не снимает: иначе добавление второй должности
 * молча отнимало бы или возвращало то, что владелец закрыл.
 * Если право включено и там и там, срок берётся более длинный.
 */
export function mergePositionPermissions(primaryRaw: unknown, extrasRaw: unknown[]): PermMapLike {
  const out = stripAdminPermissions(primaryRaw);
  for (const raw of extrasRaw) {
    for (const [feature, entry] of Object.entries(stripAdminPermissions(raw))) {
      if (!allowed(entry)) continue;
      const have = out[feature];
      if (!have) { out[feature] = { ...entry }; continue; }
      if (!allowed(have)) continue; // явный запрет основной остаётся
      const until = !have.until || !entry.until ? null : (new Date(have.until).getTime() >= new Date(entry.until).getTime() ? have.until : entry.until);
      out[feature] = { ...have, until };
    }
  }
  return out;
}
