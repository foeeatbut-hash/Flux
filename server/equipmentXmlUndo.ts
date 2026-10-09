import { getPrisma } from './context.js';
import { withBump } from './equipmentVersion.js';
import { equipmentSourceSpecsEqual } from './equipmentSourceReview.js';
import { inferEquipmentSourceFilenameRule, matchesEquipmentSourceFilename } from '../equipment/sourceXml.js';

export interface XmlUndoPlan {
  batchId: string;
  action: 'restore' | 'skip';
  reason?: string;
  elementId: string;
  itemCode: string;
  where: string;
  targetIds?: string[];
}

const METADATA_FIELDS = ['name', 'itemCode', 'monoblockId', 'parentElementId', 'status', 'sourceOrder', 'equipType', 'role', 'sourceKind', 'instanceNo', 'instanceCount', 'manual'] as const;
type MetadataSnapshot = Record<(typeof METADATA_FIELDS)[number], unknown>;
type TargetSnapshot = {
  elementId: string; oldSpecs: string | null; newSpecs: string | null;
  oldOverrides: string | null; newOverrides: string | null;
  oldVersion: number; newVersion: number;
  oldMetadata?: MetadataSnapshot; newMetadata?: MetadataSnapshot;
  existed?: boolean; created?: boolean;
  sourceBindingAfter?: Record<string, unknown>;
};
const snapshotsOf = (app: any): TargetSnapshot[] => {
  try {
    const parsed = JSON.parse(app.targetSnapshots || '[]');
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch { throw new Error('Снимок нескольких XML-позиций повреждён'); }
  return [{ elementId: app.elementId, oldSpecs: app.oldSpecs ?? null, newSpecs: app.newSpecs ?? null, oldOverrides: app.oldOverrides ?? null, newOverrides: app.newOverrides ?? null, oldVersion: Number(app.oldVersion), newVersion: Number(app.newVersion) }];
};

const normalizedMetadata = (value: any): MetadataSnapshot | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(METADATA_FIELDS.map(field => [field, value[field] ?? null])) as MetadataSnapshot;
};
const metadataMatches = (element: any, snapshot: MetadataSnapshot | null): boolean => !snapshot
  || METADATA_FIELDS.every(field => (element[field] ?? null) === snapshot[field]);
const metadataWhere = (metadata: MetadataSnapshot | null): Record<string, unknown> => metadata || {};
const metadataData = (metadata: MetadataSnapshot | null): Record<string, unknown> => metadata || {};
const expectedVersionsMatch = (candidate: any, targets: TargetSnapshot[]): boolean => {
  let raw: any;
  try { raw = typeof candidate?.expectedVersions === 'string' ? JSON.parse(candidate.expectedVersions) : candidate?.expectedVersions; } catch { return false; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const expected = Object.fromEntries(targets.map(target => [target.elementId, Number(target.newVersion)]));
  const keys = Object.keys(raw).sort();
  return keys.length === Object.keys(expected).length
    && keys.every(key => Object.prototype.hasOwnProperty.call(expected, key) && Number(raw[key]) === expected[key]);
};

async function sourceIdentityValid(prisma: any, app: any, source: any, candidate: any, targets: TargetSnapshot[]) {
  if (!source || !candidate || source.id !== app.sourceId || candidate.id !== app.candidateId
    || candidate.sourceId !== source.id || candidate.projectId !== source.projectId || source.deletedAt) return false;
  const root = await prisma.componentElement.findUnique({ where: { id: source.elementId }, include: {
    tags: true, monoblock: { include: { system: true } },
  } });
  if (!root || root.id !== app.elementId || !root.monoblock?.system || root.monoblock.system.projectId !== source.projectId) return false;
  if (!(root.tags || []).some((tag: any) => tag.id === source.tagId && tag.identifier === source.tagIdentifier)) return false;
  if (source.targetType === 'system') {
    if (!source.systemId || root.monoblock.system.id !== source.systemId || root.itemCode !== '__unit__') return false;
  } else if (source.targetType !== 'component' || source.systemId) return false;
  const rule = (() => {
    try {
      if (source.selectedRule === 'exact-tag') return { kind: 'exact-tag' };
      if (source.selectedRule === 'selected-name') return { kind: 'selected-name', fileName: candidate.fileName };
      return typeof source.selectedRule === 'string' ? JSON.parse(source.selectedRule) : source.selectedRule;
    } catch { return null; }
  })();
  if (!rule || !matchesEquipmentSourceFilename(String(candidate.fileName || ''), String(source.tagIdentifier || ''), rule)) return false;
  const bindingAfter = targets.find(target => target.sourceBindingAfter)?.sourceBindingAfter;
  if (bindingAfter) {
    const fields = ['projectId', 'tagId', 'targetType', 'systemId', 'elementId', 'tagIdentifier', 'selectedRule', 'deletedAt'];
    if (fields.some(field => (source[field] ?? null) !== (bindingAfter[field] ?? null))) return false;
  } else {
    const inferred = inferEquipmentSourceFilenameRule(String(candidate.fileName || ''), String(source.tagIdentifier || ''));
    if (!inferred || JSON.stringify(rule) !== JSON.stringify(inferred)) return false;
  }
  return targets.some(target => target.elementId === root.id);
}

async function hasUnsafeActiveDescendant(prisma: any, createdIds: Set<string>, rootId: string): Promise<boolean> {
  let frontier = [rootId];
  const visited = new Set(frontier);
  while (frontier.length) {
    const children = await prisma.componentElement.findMany({
      where: { parentElementId: { in: frontier }, status: { not: 'REMOVED' } }, select: { id: true },
    });
    const next: string[] = [];
    for (const child of children) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      if (!createdIds.has(child.id)) return true;
      next.push(child.id);
    }
    frontier = next;
  }
  return false;
}
export function isXmlRevisionBatch(batchId: string): boolean { return /^xmlrev-\d+-/.test(String(batchId || '')); }

