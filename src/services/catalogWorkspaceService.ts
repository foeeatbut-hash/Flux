import { ENV_CONFIG } from '../config/env';
import type { CatalogDraft, CatalogGrant, CatalogWorkspace } from '../../catalog/publication';
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ENV_CONFIG.apiUrl}/catalog/${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`); return data;
}
export const catalogWorkspaceService = {
  load: () => call<CatalogWorkspace>('GET', 'workspace'),
  publish: (drafts: CatalogDraft[]) => call<{ publication: number; count: number }>('POST', 'workspace/publish', { selections: drafts.map(({ entity, id, revision }) => ({ entity, id, revision })) }),
  discard: (draft: CatalogDraft) => call('POST', 'workspace/discard', draft),
  approve: (draft: CatalogDraft) => call('POST', 'workspace/approve', draft),
  setPolicy: (requireSecondReview: boolean) => call('PUT', 'policy', { requireSecondReview }),
  review: (draft: CatalogDraft) => call('POST', 'workspace/review', draft),
  access: () => call<{ grants: CatalogGrant[]; version: string; users: Array<{ id: string; name: string; role: string }> }>('GET', 'access'),
  setAccess: (grants: CatalogGrant[], version: string) => call<{ ok: boolean; version?: string }>('PUT', 'access', { grants, version }),
};
