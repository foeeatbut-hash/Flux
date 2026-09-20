/**
 * Заслон платформы на сервере: кого пускать к `/api/play/*` и что он видит.
 *
 * Два решения, от которых зависит вся скрытность:
 *
 *   1. **Отказ — это 404, а не 403.** Запрещающий ответ сообщает ровно то,
 *      что скрывается: «такое есть, но не для тебя». Поэтому сотруднику без
 *      доступа платформа отвечает так же, как отвечает на выдуманный адрес.
 *      Ни кода ошибки, ни заголовка, ни слова «Play» в теле.
 *   2. **Отбор идёт до отправки.** Данные не помечаются `allowed: false` и не
 *      отдаются «на всякий случай»: чего человеку не положено, того в ответе
 *      нет вовсе. Пометку видно в средствах разработчика, а отсутствие — нет.
 *
 * Правило доступа здесь не своё: оно общее с окном (`play/policy.ts`). Две
 * копии правила разошлись бы, и разошлись бы в худшую сторону.
 */

import type { Express, NextFunction, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { getDialect, supportsPartialIndex } from '../ddl.js';
import { allows, decide, toMap, PLATFORM_OFF, type PlatformState, type PolicySubject } from '../../play/policy.js';
import { APP_PLAY, PLAY_ADMIN, isPlayKey } from '../../play/features.js';
import { ensurePlayReady } from './tables.js';

/** Ключ общей настройки: платформа включена по всей компании. */
export const PLAY_ENABLED_KEY = 'play_enabled';

/**
 * Базы, на которых платформа работает.
 *
 * Инварианты платформы держатся частичными уникальными индексами («одна
 * активная группа на человека»). PostgreSQL и SQLite их умеют, MariaDB — нет,
 * и включать там платформу означало бы получить двойные группы и двойные
 * матчи на втором десятке игр. Поэтому там она не включается, и в Настройках
 * сказано почему — а не умалчивается.
 *
 * Ответ берётся у самого слоя DDL, а не списком имён: список разошёлся бы с
 * тем, что этот слой на самом деле умеет.
 */
export const UNSUPPORTED_NOTE = 'Платформа требует частичных уникальных индексов: '
  + 'на MariaDB их нет, поэтому раздел там не включается. Работает на PostgreSQL и SQLite.';

/**
 * Версия политики.
 *
 * Растёт при любой правке прав или общего выключателя. По её смене окно
 * перечитывает свой доступ, не дожидаясь нового входа: раньше снятое право
 * начинало действовать только после перезапуска программы.
 */
let policyVersion = 1;
export const getPolicyVersion = (): number => policyVersion;
export const bumpPolicyVersion = (): number => ++policyVersion;

let cached: { state: PlatformState; at: number } | null = null;
const CACHE_MS = 5000;

/** Общий выключатель платформы — из настроек компании, с коротким кэшем. */
export async function platformState(): Promise<PlatformState> {
  const dialect = getDialect();
  const supported = supportsPartialIndex(dialect);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return { ...cached.state, supported, version: policyVersion };
  }
  let enabled = false;
  try {
    const prisma = getPrisma();
    const row = await prisma.appSetting.findFirst({ where: { key: PLAY_ENABLED_KEY, userId: null } });
    enabled = String(row?.value || '') === '1';
  } catch (_) {
    // Настройки нет или таблица недоступна — платформа выключена. Умолчание
    // здесь отказ: включённая «по недосмотру» платформа хуже выключенной
    enabled = false;
  }
  const state: PlatformState = {
    enabled,
    supported,
    maintenance: false,
    version: policyVersion,
    note: supported ? '' : UNSUPPORTED_NOTE,
  };
  cached = { state, at: Date.now() };
  return state;
}

/** Настройку поменяли — кэш и версия политики обязаны это заметить. */
export function invalidatePlatform(): void {
  cached = null;
  bumpPolicyVersion();
}

const roleCache = new Map<string, { perms: any; at: number }>();

