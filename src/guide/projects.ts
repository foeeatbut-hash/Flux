/**
 * Чтение проектных данных для Flux Guide.
 *
 * Все запросы адресные: проект назван явно, фильтры и пагинация считает на
 * сервере, а ключ кэша включает пользователя и проект — ответы одного проекта
 * никогда не показываются в другом (ТЗ §11.1, §21).
 */
import { ENV_CONFIG } from '../config/env';

const BASE = `${ENV_CONFIG.apiUrl}/guide`;

export interface GuideProject { id: string; name: string; code?: string; status?: string; customer?: string }

export interface GuideTag {
  id: string; identifier: string; brand: string | null; department: string | null;
  fluid: string | null; mainName: string; actuality: string;
  stageId: string; stageLabel: string; stageSince: string | null; stageIsFinal: boolean;
  supplier: string; qty: string;
  components: Array<{ id: string; name: string; itemCode: string }>;
}

export interface GuideSpecParam { key: string; value: string; unit: string; group: string }

export interface GuideComponent {
  id: string; name: string; itemCode: string; equipType: string; role: string;
  systemName: string; systemCategory: string; monoblockName: string;
  status: string; hasConflict: boolean;
  tags: Array<{ id: string; identifier: string }>;
  specs: GuideSpecParam[]; specsTotal: number;
}

export interface GuideSummary {
  project: { name: string; code: string; status: string; customer: string };
  counts: {
    tags: number; systems: number; monoblocks: number; components: number;
    componentsNoTag: number; duplicates: number; conflicts: number;
  };
  categories: Array<{ type: string; count: number }>;
  stages: Array<{ id: string; label: string }>;
}

export interface Paged<T> { total: number; items: T[]; truncated?: boolean }

async function get<T>(path: string, _userId: string, signal?: AbortSignal): Promise<T> {
  const url = `${BASE}${path}`;
  // Каждый запрос проходит серверную проверку прав. Локальный кэш мог бы
  // пережить отзыв доступа и показать старые сведения без повторной проверки.
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as any));
    const err = new Error(body?.error || `Сервер недоступен (${res.status})`) as Error & { code?: string; status?: number };
    err.code = body?.code;
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export const guideProjects = (userId: string) =>
  get<{ projects: GuideProject[] }>('/projects', userId);

export const guideSummary = (userId: string, projectId: string, signal?: AbortSignal) =>
  get<GuideSummary>(`/project/${encodeURIComponent(projectId)}/summary`, userId, signal);

export const guideTags = (userId: string, projectId: string, params: Record<string, string | number> = {}, signal?: AbortSignal) => {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  return get<Paged<GuideTag>>(`/project/${encodeURIComponent(projectId)}/tags?${qs}`, userId, signal);
};

export const guideComponents = (userId: string, projectId: string, params: Record<string, string | number> = {}, signal?: AbortSignal) => {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  return get<Paged<GuideComponent>>(`/project/${encodeURIComponent(projectId)}/components?${qs}`, userId, signal);
};

export interface GuideTagLookup {
  status: 'ok' | 'no-match';
  identifier: string;
  tags?: GuideTag[];
  places?: Array<{
    componentId: string; component: string; itemCode: string; equipType: string;
    monoblock: string; system: string; specs: GuideSpecParam[]; specsTotal: number;
  }>;
}

export const guideTagLookup = (userId: string, projectId: string, identifier: string) =>
  get<GuideTagLookup>(`/project/${encodeURIComponent(projectId)}/tag/${encodeURIComponent(identifier)}`, userId);

export interface GuideSpecRow {
  componentId: string; name: string; itemCode: string; equipType: string; system: string;
  tags: string[]; field: string; value: string; unit: string; group: string; specsTotal: number;
}

export const guideSpec = (userId: string, projectId: string, field: string, params: Record<string, string | number> = {}, signal?: AbortSignal) => {
  const qs = new URLSearchParams({ field, ...Object.entries(params).map(([k, v]) => [k, String(v)]) });
  return get<Paged<GuideSpecRow>>(`/project/${encodeURIComponent(projectId)}/spec?${qs}`, userId, signal);
};

export interface GuideRevisionRow {
  componentId: string; name: string; itemCode: string; equipType: string; system: string;
  monoblock: string; tags: string[]; hasConflict: boolean;
  conflicts: Array<{ group: string; key: string; oldValue: string; newValue: string; unit: string }>;
  revisions: Array<{ id: string; version: number; changedAt: string; changeType: string; changes: Array<{ key: string; group: string; old: string; new: string }> }>;
}

export const guideRevisions = (userId: string, projectId: string, params: Record<string, string | number> = {}) => {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  return get<Paged<GuideRevisionRow>>(`/project/${encodeURIComponent(projectId)}/revisions?${qs}`, userId);
};

export interface GuideFileRow {
  id: string; name: string; folder: string; size: number; revision: string;
  statusCode: string; updatedAt: string; mainTags: string[]; additionalTags: string[];
}

export const guideFiles = (userId: string, projectId: string, params: Record<string, string | number> = {}) => {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  return get<Paged<GuideFileRow>>(`/project/${encodeURIComponent(projectId)}/files?${qs}`, userId);
};

// ── История вопросов Guide (серверное хранение, ТЗ v3 §4) ──

export interface GuideChatInfo { id: string; projectId: string; title: string; preview: string; updatedAt: string; archivedAt?: string | null }

export const guideChats = (userId: string, options: { q?: string; archived?: boolean } = {}) => {
  const qs = new URLSearchParams({ q: options.q || '', archived: options.archived ? '1' : '0' });
  return get<{ chats: GuideChatInfo[] }>(`/chats?${qs}`, userId).then((r) => r.chats);
};

export const guideChatOpen = (userId: string, id: string) =>
  get<{ chat: { id: string; projectId: string; title: string; messages: unknown[] } }>(`/chats/${encodeURIComponent(id)}`, userId);

export const guideChatSave = (userId: string, id: string, data: { title: string; projectId: string; messages: unknown[] }) =>
  put(`/chats/${encodeURIComponent(id)}`, userId, data);

export const guideChatArchive = (userId: string, id: string) =>
  post(`/chats/${encodeURIComponent(id)}/archive`, userId);

export const guideChatRestore = (userId: string, id: string) =>
  post(`/chats/${encodeURIComponent(id)}/restore`, userId);

async function put(path: string, userId: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({} as any));
    const err = new Error(payload?.error || `Сервер недоступен (${res.status})`) as Error & { code?: string; status?: number };
    err.code = payload?.code;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function post(path: string, userId: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST' });
  if (!res.ok) throw new Error(`Сервер недоступен (${res.status})`);
}
