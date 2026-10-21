import type { OfficeField } from './fluxData';
import type { OfficeBinding, OfficeHeaderAnchor, OfficeHeaderSchema, OfficePart } from '../../lib/officeModel';

export type OfficeTemplatePending =
  | { kind: 'anchor'; sourceAnchorIndex: number; candidateTargetIds: string[]; reason: 'missing-target' | 'ambiguous-target' | 'target-already-used' | 'invalid-selection' }
  | { kind: 'field'; sourceAnchorIndex: number; partIndex: number; alternativeIndex?: number; sourceId: string; fieldKey: string; reason: 'unavailable-field' };

export interface OfficeTemplateMapping {
  schema: OfficeHeaderSchema;
  pending: OfficeTemplatePending[];
}

function structuralKey(anchor: OfficeHeaderAnchor): string | null {
  if (anchor.kind === 'excel-range') {
    if (!anchor.sheetName || !anchor.address) return null;
    return JSON.stringify([anchor.kind, anchor.sheetName, anchor.address]);
  }
  if (!anchor.documentPart) return null;
  // В схеме Word пока нет номера строки; одинаковые части документа будут неоднозначны.
  return JSON.stringify([anchor.kind, anchor.documentPart]);
}

function catalogField(binding: OfficeBinding, fields: OfficeField[]): OfficeField | undefined {
  if (typeof binding.sourceId !== 'string' || !binding.sourceId || typeof binding.fieldKey !== 'string' || !binding.fieldKey) return;
  return fields.find((field) => field.sourceId === binding.sourceId && field.fieldKey === binding.fieldKey && field.entityType === binding.entityType);
}

/** Возвращает ключ слота поля для выбора из текущего каталога. */
export function officeTemplateFieldSelectionKey(sourceAnchorIndex: number, partIndex: number, alternativeIndex?: number): string {
  return alternativeIndex === undefined ? `${sourceAnchorIndex}:${partIndex}` : `${sourceAnchorIndex}:${partIndex}:${alternativeIndex}`;
}

/**
 * Применяет шапку к текущим якорям. Старые UUID не подходят другому файлу;
 * неоднозначные совпадения ждут явного выбора вместо привязки наугад.
 */
