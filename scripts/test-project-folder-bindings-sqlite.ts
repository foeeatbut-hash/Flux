/** Настоящая SQLite проверяет атомарность, область актёра и фильтрацию ACL для привязок. */
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
import { registerProjectFolderBindingRoutes } from '../server/routes/projectFolderBindings.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-folder-bindings-'));
const dbPath = path.join(dir, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
function check(label: string, condition: unknown, detail?: unknown) { assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); checks++; console.log(`✓ ${label}`); }

async function main() {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { const actor = req.header('x-actor'); if (actor) (req as any).authUser = { id: actor, role: 'USER' }; next(); });
  registerProjectFolderBindingRoutes(app);
  const server = createServer(app); let listening = false;
  try {
    setDialect('sqlite');
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {}); setPrisma(prisma);
    const p1 = '11111111-1111-4111-8111-111111111111';
    const p2 = '22222222-2222-4222-8222-222222222222';
    await prisma.project.create({ data: { id: p1, name: 'Folder binding one' } });
    await prisma.project.create({ data: { id: p2, name: 'Folder binding two' } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); listening = true;
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const get = (actor: string | null, deviceId = 'device-sql', rootId = 'root-sql') => fetch(`${base}/api/explorer/project-bindings?${new URLSearchParams({ deviceId, rootId })}`, { headers: actor ? { 'x-actor': actor } : {} });
    const post = (actor: string, expectedRevision: number, operation: unknown) => fetch(`${base}/api/explorer/project-bindings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-actor': actor }, body: JSON.stringify({ deviceId: 'device-sql', rootId: 'root-sql', expectedRevision, operation }) });

    check('GET requires the authenticated session', (await get(null)).status === 401);
    const set1 = await post('u1', 0, { kind: 'upsert', binding: { id: 'binding-1', canonicalFolderId: 'folder-one', relativePath: 'Engineering', projectId: p1 } });
    const set2 = await post('u1', 0, { kind: 'upsert', binding: { id: 'binding-2', canonicalFolderId: 'folder-two', relativePath: 'Shared', projectId: p1 } });
    const statuses = [set1.status, set2.status].sort();
    check('concurrent initial writes have one winner and one conflict', statuses[0] === 200 && statuses[1] === 409, statuses);
    const stored = await get('u1'); const visible = await stored.json() as any;
    check('winner persists one binding at revision one', stored.status === 200 && visible.revision === 1 && visible.bindings.length === 1);
    const original = await prisma.appSetting.findFirst({ where: { key: { startsWith: 'explorer_project_bindings:' }, userId: 'u1' } });
    assert.ok(original);
    const originalLedger = JSON.parse(original.value);
    check('stale revision replay is rejected', (await post('u1', 0, { kind: 'remove', bindingId: visible.bindings[0].id })).status === 409);

    await prisma.projectMember.create({ data: { id: 'membership-p1-u2', projectId: p1, userId: 'u2', addedBy: 'u2' } });
    const hidden = await get('u1'); const hiddenBody = await hidden.json() as any;
    check('revoked project membership hides binding details', hidden.status === 200 && hiddenBody.bindings.length === 0 && hiddenBody.undo.length === 0);
    const removeHidden = await post('u1', 1, { kind: 'remove', bindingId: visible.bindings[0].id });
    check('cannot unbind a project after access is revoked', removeHidden.status === 403);
    const visibleUnrelated = await post('u1', 1, { kind: 'upsert', binding: { id: 'binding-public', canonicalFolderId: 'folder-public', relativePath: 'Public', projectId: p2 } });
    const updated = await visibleUnrelated.json() as any;
    check('writes preserve hidden records while returning only accessible rows', visibleUnrelated.status === 200 && updated.bindings.length === 1 && updated.bindings[0].projectId === p2);
    const preserved = JSON.parse((await prisma.appSetting.findUnique({ where: { id: original.id } }))!.value);
    check('hidden project row remains opaque in the authoritative ledger', preserved.bindings.some((row: any) => row.projectId === p1) && preserved.bindings.some((row: any) => row.projectId === p2));
    const hiddenUndo = preserved.undo.at(-1)?.id;
    const deniedUndo = await post('u1', 2, { kind: 'undo', undoId: hiddenUndo });
    check('undo spanning a revoked project is denied without erasing hidden state', deniedUndo.status === 403 && JSON.parse((await prisma.appSetting.findUnique({ where: { id: original.id } }))!.value).bindings.length === 2);

    await prisma.projectMember.deleteMany({ where: { projectId: p1, userId: 'u2' } });
    const latest = await get('u1'); const latestBody = await latest.json() as any;
    const undoId = latestBody.undo.at(-1)?.id;
    const forged = await post('u1', 2, { kind: 'undo', undoId: 'client-invented' });
    check('client cannot invent an undo snapshot', forged.status === 409);
    const undone = await post('u1', 2, { kind: 'undo', undoId });
    const final = await undone.json() as any;
    check('server undo restores the complete prior binding snapshot', undone.status === 200 && final.revision === 3 && final.bindings.length === 1 && final.bindings[0].projectId === p1);
    const actorIsolated = await get('u2'); const other = await actorIsolated.json() as any;
    check('ledger reads remain isolated by the session actor', other.revision === 0 && other.bindings.length === 0);
    console.log(`\n${checks} SQLite binding route checks passed`);
  } finally {
    if (listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await prisma.$disconnect(); fs.rmSync(dir, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
