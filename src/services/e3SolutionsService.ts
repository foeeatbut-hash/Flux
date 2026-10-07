import { ENV_CONFIG } from '../config/env';
import type { E3Dictionary, E3Feature, E3FeatureRule, E3Profile, E3Solution, E3SolutionBook, E3SolutionPlan } from '../../e3/solutionTypes';

/** Запись истории каталога: по ней откатывают загрузку */
export interface E3SolutionRevision { id: string; action: 'import' | 'update' | 'restore'; createdAt: string; userId: string; count: number }
/** Профиль проекта: версия своя, не связана с версией каталога */
export interface E3ProfileDoc { version: number; answers: E3Profile; updatedAt: string }
export type E3SolutionPatch = Partial<Omit<E3Solution, 'id' | 'edited'>>;

/** Устаревшую версию (409) окно отличает по типу ошибки: ему нужно перечитать книгу, а не просто показать текст */
export class E3SolutionVersionError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ENV_CONFIG.apiUrl}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new (res.status === 409 ? E3SolutionVersionError : Error)(data.error || `Ошибка ${res.status}`);
  return data;
}

const BASE = '/catalog/e3-solutions';
type Written = { book: E3SolutionBook };

export const e3SolutionsService = {
  load: () => call<E3SolutionBook>('GET', BASE),
  plan: (items: E3Solution[], dictionary: E3Dictionary) => call<E3SolutionPlan>('POST', `${BASE}/plan`, { items, dictionary }),
  apply: (items: E3Solution[], dictionary: E3Dictionary, expectedVersion: number, missing: 'keep' | 'remove') =>
    call<Written & { revisionId: string }>('POST', `${BASE}/apply`, { items, dictionary, expectedVersion, missing }),
  updateSolution: (id: string, patch: E3SolutionPatch, expectedVersion: number) => call<Written>('PUT', `${BASE}/solution`, { id, patch, expectedVersion }),
  createSolution: (id: string, patch: E3SolutionPatch, expectedVersion: number) => call<Written>('PUT', `${BASE}/solution`, { id, patch, create: true, expectedVersion }),
  saveFeature: (feature: E3Feature, expectedVersion: number) => call<Written>('PUT', `${BASE}/feature`, { feature, expectedVersion }),
  deleteFeature: (id: string, expectedVersion: number) => call<Written>('PUT', `${BASE}/feature`, { id, delete: true, expectedVersion }),
  saveRule: (rule: E3FeatureRule, expectedVersion: number) => call<Written>('PUT', `${BASE}/rule`, { rule, expectedVersion }),
  deleteRule: (rule: E3FeatureRule, expectedVersion: number) => call<Written>('PUT', `${BASE}/rule`, { rule, delete: true, expectedVersion }),
  saveDictionary: (dictionary: E3Dictionary, expectedVersion: number) => call<Written>('PUT', `${BASE}/dictionary`, { dictionary, expectedVersion }),
  revisions: () => call<E3SolutionRevision[]>('GET', `${BASE}/revisions`),
  undo: (revisionId: string, expectedVersion: number) => call<Written>('POST', `${BASE}/undo`, { revisionId, expectedVersion }),
  profile: (projectId: string) => call<E3ProfileDoc>('GET', `/projects/${encodeURIComponent(projectId)}/e3-profile`),
  saveProfile: (projectId: string, answers: E3Profile, expectedVersion: number) => call<E3ProfileDoc>('PUT', `/projects/${encodeURIComponent(projectId)}/e3-profile`, { answers, expectedVersion }),
};
