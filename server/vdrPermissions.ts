/**
 * Права на маршруты ВДР: одна таблица, которой пользуется server.ts и проверка.
 *
 * Меняет данные реестра — право `vdr.manage`; стандарты документооборота —
 * отдельное `vdr.standards` (для всей компании, рискованное). Читать реестр
 * может участник проекта: это проверяет общий страж проектов
 * (`projectEntityAccess.ts`) по реестру или строке из адреса, а не право.
 * Порядок важен: частное правило раньше общего.
 */

export interface VdrPermRule { method: RegExp; path: RegExp; perm: string; title: string }

export const VDR_PERM_RULES: VdrPermRule[] = [
  { method: /^(POST|PUT|DELETE|PATCH)$/, path: /^\/api\/vdr\/standards/, perm: 'vdr.standards', title: 'Стандарты документооборота' },
  { method: /^(POST|PUT|DELETE|PATCH)$/, path: /^\/api\/vdr\//, perm: 'vdr.manage', title: 'Реестр ВДР' },
];

/** Какое право нужно этому запросу; `null` — только вход и доступ к проекту. */
export function vdrPermissionFor(method: string, route: string): VdrPermRule | null {
  return VDR_PERM_RULES.find(r => r.method.test(method) && r.path.test(route)) || null;
}