async function roleMap(code: string): Promise<Record<string, any>> {
  const hit = roleCache.get(code);
  if (hit && Date.now() - hit.at < 30000) return hit.perms;
  let perms: Record<string, any> = {};
  try {
    const prisma = getPrisma();
    const role = await prisma.role.findUnique({ where: { code } });
    perms = toMap(role?.permissions || null);
  } catch (_) { perms = {}; }
  roleCache.set(code, { perms, at: Date.now() });
  return perms;
}

export function invalidateRoleMaps(): void {
  roleCache.clear();
  bumpPolicyVersion();
}

/** Профиль из сессии — в то, что понимает правило. */
export async function subjectOf(user: any): Promise<PolicySubject | null> {
  if (!user) return null;
  const v = user.validUntil;
  return {
    active: user.isActive !== false,
    validUntil: v ? (typeof v === 'string' ? v : new Date(v).toISOString()) : null,
    personal: toMap(user.permissions || null),
    fromRole: await roleMap(String(user.role || '')),
  };
}

/**
 * Управление платформой общим выключателем не отнимается.
 *
 * Иначе выключенную платформу было бы некому включить: выключатель отбирал бы
 * право, которым его двигают.
 */
const optsFor = (key: string) => (key === PLAY_ADMIN ? { ignoreSwitch: true } : {});

/** Можно ли этому человеку вот это. Личность берётся из сессии, не из запроса. */
export async function allowed(user: any, key: string): Promise<boolean> {
  return allows(await subjectOf(user), await platformState(), key, optsFor(key));
}

/** Решение с причиной — для Настроек и карточки сотрудника, не для отказа. */
export async function verdict(user: any, key: string) {
  return decide(await subjectOf(user), await platformState(), key, optsFor(key));
}

/**
 * Ответ, которым платформа отказывает.
 *
 * Тот же, что на выдуманный адрес: у Express это `Cannot GET /api/…`, но
 * своим телом мы управляем, поэтому пишем нейтральное. Слова «Play», «право»
 * и «доступ» в нём отсутствуют намеренно — каждое из них было бы ответом на
 * вопрос, который человек не должен даже задать.
 */
export function notThere(res: Response): void {
  res.status(404).json({ error: 'Страница не найдена' });
}

/**
 * Заслон на весь `/api/play/*`.
 *
 * Ставится ОДИН раз на префикс, а не в каждом обработчике: обработчиков будет
 * десяток, и забытый — это открытая платформа. Ровно так закрыты и рабочие
 * права: одной таблицей маршрутов, а не проверкой в каждом месте.
 */
export function registerPlayAccess(app: Express): void {
  app.use('/api/play', async (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).authUser;
    if (!user) return notThere(res);
    try {
      // Управляющий платформой проходит и без доступа к ней самой: иначе
      // выключенную платформу некому было бы включить — выключатель лежит
      // ровно за этим заслоном
      if (!(await allowed(user, APP_PLAY)) && !(await allowed(user, PLAY_ADMIN))) return notThere(res);
      // Таблицы платформы создаются при первом же заходе внутрь, а не при
      // старте сервера: пока платформа выключена, заводить их незачем
      const failure = await ensurePlayReady((m) => console.warn('[Play]', m));
      if (failure) return res.status(500).json({ error: failure });
    } catch (_) {
      // Решить не удалось — значит, не пускаем. Ошибка в проверке доступа не
      // может открывать доступ
      return notThere(res);
    }
    return next();
  });
}

/**
 * Карта прав, очищенная от платформы.
 *
 * Уходит в ответ сотруднику, у которого доступа к платформе нет: сами КЛЮЧИ
 * прав («game.fluxstrike.play») называют игру, и пустой записи в карте хватило
 * бы, чтобы узнать всё. Поэтому вырезаются ключи, а не значения.
 */
export function stripPlayKeys(map: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(map || {})) {
    if (isPlayKey(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Состояние платформы, каким его видит сотрудник без доступа: её нет. */
export const hiddenPlatform = (): PlatformState => ({ ...PLATFORM_OFF, version: policyVersion });
