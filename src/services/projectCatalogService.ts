import { ENV_CONFIG } from '../config/env';
import type { Catalog, Family } from '../../catalog/model';
import type { CatalogDifference } from '../../shared/catalogProject';

export type ProjectCatalogSource = 'project' | 'common' | 'effective';
export type ProjectCatalogOperation = 'take' | 'create' | 'edit' | 'reset' | 'update';
export interface ProjectCatalogRow { id: string; code: string; basedOnFamilyId: string | null; basedOnRevision: string | null; revision: string; overrides: CatalogDifference[]; updateAvailable: boolean }
export interface ProjectCatalogView extends Catalog { meta: Record<string, unknown>; rows: ProjectCatalogRow[]; canEdit: boolean; lastPlanId: string | null }
export interface ProjectCatalogPlan { id: string; operation: ProjectCatalogOperation; rows: Array<{ id: string; code: string; before: Family | null; after: Family | null; differences: CatalogDifference[]; conflicts: unknown[]; action: string }>; expiresAt: string }
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${ENV_CONFIG.apiUrl}/catalog/project${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
  return data;
}
export const projectCatalogService = {
  load: (projectId: string, source: ProjectCatalogSource) => call<ProjectCatalogView>('GET', `?${new URLSearchParams({ projectId, source })}`),
  plan: (body: { projectId: string; operation: ProjectCatalogOperation; familyId?: string; expectedRevision?: string; document?: Family }) => call<ProjectCatalogPlan>('POST', '/plan', body),
  apply: (projectId: string, planId: string) => call<ProjectCatalogView>('POST', '/apply', { projectId, planId }),
  undo: (projectId: string, planId: string) => call<ProjectCatalogView>('POST', '/undo', { projectId, planId }),
};
