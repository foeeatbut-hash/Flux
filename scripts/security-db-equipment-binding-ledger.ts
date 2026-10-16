/** Real-provider concurrency regression for first-read ledger creation and cleanup CAS retry. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setDialect } from '../server/ddl.js';
import { cleanupEquipmentDocumentBindingLedger, readEquipmentDocumentBindingLedger } from '../server/routes/equipmentDocumentBindings.js';

const provider = String(process.env.FLUX_BINDING_LEDGER_PROVIDER || '');
if (!provider) {
  console.log('Equipment binding ledger provider fixture skipped (FLUX_BINDING_LEDGER_PROVIDER unset).');
  process.exit(0);
}
assert.ok(provider === 'mysql' || provider === 'postgresql', 'FLUX_BINDING_LEDGER_PROVIDER must be mysql or postgresql');
const urlText = String(provider === 'mysql' ? process.env.FLUX_ID_MIGRATION_MARIA_FIXTURE_URL || '' : process.env.FLUX_ID_MIGRATION_PG_FIXTURE_URL || '');
const url = new URL(urlText);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'only loopback disposable provider fixtures are allowed');
assert.ok(url.pathname.toLowerCase().includes('fixture'), 'database name must explicitly include fixture');
const require = createRequire(import.meta.url);
const { PrismaClient } = require(provider === 'mysql' ? '../prisma-clients/client-mysql' : '../prisma-clients/client-pg');
const adapter = provider === 'mysql' ? new (require('@prisma/adapter-mariadb').PrismaMariaDb)(urlText)
  : new (require('@prisma/adapter-pg').PrismaPg)({ connectionString: urlText });
const prisma = new PrismaClient({ adapter });
const projectId = `binding-ledger-fixture-${randomUUID()}`;
const otherProjectId = `${projectId}-other`;
const key = `equipment_document_bindings:project:v2:${encodeURIComponent(projectId)}`;
const legacyKey = 'equipment_document_bindings:shared:v1';
const owner = '__shared__';
const barrier = (() => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  let arrivals = 0;
  return { promise, release, arrive: () => { arrivals += 1; if (arrivals === 2) release(); } };
})();

async function main() {
  try {
    setDialect(provider === 'mysql' ? 'mysql' : 'postgresql');
    await prisma.$executeRawUnsafe(provider === 'mysql'
      ? 'CREATE TABLE IF NOT EXISTS `AppSetting` (`id` VARCHAR(191) NOT NULL, `key` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NULL, `value` LONGTEXT NOT NULL, `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`), UNIQUE KEY `AppSetting_key_userId_key` (`key`, `userId`)) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
      : 'CREATE TABLE IF NOT EXISTS "AppSetting" ("id" TEXT NOT NULL, "key" TEXT NOT NULL, "userId" TEXT, "value" TEXT NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id"), CONSTRAINT "AppSetting_key_userId_key" UNIQUE ("key", "userId"))');
    await prisma.appSetting.deleteMany({ where: { key: { in: [key, legacyKey] }, userId: owner } });
    const legacy = { revision: 7, bindings: [
      { id: 'target-binding', projectId, kind: 'document', equipmentIds: [], systemId: 'fixture-system', fileName: 'target.docx', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'other-binding', projectId: otherProjectId, kind: 'document', equipmentIds: [], fileName: 'other.docx', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ], undo: [] };
    await prisma.appSetting.create({ data: { key: legacyKey, userId: owner, value: JSON.stringify(legacy) } });

    let initialNulls = 0;
    const racedRead = (tx: any) => new Proxy(tx, { get(target, property, receiver) {
      if (property !== 'appSetting') return Reflect.get(target, property, receiver);
      return new Proxy(target.appSetting, { get(model, method, modelReceiver) {
        if (method !== 'findFirst') return Reflect.get(model, method, modelReceiver);
        return async (args: any) => {
          const row = await model.findFirst(args);
          if (!row && args?.where?.key === key && args?.where?.userId === owner) {
            initialNulls += 1;
            barrier.arrive();
            await barrier.promise;
          }
          return row;
        };
      } });
    } });
    const readOne = prisma.$transaction((tx: any) => readEquipmentDocumentBindingLedger(racedRead(tx), projectId), { isolationLevel: 'ReadCommitted' });
    const readTwo = prisma.$transaction((tx: any) => readEquipmentDocumentBindingLedger(racedRead(tx), projectId), { isolationLevel: 'ReadCommitted' });
    const [ledgerOne, ledgerTwo] = await Promise.all([readOne, readTwo]);
    assert.equal(initialNulls, 2, 'both transactions must observe the missing project ledger before either writes');
    assert.equal(ledgerOne.revision, 7);
    assert.equal(ledgerTwo.revision, 7);
    assert.equal(await prisma.appSetting.count({ where: { key, userId: owner } }), 1);
    console.log(`✓ ${provider}: concurrent first reads migrate one ledger without aborting either transaction`);

    let forcedLose = false;
    const casLossPrisma = new Proxy(prisma, { get(target, property, receiver) {
      if (property !== 'appSetting') return Reflect.get(target, property, receiver);
      return new Proxy(target.appSetting, { get(model, method, modelReceiver) {
        if (method !== 'updateMany') return Reflect.get(model, method, modelReceiver);
        return async (args: any) => {
          if (!forcedLose && args?.where?.id) {
            forcedLose = true;
            const current = await target.appSetting.findFirst({ where: { key: legacyKey, userId: owner } });
            const value = JSON.parse(current.value);
            value.bindings.push({ id: 'concurrent-other-binding', projectId: otherProjectId, kind: 'document', equipmentIds: [], fileName: 'concurrent.docx' });
            await target.appSetting.updateMany({ where: { id: current.id }, data: { value: JSON.stringify(value) } });
          }
          return model.updateMany(args);
        };
      } });
    } });
    await cleanupEquipmentDocumentBindingLedger(casLossPrisma, projectId);
    assert.ok(forcedLose, 'the fixture must force one compare-and-swap loss');
    const finalLegacy = JSON.parse((await prisma.appSetting.findFirst({ where: { key: legacyKey, userId: owner } }))!.value);
    assert.ok(finalLegacy.bindings.some((row: any) => row.id === 'concurrent-other-binding' && row.projectId === otherProjectId));
    assert.ok(finalLegacy.bindings.some((row: any) => row.id === 'other-binding' && row.projectId === otherProjectId));
    assert.ok(!finalLegacy.bindings.some((row: any) => row.projectId === projectId));
    assert.equal(await prisma.appSetting.count({ where: { key, userId: owner } }), 0);
    console.log(`✓ ${provider}: cleanup retries a lost CAS and retains concurrent writes from other projects`);
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: { in: [key, legacyKey] }, userId: owner } }).catch(() => {});
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
