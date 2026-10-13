import type { OfficeAnchorRow, OfficeTemplateLink } from './fluxData';
import type { OfficeHeaderSchema, OfficePart } from '../../lib/officeModel';

export interface HeaderSchemaSyncOptions {
  captureNative?: boolean;
  rows?: OfficeAnchorRow[];
  displayLabels?: Record<string, string>;
  removedAnchorIds?: string[];
  /** Только для файла: шаблон применён (снимок схемы) или связь снята; редактору не уходит. */
  template?: OfficeTemplateLink;
  /** Схема уже совпадает с ячейками (прочитана из них): документ не перезаписываем, только храним схему */
  storeOnly?: boolean;
}

/** Ответ редактора меняет только привязанные ячейки; остальные якоря сохраняем. */
export function schemaFromNativeHeaders(schema: OfficeHeaderSchema, response: any): OfficeHeaderSchema {
  if (!response?.ok) throw new Error(response?.error || 'Редактор не подтвердил схему заголовков.');
  const headers = new Map<string, any>((Array.isArray(response.headers) ? response.headers : []).map((header: any) => [String(header.anchorId), header]));
  return { ...schema, anchors: schema.anchors.map((anchor) => {
    const header = headers.get(anchor.id);
    if (!header) return anchor;
    let located = anchor;
    if (anchor.kind === 'excel-range' && (header.sheetName !== undefined || header.address !== undefined)) {
      if (typeof header.sheetName !== 'string' || !header.sheetName || typeof header.address !== 'string' || !/^[A-Z]{1,3}[1-9]\d*$/i.test(header.address)) throw new Error('Редактор не подтвердил адрес ячейки заголовка.');
      // Именованный диапазон может переместиться при обычной правке листа.
      located = { ...anchor, sheetName: header.sheetName, address: header.address.toUpperCase() };
    }
    if (!Array.isArray(header.parts)) return located;
    const parts: OfficePart[] = header.parts.map((part: any) => {
      if (part?.kind === 'text' && typeof part.text === 'string') return { kind: 'text', text: part.text };
      if (part?.kind === 'operator' && ['+', '-', '*', '/', '(', ')'].includes(part.operator)) return { kind: 'operator', operator: part.operator };
      if (part?.kind === 'field' && part.binding?.anchorId === anchor.id && typeof part.binding?.sourceId === 'string' && typeof part.binding?.fieldKey === 'string') return { kind: 'field', binding: part.binding };
      if (part?.kind === 'union' && part.mode === 'first-match' && Array.isArray(part.alternatives) && part.alternatives.length && part.alternatives.every((item: any) => item.anchorId === anchor.id)) return { kind: 'union', mode: 'first-match', alternatives: part.alternatives, ...(typeof part.label === 'string' ? { label: part.label } : {}), ...(part.picks && typeof part.picks === 'object' ? { picks: part.picks } : {}), ...(part.resolved === true ? { resolved: true } : {}) };
      throw new Error('Редактор вернул поле без подтверждённой привязки. Обновите схему.');
    });
    return { ...located, parts: carryPartMeta(anchor.parts, parts) };
  }) };
}

const sameField = (left: any, right: any) => left?.sourceId === right?.sourceId && left?.fieldKey === right?.fieldKey;

/**
 * Редактор возвращает части из самого документа, а своё имя параметра, исключения объединения и
 * отметка «выбор сделан» живут только в схеме Flux: возвращаем их из прежней схемы по параметру.
 */
function carryPartMeta(before: OfficePart[], after: OfficePart[]): OfficePart[] {
  return after.map((part: any) => {
    if (part.kind === 'field') {
      const old: any = before.find((item: any) => item.kind === 'field' && sameField(item.binding, part.binding));
      return old?.binding?.label && !part.binding.label ? { ...part, binding: { ...part.binding, label: old.binding.label } } : part;
    }
    if (part.kind !== 'union') return part;
    const old: any = before.find((item: any) => item.kind === 'union' && item.alternatives.length === part.alternatives.length && item.alternatives.every((alt: any) => part.alternatives.some((next: any) => sameField(alt, next))));
    if (!old) return part;
    const labelled = new Map<string, string>(old.alternatives.filter((alt: any) => alt.label).map((alt: any) => [`${alt.sourceId}\u0000${alt.fieldKey}`, alt.label]));
    return { ...part,
      alternatives: part.alternatives.map((alt: any) => labelled.has(`${alt.sourceId}\u0000${alt.fieldKey}`) && !alt.label ? { ...alt, label: labelled.get(`${alt.sourceId}\u0000${alt.fieldKey}`) } : alt),
      ...(old.picks && !part.picks ? { picks: old.picks } : {}), ...(old.resolved && part.resolved === undefined ? { resolved: true } : {}), ...(old.label && part.label === undefined ? { label: old.label } : {}) };
  });
}
