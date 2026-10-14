/** Настоящая SQLite проверяет атомарность общего журнала, право project.manage и фильтрацию ACL для привязок. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setDialect } from '../server/ddl.js';
import { setPrisma } from '../server/context.js';
import { actorMay } from '../server/projectAccess.js';
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
  // x-role задаёт роль, x-manage — личное право project.manage; сама проверка — настоящая actorMay.
  app.use((req, _res, next) => {
    const actor = req.header('x-actor');
    if (actor) (req as any).authUser = { id: actor, role: req.header('x-role') || 'USER', ...(req.header('x-manage') ? { permissions: JSON.stringify({ 'project.manage': { enabled: true } }) } : {}) };
    next();
  });
  registerProjectFolderBindingRoutes(app, { mayManage: req => actorMay((req as any).authUser, async () => null) });
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
    const sha = (path: string) => createHash('sha256').update(path).digest('hex');
    const k1 = sha('//srv/share/engineering'); const k2 = sha('//srv/share/shared'); const kPublic = sha('//srv/share/public');
    const headers = (actor: string, extra: Record<string, string> = {}) => ({ 'x-actor': actor, ...extra });
    const MANAGER = { 'x-manage': '1' };
    const get = (actor: string | null, extra: Record<string, string> = {}) => fetch(`${base}/api/explorer/project-bindings`, { headers: actor ? headers(actor, extra) : {} });
    const post = (actor: string, expectedRevision: number, operation: unknown, extra: Record<string, string> = {}) => fetch(`${base}/api/explorer/project-bindings`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers(actor, extra) }, body: JSON.stringify({ expectedRevision, operation }) });
    const ledgerRow = () => prisma.appSetting.findFirst({ where: { key: 'explorer_project_bindings:shared:v1' } });

    check('GET requires the authenticated session', (await get(null)).status === 401);
    const denied = await post('u-plain', 0, { kind: 'upsert', binding: { id: 'x', locationKey: k1, projectId: p1, label: 'Engineering' } });
    check('a user without project.manage gets 403 on POST and no ledger row appears', denied.status === 403 && !(await ledgerRow()));
    const set1 = await post('m1', 0, { kind: 'upsert', binding: { id: 'binding-1', locationKey: k1, projectId: p1, label: 'Engineering' } }, MANAGER);
    const set2 = await post('m2', 0, { kind: 'upsert', binding: { id: 'binding-2', locationKey: k2, projectId: p1, label: 'Shared' } }, MANAGER);
    const statuses = [set1.status, set2.status].sort();
    check('concurrent initial writes have one winner and one conflict', statuses[0] === 200 && statuses[1] === 409, statuses);
    const rows = await prisma.appSetting.findMany({ where: { key: 'explorer_project_bindings:shared:v1' } });
    check('a single shared ledger row exists', rows.length === 1);
    const stored = await get('u-plain'); const visible = await stored.json() as any;
    check('a plain user reads the winner binding at revision one, read-only', stored.status === 200 && visible.revision === 1 && visible.bindings.length === 1 && visible.canManage === false && visible.undo.length === 0);
    const original = await ledgerRow();
    assert.ok(original);
    check('stale revision replay is rejected', (await post('m1', 0, { kind: 'remove', bindingId: visible.bindings[0].id }, MANAGER)).status === 409);
    const adminRead = await (await get('adm', { 'x-role': 'ADMIN' })).json() as any;
    check('an administrator sees the same record and may manage it', adminRead.canManage === true && adminRead.bindings[0].locationKey === visible.bindings[0].locationKey);

    await prisma.projectMember.create({ data: { id: 'membership-p1-u2', projectId: p1, userId: 'u2', addedBy: 'u2' } });
    const hidden = await get('m1', MANAGER); const hiddenBody = await hidden.json() as any;
    check('a project hidden from the user hides its binding details and undo history', hidden.status === 200 && hiddenBody.bindings.length === 0 && hiddenBody.undo.length === 0);
    const removeHidden = await post('m1', 1, { kind: 'remove', bindingId: visible.bindings[0].id }, MANAGER);
    check('a manager cannot unbind a project they cannot see', removeHidden.status === 403);
    const visibleUnrelated = await post('m1', 1, { kind: 'upsert', binding: { id: 'binding-public', locationKey: kPublic, projectId: p2, label: 'Public' } }, MANAGER);
    const updated = await visibleUnrelated.json() as any;
    check('writes preserve hidden records while returning only accessible rows', visibleUnrelated.status === 200 && updated.bindings.length === 1 && updated.bindings[0].projectId === p2);
    const preserved = JSON.parse((await prisma.appSetting.findUnique({ where: { id: original.id } }))!.value);
    check('hidden project row remains opaque in the authoritative ledger', preserved.bindings.some((row: any) => row.projectId === p1) && preserved.bindings.some((row: any) => row.projectId === p2));
    const hiddenUndo = preserved.undo.at(-1)?.id;
    const deniedUndo = await post('m1', 2, { kind: 'undo', undoId: hiddenUndo }, MANAGER);
    check('undo spanning a hidden project is denied without erasing hidden state', deniedUndo.status === 403 && JSON.parse((await prisma.appSetting.findUnique({ where: { id: original.id } }))!.value).bindings.length === 2);
    const adminSees = await (await get('adm', { 'x-role': 'ADMIN' })).json() as any;
    check('an administrator still sees every binding', adminSees.bindings.length === 2);

    await prisma.projectMember.deleteMany({ where: { projectId: p1, userId: 'u2' } });
    const latest = await get('m1', MANAGER); const latestBody = await latest.json() as any;
    const undoId = latestBody.undo.at(-1)?.id;
    const forged = await post('m1', 2, { kind: 'undo', undoId: 'client-invented' }, MANAGER);
    check('client cannot invent an undo snapshot', forged.status === 409);
    check('a non-manager cannot undo', (await post('u-plain', 2, { kind: 'undo', undoId })).status === 403);
    const undone = await post('m1', 2, { kind: 'undo', undoId }, MANAGER);
    const final = await undone.json() as any;
    check('server undo restores the complete prior binding snapshot', undone.status === 200 && final.revision === 3 && final.bindings.length === 1 && final.bindings[0].projectId === p1);
    const otherUser = await (await get('someone-else')).json() as any;
    check('every user reads the same shared ledger', otherUser.revision === 3 && otherUser.bindings.length === 1 && otherUser.bindings[0].id === final.bindings[0].id);
    console.log(`\n${checks} SQLite binding route checks passed`);
  } finally {
    if (listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await prisma.$disconnect(); fs.rmSync(dir, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