/** План отмены сверяет каждую позицию составной XML-ревизии до записи. */
export async function planXmlRevisionUndo(batchId: string): Promise<XmlUndoPlan> {
  const p = getPrisma();
  const app = await p.equipmentXmlApplication.findUnique({ where: { batchId } });
  if (!app) return { batchId, action: 'skip', reason: 'снимок операции не найден', elementId: '', itemCode: '—', where: '' };
  let targets: TargetSnapshot[];
  try { targets = snapshotsOf(app); } catch (error: any) { return { batchId, action: 'skip', reason: error.message, elementId: app.elementId, itemCode: '—', where: '' }; }
  const [elements, candidate, source] = await Promise.all([
    p.componentElement.findMany({ where: { id: { in: targets.map(target => target.elementId) } }, include: { monoblock: { include: { system: true } } } }),
    p.equipmentXmlCandidate.findUnique({ where: { id: app.candidateId } }),
    p.equipmentXmlSource.findUnique({ where: { id: app.sourceId } }),
  ]);
  const byId = new Map(elements.map((item: any) => [item.id, item]));
  const root = byId.get(app.elementId) as any;
  const base = { batchId, elementId: app.elementId, itemCode: String(root?.itemCode || root?.name || '—'), where: `${root?.monoblock?.system?.name || ''} · ${root?.monoblock?.name || ''}`, targetIds: targets.map(target => target.elementId) };
  if (!root || elements.length !== targets.length || !candidate || !source) return { ...base, action: 'skip', reason: 'оборудование, кандидат или источник уже удалён' };
  const currentSource = [source.lastImportedRevision ?? null, source.lastImportedSha256 ?? null, source.lastImportedAt ? new Date(source.lastImportedAt).getTime() : null];
  const expectedSource = [app.newImportedRevision ?? null, app.newImportedSha256 ?? null, app.newImportedAt ? new Date(app.newImportedAt).getTime() : null];
  const currentReview = [source.lastReviewedRevision ?? null, source.lastReviewedSha256 ?? null, source.lastReviewedAt ? new Date(source.lastReviewedAt).getTime() : null];
  const expectedReview = [app.newReviewedRevision ?? null, app.newReviewedSha256 ?? null, app.newReviewedAt ? new Date(app.newReviewedAt).getTime() : null];
  const targetsMatch = targets.every(target => {
    const element = byId.get(target.elementId) as any;
    return Number(element.version || 1) === Number(target.newVersion)
      && equipmentSourceSpecsEqual(element.specs ?? null, target.newSpecs ?? null)
      && (element.overrides ?? null) === (target.newOverrides ?? null)
      && metadataMatches(element, normalizedMetadata(target.newMetadata));
  });
  const createdIds = new Set(targets.filter(target => target.created || target.existed === false).map(target => target.elementId));
  let descendantsSafe = true;
  for (const target of targets.filter(item => item.created || item.existed === false)) {
    if (await hasUnsafeActiveDescendant(p, createdIds, target.elementId)) { descendantsSafe = false; break; }
  }
  if (!targetsMatch || String(candidate.decisions || '{}') !== String(app.afterDecisions || '{}') || candidate.status !== app.afterStatus
      || Number(candidate.expectedVersion) !== Number(app.newVersion)
      || !expectedVersionsMatch(candidate, targets)
      || JSON.stringify(currentSource) !== JSON.stringify(expectedSource) || JSON.stringify(currentReview) !== JSON.stringify(expectedReview)
      || !descendantsSafe || !(await sourceIdentityValid(p, app, source, candidate, targets))) {
    return { ...base, action: 'skip', reason: 'после подтверждения кто-то изменил оборудование или состояние ревизии' };
  }
  return { ...base, action: 'restore' };
}

