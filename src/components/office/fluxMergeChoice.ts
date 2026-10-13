/**
 * Объединение двух параметров в одну колонку и своё имя параметра: чистые функции над схемой.
 * Здесь нет DOM и запросов, кроме одного чтения данных для списка «заполнены оба».
 */
import type { OfficeBinding, OfficeHeaderSchema, OfficePart, OfficeUnionPart } from '../../lib/officeModel';
import { officeDataApi, type OfficeAnchorRow, type OfficeField } from './fluxData';

const readableKey = (key: string): string => key.replace(/^param:@?/, '').split('|').pop() || key;

const fieldOf = (binding: OfficeBinding, fields: OfficeField[]) => fields.find((item) => item.sourceId === binding.sourceId && item.fieldKey === binding.fieldKey);

/** Имя на плашке: своё, если задано, иначе программное из каталога. */
export function bindingName(binding: OfficeBinding & { displayName?: string }, fields: OfficeField[]): string {
  return binding.label || binding.displayName || fieldOf(binding, fields)?.displayName || readableKey(binding.fieldKey);
}

/** Программное имя «название · источник» — для подсказки и окна переименования. */
export function technicalName(binding: OfficeBinding & { displayName?: string }, fields: OfficeField[]): string {
  return `${fieldOf(binding, fields)?.displayName || binding.displayName || readableKey(binding.fieldKey)} · ${binding.sourceId}`;
}

type Alternative = OfficeUnionPart['alternatives'][number];

/** Имя колонки по умолчанию: «<имя1> / <имя2>», как его собирает объединение. */
export function defaultUnionLabel(alternatives: Alternative[], fields: OfficeField[]): string {
  return [...alternatives].sort((a, b) => a.priority - b.priority).map((item) => bindingName(item, fields)).join(' / ');
}

/** Имя части, как оно стоит на плашке. */
export function partName(part: OfficePart, fields: OfficeField[]): string {
  if (part.kind === 'field') return bindingName(part.binding, fields);
  if (part.kind === 'union') return part.label || defaultUnionLabel(part.alternatives, fields);
  return '';
}

/** Части ячейки, у которых бывает имя: параметр или объединение, с их номерами среди частей. */
export function namedParts(parts: OfficePart[]): Array<{ index: number; part: Extract<OfficePart, { kind: 'field' | 'union' }> }> {
  return parts.flatMap((part, index) => part.kind === 'field' || part.kind === 'union' ? [{ index, part }] : []);
}

/** Новое имя части. Пустое имя или null возвращает программное (у объединения — «<имя1> / <имя2>»). */
export function renamePart(schema: OfficeHeaderSchema, anchorId: string, index: number, name: string | null, fields: OfficeField[]): OfficeHeaderSchema {
  const clean = (name || '').trim().slice(0, 200);
  return { ...schema, anchors: schema.anchors.map((anchor) => anchor.id !== anchorId ? anchor : { ...anchor, parts: anchor.parts.map((part, at): OfficePart => {
    if (at !== index) return part;
    if (part.kind === 'field') {
      const { label: _old, ...binding } = part.binding;
      // Имя, совпавшее с программным, своим не считается: «сбросить» и «ввести то же» дают одно и то же
      return { kind: 'field', binding: clean && clean !== (fieldOf(binding, fields)?.displayName ?? '') ? { ...binding, label: clean } : binding };
    }
    if (part.kind === 'union') return { ...part, label: clean || defaultUnionLabel(part.alternatives, fields) };
    return part;
  }) }) };
}

export interface MergePosition { entityId: string; name: string; values: Record<string, string> }

/**
 * Позиции документа, у которых заполнены все параметры объединения. Документ не читаем:
 * берём строки, уже внесённые в него, и их значения из источника.
 */
export async function bothFilledPositions(projectId: string, rows: OfficeAnchorRow[] | undefined, alternatives: Alternative[]): Promise<MergePosition[]> {
  const placed = new Set((rows || []).map((row) => row.entityId));
  if (!placed.size || alternatives.length < 2) return [];
  const sourceId = alternatives[0].sourceId;
  if (alternatives.some((item) => item.sourceId !== sourceId)) return [];
  const keys = [...new Set(alternatives.map((item) => item.fieldKey))];
  const data = await officeDataApi.query({ projectId, sources: [sourceId], types: [], filters: [], sort: [], excludedEntityIds: [], limit: 50000, columns: keys });
  const filled = (value: unknown) => value !== null && value !== undefined && value !== '';
  return data.rows.filter((row) => placed.has(row.entityId) && keys.every((key) => filled(row.values[key]?.value))).map((row) => ({
    entityId: row.entityId, name: row.tag || decodeURIComponent(row.entityId.split(':').at(-1) || row.entityId),
    values: Object.fromEntries(keys.map((key) => [key, `${row.values[key]?.value}${row.values[key]?.unit ? ` ${row.values[key]!.unit}` : ''}`])),
  }));
}

/** Порядок параметров и исключения по позициям; пометка «выбор сделан» снимает вопрос с плашки. */
export function applyUnionChoice(part: OfficeUnionPart, order: string[], picks: Record<string, string>): OfficeUnionPart {
  const rank = new Map(order.map((key, at) => [key, at]));
  const alternatives = [...part.alternatives].sort((a, b) => (rank.get(a.fieldKey) ?? 99) - (rank.get(b.fieldKey) ?? 99)).map((item, priority) => ({ ...item, priority }));
  const { picks: _old, ...rest } = part;
  // Исключение, совпадающее с общим порядком, не храним: оно ничего не меняет
  const first = alternatives[0].fieldKey;
  const kept = Object.fromEntries(Object.entries(picks).filter(([, key]) => key !== first));
  return { ...rest, alternatives, resolved: true, ...(Object.keys(kept).length ? { picks: kept } : {}) };
}

/** «Брать <параметр>»: он идёт первым во всех позициях. */
export function takeFirst(part: OfficeUnionPart, fieldKey: string): OfficeUnionPart {
  const order = [fieldKey, ...[...part.alternatives].sort((a, b) => a.priority - b.priority).map((item) => item.fieldKey).filter((key) => key !== fieldKey)];
  return applyUnionChoice(part, order, {});
}

/** Подставляет новую часть вместо старой в схеме. */
export function replacePart(schema: OfficeHeaderSchema, anchorId: string, index: number, next: OfficePart): OfficeHeaderSchema {
  return { ...schema, anchors: schema.anchors.map((anchor) => anchor.id !== anchorId ? anchor : { ...anchor, parts: anchor.parts.map((part, at) => at === index ? next : part) }) };
}
