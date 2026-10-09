/** Structural XML undo safety regression against a temporary real SQLite database. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma } from '../server/context.js';
import { applyXmlRevisionUndo, planXmlRevisionUndo } from '../server/equipmentXmlUndo.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-equipment-xml-undo-structure-'));
const dbPath = path.join(temp, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
const check = (label: string, value: unknown) => { assert.ok(value, label); checks++; console.log(`✓ ${label}`); };
const spec = (value: string) => JSON.stringify({ groups: [{ title: 'Параметры', params: [{ key: 'Расход', value, unit: 'м³/ч' }] }] });
const metadataOf = (row: any) => ({
  name: row.name, itemCode: row.itemCode, monoblockId: row.monoblockId,
  parentElementId: row.parentElementId ?? null, status: row.status,
  sourceOrder: row.sourceOrder, equipType: row.equipType, role: row.role,
  sourceKind: row.sourceKind ?? null, instanceNo: row.instanceNo ?? null,
  instanceCount: row.instanceCount ?? null, manual: row.manual,
});

async function seedBatch(prefix: string, targetRows: Array<{ id: string; existed: boolean; old?: any; after: any; newSpecs?: string; oldSpecs?: string }>, externalChild = false) {
  const projectId = `${prefix}-project`, systemId = `${prefix}-system`, monoId = `${prefix}-mono`;
  const rootId = `${prefix}-root`, tagId = `${prefix}-tag`, sourceId = `${prefix}-source`, candidateId = `${prefix}-candidate`;
  const batchId = `xmlrev-${Date.now()}-${prefix}`;
  const nowOld = new Date('2026-01-01T00:00:00.000Z');
  const nowNew = new Date('2026-02-01T00:00:00.000Z');
  await prisma.project.create({ data: { id: projectId, name: prefix } });
  await prisma.tag.create({ data: { id: tagId, identifier: 'SYS-1', projectId } });
  await prisma.equipmentSystem.create({ data: { id: systemId, name: 'SYS-1', projectId, category: 'AHU' } });
  await prisma.monoblock.create({ data: { id: monoId, name: '__unit__', systemId } });
  const root = await prisma.componentElement.create({ data: {
    id: rootId, name: 'Установка', itemCode: '__unit__', monoblockId: monoId, specs: spec('1'),
    tags: { connect: { id: tagId } },
  } });
  const source = await prisma.equipmentXmlSource.create({ data: {
    id: sourceId, projectId, tagId, targetType: 'system', systemId, elementId: rootId,
    tagIdentifier: 'SYS-1', selectedRule: JSON.stringify({ kind: 'exact-tag' }),
    lastImportedRevision: 'B', lastImportedSha256: 'b'.repeat(64), lastImportedAt: nowNew,
    lastReviewedRevision: 'B', lastReviewedSha256: 'b'.repeat(64), lastReviewedAt: nowNew,
  } });
  const candidate = await prisma.equipmentXmlCandidate.create({ data: {
    id: candidateId, sourceId, projectId, revision: 'B', fileName: 'SYS-1.xml', sha256: 'b'.repeat(64),
    parsedSpecs: JSON.stringify({ targets: [] }), changes: '[]', decisions: '{}', status: 'complete',
    expectedVersion: root.version, expectedVersions: JSON.stringify({ [rootId]: root.version }),
  } });

  const snapshots: any[] = [{
    elementId: rootId, oldSpecs: root.specs, newSpecs: root.specs, oldOverrides: null, newOverrides: null,
    oldVersion: root.version, newVersion: root.version, oldMetadata: metadataOf(root), newMetadata: metadataOf(root),
    existed: true, created: false,
  }];
  const finalExpectedVersions: Record<string, number> = { [rootId]: root.version };
  for (const row of targetRows) {
    if (row.after.tagId) await prisma.tag.create({ data: { id: row.after.tagId, identifier: row.after.itemCode, projectId } });
    if (row.existed) {
      const current = await prisma.componentElement.create({ data: {
        id: row.id, name: row.after.name, itemCode: row.after.itemCode, monoblockId: row.after.monoblockId || monoId,
        specs: row.newSpecs ?? row.oldSpecs ?? spec('1'), overrides: row.after.overrides ?? null,
        version: row.after.version ?? 2, status: row.after.status || 'OK', role: row.after.role || 'БЛОК',
        equipType: row.after.equipType || 'ПРОЧЕЕ', sourceOrder: row.after.sourceOrder ?? 0,
        parentElementId: row.after.parentElementId ?? null, manual: row.after.manual ?? false,
        sourceKind: row.after.sourceKind ?? null, instanceNo: row.after.instanceNo ?? null, instanceCount: row.after.instanceCount ?? null,
      } });
      const oldMetadata = row.old || metadataOf(current);
      const newMetadata = metadataOf(current);
      snapshots.push({ elementId: row.id, oldSpecs: row.oldSpecs ?? current.specs, newSpecs: row.newSpecs ?? current.specs,
        oldOverrides: row.old?.overrides ?? current.overrides, newOverrides: current.overrides,
        oldVersion: row.old?.version ?? current.version - 1, newVersion: current.version,
        oldMetadata, newMetadata, existed: true, created: false });
      finalExpectedVersions[row.id] = current.version;
    } else {
      const created = await prisma.componentElement.create({ data: {
        id: row.id, name: row.after.name, itemCode: row.after.itemCode, monoblockId: row.after.monoblockId || monoId,
        specs: row.newSpecs ?? spec('1'), version: row.after.version ?? 1, status: row.after.status || 'OK',
        role: row.after.role || 'БЛОК', equipType: row.after.equipType || 'ПРОЧЕЕ', sourceOrder: row.after.sourceOrder ?? 0,
        parentElementId: row.after.parentElementId ?? rootId, manual: row.after.manual ?? false,
      } });
      if (row.after.tagId) await prisma.componentElement.update({ where: { id: created.id }, data: { tags: { connect: { id: row.after.tagId } } } });
      snapshots.push({ elementId: row.id, oldSpecs: null, newSpecs: created.specs, oldOverrides: null, newOverrides: created.overrides,
        oldVersion: 0, newVersion: created.version, oldMetadata: null, newMetadata: metadataOf(created), existed: false, created: true });
      finalExpectedVersions[row.id] = created.version;
    }
  }
  if (externalChild && targetRows.length) {
    const parentId = targetRows.find(row => !row.existed)!.id;
    await prisma.componentElement.create({ data: { id: `${prefix}-outside-child`, name: 'Manual child', itemCode: 'MANUAL-CHILD', monoblockId: monoId, parentElementId: parentId, manual: true } });
  }
  await prisma.equipmentXmlCandidate.update({ where: { id: candidateId }, data: { expectedVersions: JSON.stringify(finalExpectedVersions) } });
  const sourceBindingAfter = {
    projectId, tagId, targetType: 'system', systemId, elementId: rootId,
    tagIdentifier: 'SYS-1', selectedRule: source.selectedRule, deletedAt: null,
  };
  snapshots[0].sourceBindingAfter = sourceBindingAfter;
  await prisma.equipmentXmlApplication.create({ data: {
    id: `${prefix}-application`, batchId, candidateId, sourceId, elementId: rootId,
    oldSpecs: root.specs, newSpecs: root.specs, oldOverrides: null, newOverrides: null,
    oldVersion: root.version, newVersion: root.version, targetSnapshots: JSON.stringify(snapshots),
    beforeDecisions: '{}', afterDecisions: '{}', beforeStatus: 'pending', afterStatus: 'complete',
    oldImportedRevision: 'A', oldImportedSha256: 'a'.repeat(64), oldImportedAt: nowOld,
    newImportedRevision: 'B', newImportedSha256: 'b'.repeat(64), newImportedAt: nowNew,
    oldReviewedRevision: 'A', oldReviewedSha256: 'a'.repeat(64), oldReviewedAt: nowOld,
    newReviewedRevision: 'B', newReviewedSha256: 'b'.repeat(64), newReviewedAt: nowNew,
  } });
  return { batchId, rootId, sourceId, candidateId, systemId, tagId, snapshots, finalExpectedVersions };
}

async function main() {
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);

    const metaBatch = await seedBatch('metadata', [{ id: 'metadata-element', existed: true,
      old: { name: 'Before', itemCode: 'FAN-1', monoblockId: 'metadata-mono', parentElementId: null, status: 'OK', sourceOrder: 1, equipType: 'ВЕНТИЛЯТОР', role: 'ВЕНТИЛЯТОР', sourceKind: 'cadFan', instanceNo: 1, instanceCount: 2, manual: false, version: 1 },
      after: { name: 'After', itemCode: 'FAN-2', monoblockId: 'metadata-mono', parentElementId: 'metadata-root', status: 'REMOVED', sourceOrder: 9, equipType: 'НАСОС', role: 'НАСОС', sourceKind: 'cadPump', instanceNo: 2, instanceCount: 2, manual: false, version: 2 } }]);
    const metaPlan = await planXmlRevisionUndo(metaBatch.batchId);
    check('metadata snapshot allows a complete undo plan', metaPlan.action === 'restore');
    const metaUndo = await applyXmlRevisionUndo(metaBatch.batchId, metaPlan);
    const metaAfter = await prisma.componentElement.findUnique({ where: { id: 'metadata-element' } });
    check('undo restores all structural metadata and bumps the version', metaUndo.restored === 1 && metaAfter?.name === 'Before'
      && metaAfter.itemCode === 'FAN-1' && metaAfter.parentElementId === null && metaAfter.status === 'OK'
      && metaAfter.sourceOrder === 1 && metaAfter.equipType === 'ВЕНТИЛЯТОР' && metaAfter.role === 'ВЕНТИЛЯТОР'
      && metaAfter.sourceKind === 'cadFan' && metaAfter.instanceNo === 1 && metaAfter.instanceCount === 2 && metaAfter.version === 3);

    const createdBatch = await seedBatch('created', [{ id: 'created-element', existed: false,
      after: { name: 'Added fan', itemCode: 'FAN-NEW', parentElementId: 'created-root', role: 'ВЕНТИЛЯТОР', sourceOrder: 2, status: 'OK', tagId: 'created-item-tag' },
      newSpecs: spec('10') }]);
    const createdPlan = await planXmlRevisionUndo(createdBatch.batchId);
    check('new row can be safely marked for removal', createdPlan.action === 'restore');
    const createdUndo = await applyXmlRevisionUndo(createdBatch.batchId, createdPlan);
    const createdAfter = await prisma.componentElement.findUnique({ where: { id: 'created-element' }, include: { tags: true } });
    check('undo soft-removes created row, preserves its tag link and records history', createdUndo.restored === 1
      && createdAfter?.status === 'REMOVED' && createdAfter.version === 2 && createdAfter.tags.some((tag: any) => tag.id === 'created-item-tag')
      && await prisma.equipmentHistory.count({ where: { elementId: 'created-element', changeType: 'XML_REVISION_UNDO_CREATE' } }) === 1);

    const descendantBatch = await seedBatch('descendant', [{ id: 'descendant-created', existed: false,
      after: { name: 'New owner', itemCode: 'OWNER', parentElementId: 'descendant-root', status: 'OK' } }], true);
    check('active descendant outside the batch blocks safe undo', (await planXmlRevisionUndo(descendantBatch.batchId)).action === 'skip');

    const staleBatch = await seedBatch('stale-metadata', [{ id: 'stale-element', existed: true,
      old: { name: 'Old name', itemCode: 'FAN-1', monoblockId: 'stale-metadata-mono', parentElementId: null, status: 'OK', sourceOrder: 0, equipType: 'ПРОЧЕЕ', role: 'БЛОК', sourceKind: null, instanceNo: null, instanceCount: null, manual: false, version: 1 },
      after: { name: 'New name', itemCode: 'FAN-1', monoblockId: 'stale-metadata-mono', parentElementId: null, status: 'OK', sourceOrder: 0, equipType: 'ПРОЧЕЕ', role: 'БЛОК', sourceKind: null, instanceNo: null, instanceCount: null, manual: false, version: 2 } }]);
    const stalePlan = await planXmlRevisionUndo(staleBatch.batchId);
    await prisma.componentElement.update({ where: { id: 'stale-element' }, data: { role: 'РУЧНАЯ РОЛЬ' } });
    check('metadata edits after confirmation block undo even without a version bump', (await applyXmlRevisionUndo(staleBatch.batchId, stalePlan)).skipped === 1
      && (await prisma.componentElement.findUnique({ where: { id: 'stale-element' } }))?.role === 'РУЧНАЯ РОЛЬ');

    const reboundBatch = await seedBatch('rebound', []);
    const reboundPlan = await planXmlRevisionUndo(reboundBatch.batchId);
    await prisma.equipmentXmlSource.update({ where: { id: reboundBatch.sourceId }, data: { tagIdentifier: 'OTHER-TAG' } });
    check('source tag rebind blocks undo', (await applyXmlRevisionUndo(reboundBatch.batchId, reboundPlan)).skipped === 1);

    const ruleBatch = await seedBatch('rule-stale', []);
    const rulePlan = await planXmlRevisionUndo(ruleBatch.batchId);
    await prisma.equipmentXmlSource.update({ where: { id: ruleBatch.sourceId }, data: { selectedRule: JSON.stringify({ kind: 'selected-name', fileName: 'SYS-1.xml' }) } });
    check('filename rule change blocks undo even when the new rule still matches', (await applyXmlRevisionUndo(ruleBatch.batchId, rulePlan)).skipped === 1);

    const deletedBatch = await seedBatch('deleted-stale', []);
    const deletedPlan = await planXmlRevisionUndo(deletedBatch.batchId);
    await prisma.equipmentXmlSource.update({ where: { id: deletedBatch.sourceId }, data: { deletedAt: new Date() } });
    check('soft-deleting the source blocks undo', (await applyXmlRevisionUndo(deletedBatch.batchId, deletedPlan)).skipped === 1);

    const rollbackBatch = await seedBatch('rollback', [{ id: 'rollback-element', existed: true,
      old: { name: 'Before rollback', itemCode: 'FAN-1', monoblockId: 'rollback-mono', parentElementId: null, status: 'OK', sourceOrder: 0, equipType: 'ПРОЧЕЕ', role: 'БЛОК', sourceKind: null, instanceNo: null, instanceCount: null, manual: false, version: 1 },
      after: { name: 'After rollback', itemCode: 'FAN-1', monoblockId: 'rollback-mono', parentElementId: null, status: 'OK', sourceOrder: 0, equipType: 'ПРОЧЕЕ', role: 'БЛОК', sourceKind: null, instanceNo: null, instanceCount: null, manual: false, version: 2 } }]);
    const rollbackPlan = await planXmlRevisionUndo(rollbackBatch.batchId);
    const rollbackBefore = await prisma.componentElement.findUnique({ where: { id: 'rollback-element' } });
    const historyBefore = await prisma.equipmentHistory.count();
    const realTransaction = prisma.$transaction.bind(prisma);
    (prisma as any).$transaction = (work: any, options: any) => realTransaction((tx: any) => work(new Proxy(tx, {
      get(target, property) {
        if (property === 'equipmentXmlCandidate') return new Proxy(target.equipmentXmlCandidate, {
          get(delegate, method) {
            if (method === 'updateMany') return async () => { throw new Error('fixture candidate CAS failure'); };
            const value = Reflect.get(delegate, method, delegate); return typeof value === 'function' ? value.bind(delegate) : value;
          },
        });
        const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
      },
    })), options);
    const rollbackResult = await applyXmlRevisionUndo(rollbackBatch.batchId, rollbackPlan);
    (prisma as any).$transaction = realTransaction;
    const rollbackAfter = await prisma.componentElement.findUnique({ where: { id: 'rollback-element' } });
    check('candidate CAS failure rolls back metadata restoration and history atomically', rollbackResult.skipped === 1
      && rollbackAfter?.name === rollbackBefore?.name && rollbackAfter?.version === rollbackBefore?.version
      && await prisma.equipmentHistory.count() === historyBefore);

    console.log(`Equipment XML structural undo checks: ${checks} passed.`);
  } finally {
    setPrisma(null); await prisma.$disconnect(); fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
