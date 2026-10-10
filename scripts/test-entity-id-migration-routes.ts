/** Real HTTP authorization and journal-isolation checks on an isolated SQLite database. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setDialect } from '../server/ddl.js';
import { setPrisma } from '../server/context.js';
import { registerEntityIdMigrationRoutes } from '../server/routes/entityIdMigration.js';
import { registerSettingsRoutes } from '../server/routes/settings.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-id-migration-routes-'));
const dbPath = path.join(dir, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
const check = (label: string, ok: unknown, detail?: unknown) => {
  assert.ok(ok, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  checks++;
  console.log(`✓ ${label}`);
};

async function main() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.header('x-test-role');
    if (role) (req as any).authUser = { id: role === 'OWNER' ? 'owner-user' : 'ordinary-user', role };
    next();
  });
  registerEntityIdMigrationRoutes(app);
  registerSettingsRoutes(app);
  const server = createServer(app);
  let listening = false;
  try {
    setDialect('sqlite');
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);

    const projectA = '11111111-1111-4111-8111-111111111111';
    const projectB = '22222222-2222-4222-8222-222222222222';
    await prisma.project.create({ data: { id: projectA, name: 'Route test A' } });
    await prisma.project.create({ data: { id: projectB, name: 'Route test B' } });
    await prisma.projectMember.create({ data: { projectId: projectA, userId: 'ordinary-user' } });
    await prisma.projectMember.create({ data: { projectId: projectB, userId: 'someone-else' } });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    listening = true;
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const call = (pathName: string, role?: string, method = 'GET', body?: unknown) => fetch(`${base}${pathName}`, {
      method,
      headers: { ...(role ? { 'x-test-role': role } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const noSession = await call('/api/settings/entity-id-migration/history');
    const deniedPreview = await call('/api/settings/entity-id-migration/preview', 'USER', 'POST', {});
    const previewResponse = await call('/api/settings/entity-id-migration/preview', 'OWNER', 'POST', {});
    const preview = await previewResponse.json() as any;
    check('migration history requires an authenticated user', noSession.status === 401);
    check('ordinary users cannot preview migration', deniedPreview.status === 403);
    check('owner can preview and receives a plan token', previewResponse.status === 200 && /^[a-f0-9]{64}$/.test(preview.planToken), preview);

    const deniedApply = await call('/api/settings/entity-id-migration/apply', 'USER', 'POST', { planToken: preview.planToken });
    check('ordinary users cannot apply a migration', deniedApply.status === 403);
    const applyResponse = await call('/api/settings/entity-id-migration/apply', 'OWNER', 'POST', { planToken: preview.planToken });
    const applied = await applyResponse.json() as any;
    check('owner can apply the previewed migration', applyResponse.status === 200 && applied.state === 'APPLIED' && !!applied.migrationId, applied);

    const ownerHistoryResponse = await call('/api/settings/entity-id-migration/history', 'OWNER');
    const ownerHistory = await ownerHistoryResponse.json() as any;
    const userHistoryResponse = await call('/api/settings/entity-id-migration/history', 'USER');
    const userHistory = await userHistoryResponse.json() as any;
    const ownerMigration = ownerHistory.migrations?.find((m: any) => m.migrationId === applied.migrationId);
    const userMigration = userHistory.migrations?.find((m: any) => m.migrationId === applied.migrationId);
    check('owner history includes both migrated projects', ownerHistoryResponse.status === 200 && ownerMigration?.projectIds.length === 2, ownerMigration);
    check('user history exposes only projects visible through membership', userHistoryResponse.status === 200 && userMigration?.projectIds.length === 1 && userMigration.projectIds[0] === projectA && userMigration.mappings.every((m: any) => m.projectId === projectA), userMigration);

    const journal = await prisma.appSetting.findFirst({ where: { key: { startsWith: 'entity_id_migration:' } } });
    assert.ok(journal, 'migration journal row should exist');
    const genericReadOwner = await call(`/api/settings/${encodeURIComponent(journal.key)}`, 'OWNER');
    const genericReadUser = await call(`/api/settings/${encodeURIComponent(journal.key)}`, 'USER');
    const genericWriteOwner = await call(`/api/settings/${encodeURIComponent(journal.key)}`, 'OWNER', 'POST', { value: 'tampered' });
    const journalAfter = await prisma.appSetting.findUnique({ where: { id: journal.id } });
    check('generic settings GET cannot expose migration journal to owner or user', genericReadOwner.status === 403 && genericReadUser.status === 403);
    check('generic settings POST cannot overwrite migration journal', genericWriteOwner.status === 403 && journalAfter?.value === journal.value);

    const deniedUndo = await call('/api/settings/entity-id-migration/undo', 'USER', 'POST', { migrationId: applied.migrationId });
    const undoResponse = await call('/api/settings/entity-id-migration/undo', 'OWNER', 'POST', { migrationId: applied.migrationId });
    check('ordinary users cannot undo a migration', deniedUndo.status === 403);
    check('owner can undo the applied migration', undoResponse.status === 200 && (await prisma.project.findUnique({ where: { id: projectA } })) !== null);
    console.log(`\n${checks} migration HTTP route checks passed`);
  } finally {
    if (listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await prisma.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
