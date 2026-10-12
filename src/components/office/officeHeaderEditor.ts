import type { OfficeBinding, OfficePart } from '../../lib/officeModel';

/** Порядок частей совпадает с последовательностью текста и ячеек Office. */
export function insertOfficeHeaderPart(parts: OfficePart[], index: number, part: OfficePart): OfficePart[] {
  const next = [...parts];
  next.splice(clampIndex(index, next.length), 0, part);
  return next;
}

export function removeOfficeHeaderPart(parts: OfficePart[], index: number): OfficePart[] {
  if (index < 0 || index >= parts.length) return parts;
  return parts.filter((_part, at) => at !== index);
}

export function moveOfficeHeaderPart(parts: OfficePart[], from: number, to: number): OfficePart[] {
  if (from < 0 || from >= parts.length || to < 0 || to >= parts.length || from === to) return parts;
  const next = [...parts];
  const [part] = next.splice(from, 1);
  next.splice(to, 0, part);
  return next;
}

/** Удаление привязки не затрагивает обычный текст по краям. */
export function removeOfficeHeaderBinding(parts: OfficePart[], index: number, binding: OfficeBinding): OfficePart[] {
  const part = parts[index];
  if (!part) return parts;
  if (part.kind === 'field') {
    if (!sameBinding(part.binding, binding)) return parts;
    return removeOfficeHeaderPart(parts, index);
  }
  if (part.kind !== 'union') return parts;
  const alternatives = part.alternatives.filter((item) => !sameBinding(item, binding));
  if (alternatives.length === part.alternatives.length) return parts;
  if (alternatives.length === 0) return removeOfficeHeaderPart(parts, index);
  if (alternatives.length === 1) return parts.map((item, at) => at === index ? { kind: 'field', binding: withoutPriority(alternatives[0]) } : item);
  return parts.map((item, at) => at === index && item.kind === 'union'
    ? { ...item, alternatives: alternatives.map((alternative, priority) => ({ ...alternative, priority })) }
    : item);
}

export function insertOfficeHeaderField(parts: OfficePart[], index: number, binding: OfficeBinding): OfficePart[] {
  return insertOfficeHeaderPart(parts, index, { kind: 'field', binding });
}

export function mergeOfficeHeaderBinding(parts: OfficePart[], index: number, binding: OfficeBinding): OfficePart[] {
  const current = parts[index];
  if (!current || (current.kind !== 'field' && current.kind !== 'union')) return parts;
  const bindings = current.kind === 'field' ? [current.binding] : current.alternatives;
  if (bindings.some((item) => sameBinding(item, binding))) return parts;
  const alternatives = [...bindings, binding].map((item, priority) => ({ ...item, priority }));
  return parts.map((part, at) => at !== index ? part : { kind: 'union', mode: 'first-match', alternatives });
}

function sameBinding(left: OfficeBinding, right: OfficeBinding): boolean {
  return left.sourceId === right.sourceId && left.fieldKey === right.fieldKey;
}

function withoutPriority(binding: OfficeBinding & { priority: number }): OfficeBinding {
  const { priority: _priority, ...plain } = binding;
  return plain;
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : length, length));
}
