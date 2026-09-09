/**
 * Общее для всех маршрутов обращений: кто обращается, что ему можно и как
 * выглядит ответ.
 *
 * Личность берётся ТОЛЬКО из сессии. Поле `authorId` в теле запроса — не
 * доказательство: идентификаторы коллег видны в списке сотрудников, и на этом
 * в мессенджере уже обжигались — чужую переписку можно было вычитать запросом,
 * потому что проверка сравнивала присланное с присланным.
 *
 * Ответ у всех маршрутов одинаковой формы: `{ data, meta }` при успехе и
 * `{ error: { code, message, requestId } }` при отказе. Код нужен окну, чтобы
 * различать «повтори» и «поправь и пришли заново», а `requestId` — чтобы
 * человек мог назвать его при разборе.
 */

import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { getPrisma, upsertSetting } from '../context.js';
import { ERRORS, type ErrorCode } from '../../feedback/contracts.js';

/** Настройки домена: одна запись на всю базу. */
const SETTINGS_KEY = 'feedback.settings.v1';

export interface Actor {
  id: string;
  name: string;
  isAdmin: boolean;
}

/** Кто обращается. Пусто — значит сессии нет и дальше идти нельзя. */
export function actorOf(req: Request): Actor | null {
  const user = (req as any).authUser;
  if (!user?.id) return null;
  const name = [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ')
    || user.fullName || user.symbol || 'Сотрудник';
  return { id: String(user.id), name: String(name).slice(0, 160), isAdmin: user.role === 'ADMIN' };
}

/** HTTP-код по смыслу отказа: окно решает по нему, что делать дальше. */
const STATUS_OF: Record<string, number> = {
  [ERRORS.VALIDATION]: 400,
  [ERRORS.FORBIDDEN]: 403,
  [ERRORS.NOT_FOUND]: 404,
  [ERRORS.REVISION_CONFLICT]: 409,
  [ERRORS.IDEMPOTENCY_CONFLICT]: 409,
  [ERRORS.INVALID_TRANSITION]: 409,
  [ERRORS.CHUNK_CONFLICT]: 409,
  [ERRORS.UPLOAD_EXPIRED]: 409,
  [ERRORS.TOO_LARGE]: 413,
  [ERRORS.UNSUPPORTED_TYPE]: 415,
  [ERRORS.RATE_LIMITED]: 429,
  [ERRORS.UNAVAILABLE]: 503,
};

/**
 * Отказ. Ни SQL, ни стека наружу: сообщение драйвера содержит запрос со
 * значениями, а человеку оно всё равно ничего не объясняет.
 */
export function fail(res: Response, code: ErrorCode, message: string, details?: unknown): void {
  const requestId = String(res.getHeader('X-Flux-Trace') || randomUUID());
  res.status(STATUS_OF[code] || 400).json({
    error: { code, message, requestId, ...(details === undefined ? {} : { details }) },
  });
}

/** Успех. Всегда в конверте: окно разбирает один вид ответа, а не пять. */
export function ok(res: Response, data: unknown, meta?: unknown): void {
  res.json({ data, ...(meta === undefined ? {} : { meta }) });
}

interface Settings {
  /** Постоянный признак этой базы: черновики одного контура не уезжают в другой. */
  deploymentId: string;
  /** Сколько всего места отведено вложениям обращений. */
  quotaBytes: number;
  /** И сколько незакреплённых загрузок может держать один человек. */
  perUserBytes: number;
}

const DEFAULTS: Settings = {
  deploymentId: '',
  quotaBytes: 2 * 1024 * 1024 * 1024,
  perUserBytes: 100 * 1024 * 1024,
};

let cached: Settings | null = null;

/**
 * Настройки домена, заводятся при первом обращении.
 *
 * `deploymentId` создаётся один раз на базу, а не на каждый сервер: у каждого
 * сотрудника свой встроенный Express, и признак «это тот же контур» должен
 * быть общим — иначе очередь отправки с одной машины считалась бы чужой на
 * другой.
 */
export async function settings(): Promise<Settings> {
  if (cached) return cached;
  const prisma = getPrisma();
  let value: Settings = { ...DEFAULTS };
  try {
    const row = await prisma.appSetting.findFirst({ where: { key: SETTINGS_KEY, userId: null } });
    if (row?.value) value = { ...DEFAULTS, ...JSON.parse(row.value) };
  } catch (_) { /* настройки ещё нет — заведём */ }
  if (!value.deploymentId) {
    value.deploymentId = randomUUID();
    try { await upsertSetting(SETTINGS_KEY, null, JSON.stringify(value)); } catch (_) { /* запишем позже */ }
  }
  cached = value;
  return value;
}

export function resetSettings(): void { cached = null; }

/**
 * Кому уходит новое обращение.
 *
 * Список считается по тому же праву, что и доступ к очереди: отдельного списка
 * получателей нет намеренно — он разошёлся бы с правами, и человек, у которого
 * право забрали, продолжал бы получать чужие обращения.
 */
export async function triageRecipients(can: (user: any, feature: string) => boolean): Promise<string[]> {
  try {
    const prisma = getPrisma();
    const users = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, role: true, permissions: true, isActive: true, validUntil: true },
    });
    return users.filter((u: any) => can(u, 'feedback.triage')).map((u: any) => String(u.id));
  } catch (_) {
    return [];
  }
}

/** Читаемое имя автора на момент отправки: сотрудника могут переименовать. */
export const snapshotName = (actor: Actor): string => actor.name;
