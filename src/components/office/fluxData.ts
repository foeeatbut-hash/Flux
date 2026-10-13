/** Реальные REST-контракты Flux Office; синтетические поля и демо-ревизии здесь запрещены. */
export type OfficeEntityType = 'tag' | 'element' | 'procurement' | 'vdr' | 'e3';

export interface OfficeField {
  fieldKey: string;
  sourceId: string;
  entityType: OfficeEntityType;
  displayName: string;
  unit?: string;
  kind?: 'text' | 'number';
}

export interface OfficeQueryFilter {
  fieldKey: string;
  op: 'contains' | 'equals' | 'notEquals' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'notEmpty';
  value?: string;
}

export interface OfficeQuerySort { fieldKey: string; direction: 'asc' | 'desc' }
export interface OfficeQuery {
  projectId: string;
  sourceRevision?: string;
  sources: string[];
  types: string[];
  filters: OfficeQueryFilter[];
  sort: OfficeQuerySort[];
  excludedEntityIds: string[];
  limit: number;
  cursor?: string;
  /** Колонки запроса нужны только текущему project-data executor. */
  columns?: string[];
}

export interface OfficeValue { value: string | number | null; unit?: string; revision?: string }
export interface OfficeQueryRow {
  entityId: string;
  entityType: OfficeEntityType;
  sourceId: string;
  tag?: string;
  values: Record<string, OfficeValue>;
}

export interface OfficeQueryResult {
  revision: string;
  total: number;
  rows: OfficeQueryRow[];
  nextCursor?: string;
  fields?: OfficeField[];
}

export interface OfficeFillPlan {
  planId: string;
  baseHash: string;
  sourceRevision: string;
  selectedEntityIds: string[];
  writes: Array<{ entityId: string; anchorId: string; value: string | number; unit?: string }>;
  adds: string[];
  replaces: string[];
  manualRows: string[];
  skips: Array<{ entityId: string; anchorId: string; reason: string }>;
  errors: Array<{ entityId: string; anchorId: string; message: string }>;
  conflicts: Array<{ entityId: string; anchorId: string; candidates: string[] }>;
}

export interface OfficeTemplate {
  id: string;
  name: string;
  description?: string;
  scope: 'PERSONAL' | 'SHARED';
  ownerId: string | null;
  /** Создатель: только он правит и удаляет общий шаблон. */
  createdById?: string;
  pinned?: boolean;
  schema: unknown;
  query: Record<string, unknown>;
  updatedAt: string;
}

/** Шаблон, применённый к файлу: снимок его схемы на момент применения (для «Исходной шапки»). */
export interface OfficeAppliedTemplate {
  templateId: string;
  name?: string;
  appliedAt: string;
  schema: import('../../lib/officeModel').OfficeHeaderSchema;
}
/** Что записать в часть Flux вместе со схемой: шаблон применён (снимок берётся с записываемой схемы) или связь снята. */
export type OfficeTemplateLink = { templateId: string; name?: string } | null;

export interface OfficeState {
  baseHash: string;
  schema: import('../../lib/officeModel').OfficeHeaderSchema;
  /** Есть, если к файлу применяли шаблон; одного последнего. */
  template?: OfficeAppliedTemplate;
  sourceRevision: string;
  rows?: OfficeAnchorRow[];
}

export interface OfficeAnchorRow {
  entityId: string;
  entityType: string;
  sourceId: string;
  sourceRevision: string;
  anchorIds: string[];
  cells?: Record<string, string>;
  values?: Record<string, string | number | null>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(data?.error || `Сервер ответил ${response.status}`));
  return data as T;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function toProjectQuery(query: OfficeQuery): Record<string, unknown> {
  const source = query.sources[0];
  if (!['equipment', 'tags', 'management', 'e3flux'].includes(source)) throw new Error(`Источник «${source || 'не выбран'}» пока не поддерживается в запросе Office`);
  return {
    entity: ({ equipment: 'element', tags: 'tag', management: query.types.includes('vdr') ? 'vdr' : 'procurement', e3flux: 'e3' } as Record<string, string>)[source],
    columns: query.columns || [],
    filters: query.filters.map((filter) => ({
      field: filter.fieldKey,
      op: ({ equals: 'eq', notEquals: 'neq', notEmpty: 'nempty' } as Record<string, string>)[filter.op] || filter.op,
      value: filter.value,
    })).concat(query.sources[0] === 'equipment' && query.types.length ? [{ field: 'equipType', op: 'in', value: query.types.join('|') }] : []),
    sort: query.sort.map((item) => ({ field: item.fieldKey, dir: item.direction })),
    excludedEntityIds: query.excludedEntityIds,
    limit: query.limit,
  };
}

/**
 * Откуда берётся файл. Строка — файл на сервере (fileId). Локальный источник —
 * файл Проводника: сервер получает его содержимое в запросе, ничего не хранит
 * и записи не делает; новые байты записывает сам редактор (ТЗ §17).
 */
export interface OfficeLocalSource {
  kind: 'local';
  /** Проект, чьи права и данные применяются к файлу. */
  projectId: () => string;
  /** Содержимое файла, как оно записано сейчас (base64). */
  base64: () => string;
}
export type OfficeFileSource = string | OfficeLocalSource;
export const isLocalSource = (source: OfficeFileSource): source is OfficeLocalSource => typeof source !== 'string';

