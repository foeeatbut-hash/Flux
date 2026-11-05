/** Общие права ДО на старых адресах ВДР: совместимость URL не обходит защиту. */
export interface VdrPermRule {
  method: RegExp; path: RegExp; perm: string; title: string;
  also?: { perm: string; title: string }[];
}
const view = { perm: 'docflow.view', title: 'Просмотр документооборота' };
export const VDR_PERM_RULES: VdrPermRule[] = [
  { method: /^(POST|PUT|DELETE|PATCH)$/, path: /^\/api\/vdr\/standards/,
    perm: 'docflow.settings', title: 'Настройки документооборота', also: [view] },
  { method: /^DELETE$/, path: /^\/api\/vdr\/(registers|items)\//,
    perm: 'docflow.delete', title: 'Удаление реестров и строк ВДР',
    also: [view, { perm: 'docflow.edit', title: 'Правка реестра ВДР' }] },
  // Выдача ревизии — отдельная ответственность, правка полей её не разрешает.
  { method: /^POST$/, path: /^\/api\/vdr\/(?:items\/[^/]+\/(?:issue-revision|revision-up)|registers\/[^/]+\/revision-up)\/?$/,
    perm: 'docflow.issue', title: 'Выпуск документов', also: [view] },
  { method: /^(POST|PUT|DELETE|PATCH)$/, path: /^\/api\/vdr\//,
    perm: 'docflow.edit', title: 'Реестр ВДР', also: [view] },
  { method: /^GET$/, path: /^\/api\/vdr\//, ...view },
];
export function vdrPermissionFor(method: string, route: string): VdrPermRule | null {
  return VDR_PERM_RULES.find(rule => rule.method.test(method) && rule.path.test(route)) || null;
}
