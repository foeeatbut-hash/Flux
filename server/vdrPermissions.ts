/**
 * Права на маршруты ВДР: одна таблица, которой пользуется server.ts и проверка.
 *
 * Меняет данные реестра — право `vdr.manage`; стандарты документооборота —
 * отдельное `vdr.standards` (для всей компании, рискованное). Читать реестр
 * может участник проекта: это проверяет общий страж проектов
 * (`projectEntityAccess.ts`) по реестру или строке из адреса, а не право.
 * Удаление реестров и строк — `vdr.delete` (вместе с `vdr.manage`); админ проходит всегда.
 * Порядок важен: частное правило раньше общего.
 */

export interface VdrPermRule { method: RegExp; path: RegExp; perm: string; title: string; also?: { perm: string; title: string }[] }

export const VDR_PERM_RULES: VdrPermRule[] = [
  { method: /^(POST|PUT|DELETE|PATCH)$/, path: /^\/api\/vdr\/standards/, perm: 'vdr.standards', title: 'Стандарты документооборота' },
  // Удаление реестров и строк — отдельное право (решение владельца 4.11.2026):
  // администратору оно не нужно, остальным выдаётся явно; вести реестр при этом тоже надо уметь
  { method: /^DELETE$/, path: /^\/api\/vdr\/(registers|items)\//, perm: 'vdr.delete', title: 'Удаление реестров и строк ВДР',
    also: [{ perm: 'vdr.manage', title: 'Реестр ВДР' }] },
  { method: /^(POST|PUT|DELETE|PATCH)$/, path: /^\/api\/vdr\//, perm: 'vdr.manage', title: 'Реестр ВДР' },
];

/** Какое право нужно этому запросу; `null` — только вход и доступ к проекту. */
export function vdrPermissionFor(method: string, route: string): VdrPermRule | null {
  return VDR_PERM_RULES.find(r => r.method.test(method) && r.path.test(route)) || null;
}
