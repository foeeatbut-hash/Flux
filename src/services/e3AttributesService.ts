import { ENV_CONFIG } from '../config/env';
import type { E3Attribute, E3AttributeBook, E3Plan } from '../../e3/attributes';

/** Запись истории справочника: по ней откатывают загрузку */
export interface E3Revision { id: string; action: 'import' | 'update' | 'restore'; createdAt: string; userId: string; count: number }
export type E3ItemPatch = Partial<Pick<E3Attribute, 'fromFlux' | 'source' | 'sourceByClass' | 'classes' | 'conflict' | 'title'>>;

/** Устаревшую версию (409) окно отличает по типу ошибки: ему нужно перечитать книгу, а не просто показать текст */
export class E3VersionError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ENV_CONFIG.apiUrl}/catalog/e3-attributes${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new (res.status === 409 ? E3VersionError : Error)(data.error || `Ошибка ${res.status}`);
  return data;
}

export interface E3ClassParam { key: string; group: string; name: string; units: { unit: string; count: number }[]; count: number }

export const e3AttributesService = {
  classParams: (cls: string) => call<{ params: E3ClassParam[]; positions: number }>('GET', `/params?class=${encodeURIComponent(cls)}`),
  load: () => call<E3AttributeBook>('GET', ''),
  plan: (items: E3Attribute[]) => call<E3Plan>('POST', '/plan', { items }),
  apply: (items: E3Attribute[], expectedVersion: number, missing: 'keep' | 'remove') =>
    call<{ book: E3AttributeBook; revisionId: string }>('POST', '/apply', { items, expectedVersion, missing }),
  update: (name: string, patch: E3ItemPatch, expectedVersion: number) =>
    call<{ book: E3AttributeBook }>('PUT', '/item', { name, patch, expectedVersion }),
  revisions: () => call<E3Revision[]>('GET', '/revisions'),
  undo: (revisionId: string, expectedVersion: number) => call<{ book: E3AttributeBook }>('POST', '/undo', { revisionId, expectedVersion }),
};