const LOCAL = '/api/project-data/office-local';
const fileRoute = (source: string, tail: string) => `/api/project-data/files/${encodeURIComponent(source)}/${tail}`;
const withContent = <T extends object>(source: OfficeLocalSource, body: T) => ({ ...body, projectId: source.projectId(), base64: source.base64() });

export interface OfficeStateWritten { ok: true; baseHash: string; schemaVersion: number; anchorCount: number; /** Только у локального источника: байты, которые должен записать вызывающий. */ base64?: string }

export const officeDataApi = {
  catalog: async (projectId: string) => {
    const extra = await request<Record<string, unknown>>(`/api/project-data/office/catalog?projectId=${encodeURIComponent(projectId)}`);
    const base = await request<Record<string, unknown>>(`/api/project-data/catalog?projectId=${encodeURIComponent(projectId)}`);
    return { ...base, ...extra };
  },
  query: (query: OfficeQuery) => request<OfficeQueryResult>('/api/project-data/office/query', json({
    projectId: query.projectId,
    sourceRevision: query.sourceRevision,
    query: toProjectQuery(query),
  })),
  state: (source: OfficeFileSource) => isLocalSource(source)
    ? request<OfficeState>(`${LOCAL}/state`, json(withContent(source, {})))
    : request<OfficeState>(fileRoute(source, 'office-state')),
  updateState: (source: OfficeFileSource, body: { baseHash: string; sourceRevision: string; schema: OfficeState['schema']; rows?: OfficeAnchorRow[]; template?: OfficeTemplateLink }) => isLocalSource(source)
    ? request<OfficeStateWritten>(`${LOCAL}/write-state`, json(withContent(source, body)))
    : request<OfficeStateWritten>(fileRoute(source, 'office-state'), { ...json(body), method: 'PUT' }),
  preview: (source: OfficeFileSource, body: { projectId: string; baseHash: string; sourceRevision: string; selectedEntityIds: string[]; query: Record<string, unknown>; schema: OfficeState['schema'] }) => isLocalSource(source)
    ? request<OfficeFillPlan>(`${LOCAL}/preview`, json(withContent(source, body)))
    : request<OfficeFillPlan>(fileRoute(source, 'preview'), json(body)),
  confirm: (source: OfficeFileSource, body: { projectId: string; planId: string; baseHash: string; sourceRevision: string; selectedEntityIds: string[]; query: Record<string, unknown>; schema: OfficeState['schema'] }) => isLocalSource(source)
    ? request<{ writes: OfficeFillPlan['writes']; status: 'ready-for-editor' }>(`${LOCAL}/confirm`, json(withContent(source, body)))
    : request<{ writes: OfficeFillPlan['writes']; status: 'ready-for-editor' }>(fileRoute(source, 'confirm'), json(body)),
  templates: () => request<{ templates: OfficeTemplate[]; pinned: string[] }>('/api/project-data/office/templates'),
  saveTemplate: (body: { name: string; description?: string; scope: OfficeTemplate['scope']; schema: OfficeState['schema']; query: Record<string, unknown> }) =>
    request<{ template: OfficeTemplate }>('/api/project-data/office/templates', json(body)),
  updateTemplate: (id: string, body: Partial<Pick<OfficeTemplate, 'name' | 'description' | 'scope' | 'schema' | 'query'>>) =>
    request<{ template: OfficeTemplate }>(`/api/project-data/office/templates/${encodeURIComponent(id)}`, { ...json(body), method: 'PUT' }),
  deleteTemplate: (id: string) => request<{ ok: true }>(`/api/project-data/office/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  pinTemplate: (id: string, pinned: boolean) => request<{ pinned: string[] }>(`/api/project-data/office/templates/${encodeURIComponent(id)}/pin`, json({ pinned })),
};

/** Приводит только реально выданные каталогом поля к общему UI-контракту. */
export function fieldsFromCatalog(catalog: Record<string, any>): OfficeField[] {
  const fields: OfficeField[] = [];
  for (const field of catalog.tagFields || []) fields.push({ fieldKey: String(field.path), sourceId: 'tags', entityType: 'tag', displayName: String(field.title || field.path), kind: 'text' });
  for (const field of catalog.elementFields || []) fields.push({ fieldKey: String(field.path), sourceId: 'equipment', entityType: 'element', displayName: String(field.title || field.path), kind: 'text' });
  for (const param of catalog.params || []) fields.push({ fieldKey: `param:${param.group}|${param.key}`, sourceId: 'equipment', entityType: 'element', displayName: `${param.group} · ${param.key}`, unit: param.unit || undefined, kind: 'number' });
  for (const field of catalog.aliases || []) fields.push({ fieldKey: String(field.path), sourceId: 'equipment', entityType: 'element', displayName: String(field.title || field.path), unit: field.unit || undefined, kind: 'number' });
  for (const field of catalog.metaKeys || []) fields.push({ fieldKey: `meta:${field.key}`, sourceId: 'tags', entityType: 'tag', displayName: String(field.key), kind: 'text' });
  for (const sourceId of ['management', 'e3flux']) {
    for (const field of catalog[`${sourceId}Fields`] || []) fields.push({ fieldKey: String(field.path), sourceId, entityType: field.entityType, displayName: String(field.title || field.path), kind: field.kind, unit: field.unit });
  }
  return fields;
}
