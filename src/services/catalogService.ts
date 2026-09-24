/**
 * Запросы Каталога и Конструктора.
 *
 * Отдельно от dataService намеренно: тот при обрыве связи молча отвечает
 * заглушкой «автономной базы», а здесь заглушка опасна — пустой каталог вместо
 * настоящего выглядел бы как «подбор ничего не нашёл», а несохранённая правка
 * ведомости — как сохранённая. Ошибка сети здесь всегда ошибка.
 *
 * Токен сессии подставляет общая обёртка fetch (src/config/env.ts).
 */
import { ENV_CONFIG } from '../config/env';
import type { Catalog, Family, Component, TagRule, EquipmentClass, Manufacturer } from '../../catalog/model';
import type { Learned } from '../../catalog/match';
import type { BlankTemplate } from '../../catalog/blank/model';
import type { SelectionItemData, ListHeader, IssueInfo } from '../../catalog/selection';
import type { ColumnMap } from '../../catalog/sheetImport';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ENV_CONFIG.apiUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Нет связи с сервером — изменения не сохранены');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String((data as any)?.error || `Сервер ответил ${res.status}`));
  return data as T;
}

export type CatalogMeta = Record<string, { edited: boolean; seedVersion: number; updatedAt: string; deleted: boolean }>;
export type CatalogEntity = 'family' | 'component' | 'tagRule' | 'class' | 'manufacturer';

export interface SelectionList {
  id: string;
  projectId: string;
  classId: string;
  name: string;
  header: ListHeader;
  orderNos: Record<string, string>;
  templateId: string | null;
  lang: 'ru' | 'en' | 'ru+en';
  items?: number;
  qty?: number;
  updatedAt: string;
}

export interface StoredTemplate {
  id: string;
  name: string;
  classId: string | null;
  scope: 'SHARED' | 'PERSONAL';
  ownerId: string | null;
  isDefault: boolean;
  version: number;
  layout: BlankTemplate;
  updatedAt: string;
}

export interface StoredIssue extends IssueInfo {
  id: string;
  diffText: string;
  fileId: string | null;
  createdAt: string;
  snapshot?: { items: SelectionItemData[]; header: ListHeader };
}

export interface TagLinkPlan {
  blockKey: string;
  identifier: string;
  action: 'link' | 'create' | 'skip' | 'ambiguous' | 'invalid';
  problem?: string;
  fix?: string;
  existingTagId?: string;
  candidates?: Array<{ id: string; identifier: string; why: string }>;
}

export const catalogService = {
  catalog: () => call<Catalog & { meta: CatalogMeta; stamp: string }>('GET', '/catalog'),
  stamp: () => call<{ stamp: string }>('GET', '/catalog/stamp'),
  save: (entity: CatalogEntity, item: Family | Component | TagRule | EquipmentClass | Manufacturer) =>
    call<{ ok: true; id: string }>('PUT', `/catalog/${entity}/${encodeURIComponent(item.id)}`, item),
  remove: (entity: CatalogEntity, id: string) => call<{ ok: true }>('DELETE', `/catalog/${entity}/${encodeURIComponent(id)}`),
  revisions: (entity: CatalogEntity | 'template', id: string) =>
    call<{ revisions: Array<{ id: string; action: string; userId: string | null; createdAt: string }> }>('GET', `/catalog/${entity}/${encodeURIComponent(id)}/revisions`),
  restore: (revisionId: string) => call<{ ok: true }>('POST', `/catalog/revisions/${revisionId}/restore`),
  reseed: (familyId: string) => call<{ ok: true }>('POST', `/catalog/family/${encodeURIComponent(familyId)}/reseed`),
  exportCatalog: () => call<Record<string, unknown>>('GET', '/catalog/export'),
  importCatalog: (file: Record<string, unknown>, mode: 'plan' | 'apply') =>
    call<{ plan: Array<{ entity: string; id: string; code: string; action: 'new' | 'update' | 'same' }>; applied: boolean }>('POST', '/catalog/import', { ...file, mode }),

  learned: (classId?: string) => call<{ learned: Array<Learned & { id: string; classId: string; updatedAt: string }> }>('GET', `/catalog/learn${classId ? `?classId=${encodeURIComponent(classId)}` : ''}`),
  learn: (entry: { classId: string; signature: string; familyId: string; values: Record<string, unknown> }) => call<{ ok: true }>('POST', '/catalog/learn', entry),
  forget: (id: string) => call<{ ok: true }>('DELETE', `/catalog/learn/${id}`),

  templates: () => call<{ templates: StoredTemplate[] }>('GET', '/blank-templates'),
  saveTemplate: (id: string, t: { name: string; layout: BlankTemplate; scope?: 'SHARED' | 'PERSONAL'; classId?: string | null; isDefault?: boolean }) =>
    call<{ ok: true; id: string }>('PUT', `/blank-templates/${encodeURIComponent(id)}`, t),
  removeTemplate: (id: string) => call<{ ok: true }>('DELETE', `/blank-templates/${encodeURIComponent(id)}`),

  profiles: () => call<{ profiles: Array<{ id: string; name: string; signature: string; mapping: { columns: ColumnMap; headerRow: number; sheet?: string }; updatedAt: string }> }>('GET', '/import-profiles'),
  saveProfile: (p: { name: string; signature: string; mapping: { columns: ColumnMap; headerRow: number; sheet?: string } }) => call<{ ok: true }>('POST', '/import-profiles', p),

  lists: (projectId: string) => call<{ lists: SelectionList[] }>('GET', `/builder/lists?projectId=${encodeURIComponent(projectId)}`),
  createList: (l: { projectId: string; classId: string; name: string; header?: ListHeader; templateId?: string | null }) => call<{ list: SelectionList }>('POST', '/builder/lists', l),
  list: (id: string) => call<{ list: SelectionList; items: SelectionItemData[] }>('GET', `/builder/lists/${id}`),
  updateList: (id: string, patch: Partial<Pick<SelectionList, 'name' | 'header' | 'orderNos' | 'templateId' | 'lang'>>) => call<{ list: SelectionList }>('PUT', `/builder/lists/${id}`, patch),
  removeList: (id: string) => call<{ ok: true }>('DELETE', `/builder/lists/${id}`),
  apply: (listId: string, title: string, upserts: Array<Partial<SelectionItemData>>, removeIds: string[] = []) =>
    call<{ batchId: string | null; items: SelectionItemData[]; removed: string[] }>('POST', `/builder/lists/${listId}/apply`, { title, upserts, removeIds }),
  batches: (listId: string) => call<{ batches: Array<{ id: string; title: string; undone: boolean; createdAt: string }> }>('GET', `/builder/lists/${listId}/batches`),
  undo: (batchId: string) => call<{ ok: true; listId: string }>('POST', `/builder/batches/${batchId}/undo`),
  issues: (listId: string, withSnapshots = false) => call<{ issues: StoredIssue[] }>('GET', `/builder/lists/${listId}/issues${withSnapshots ? '?snapshots=1' : ''}`),
  issue: (listId: string, issue: IssueInfo & { diffText?: string; fileId?: string | null }) => call<{ issue: { id: string; rev: string } }>('POST', `/builder/lists/${listId}/issues`, issue),
  tagPlan: (listId: string, extraTags?: Record<string, string[]>) => call<{ links: TagLinkPlan[] }>('POST', `/builder/lists/${listId}/tag-plan`, { extraTags }),
  tagApply: (listId: string, links: TagLinkPlan[]) => call<{ created: number; linked: number }>('POST', `/builder/lists/${listId}/tag-apply`, { links }),
};
