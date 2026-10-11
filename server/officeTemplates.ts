import { randomUUID } from 'node:crypto';
import type { OfficeHeaderSchema, OfficePart } from '../src/lib/officeModel.js';

export interface OfficeHeaderTemplate {
  id: string;
  name: string;
  description: string;
  scope: 'PERSONAL' | 'SHARED';
  ownerId: string | null;
  createdById: string;
  schema: OfficeHeaderSchema;
  query: Record<string, unknown>;
  updatedAt: string;
}

export const OFFICE_TEMPLATE_KEY = 'flux_office_header_templates_v1';
export const OFFICE_TEMPLATE_PINS_KEY = 'flux_office_header_template_pins_v1';

function cleanBinding(value: any): any | null {
  if (!value || typeof value.fieldKey !== 'string' || typeof value.sourceId !== 'string' || typeof value.entityType !== 'string') return null;
  if (value.entityId !== null && value.entityId !== undefined) return null;
  return {
    fieldKey: value.fieldKey.slice(0, 200), sourceId: value.sourceId.slice(0, 120), entityType: value.entityType.slice(0, 80),
    entityId: null, sourceRevision: String(value.sourceRevision || '').slice(0, 120),
    ...(value.unit ? { unit: String(value.unit).slice(0, 80) } : {}), anchorId: String(value.anchorId || '').slice(0, 120),
  };
}

function cleanPart(part: any): OfficePart | null {
  if (part?.kind === 'text') return typeof part.text === 'string' ? { kind: 'text', text: part.text.slice(0, 2000) } : null;
  if (part?.kind === 'operator' && ['+', '-', '*', '/', '(', ')'].includes(part.operator)) return { kind: 'operator', operator: part.operator };
  if (part?.kind === 'field') {
    const binding = cleanBinding(part.binding);
    return binding ? { kind: 'field', binding } : null;
  }
  if (part?.kind === 'union' && part.mode === 'first-match' && Array.isArray(part.alternatives) && part.alternatives.length > 0 && part.alternatives.length <= 30) {
    const alternatives = part.alternatives.map((item: any) => ({ ...cleanBinding(item), priority: Math.max(0, Math.min(10000, Number(item?.priority) || 0)) }));
    if (alternatives.some((item: any) => !item.fieldKey)) return null;
    return { kind: 'union', mode: 'first-match', alternatives };
  }
  return null;
}

/** Сохраняет только схему шапки и выборку, без данных заполненных строк. */
export function cleanOfficeTemplate(input: any, actorId: string, existing?: OfficeHeaderTemplate): OfficeHeaderTemplate {
  const name = String(input?.name || '').trim().slice(0, 120);
  if (!name) throw new Error('Укажите имя шаблона');
  const schema = input?.schema;
  if (!schema || schema.version !== 1 || !Array.isArray(schema.anchors) || schema.anchors.length > 1000) throw new Error('Схема шапки не поддерживается');
  const anchors = schema.anchors.map((anchor: any) => {
    if (!anchor || typeof anchor.id !== 'string' || !anchor.id || !['word-row', 'excel-range'].includes(anchor.kind) || !Array.isArray(anchor.parts)) throw new Error('Якорь шапки повреждён');
    if (anchor.parts.length > 200) throw new Error('В одной ячейке слишком много меток');
    const parts = anchor.parts.map(cleanPart);
    if (parts.some((part: OfficePart | null) => !part)) throw new Error('В шапке есть неизвестная метка или команда');
    return { kind: anchor.kind, id: anchor.id.slice(0, 120), ...(anchor.documentPart ? { documentPart: String(anchor.documentPart).slice(0, 200) } : {}), ...(anchor.sheetName ? { sheetName: String(anchor.sheetName).slice(0, 120) } : {}), ...(anchor.address ? { address: String(anchor.address).slice(0, 100) } : {}), parts };
  });
  if (new Set(anchors.map((anchor: any) => anchor.id)).size !== anchors.length) throw new Error('В схеме повторяется ID якоря');
  const query = input?.query && typeof input.query === 'object' ? {
    entity: input.query.entity === 'element' ? 'element' : 'tag',
    columns: Array.isArray(input.query.columns) ? input.query.columns.map(String).slice(0, 200) : [],
    filters: Array.isArray(input.query.filters) ? input.query.filters.slice(0, 50).map((filter: any) => ({ field: String(filter?.field || '').slice(0, 200), op: String(filter?.op || 'contains').slice(0, 30), value: String(filter?.value ?? '').slice(0, 500) })) : [],
    sort: Array.isArray(input.query.sort) ? input.query.sort.slice(0, 10).map((sort: any) => ({ field: String(sort?.field || '').slice(0, 200), direction: sort?.direction === 'desc' ? 'desc' : 'asc' })) : [],
    excludedEntityIds: Array.isArray(input.query.excludedEntityIds) ? [...new Set(input.query.excludedEntityIds.map(String))].slice(0, 5000) : [],
  } : {};
  const scope = existing?.scope || (input?.scope === 'SHARED' ? 'SHARED' : 'PERSONAL');
  return {
    id: existing?.id || randomUUID(), name, description: String(input?.description || '').trim().slice(0, 500), scope,
    ownerId: scope === 'PERSONAL' ? existing?.ownerId || actorId : null,
    createdById: existing?.createdById || actorId, schema: { version: 1, anchors }, query,
    updatedAt: new Date().toISOString(),
  };
}

export function parseOfficeTemplates(raw: string | null | undefined): OfficeHeaderTemplate[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item) => item && typeof item.id === 'string' && item.schema?.version === 1) : [];
  } catch { return []; }
}
