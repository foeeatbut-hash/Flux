/** Реальные SQLite/MariaDB/PostgreSQL: схема и проектный план классификации. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { setDialect } from '../server/ddl.js';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { ensureRemoteSchema } from '../server/schema-sync.js';
import { setPrisma, setBroadcaster } from '../server/context.js';
import { registerEquipmentClassRoutes } from '../server/routes/equipmentClasses.js';

const require = createRequire(import.meta.url);
assert.equal(process.env.FLUX_TEST_FIXTURE_DOCFLOW_STAGE2, '1', 'нужен marker одноразовой fixture');
const provider = process.env.FLUX_DOCFLOW_STAGE2_PROVIDER || 'sqlite';
assert.ok(['sqlite', 'mysql', 'postgresql'].includes(provider));
const local = provider === 'sqlite';
const tmp = local ? fs.mkdtempSync(path.join(os.tmpdir(), 'flux-stage2-db-')) : '';
const file = path.join(tmp, 'fixture.sqlite');
const endpoint = local ? `file:${file}` : String(process.env.FLUX_DOCFLOW_STAGE2_FIXTURE_URL || '');
if (!local) {
  const url = new URL(endpoint);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'только локальная fixture');
  assert.match(url.pathname, /^\/flux_docflow_stage2_fixture(?:_[a-z0-9]+)?$/);
}
const clientPath = local ? '../prisma-clients/client-sqlite' : provider === 'mysql' ? '../prisma-clients/client-mysql' : '../prisma-clients/client-pg';
const { PrismaClient } = require(clientPath);
const adapter = local ? new (require('@prisma/adapter-better-sqlite3').PrismaBetterSqlite3)({ url: endpoint })
  : provider === 'mysql' ? new (require('@prisma/adapter-mariadb').PrismaMariaDb)(endpoint)
  : new (require('@prisma/adapter-pg').PrismaPg)({ connectionString: endpoint });
const db = new PrismaClient({ adapter });

async function main() {
  setDialect(provider as 'sqlite' | 'mysql' | 'postgresql');
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.authUser = req.headers['x-denied'] ? { id: 'denied', role: 'USER' } : { id: 'admin', role: 'ADMIN' }; next(); });
  registerEquipmentClassRoutes(app);
  const server = await new Promise<any>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/equipment/projects`;
  const call = async (project: string, action: string, body?: any, denied = false) => {
    const r = await fetch(`${base}/${project}/catalog-classes/${action}`, { method: action === 'last' ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(denied ? { 'x-denied': '1' } : {}) }, ...(action === 'last' ? {} : { body: JSON.stringify(body || {}) }) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    const schemaName = local ? 'schema.prisma' : provider === 'mysql' ? 'schema.mariadb.prisma' : 'schema.postgresql.prisma';
    const schema = fs.readFileSync(path.join('prisma', schemaName), 'utf8');
    if (local) await bootstrapLocalDatabase(file, db, schema, () => {});
    else {
      const existing = await db.$queryRawUnsafe(provider === 'mysql' ? 'SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE()' : "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'");
      assert.equal(existing.length, 0, 'нужна новая пустая fixture');
      const logs: string[] = [];
      await ensureRemoteSchema(db, provider as 'mysql' | 'postgresql', schema, x => logs.push(x));
      assert.deepEqual(logs.filter(x => /Не удалось|Пропуск|Ошибка при/.test(x)), [], 'ошибка подготовки схемы');
    }
    setPrisma(db); setBroadcaster(() => {});
    await db.project.createMany({ data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
    await db.projectMember.createMany({ data: [{ projectId: 'a', userId: 'denied' }, { projectId: 'b', userId: 'other' }] });
    await db.catalogClass.create({ data: { id: 'class', code: 'CLASS' } });
    await db.docflowSettings.create({ data: { projectId: 'a', config: JSON.stringify({ equipmentClasses: [{ type: 'FAN', classId: 'class' }] }) } });
    await db.equipment.create({ data: { id: 'shared', type: 'FAN', description: 'fixture' } });
    await db.tag.createMany({ data: [{ id: 'local', identifier: 'L', projectId: 'a', equipmentId: 'shared' }, { id: 'foreign', identifier: 'F', projectId: 'b', equipmentId: 'shared' }] });
    for (const action of ['plan', 'apply', 'undo', 'last']) assert.equal((await call('a', action, { planId: 'none' }, true)).status, 403, `право ${action}`);
    const first = await call('a', 'plan', { tagIds: ['local'] });
    const second = await call('a', 'plan', { tagIds: ['local'] });
    assert.equal(first.status, 200); assert.equal(first.body.rows[0].classId, 'class');
    assert.equal((await db.tag.findUnique({ where: { id: 'local' } })).equipmentId, 'shared', 'предпросмотр не записывает');
    const applied = await call('a', 'apply', { planId: first.body.id });
    assert.equal(applied.status, 200); assert.equal(applied.body.count, 1);
    assert.equal((await call('a', 'apply', { planId: second.body.id })).status, 409, 'устаревший план блокируется');
    assert.equal((await db.equipment.findUnique({ where: { id: 'shared' } })).catalogClassId, null, 'общая запись сохранена');
    assert.equal((await db.tag.findUnique({ where: { id: 'foreign' } })).equipmentId, 'shared', 'чужой тег сохранён');
    const localTag = await db.tag.findUnique({ where: { id: 'local' }, include: { equipment: true } });
    assert.equal(localTag.equipment.catalogClassId, 'class', 'класс записан в проектную копию');
    assert.equal((await call('a', 'last')).body.id, first.body.id);
    assert.equal((await call('a', 'undo', { planId: first.body.id })).status, 200);
    assert.equal((await db.tag.findUnique({ where: { id: 'local' } })).equipmentId, 'shared');
    assert.equal((await db.docflowPlan.findUnique({ where: { id: first.body.id } })).state, 'undone');
    console.log(`✓ ${provider}: схема, права, план, CAS, общая запись и отмена`);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.$disconnect(); if (local) fs.rmSync(tmp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
