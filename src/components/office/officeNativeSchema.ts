import type { OfficeAnchorRow } from './fluxData';
import type { OfficeHeaderSchema, OfficePart } from '../../lib/officeModel';

export interface HeaderSchemaSyncOptions {
  captureNative?: boolean;
  rows?: OfficeAnchorRow[];
  displayLabels?: Record<string, string>;
  removedAnchorIds?: string[];
}

/** Ответ редактора меняет только привязанные ячейки; остальные якоря сохраняем. */
export function schemaFromNativeHeaders(schema: OfficeHeaderSchema, response: any): OfficeHeaderSchema {
  if (!response?.ok) throw new Error(response?.error || 'Редактор не подтвердил схему заголовков.');
  const headers = new Map<string, any>((Array.isArray(response.headers) ? response.headers : []).map((header: any) => [String(header.anchorId), header]));
  return { ...schema, anchors: schema.anchors.map((anchor) => {
    const header = headers.get(anchor.id);
    if (!header || !Array.isArray(header.parts)) return anchor;
    const parts: OfficePart[] = header.parts.map((part: any) => {
      if (part?.kind === 'text' && typeof part.text === 'string') return { kind: 'text', text: part.text };
      if (part?.kind === 'operator' && ['+', '-', '*', '/', '(', ')'].includes(part.operator)) return { kind: 'operator', operator: part.operator };
      if (part?.kind === 'field' && part.binding?.anchorId === anchor.id && typeof part.binding?.sourceId === 'string' && typeof part.binding?.fieldKey === 'string') return { kind: 'field', binding: part.binding };
      if (part?.kind === 'union' && part.mode === 'first-match' && Array.isArray(part.alternatives) && part.alternatives.length && part.alternatives.every((item: any) => item.anchorId === anchor.id)) return { kind: 'union', mode: 'first-match', alternatives: part.alternatives, ...(typeof part.label === 'string' ? { label: part.label } : {}) };
      throw new Error('Редактор вернул поле без подтверждённой привязки. Обновите схему.');
    });
    return { ...anchor, parts };
  }) };
}
