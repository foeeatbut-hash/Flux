/**
 * Правило доступа к встроенным программам — сейчас это игровая платформа
 * Flux Play.
 *
 * Само правило лежит в корне (`play/policy.ts`) и общее с сервером: решение
 * принимают двое — окно (показать ли раздел) и сервер (ответить ли на
 * запрос), — и две копии одного правила разошлись бы молча и в худшую
 * сторону: окно спрятало бы, сервер отдал бы. Здесь — сторона окна: перевод
 * профиля в то, что понимает правило, и отбор разделов по нему.
 *
 * React и хранилищ тут по-прежнему нет: на вход карта прав и состояние
 * платформы, на выход решение. Так это и проверяется скриптом.
 *
 * Чем это отличается от `can()` из permissions.ts, и почему второй функции
 * всё-таки пришлось появиться:
 *
 *   1. **ADMIN не обходит.** `can()` первой строкой отвечает `true`
 *      администратору — для рабочих прав это верно. Здесь наоборот: доступ к
 *      платформе выдаётся явно, и должность сама по себе его не даёт.
 *   2. **Три состояния вместо двух.** Рабочее право либо выдано, либо нет.
 *      Здесь есть ещё «ничего не сказано»: тогда ответ ищется в правах роли.
 *      Личный запрет поэтому именно записывается, а не стирается.
 *   3. **Молчаливый отказ.** Закрытый рабочий раздел отвечает словами — это
 *      правильно, человек должен понять, что дело в праве. Платформа отвечает
 *      пустотой: у сотрудника без доступа её нет нигде — ни в Пуске, ни на
 *      столе, ни в поиске, ни в руководстве, ни по прямому адресу.
 *
 * Порядок проверок задан ТЗ и повторён здесь дословно, потому что от него
 * зависит смысл: личный запрет обязан быть сильнее прав роли, а глобальный
 * выключатель — сильнее любых личных выдач.
 */
import { can, parsePermissions, type PermUser } from './permissions';
import { APP_PLAY, PLAY_ADMIN, PLAY_GAMES, gameEntitlement, type PlayGameDef } from '../../play/features';
import {
  PLATFORM_OFF, decide as decideBy, type PlatformState, type PolicySubject, type PolicyVerdict,
} from '../../play/policy';

export { PLATFORM_OFF, entryMode } from '../../play/policy';
export type { PlatformState, PolicySource, PolicyVerdict } from '../../play/policy';

export interface AppContext {
  user: PermUser | null | undefined;
  platform: PlatformState;
}

/**
 * Профиль окна — в то, что понимает правило.
 *
 * Личные права и права роли нужны порознь: личное сильнее роли, и слитая
 * карта (`effectivePermissions`) ответ на это потеряла бы.
 */
function subjectOf(user: PermUser | null | undefined): PolicySubject | null {
  if (!user) return null;
  const v = user.validUntil;
  return {
    active: user.isActive !== false,
    validUntil: typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : null,
    personal: parsePermissions(user.permissions),
    fromRole: parsePermissions(user.rolePermissions),
  };
}

/**
 * Решение и его причина. Само правило — общее с сервером (play/policy.ts).
 *
 * Управление платформой общим выключателем не отнимается: иначе выключенную
 * платформу было бы некому включить обратно.
 */
export function decide(ctx: AppContext, key: string): PolicyVerdict {
  const opts = key === PLAY_ADMIN ? { ignoreSwitch: true } : {};
  return decideBy(subjectOf(ctx.user), ctx.platform || PLATFORM_OFF, key, opts);
}

/** Короткий ответ там, где причина не нужна. */
export const canUseFeature = (ctx: AppContext, key: string): boolean => decide(ctx, key).allowed;

/** Кто двигает общий выключатель и публикует сборки. */
export const canManagePlay = (ctx: AppContext): boolean => canUseFeature(ctx, PLAY_ADMIN);

/** Платформа доступна: раздел открывается, запросы к нему отвечают. */
export const canOpenApp = (ctx: AppContext): boolean => canUseFeature(ctx, APP_PLAY);

/**
 * Платформу видно.
 *
 * Совпадает с `canOpenApp` намеренно и должно совпадать всегда: раздельная
 * «видимость» и «доступность» — это и есть та щель, через которую название
 * утекает в поиск, в подсказку помощника и в оглавление руководства.
 */
export const canDiscoverApp = (ctx: AppContext): boolean => canOpenApp(ctx);

/** Игру видно: доступна платформа и выдано право на саму игру. */
export const canDiscoverGame = (ctx: AppContext, gameId: string): boolean =>
  canOpenApp(ctx) && canUseFeature(ctx, gameEntitlement(gameId));

export const visibleGames = (ctx: AppContext): PlayGameDef[] =>
  canOpenApp(ctx) ? PLAY_GAMES.filter((g) => canUseFeature(ctx, gameEntitlement(g.id))) : [];

/** Раздел, закрытый правом или правом платформы. */
export type AccessMode = 'normal' | 'stealth';

export interface GuardedSection {
  path: string;
  adminOnly?: boolean;
  /** Рабочее право из FEATURES: отказ объясняется словами */
  feature?: string;
  /** Право платформы: отказ молчаливый */
  entitlement?: string;
  accessMode?: AccessMode;
}

/**
 * Что делать с разделом:
 *
 *   'open'    — показывать и открывать;
 *   'explain' — не показывать в списках, но по прямому адресу объяснить, что
 *               дело в праве (так ведут себя Журнал и Обращения);
 *   'hide'    — не показывать нигде и по прямому адресу молча увести на
 *               Главную, как будто такого адреса нет.
 */
export function sectionAccess(s: GuardedSection, ctx: AppContext): 'open' | 'explain' | 'hide' {
  const user = ctx.user;
  const isAdmin = user?.role === 'ADMIN';
  if (s.adminOnly && !isAdmin) return 'hide';
  if (s.entitlement && !canUseFeature(ctx, s.entitlement)) {
    return s.accessMode === 'stealth' ? 'hide' : 'explain';
  }
  if (s.feature && !isAdmin && !can(user, s.feature)) {
    return s.accessMode === 'stealth' ? 'hide' : 'explain';
  }
  return 'open';
}

/** Раздел показывается в списках: Пуск, стол, панель задач, поиск, руководство. */
export const sectionVisible = (s: GuardedSection, ctx: AppContext): boolean =>
  sectionAccess(s, ctx) === 'open';

/**
 * Единственная воронка для всех поверхностей программы.
 *
 * Через неё проходят Пуск, панель задач, рабочий стол, переключатель панелей,
 * строка команд, помощник, руководство и центр уведомлений. Список поверхностей
 * стережёт `scripts/test-play-policy.ts`: забыть одну из них молча нельзя —
 * именно так название закрытого раздела и утекало раньше на панель задач.
 */
export function visibleSections<T extends GuardedSection>(list: T[], ctx: AppContext): T[] {
  return list.filter((s) => sectionVisible(s, ctx));
}

/** Набор доступных кодов — его сервер кладёт в ответ и его же шлёт при смене. */
export function grantedKeys(ctx: AppContext, keys: string[]): string[] {
  return keys.filter((k) => canUseFeature(ctx, k));
}
