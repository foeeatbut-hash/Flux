/**
 * Где живёт доступ к встроенным программам, пока программа открыта.
 *
 * Правило — в `src/lib/appPolicy.ts`, здесь только состояние. Отдельный
 * магазин понадобился из-за двух вещей, которых у рабочих прав нет:
 *
 *   1. **Права меняются в живой сессии.** Раньше доступ приходил один раз, в
 *      ответе на вход, и снятое право начинало действовать только после
 *      перезапуска программы. Для платформы это недопустимо: доступ ей выдают
 *      и отбирают точечно, и отобранный обязан пропасть сразу, а не завтра.
 *   2. **Есть общее состояние платформы.** Она может быть выключена по всей
 *      компании или не поддержана базой — это не про человека, и в его правах
 *      этого нет.
 *
 * Свежие права кладутся сюда, а не в профиль (`store.ts`): профиль — это то,
 * чем человек вошёл, и перезаписывать его ответом фонового запроса значило бы
 * трогать активный проект и тему при каждой смене чужой галочки.
 */
import React from 'react';
import { create } from 'zustand';
import { PLATFORM_OFF, canUseFeature, type AppContext, type PlatformState } from '../lib/appPolicy';
import { parsePermissions, type PermMap } from '../lib/permissions';
import { useStore } from './store';

/** Что отдаёт `GET /api/me/bootstrap`. */
export interface PolicyBootstrap {
  platform?: Partial<PlatformState> | null;
  /** Личные права — уже без чужих кодов платформы, если доступа нет */
  permissions?: string | PermMap | null;
  rolePermissions?: string | PermMap | null;
  policyVersion?: number;
}

interface PolicyState {
  platform: PlatformState;
  /** null — сервер ещё не отвечал, действует копия из входа */
  permissions: PermMap | null;
  rolePermissions: PermMap | null;
  version: number;
  loaded: boolean;
  apply: (b: PolicyBootstrap) => void;
  reset: () => void;
  refresh: () => Promise<void>;
}

const readPlatform = (raw: Partial<PlatformState> | null | undefined): PlatformState => ({
  enabled: !!raw?.enabled,
  supported: !!raw?.supported,
  maintenance: !!raw?.maintenance,
  version: Number(raw?.version) || 0,
  note: String(raw?.note || ''),
});

export const usePolicyStore = create<PolicyState>((set, get) => ({
  platform: PLATFORM_OFF,
  permissions: null,
  rolePermissions: null,
  version: 0,
  loaded: false,

  apply: (b) => set({
    platform: readPlatform(b?.platform),
    permissions: b?.permissions == null ? null : parsePermissions(b.permissions),
    rolePermissions: b?.rolePermissions == null ? null : parsePermissions(b.rolePermissions),
    version: Number(b?.policyVersion) || 0,
    loaded: true,
  }),

  // Выход и смена базы: прежний доступ к новой сессии отношения не имеет.
  // Умолчание — «платформы нет», а не «была и осталась»
  reset: () => set({
    platform: PLATFORM_OFF, permissions: null, rolePermissions: null, version: 0, loaded: false,
  }),

  refresh: async () => {
    try {
      const { fetchPolicyBootstrap } = await import('../services/policyService');
      const b = await fetchPolicyBootstrap();
      get().apply(b);
    } catch (_) {
      // Сервер не ответил — оставляем как было. Обнулять доступ по сетевой
      // неудаче нельзя: раздел закрылся бы посреди работы от одного обрыва
    }
  },
}));

/**
 * Контекст решения: профиль плюс общее состояние платформы.
 *
 * Права берутся свежие, если сервер их присылал, и из профиля, пока не
 * присылал. Так первый кадр после входа уже знает ответ и не мигает разделом,
 * которого человек видеть не должен.
 */
export function useAppContext(): AppContext {
  const user = useStore((s) => s.user);
  const platform = usePolicyStore((s) => s.platform);
  const permissions = usePolicyStore((s) => s.permissions);
  const rolePermissions = usePolicyStore((s) => s.rolePermissions);
  return React.useMemo<AppContext>(() => ({
    user: user
      ? {
        ...(user as any),
        permissions: permissions ?? (user as any).permissions ?? null,
        rolePermissions: rolePermissions ?? (user as any).rolePermissions ?? null,
      }
      : null,
    platform,
  }), [user, platform, permissions, rolePermissions]);
}

/** Тот же контекст вне React — для обработчиков и хранилищ. */
export function appContext(): AppContext {
  const user = useStore.getState().user as any;
  const { platform, permissions, rolePermissions } = usePolicyStore.getState();
  return {
    user: user
      ? {
        ...user,
        permissions: permissions ?? user.permissions ?? null,
        rolePermissions: rolePermissions ?? user.rolePermissions ?? null,
      }
      : null,
    platform,
  };
}

/**
 * Одно готовое «можно ли» для чистых модулей.
 *
 * Руководство, демонстрации помощника и справка по разделу написаны без
 * React и без хранилищ — и правильно: их проверяют скриптами. Решение им
 * передаётся предикатом, а не импортом состояния, и берётся он отсюда, чтобы
 * правило осталось одно на всю программу.
 */
export const allowEntitlement = (key: string): boolean => canUseFeature(appContext(), key);