export function mapOfficeTemplateToTarget(
  template: OfficeHeaderSchema,
  target: OfficeHeaderSchema,
  fields: OfficeField[],
  anchorSelections: Record<number, string> = {},
  fieldSelections: Record<string, OfficeField> = {},
): OfficeTemplateMapping {
  const pending: OfficeTemplatePending[] = [];
  const targetByKey = new Map<string, OfficeHeaderAnchor[]>();
  for (const anchor of target.anchors) {
    const key = structuralKey(anchor);
    if (key) targetByKey.set(key, [...(targetByKey.get(key) || []), anchor]);
  }

  const sourceMatches = template.anchors.map((sourceAnchor, sourceAnchorIndex) => {
    const key = structuralKey(sourceAnchor);
    const candidates = key ? targetByKey.get(key) || [] : [];
    const chosenId = anchorSelections[sourceAnchorIndex];
    const chosen = chosenId ? target.anchors.find((anchor) => anchor.id === chosenId) : undefined;
    if (chosenId) return { sourceAnchor, sourceAnchorIndex, candidates, chosen, invalidSelection: !chosen, explicit: true, reservedTargetId: undefined as string | undefined };
    if (candidates.length !== 1) return { sourceAnchor, sourceAnchorIndex, candidates, chosen: undefined, invalidSelection: false, explicit: false, reservedTargetId: undefined as string | undefined };
    return { sourceAnchor, sourceAnchorIndex, candidates, chosen: candidates[0], invalidSelection: false, explicit: false, reservedTargetId: undefined as string | undefined };
  });
  const explicitTargets = new Set(sourceMatches.filter((match) => match.explicit && match.chosen).map((match) => match.chosen!.id));
  for (const match of sourceMatches) {
    if (!match.explicit && match.chosen && explicitTargets.has(match.chosen.id)) {
      match.reservedTargetId = match.chosen.id;
      match.chosen = undefined;
    }
  }
  const counts = new Map<string, number>();
  for (const match of sourceMatches) if (match.chosen) counts.set(match.chosen.id, (counts.get(match.chosen.id) || 0) + 1);
  const replacements = new Map<string, OfficeHeaderAnchor>();
  for (const match of sourceMatches) {
    const { sourceAnchor, sourceAnchorIndex, candidates, chosen } = match;
    if (!chosen || match.invalidSelection || counts.get(chosen.id) !== 1) {
      const reason = match.invalidSelection ? 'invalid-selection'
        : match.reservedTargetId ? 'target-already-used'
        : counts.get(chosen?.id || '')! > 1 ? 'target-already-used'
          : candidates.length ? 'ambiguous-target' : 'missing-target';
      // Показываем все якоря файла, чтобы инженер мог выбрать другую ячейку,
      // когда в сохранённой схеме нет надёжного структурного совпадения.
      pending.push({ kind: 'anchor', sourceAnchorIndex, candidateTargetIds: target.anchors.map((anchor) => anchor.id), reason });
      continue;
    }
    const targetAnchor = chosen;
    const parts: OfficePart[] = [];
    for (const [partIndex, part] of sourceAnchor.parts.entries()) {
      if (part.kind === 'field') {
        const field = catalogField(part.binding, fields) || fieldSelections[officeTemplateFieldSelectionKey(sourceAnchorIndex, partIndex)];
        if (!field || !fields.some((item) => item.sourceId === field.sourceId && item.fieldKey === field.fieldKey && item.entityType === field.entityType)) {
          pending.push({ kind: 'field', sourceAnchorIndex, partIndex, sourceId: part.binding.sourceId, fieldKey: part.binding.fieldKey, reason: 'unavailable-field' });
          continue;
        }
        const binding = { ...part.binding };
        delete binding.unit;
        parts.push({ kind: 'field', binding: { ...binding, sourceId: field.sourceId, fieldKey: field.fieldKey, entityType: field.entityType, ...(field.unit ? { unit: field.unit } : {}), anchorId: targetAnchor.id } });
      } else if (part.kind === 'union') {
        const alternatives = part.alternatives.flatMap((binding, alternativeIndex) => {
          const field = catalogField(binding, fields) || fieldSelections[officeTemplateFieldSelectionKey(sourceAnchorIndex, partIndex, alternativeIndex)];
          if (!field || !fields.some((item) => item.sourceId === field.sourceId && item.fieldKey === field.fieldKey && item.entityType === field.entityType)) {
            pending.push({ kind: 'field', sourceAnchorIndex, partIndex, alternativeIndex, sourceId: binding.sourceId, fieldKey: binding.fieldKey, reason: 'unavailable-field' });
            return [];
          }
          const rest = { ...binding };
          delete rest.unit;
          return [{ ...rest, sourceId: field.sourceId, fieldKey: field.fieldKey, entityType: field.entityType, ...(field.unit ? { unit: field.unit } : {}), anchorId: targetAnchor.id }];
        });
        if (alternatives.length) parts.push({ ...part, alternatives });
      } else parts.push(part);
    }
    replacements.set(targetAnchor.id, { ...targetAnchor, parts });
  }

  return {
    schema: { version: 1, anchors: target.anchors.map((anchor) => replacements.get(anchor.id) || anchor) },
    pending,
  };
}

/** Для пустой книги переносит только адреса шапки; содержимое и UUID берутся из шаблона/нового файла. */
export function seedEmptyOfficeTemplateTarget(
  template: OfficeHeaderSchema,
  target: OfficeHeaderSchema,
  createId: () => string = () => crypto.randomUUID(),
): OfficeHeaderSchema {
  if (target.anchors.length || !template.anchors.length || template.anchors.some((anchor) => anchor.kind !== 'excel-range' || !anchor.sheetName || !anchor.address)) return target;
  return { ...target, anchors: template.anchors.map((anchor) => ({
    kind: 'excel-range', id: createId(), sheetName: anchor.sheetName, address: anchor.address, parts: [],
  })) };
}