export async function applyXmlRevisionUndo(batchId: string, plan: XmlUndoPlan): Promise<{ restored: number; skipped: number; changedElementIds: string[] }> {
  if (plan.action !== 'restore') return { restored: 0, skipped: 1, changedElementIds: [] };
  const p = getPrisma();
  const app = await p.equipmentXmlApplication.findUnique({ where: { batchId } });
  if (!app) return { restored: 0, skipped: 1, changedElementIds: [] };
  let targets: TargetSnapshot[];
  try { targets = snapshotsOf(app); } catch { return { restored: 0, skipped: 1, changedElementIds: [] }; }
  try {
    await p.$transaction(async (tx: any) => {
      const [elements, candidate, source] = await Promise.all([
        tx.componentElement.findMany({ where: { id: { in: targets.map(target => target.elementId) } } }),
        tx.equipmentXmlCandidate.findUnique({ where: { id: app.candidateId } }),
        tx.equipmentXmlSource.findUnique({ where: { id: app.sourceId } }),
      ]);
      const byId = new Map(elements.map((item: any) => [item.id, item]));
      if (elements.length !== targets.length || !candidate || !source || candidate.status !== app.afterStatus || String(candidate.decisions || '{}') !== String(app.afterDecisions || '{}')) throw new Error('conflict');
      for (const target of targets) {
        const element = byId.get(target.elementId) as any;
        if (!element || Number(element.version || 1) !== Number(target.newVersion)
          || !equipmentSourceSpecsEqual(element.specs ?? null, target.newSpecs ?? null) || (element.overrides ?? null) !== (target.newOverrides ?? null)
          || !metadataMatches(element, normalizedMetadata(target.newMetadata))) throw new Error('conflict');
      }
      if (Number(candidate.expectedVersion) !== Number(app.newVersion)) throw new Error('conflict');
      if (!expectedVersionsMatch(candidate, targets)) throw new Error('conflict');
      const currentSource = [source.lastImportedRevision ?? null, source.lastImportedSha256 ?? null, source.lastImportedAt ? new Date(source.lastImportedAt).getTime() : null];
      const expectedSource = [app.newImportedRevision ?? null, app.newImportedSha256 ?? null, app.newImportedAt ? new Date(app.newImportedAt).getTime() : null];
      const currentReview = [source.lastReviewedRevision ?? null, source.lastReviewedSha256 ?? null, source.lastReviewedAt ? new Date(source.lastReviewedAt).getTime() : null];
      const expectedReview = [app.newReviewedRevision ?? null, app.newReviewedSha256 ?? null, app.newReviewedAt ? new Date(app.newReviewedAt).getTime() : null];
      if (JSON.stringify(currentSource) !== JSON.stringify(expectedSource) || JSON.stringify(currentReview) !== JSON.stringify(expectedReview)) throw new Error('conflict');
      if (!(await sourceIdentityValid(tx, app, source, candidate, targets))) throw new Error('conflict');
      const createdIds = new Set(targets.filter(target => target.created || target.existed === false).map(target => target.elementId));
      for (const target of targets.filter(item => item.created || item.existed === false)) {
        if (await hasUnsafeActiveDescendant(tx, createdIds, target.elementId)) throw new Error('conflict');
      }
      const finalVersions: Record<string, number> = {};
      const depthOf = (id: string): number => {
        let depth = 0; let current = id; const seen = new Set<string>();
        while (createdIds.has(current) && !seen.has(current)) {
          seen.add(current);
          const parentId = String(normalizedMetadata(targets.find(item => item.elementId === current)?.newMetadata)?.parentElementId || '');
          if (!parentId || !createdIds.has(parentId)) break;
          current = parentId; depth++;
        }
        return depth;
      };
      const orderedTargets = [...targets].sort((a, b) => Number(b.created || b.existed === false) - Number(a.created || a.existed === false)
        || depthOf(b.elementId) - depthOf(a.elementId));
      for (const target of orderedTargets) {
        const element = byId.get(target.elementId) as any;
        const created = target.created || target.existed === false;
        const oldMetadata = normalizedMetadata(target.oldMetadata);
        const newMetadata = normalizedMetadata(target.newMetadata);
        const metadataChanged = !created && !!oldMetadata && !!newMetadata
          && METADATA_FIELDS.some(field => oldMetadata[field] !== newMetadata[field]);
        const changed = created || metadataChanged
          || !equipmentSourceSpecsEqual(element.specs ?? null, target.oldSpecs ?? null)
          || (element.overrides ?? null) !== (target.oldOverrides ?? null);
        const nextVersion = Number(element.version || 1) + (changed ? 1 : 0);
        const expectedMetadata = metadataWhere(newMetadata);
        const restoreMetadata = created ? {} : metadataData(oldMetadata);
        const restoreSpecs = created ? (element.specs ?? null) : (target.oldSpecs ?? null);
        const restoreOverrides = created ? (element.overrides ?? null) : (target.oldOverrides ?? null);
        const data = changed
          ? withBump({ ...(created ? { status: 'REMOVED' } : { ...restoreMetadata, specs: restoreSpecs, overrides: restoreOverrides }) })
          : { version: target.newVersion, specs: element.specs ?? null, overrides: element.overrides ?? null, ...expectedMetadata };
        const update = await tx.componentElement.updateMany({
          where: { id: element.id, version: target.newVersion, specs: element.specs ?? null, overrides: element.overrides ?? null, ...expectedMetadata }, data,
        });
        if (update.count !== 1) throw new Error('conflict');
        finalVersions[target.elementId] = nextVersion;
        if (changed) await tx.equipmentHistory.create({ data: {
          elementId: element.id, version: Number(element.version || 1), oldSpecs: element.specs ?? null,
          newSpecs: restoreSpecs, changeType: created ? 'XML_REVISION_UNDO_CREATE' : 'XML_REVISION_UNDO', batchId: `xmlundo-${Date.now()}-${batchId}`,
        } });
      }
      const sourceUpdate = await tx.equipmentXmlSource.updateMany({
        where: { id: source.id, projectId: source.projectId, tagId: source.tagId, targetType: source.targetType,
          systemId: source.systemId ?? null, elementId: source.elementId, tagIdentifier: source.tagIdentifier,
          selectedRule: source.selectedRule, deletedAt: null,
          lastImportedRevision: app.newImportedRevision ?? null, lastImportedSha256: app.newImportedSha256 ?? null, lastImportedAt: app.newImportedAt ?? null,
          lastReviewedRevision: app.newReviewedRevision ?? null, lastReviewedSha256: app.newReviewedSha256 ?? null, lastReviewedAt: app.newReviewedAt ?? null },
        data: { lastImportedRevision: app.oldImportedRevision ?? null, lastImportedSha256: app.oldImportedSha256 ?? null, lastImportedAt: app.oldImportedAt ?? null, lastReviewedRevision: app.oldReviewedRevision ?? null, lastReviewedSha256: app.oldReviewedSha256 ?? null, lastReviewedAt: app.oldReviewedAt ?? null },
      });
      if (sourceUpdate.count !== 1) throw new Error('conflict');
      const candidateUpdate = await tx.equipmentXmlCandidate.updateMany({ where: { id: candidate.id, sourceId: app.sourceId, projectId: source.projectId,
        updatedAt: candidate.updatedAt, status: app.afterStatus, decisions: app.afterDecisions, expectedVersion: Number(app.newVersion) },
        data: { status: app.beforeStatus, decisions: app.beforeDecisions, expectedVersion: finalVersions[app.elementId], expectedVersions: JSON.stringify(finalVersions) } });
      if (candidateUpdate.count !== 1) throw new Error('conflict');
    }, { timeout: 30_000, isolationLevel: 'Serializable' });
    return { restored: 1, skipped: 0, changedElementIds: targets.map(target => target.elementId) };
  } catch (_) { return { restored: 0, skipped: 1, changedElementIds: [] }; }
}
