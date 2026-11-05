export function moduleHref(id: string, context?: { entry?: string; entityId?: string; projectId?: string }): string {
  const params = new URLSearchParams();
  if (context?.entry) params.set('entry', context.entry);
  if (context?.entityId) params.set('entityId', context.entityId);
  if (context?.projectId) params.set('projectId', context.projectId);
  return `/module/${encodeURIComponent(id)}${params.size ? `?${params}` : ''}`;
}
