import { createHash } from 'node:crypto';
import { unitBlocksOf } from './equipmentResolve.js';
import type { ParsedUnit } from './equipmentParser.js';
import { diffEquipmentSource, type SourceChange, type SourceGroup } from './equipmentSourceReview.js';

/** Минимальная сохранённая идентичность и состояние источника для сравнения позиции с XML. */
export interface EquipmentSourceTargetElement {
  id: string;
  itemCode: string;
  name: string;
  monoblockName?: string;
  parentElementId?: string | null;
  equipType?: string | null;
  role?: string | null;
  sourceKind?: string | null;
  instanceNo?: number | null;
  instanceCount?: number | null;
  sourceOrder?: number | null;
  status?: string | null;
  manual?: boolean;
  version: number;
  specs: string | null;
  overrides?: string | Record<string, unknown> | null;
  tags?: string[];
}

export interface EquipmentSourceTargetChange extends SourceChange {
  /** Исходный адрес изменения без привязки к элементу для сохранения решения на маршруте. */
  rawId: string;
  targetId: string;
  targetLabel: string;
}

export interface EquipmentSourceTargetProposal {
  elementId: string;
  label: string;
  groups: SourceGroup[];
  changes: EquipmentSourceTargetChange[];
  expectedVersion: number;
}

export interface EquipmentSourceStructuralAction {
  id: string;
  kind: 'added' | 'removed' | 'ambiguous' | 'moved' | 'restored' | 'metadata-changed';
  label: string;
  parsedKey?: string;
  elementIds: string[];
  reason: string;
  field?: 'monoblockName' | 'parentElementId' | 'sourceOrder' | 'title' | 'equipType' | 'status' | 'role' | 'sourceKind' | 'instanceNo' | 'instanceCount';
  before?: unknown;
  after?: unknown;
  proposed?: EquipmentSourceStructuralProposal;
}

export interface EquipmentSourceStructuralProposal {
  code: string;
  itemCode: string;
  title: string;
  equipType: string;
  groups: SourceGroup[];
  monoblockName: string;
  parentName?: string;
  sourceOrder?: number;
  tags?: string[];
  role?: string;
  sourceKind?: string;
  instanceNo?: number;
  instanceCount?: number;
}

export interface EquipmentSourceTargetsResult {
  targets: EquipmentSourceTargetProposal[];
  structuralActions: EquipmentSourceStructuralAction[];
}

interface ParsedTarget {
  key: string;
  monoblockName: string;
  code: string;
  label: string;
  tags: string[];
  groups: SourceGroup[];
  parentName?: string;
  sourceOrder?: number;
  title: string;
  equipType: string;
  role?: string;
  sourceKind?: string;
  instanceNo?: number;
  instanceCount?: number;
}

const norm = (value: unknown) => String(value ?? '').normalize('NFC').trim().toLocaleLowerCase();
const address = (monoblockName: string, itemCode: string) => `${norm(monoblockName)}\u001f${norm(itemCode)}`;
const tagSet = (tags: unknown) => new Set((Array.isArray(tags) ? tags : []).map(norm).filter(Boolean));
const elementLabel = (element: EquipmentSourceTargetElement) =>
  [element.monoblockName, element.name || element.itemCode].filter(Boolean).join(' · ') || element.itemCode || element.id;

