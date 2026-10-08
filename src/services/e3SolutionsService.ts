import { ENV_CONFIG } from '../config/env';
import { notifyE3Changed } from '../lib/e3Changed';
import type { E3Dictionary, E3Feature, E3FeatureRule, E3IoRow, E3IoRule, E3Profile, E3Solution, E3SolutionBook, E3SolutionPlan } from '../../e3/solutionTypes';
import type { E3MissingDefaults } from '../../e3/solutionMissing';

/** Запись истории каталога: по ней откатывают загрузку */
export interface E3SolutionRevision { id: string; action: 'import' | 'update' | 'restore'; createdAt: string; userId: string; count: number }
/** Профиль проекта: версия своя, не связана с версией каталога */
export interface E3ProfileDoc { version: number; answers: E3Profile; updatedAt: string }
/** Раскладка схемы за проектом: где стоят блоки, формат листа и снятые флажки */
export interface E3LayoutDoc { version: number; format: string; placed: Record<string, { rect: { x: number; y: number; w: number; h: number }; manual: boolean }>; off: Record<string, true> }
export type E3SolutionPatch = Partial<Omit<E3Solution, 'id' | 'edited'>>;

/** Устаревшую версию (409) окно отличает по типу ошибки: ему нужно перечитать книгу, а не просто показать текст */
export class E3SolutionVersionError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ENV_CONFIG.apiUrl}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new (res.status === 409 ? E3SolutionVersionError : Error)(data.error || `Ошибка ${res.status}`);
  // Запись — не чтение и не пересчёт плана: только она меняет то, что видит «Нет данных»
  if (method !== 'GET' && !path.endsWith('/plan') && !path.endsWith('/defaults/plan')) notifyE3Changed();
  return data;
}

const BASE = '/catalog/e3-solutions';
type Written = { book: E3SolutionBook };

export const e3SolutionsService = {
  load: () => call<E3SolutionBook>('GET', BASE),
  plan: (items: E3Solution[], dictionary: E3Dictionary, ioTable: E3IoRow[] = []) => call<E3SolutionPlan>('POST', `${BASE}/plan`, { items, dictionary, ioTable }),
  apply: (items: E3Solution[], dictionary: E3Dictionary, expectedVersion: number, missing: 'keep' | 'remove', ioTable: E3IoRow[] = []) =>
    call<Written & { revisionId: string }>('POST', `${BASE}/apply`, { items, dictionary, ioTable, expectedVersion, missing }),
  updateSolution: (id: string, patch: E3SolutionPatch, expectedVersion: number) => call<Written>('PUT', `${BASE}/solution`, { id, patch, expectedVersion }),
  createSolution: (id: string, patch: E3SolutionPatch, expectedVersion: number) => call<Written>('PUT', `${BASE}/solution`, { id, patch, create: true, expectedVersion }),
  saveFeature: (feature: E3Feature, expectedVersion: number) => call<Written>('PUT', `${BASE}/feature`, { feature, expectedVersion }),
  deleteFeature: (id: string, expectedVersion: number) => call<Written>('PUT', `${BASE}/feature`, { id, delete: true, expectedVersion }),
  saveRule: (rule: E3FeatureRule, expectedVersion: number) => call<Written>('PUT', `${BASE}/rule`, { rule, expectedVersion }),
  deleteRule: (rule: E3FeatureRule, expectedVersion: number) => call<Written>('PUT', `${BASE}/rule`, { rule, delete: true, expectedVersion }),
  saveIoRow: (row: E3IoRow, expectedVersion: number) => call<Written>('PUT', `${BASE}/io-row`, { row, expectedVersion }),
  createIoRow: (row: E3IoRow, expectedVersion: number) => call<Written>('PUT', `${BASE}/io-row`, { row, create: true, expectedVersion }),
  deleteIoRow: (id: string, expectedVersion: number) => call<Written>('PUT', `${BASE}/io-row`, { id, delete: true, expectedVersion }),
  saveIoRule: (rule: E3IoRule, expectedVersion: number) => call<Written>('PUT', `${BASE}/io-rule`, { rule, expectedVersion }),
  createIoRule: (rule: E3IoRule, expectedVersion: number) => call<Written>('PUT', `${BASE}/io-rule`, { rule, create: true, expectedVersion }),
  deleteIoRule: (id: string, expectedVersion: number) => call<Written>('PUT', `${BASE}/io-rule`, { id, delete: true, expectedVersion }),
  missingDefaults: () => call<E3MissingDefaults>('POST', `${BASE}/defaults/plan`, {}),
  applyMissingDefaults: (expectedVersion: number) => call<Written>('POST', `${BASE}/defaults/apply`, { expectedVersion }),
  saveDictionary: (dictionary: E3Dictionary, expectedVersion: number) => call<Written>('PUT', `${BASE}/dictionary`, { dictionary, expectedVersion }),
  saveClassMap: (classMap: Record<string, string[]>, expectedVersion: number) => call<Written>('PUT', `${BASE}/classmap`, { classMap, expectedVersion }),
  layout: (projectId: string) => call<E3LayoutDoc>('GET', `/projects/${encodeURIComponent(projectId)}/e3-layout`),
  saveLayout: (projectId: string, doc: Omit<E3LayoutDoc, 'version'>, expectedVersion: number) => call<E3LayoutDoc>('PUT', `/projects/${encodeURIComponent(projectId)}/e3-layout`, { ...doc, expectedVersion }),
  revisions: () => call<E3SolutionRevision[]>('GET', `${BASE}/revisions`),
  undo: (revisionId: string, expectedVersion: number) => call<Written>('POST', `${BASE}/undo`, { revisionId, expectedVersion }),
  profile: (projectId: string) => call<E3ProfileDoc>('GET', `/projects/${encodeURIComponent(projectId)}/e3-profile`),
  saveProfile: (projectId: string, answers: E3Profile, expectedVersion: number) => call<E3ProfileDoc>('PUT', `/projects/${encodeURIComponent(projectId)}/e3-profile`, { answers, expectedVersion }),
};
