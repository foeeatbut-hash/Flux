/** Классификация проектных тегов: HTTP, изолированная SQLite и конкурентные планы. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { registerEquipmentClassRoutes } from '../server/routes/equipmentClasses.js';
import { setPrisma, setBroadcaster } from '../server/context.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-classes-'));
const file = path.join(dir, 'db.sqlite');
const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
let checks = 0;
function check(name: string, value: unknown) { assert.ok(value, name); checks++; console.log(`✓ ${name}`); }

async function main() {
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => {
    const id = String(req.headers['x-user'] || 'admin');
    req.authUser = id === 'admin' ? { id, role: 'ADMIN' } : { id, role: 'USER', permissions: JSON.stringify({ 'equipment.manage': { enabled: id !== 'denied', until: null } }) };
    next();
  });
  registerEquipmentClassRoutes(app);
  const server = await new Promise<any>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/equipment/projects`;
  const call = async (project: string, action: string, body?: any, user = 'admin') => {
    const r = await fetch(`${base}/${project}/catalog-classes/${action}`, { method: action === 'last' ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, ...(action === 'last' ? {} : { body: JSON.stringify(body || {}) }) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    await bootstrapLocalDatabase(file, db, fs.readFileSync('prisma/schema.prisma', 'utf8'), () => {});
    setPrisma(db); setBroadcaster(() => {});
    for (const id of ['a', 'b']) await db.project.create({ data: { id, name: id } });
    await db.projectMember.createMany({ data: [{ projectId: 'a', userId: 'member' }, { projectId: 'a', userId: 'denied' }, { projectId: 'b', userId: 'other' }] });
    await db.catalogClass.createMany({ data: [{ id: 'class-a', code: 'A' }, { id: 'class-b', code: 'B' }] });
    await db.docflowSettings.create({ data: { projectId: 'a', config: JSON.stringify({ equipmentClasses: [{ type: 'FAN', classId: 'class-a' }] }) } });
    await db.equipment.create({ data: { id: 'shared', type: 'FAN', description: 'Общее' } });
    for (const [id, projectId, equipmentId] of [['local', 'a', 'shared'], ['foreign', 'b', 'shared'], ['manual', 'a', null], ['snapshot', 'a', null]] as const)
      await db.tag.create({ data: { id, identifier: id, projectId, equipmentId } });
    await db.equipmentSystem.create({ data: { id: 'sys', name: 'sys', projectId: 'a' } });
    await db.monoblock.create({ data: { id: 'mono', name: 'mono', systemId: 'sys' } });
    await db.componentElement.create({ data: { id: 'el', name: 'el', itemCode: 'el', monoblockId: 'mono', equipType: 'FAN', tags: { connect: { id: 'snapshot' } } } });
    await db.appSetting.create({ data: { key: 'equipment_catalog_binding:el', value: JSON.stringify({ mode: 'catalog', sourceType: 'family', snapshot: { classId: 'class-b' } }) } });
    for (const action of ['plan', 'apply', 'undo', 'last']) {
      check(`нет права: ${action} — 403`, (await call('a', action, { planId: 'x' }, 'denied')).status === 403);
      check(`чужой проект: ${action} — 403`, (await call('b', action, { planId: 'x' }, 'member')).status === 403);
    }
    check('несуществующий проект — 404', (await call('missing', 'plan')).status === 404);
    check('чужой тег — 403', (await call('a', 'plan', { tagIds: ['foreign'] })).status === 403);
    check('неизвестный тег — 403', (await call('a', 'plan', { tagIds: ['unknown'] })).status === 403);
    check('неизвестный класс — 400', (await call('a', 'plan', { tagIds: ['local'], overrides: [{ tagId: 'local', classId: 'absent' }] })).status === 400);
    const original = await db.equipment.findUnique({ where: { id: 'shared' } });
    const plan = await call('a', 'plan', { tagIds: ['local', 'manual', 'snapshot'], overrides: [{ tagId: 'manual', type: 'FAN', classId: 'class-b' }] });
    check('план создан', plan.status === 200);
    const rows = Object.fromEntries(plan.body.rows.map((r: any) => [r.tagId, r]));
    check('соответствие типа, ручной и семейство', (rows.local as any).classId === 'class-a' && (rows.manual as any).classId === 'class-b' && (rows.snapshot as any).classId === 'class-b');
    check('предпросмотр не меняет оборудование и привязки', await db.equipment.count() === 1 && (await db.tag.findUnique({ where: { id: 'local' } })).equipmentId === 'shared' && (await db.tag.findUnique({ where: { id: 'manual' } })).equipmentId === null);
    check('чужой автор не применяет план', (await call('a', 'apply', { planId: plan.body.id }, 'member')).status === 403);
    check('чужой проект не применяет план', (await call('b', 'apply', { planId: plan.body.id })).status === 403);
    const concurrent = await call('a', 'plan', { tagIds: ['local'] });
    const applied = await call('a', 'apply', { planId: plan.body.id });
    check('применены три тега', applied.status === 200 && applied.body.count === 3);
    check('повтор применения идемпотентен', JSON.stringify((await call('a', 'apply', { planId: plan.body.id })).body) === JSON.stringify(applied.body));
    check('параллельный план устарел', (await call('a', 'apply', { planId: concurrent.body.id })).status === 409);
    check('общее оборудование и чужой тег не изменены', JSON.stringify(await db.equipment.findUnique({ where: { id: 'shared' } })) === JSON.stringify(original) && (await db.tag.findUnique({ where: { id: 'foreign' } })).equipmentId === 'shared');
    check('last находит применённый план', (await call('a', 'last')).body.id === plan.body.id);
    check('отмена восстанавливает ссылки', (await call('a', 'undo', { planId: plan.body.id })).status === 200 && (await db.tag.findUnique({ where: { id: 'local' } })).equipmentId === 'shared' && (await db.tag.findUnique({ where: { id: 'manual' } })).equipmentId === null);
    const stale = await call('a', 'plan', { tagIds: ['local'] });
    await call('a', 'apply', { planId: stale.body.id });
    const tag = await db.tag.findUnique({ where: { id: 'local' } });
    await db.tag.update({ where: { id: 'local' }, data: { brand: 'Изменено', updatedAt: new Date(tag.updatedAt.getTime() + 1000) } });
    check('отмена не затирает последующую правку', (await call('a', 'undo', { planId: stale.body.id })).status === 409 && (await db.tag.findUnique({ where: { id: 'local' } })).brand === 'Изменено');
    // Два плана, построенные по одному состоянию, не могут оба записать тег.
    await db.tag.update({ where: { id: 'local' }, data: { equipmentId: 'shared' } });
    const p1 = await call('a', 'plan', { tagIds: ['local'] });
    const p2 = await call('a', 'plan', { tagIds: ['local'] });
    const concurrentResults = await Promise.all([call('a', 'apply', { planId: p1.body.id }), call('a', 'apply', { planId: p2.body.id })]);
    check('одновременные планы одного тега: один успех и один конфликт', concurrentResults.map(r => r.status).sort().join(',') === '200,409');
    const winner = concurrentResults[0].status === 200 ? p1 : p2;
    check('после гонки тег указывает на одну классифицированную копию', await db.equipment.count({ where: { id: { not: 'shared' }, tags: { some: { id: 'local' } } } }) === 1);
    check('отмена победителя гонки', (await call('a', 'undo', { planId: winner.body.id })).status === 200);
    const same = await call('a', 'plan', { tagIds: ['local'] });
    const sameResults = await Promise.all([call('a', 'apply', { planId: same.body.id }), call('a', 'apply', { planId: same.body.id })]);
    check('повтор одного плана одновременно: один успех, второй успех или конфликт', sameResults.some(r => r.status === 200) && sameResults.every(r => r.status === 200 || r.status === 409));
    check('повтор одного плана не создаёт лишних копий', await db.equipment.count({ where: { id: { not: 'shared' }, tags: { some: { id: 'local' } } } }) === 1);
    check('отмена одновременно применённого плана', (await call('a', 'undo', { planId: same.body.id })).status === 200);
    const exp = await call('a', 'plan', { tagIds: ['local'] });
    const record = await db.docflowPlan.findUnique({ where: { id: exp.body.id } });
    check('срок предпросмотра 15 минут', Math.abs(record.expiresAt.getTime() - record.createdAt.getTime() - 15 * 60000) < 2000);
    await db.docflowPlan.update({ where: { id: exp.body.id }, data: { expiresAt: new Date(0) } });
    check('истёкший план не применить', (await call('a', 'apply', { planId: exp.body.id })).status === 410);
    await call('a', 'plan', { tagIds: ['local'] });
    check('истёкший план очищается', !(await db.docflowPlan.findUnique({ where: { id: exp.body.id } })));
    const appliedRecord = await db.docflowPlan.findUnique({ where: { id: stale.body.id } });
    check('срок отмены 30 дней', Math.abs(appliedRecord.expiresAt.getTime() - appliedRecord.updatedAt.getTime() - 30 * 86400000) < 2000);
    await db.docflowPlan.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ id: `history-limit-${i}`, projectId: 'a', actorId: 'admin', kind: 'equipment-classes', state: i % 2 ? 'applied' : 'undone', payload: '{}', expiresAt: new Date(Date.now() + 60000) })) });
    check('завершённые планы не занимают лимит предпросмотров', (await call('a', 'plan', { tagIds: ['local'] })).status === 200 && await db.docflowPlan.count({ where: { id: { startsWith: 'history-limit-' } } }) === 200);
    await db.docflowPlan.deleteMany({ where: { id: { startsWith: 'history-limit-' } } });
    const current = await db.docflowPlan.count({ where: { projectId: 'a', actorId: 'admin', kind: 'equipment-classes', state: 'preview' } });
    await db.docflowPlan.createMany({ data: Array.from({ length: 200 - current }, (_, i) => ({ id: `limit-${i}`, projectId: 'a', actorId: 'admin', kind: 'equipment-classes', payload: '{}', expiresAt: new Date(Date.now() + 60000) })) });
    check('предел хранения не удаляет действующие планы', (await call('a', 'plan', { tagIds: ['local'] })).status === 429 && await db.docflowPlan.count({ where: { projectId: 'a', actorId: 'admin', kind: 'equipment-classes', state: 'preview' } }) === 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`Классы оборудования: ${checks} проверок прошли`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