function overrideJson(overrides: EquipmentSourceTargetElement['overrides']): string | null {
  if (overrides == null || overrides === '') return null;
  if (typeof overrides === 'string') {
    let parsed: unknown;
    try { parsed = JSON.parse(overrides); } catch { throw Object.assign(new Error('Ручные значения характеристики повреждены; сравнение XML остановлено.'), { status: 409 }); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Object.assign(new Error('Формат ручных значений не распознан; сравнение XML остановлено.'), { status: 409 });
    return overrides;
  }
  if (typeof overrides !== 'object' || Array.isArray(overrides)) throw Object.assign(new Error('Формат ручных значений не распознан; сравнение XML остановлено.'), { status: 409 });
  return JSON.stringify(overrides);
}

function parsedTargets(unit: ParsedUnit): ParsedTarget[] {
  return unitBlocksOf(unit)
    .filter(block => block.code !== '__unit__')
    .map(block => ({
      key: address(block.mbName, block.code),
      monoblockName: block.mbName,
      code: block.code,
      label: [block.mbName, block.title || block.code].filter(Boolean).join(' · '),
      tags: block.tags || [],
      groups: block.groups || [],
      parentName: block.parent,
      sourceOrder: block.sourceOrder,
      title: block.title || block.code,
      equipType: block.equipType,
      role: block.role,
      sourceKind: block.sourceKind,
      instanceNo: block.instanceNo,
      instanceCount: block.instanceCount,
    }));
}

type StructuralActionInput = Omit<EquipmentSourceStructuralAction, 'id'>;
function appendStructuralAction(actions: EquipmentSourceStructuralAction[], action: StructuralActionInput): void {
  const identity = JSON.stringify([action.kind, action.parsedKey || '', [...action.elementIds].sort(), action.field || '', action.proposed || null, action.before ?? null, action.after ?? null]);
  const id = `xml-struct-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
  actions.push({ ...action, elementIds: [...action.elementIds].sort(), id });
}

const addMetadataAction = (
  actions: EquipmentSourceStructuralAction[],
  element: EquipmentSourceTargetElement,
  parsed: ParsedTarget,
  field: NonNullable<EquipmentSourceStructuralAction['field']>,
  before: unknown,
  after: unknown,
  kind: EquipmentSourceStructuralAction['kind'] = 'metadata-changed',
) => {
  if (before === after) return;
  appendStructuralAction(actions, { kind, label: parsed.label, parsedKey: parsed.key, elementIds: [element.id], field, before, after,
    reason: field === 'monoblockName' || field === 'parentElementId'
      ? 'Изменилась структура или расположение позиции; требуется подтверждение.'
      : 'Изменились метаданные позиции; требуется подтверждение.' });
};

/**
 * Сопоставляет установку XML и вложенные позиции со стабильными ID проекта.
 * Сначала используется точный тег, затем точный адрес «моноблок/код позиции»;
 * сходство и порядок в исходном файле не применяются. Несопоставленный состав
 * возвращается отдельными действиями проверки и не становится целью записи.
 */
export function resolveEquipmentSourceTargets(
  parsedUnit: ParsedUnit,
  rootElement: EquipmentSourceTargetElement,
  existingElements: EquipmentSourceTargetElement[],
): EquipmentSourceTargetsResult {
  const children = parsedTargets(parsedUnit);
  const usable = existingElements.filter(element => element.id !== rootElement.id && element.itemCode !== '__unit__' && !element.manual);
  const used = new Set<string>([rootElement.id]);
  const targets: EquipmentSourceTargetProposal[] = [];
  const structuralActions: EquipmentSourceStructuralAction[] = [];
  const matched: { parsed: ParsedTarget; element: EquipmentSourceTargetElement }[] = [];
  const parsedKeyCounts = new Map<string, number>();
  const parsedTagCounts = new Map<string, number>();
  for (const parsed of children) {
    parsedKeyCounts.set(parsed.key, (parsedKeyCounts.get(parsed.key) || 0) + 1);
    for (const tag of tagSet(parsed.tags)) parsedTagCounts.set(tag, (parsedTagCounts.get(tag) || 0) + 1);
  }

  const appendTarget = (element: EquipmentSourceTargetElement, label: string, groups: SourceGroup[]) => {
    const changes = diffEquipmentSource(element.specs, groups, overrideJson(element.overrides));
    targets.push({
      elementId: element.id,
      label,
      groups,
      expectedVersion: element.version,
      changes: changes.map(change => ({
        ...change,
        rawId: change.id,
        targetId: element.id,
        id: `${element.id}\u0001${change.id}`,
        targetLabel: label,
      })),
    });
  };

  appendTarget(rootElement, elementLabel(rootElement), parsedUnit.groups || []);

  for (const parsed of children) {
    const parsedTags = tagSet(parsed.tags);
    const duplicateIdentity = (parsedKeyCounts.get(parsed.key) || 0) > 1 || [...parsedTags].some(tag => (parsedTagCounts.get(tag) || 0) > 1);
    if (duplicateIdentity) {
      const possible = usable.filter(element => address(element.monoblockName || '', element.itemCode) === parsed.key
        || [...tagSet(element.tags)].some(tag => parsedTags.has(tag)));
      for (const element of possible) used.add(element.id);
      appendStructuralAction(structuralActions, { kind: 'ambiguous', label: parsed.label, parsedKey: parsed.key, elementIds: possible.map(item => item.id), reason: 'Тег или адрес позиции повторяется в XML; автоматическое сопоставление остановлено.' });
      continue;
    }
    const tagCandidates = parsedTags.size
      ? usable.filter(element => !used.has(element.id) && [...tagSet(element.tags)].some(tag => parsedTags.has(tag)))
      : [];
    let candidate: EquipmentSourceTargetElement | undefined;
    if (tagCandidates.length > 1) {
      appendStructuralAction(structuralActions, { kind: 'ambiguous', label: parsed.label, parsedKey: parsed.key, elementIds: tagCandidates.map(item => item.id), reason: 'Тег XML встречается у нескольких позиций проекта.' });
      continue;
    }
    if (tagCandidates.length === 1) candidate = tagCandidates[0];
    else {
      const addressCandidates = usable.filter(element => !used.has(element.id)
        && address(element.monoblockName || '', element.itemCode) === parsed.key);
      if (addressCandidates.length > 1) {
        appendStructuralAction(structuralActions, { kind: 'ambiguous', label: parsed.label, parsedKey: parsed.key, elementIds: addressCandidates.map(item => item.id), reason: 'Адрес моноблока и позиции повторяется в проекте.' });
        continue;
      }
      candidate = addressCandidates[0];
    }

    if (!candidate) {
      appendStructuralAction(structuralActions, { kind: 'added', label: parsed.label, parsedKey: parsed.key, elementIds: [], reason: 'В XML есть позиция без точной пары в проекте; требуется отдельное решение по составу.', proposed: {
        code: parsed.code, itemCode: parsed.code, title: parsed.title, equipType: parsed.equipType, groups: parsed.groups,
        monoblockName: parsed.monoblockName, ...(parsed.parentName ? { parentName: parsed.parentName } : {}),
        ...(parsed.sourceOrder !== undefined ? { sourceOrder: parsed.sourceOrder } : {}), ...(parsed.tags.length ? { tags: parsed.tags } : {}),
        ...(parsed.role ? { role: parsed.role } : {}), ...(parsed.sourceKind ? { sourceKind: parsed.sourceKind } : {}), ...(parsed.instanceNo !== undefined ? { instanceNo: parsed.instanceNo } : {}),
        ...(parsed.instanceCount !== undefined ? { instanceCount: parsed.instanceCount } : {}),
      } });
      continue;
    }
    used.add(candidate.id);
    appendTarget(candidate, parsed.label, parsed.groups);
    matched.push({ parsed, element: candidate });
  }

  const parsedIdByKey = new Map(matched.map(item => [item.parsed.key, item.element.id]));
  for (const { parsed, element } of matched) {
    if (element.status === 'REMOVED') {
      appendStructuralAction(structuralActions, { kind: 'restored', label: parsed.label, parsedKey: parsed.key, elementIds: [element.id], field: 'status', before: element.status, after: 'ACTIVE', reason: 'Точная позиция найдена среди снятых; её восстановление требует отдельного подтверждения.' });
    }
    const oldMonoblock = norm(element.monoblockName || '');
    const nextMonoblock = norm(parsed.monoblockName);
    addMetadataAction(structuralActions, element, parsed, 'monoblockName', element.monoblockName || '', parsed.monoblockName, oldMonoblock !== nextMonoblock ? 'moved' : 'metadata-changed');

    const parentKey = parsed.parentName ? address(parsed.monoblockName, parsed.parentName) : '';
    const nextParentId = parentKey ? parsedIdByKey.get(parentKey) : null;
    if (parsed.parentName && !nextParentId) {
      appendStructuralAction(structuralActions, { kind: 'ambiguous', label: parsed.label, parsedKey: parsed.key, elementIds: [element.id], field: 'parentElementId', before: element.parentElementId || null, after: null, reason: `Родительская позиция «${parsed.parentName}» не сопоставлена однозначно.` });
    } else {
      const oldParentId = element.parentElementId || null;
      const normalizedNextParent = nextParentId || null;
      if (oldParentId !== normalizedNextParent) addMetadataAction(structuralActions, element, parsed, 'parentElementId', oldParentId, normalizedNextParent, 'moved');
    }

    if (parsed.sourceOrder !== undefined && parsed.sourceOrder !== element.sourceOrder) addMetadataAction(structuralActions, element, parsed, 'sourceOrder', element.sourceOrder ?? null, parsed.sourceOrder);
    if (String(element.name || '') !== String(parsed.title || '')) addMetadataAction(structuralActions, element, parsed, 'title', element.name || '', parsed.title);
    if (String(element.equipType || '') !== String(parsed.equipType || '')) addMetadataAction(structuralActions, element, parsed, 'equipType', element.equipType || '', parsed.equipType);
    if (parsed.role !== undefined && String(element.role || '') !== String(parsed.role || '')) addMetadataAction(structuralActions, element, parsed, 'role', element.role || '', parsed.role);
    if (parsed.sourceKind !== undefined && String(element.sourceKind || '') !== String(parsed.sourceKind || '')) addMetadataAction(structuralActions, element, parsed, 'sourceKind', element.sourceKind || '', parsed.sourceKind);
    if (parsed.instanceNo !== undefined && element.instanceNo !== parsed.instanceNo) addMetadataAction(structuralActions, element, parsed, 'instanceNo', element.instanceNo ?? null, parsed.instanceNo);
    if (parsed.instanceCount !== undefined && element.instanceCount !== parsed.instanceCount) addMetadataAction(structuralActions, element, parsed, 'instanceCount', element.instanceCount ?? null, parsed.instanceCount);
  }

  for (const existing of usable) if (!used.has(existing.id) && existing.status !== 'REMOVED') {
    appendStructuralAction(structuralActions, { kind: 'removed', label: elementLabel(existing), elementIds: [existing.id], before: {
      code: existing.itemCode, title: existing.name, equipType: existing.equipType || '', monoblockName: existing.monoblockName || '',
      parentElementId: existing.parentElementId || null, sourceOrder: existing.sourceOrder ?? null, tags: existing.tags || [],
    }, reason: 'Позиция проекта отсутствует в XML; автоматическое снятие или удаление не выполняется.' });
  }

  targets.sort((a, b) => a.elementId === rootElement.id
    ? (b.elementId === rootElement.id ? 0 : -1)
    : b.elementId === rootElement.id ? 1 : a.label.localeCompare(b.label, 'ru'));
  structuralActions.sort((a, b) => a.label.localeCompare(b.label, 'ru') || a.kind.localeCompare(b.kind) || String(a.field || '').localeCompare(String(b.field || '')));
  return { targets, structuralActions };
}
