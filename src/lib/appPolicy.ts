import { can, parsePermissions, type PermUser } from './permissions';
import {
  PLATFORM_OFF, decide as decideBy, type PlatformState, type PolicySubject, type PolicyVerdict,
} from '../../shared/appPolicy';

export { PLATFORM_OFF, entryMode } from '../../shared/appPolicy';
export type { PlatformState, PolicySource, PolicyVerdict } from '../../shared/appPolicy';

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
    owner: user.role === 'OWNER',
    active: user.isActive !== false,
    validUntil: typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : null,
    personal: parsePermissions(user.permissions),
    fromRole: parsePermissions(user.rolePermissions),
  };
}

/**
 * Решение и его причина. Само правило — общее с сервером (shared/appPolicy.ts).
 *
 * Управление платформой общим выключателем не отнимается: иначе выключенную
 * платформу было бы некому включить обратно.
 */
export function decide(ctx: AppContext, key: string): PolicyVerdict {
  return decideBy(subjectOf(ctx.user), ctx.platform || PLATFORM_OFF, key);
}

/** Короткий ответ там, где причина не нужна. */
export const canUseFeature = (ctx: AppContext, key: string): boolean => decide(ctx, key).allowed;

/** Раздел, закрытый правом или правом платформы. */
export type AccessMode = 'normal' | 'stealth';

export interface GuardedSection {
  path: string;
  /** Встроенный редактор/просмотр файла, а не самостоятельная программа. */
  fileOnly?: boolean;
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
  // OWNER может открыть управление сотрудниками, но роль сама по себе не
  // обходит проверку встроенных программ ниже.
  if (s.adminOnly && !isAdmin && user?.role !== 'OWNER') return 'hide';
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
  !s.fileOnly && sectionAccess(s, ctx) === 'open';

/**
 * Единственная воронка для всех поверхностей программы.
 *
 * Через неё проходят Пуск, панель задач, рабочий стол, переключатель панелей,
 * строка команд, помощник, руководство и центр уведомлений. Список поверхностей
 * стережёт `scripts/test-app-policy.ts`: забыть одну из них молча нельзя —
 * именно так название закрытого раздела и утекало раньше на панель задач.
 */
export function visibleSections<T extends GuardedSection>(list: T[], ctx: AppContext, openFilePaths: readonly string[] = []): T[] {
  // Панель задач возвращает открытые файловые окна; Пуск и поиск — только
  // программы. Право открытия проверяется и для уже запущенного редактора.
  const opened = new Set(openFilePaths);
  return list.filter((s) => sectionVisible(s, ctx) ||
    (s.fileOnly && opened.has(s.path) && sectionAccess(s, ctx) === 'open'));
}

/** Набор доступных кодов — его сервер кладёт в ответ и его же шлёт при смене. */
export function grantedKeys(ctx: AppContext, keys: string[]): string[] {
  return keys.filter((k) => canUseFeature(ctx, k));
}
