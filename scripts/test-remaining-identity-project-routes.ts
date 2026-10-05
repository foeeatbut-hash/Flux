import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { setPrisma } from '../server/context.js';
import { registerProjectRoutes } from '../server/routes/projects.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { PrismaClient } = require('@prisma/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-identity-project-routes-'));
const dbPath = path.join(tempDir, 'synthetic.sqlite');
const raw = new Database(dbPath);
raw.exec(`
  CREATE TABLE "Project" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT NOT NULL, "code" TEXT NOT NULL DEFAULT '', "customer" TEXT NOT NULL DEFAULT '', "contractor" TEXT NOT NULL DEFAULT '', "description" TEXT NOT NULL DEFAULT '', "info" TEXT NOT NULL DEFAULT '', "status" TEXT NOT NULL DEFAULT 'ACTIVE', "system" BOOLEAN NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE "ProjectMember" ("id" TEXT PRIMARY KEY NOT NULL, "projectId" TEXT NOT NULL, "userId" TEXT NOT NULL, "addedBy" TEXT NOT NULL, "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);
raw.close();
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as any).authUser = req.header('x-test-role') === 'ADMIN'
    ? { id: 'synthetic-admin', role: 'ADMIN', isActive: true }
    : { id: 'synthetic-reader', role: 'ENGINEER_VENT', isActive: true };
  next();
});
registerProjectRoutes(app, {
  enforce: async (req, res) => {
    if ((req as any).authUser?.role === 'ADMIN') return true;
    res.status(403).json({ error: 'Synthetic denied' });
    return false;
  },
  notifyAll: async () => undefined,
});

let server: ReturnType<typeof app.listen> | undefined;
let checks = 0;
const check = (condition: unknown, label: string) => { assert.ok(condition, label); checks++; console.log(`✓ ${label}`); };

async function main() {
  try {
    setPrisma(prisma);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No dynamic loopback address');
    const base = `http://127.0.0.1:${address.port}`;
    const api = async (role: string, method: string, route: string, body?: unknown) => {
      const response = await fetch(`${base}${route}`, { method, headers: { 'x-test-role': role, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() as any };
    };

    const denied = await api('ENGINEER_VENT', 'POST', '/api/projects', { name: 'Should not exist' });
    check(denied.status === 403 && await prisma.project.count() === 0, 'non-admin create is denied and leaves the synthetic DB unchanged');
    const created = await api('ADMIN', 'POST', '/api/projects', { name: 'Synthetic identity project', code: 'SYN-ID-01', customer: 'Synthetic customer', description: 'Before edit' });
    check(created.status === 200 && created.body.project?.id && created.body.project.name === 'Synthetic identity project', 'ADMIN create returns the new synthetic project');
    const createdId = String(created.body.project.id);
    const afterCreate = await prisma.project.findUnique({ where: { id: createdId } });
    check(afterCreate?.code === 'SYN-ID-01' && afterCreate.customer === 'Synthetic customer', 'create fields persist in SQLite and read back');

    const edited = await api('ADMIN', 'PUT', `/api/projects/${encodeURIComponent(createdId)}`, { name: 'Synthetic project edited', description: 'After edit' });
    const afterEdit = await prisma.project.findUnique({ where: { id: createdId } });
    check(edited.status === 200 && afterEdit?.name === 'Synthetic project edited' && afterEdit.description === 'After edit' && afterEdit.code === 'SYN-ID-01', 'edit persists changed fields and retains omitted fields on readback');
    const visible = await api('ADMIN', 'GET', '/api/projects');
    check(visible.status === 200 && visible.body.projects.some((row: any) => row.id === createdId), 'list readback includes the created project');

    const deleted = await api('ADMIN', 'DELETE', `/api/projects/${encodeURIComponent(createdId)}`);
    const afterDelete = await prisma.project.findUnique({ where: { id: createdId } });
    check(deleted.status === 200 && deleted.body.success === true && afterDelete === null, 'delete removes only the synthetic project and readback confirms absence');
    const deniedDelete = await api('ENGINEER_VENT', 'DELETE', `/api/projects/${encodeURIComponent(createdId)}`);
    check(deniedDelete.status === 403, 'non-admin delete is denied');
    console.log(`PASS ${checks} project-route assertions; temporary synthetic SQLite and per-test project only`);
  } finally {
    await prisma.$disconnect();
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
