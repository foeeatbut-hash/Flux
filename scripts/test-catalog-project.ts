/** Проектный каталог: настоящий HTTP и одноразовая SQLite. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setBroadcaster, setPrisma } from '../server/context.js';
import { ensureCatalog, registerCatalogRoutes } from '../server/routes/catalog.js';
import { BUILTIN_ROLES, seedRoles } from '../server/routes/users.js';
import { DEFAULT_DENIED, can } from '../src/lib/permissions.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const grant = JSON.stringify({ 'catalog.project': { enabled: true, until: null } });
async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'flux-project-catalog-'));
  const file = join(dir, 'test.sqlite');
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  let server: any;
  let passed = 0;
  const check = (name: string, condition: unknown) => { assert.ok(condition, name); passed++; console.log(`✓ ${name}`); };
  try {
    await bootstrapLocalDatabase(file, db, readFileSync('prisma/schema.prisma', 'utf8'), () => {});
    setPrisma(db); setBroadcaster(() => {}); await ensureCatalog(db); await seedRoles();
    await db.project.createMany({ data: [{ id: 'a', name: 'А' }, { id: 'b', name: 'Б' }] });
    await db.projectMember.createMany({ data: ['reader', 'writer', 'writer2', 'developer'].map(userId => ({ projectId: 'a', userId })).concat([{ projectId: 'b', userId: 'foreign' }]) });
    const app = express(); app.use(express.json());
    app.use((req: any, _res, next) => { const id = String(req.headers['x-user'] || ''); if (id) req.authUser = { id, role: id === 'admin' ? 'ADMIN' : 'USER', positionCode: id === 'developer' ? 'MODULE_DEVELOPER' : null, permissions: ['writer', 'writer2'].includes(id) ? grant : null }; next(); });
    registerCatalogRoutes(app, (user, feature) => can(user, feature));
    server = await new Promise<any>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = async (method: string, path: string, body?: any, user = 'writer') => {
      const res = await fetch(origin + path, { method, headers: { 'content-type': 'application/json', 'x-user': user }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json().catch(() => ({})) as any };
    };
    const root = '/api/catalog/project';
    const plan = (input: any, user = 'writer') => send('POST', `${root}/plan`, { projectId: 'a', ...input }, user);
    const apply = (id: string, user = 'writer', projectId = 'a') => send('POST', `${root}/apply`, { projectId, planId: id }, user);
    const undo = (id: string, user = 'writer', projectId = 'a') => send('POST', `${root}/undo`, { projectId, planId: id }, user);
    const view = (user = 'writer', projectId = 'a', source = 'project') => send('GET', `${root}?projectId=${projectId}&source=${source}`, undefined, user);
    const row = async (id: string) => (await view()).body.rows.find((r: any) => r.id === id);
    check('право закрыто по умолчанию', DEFAULT_DENIED.includes('catalog.project'));
    check('штатные роли не получают право', BUILTIN_ROLES.every(role => !JSON.parse(role.permissions)['catalog.project']?.enabled));
    check('участник читает проект', (await view('reader')).status === 200);
    check('скрытый проект закрыт', (await view('reader', 'b')).status === 403);
    check('несуществующий проект не найден', (await view('reader', 'missing')).status === 404);
    check('без входа чтение закрыто', (await view('', 'a')).status === 401);
    for (const action of ['plan', 'apply', 'undo']) {
      for (const user of ['reader', 'developer']) check(`${user}: ${action} без права закрыт`, (await send('POST', `${root}/${action}`, { projectId: 'a', planId: 'missing', operation: 'take' }, user)).status === 403);
      check(`${action} без входа закрыт`, (await send('POST', `${root}/${action}`, { projectId: 'a' }, '')).status === 401);
    }
    const common = await db.catalogFamily.findFirst({ where: { projectId: null, deletedAt: null } }); assert.ok(common);
    const original = await db.catalogFamily.findUnique({ where: { id: common.id } });
    const take = await plan({ operation: 'take', familyId: common.id });
    check('предпросмотр взятия не пишет позицию', take.status === 200 && await db.catalogFamily.count({ where: { projectId: 'a' } }) === 0);
    const id = take.body.rows[0].id;
    check('чужой пользователь не применяет план', (await apply(take.body.id, 'writer2')).status === 403);
    check('чужой проект не применяет план', (await apply(take.body.id, 'admin', 'b')).status === 403);
    check('взятие из общего создаёт позицию', (await apply(take.body.id)).status === 200 && !!await row(id));
    check('повтор применения не создаёт дубль', (await apply(take.body.id)).status === 200 && await db.catalogFamily.count({ where: { projectId: 'a', basedOnFamilyId: common.id } }) === 1);
    check('проектная позиция не доступна чужому проекту', !(await view('admin', 'b')).body.families.some((f: any) => f.id === id));
    check('проектную позицию нельзя взять за общую', (await plan({ operation: 'take', familyId: id })).status === 404);
    check('чужую позицию нельзя редактировать', (await send('POST', `${root}/plan`, { projectId: 'b', operation: 'edit', familyId: id, expectedRevision: (await row(id)).revision }, 'admin')).status === 403);
    const initial = (await view()).body.families.find((f: any) => f.id === id);
    const proposal = { ...initial, id: 'global-project-proposal', code: 'PROPOSAL' };
    check('право проекта не разрешает запись общего черновика', (await send('PUT', `/api/catalog/family/${proposal.id}`, proposal)).status === 403);
    const proposed = await send('PUT', `/api/catalog/family/${proposal.id}`, proposal, 'admin');
    check('обычный общий черновик не публикует и не меняет проект', proposed.status === 200 && !await db.catalogFamily.findUnique({ where: { id: proposal.id } }) && (await view()).body.families.find((f: any) => f.id === id).code === initial.code);
    check('общий черновик отменяется штатным адресом', (await send('POST', '/api/catalog/workspace/discard', { entity: 'family', id: proposal.id, revision: proposed.body.revision }, 'admin')).status === 200);
    check('неизвестный класс запрещён сервером', (await plan({ operation: 'create', document: { ...initial, classId: 'missing-class' } })).status === 400);
    check('неизвестный изготовитель запрещён сервером', (await plan({ operation: 'create', document: { ...initial, manufacturerId: 'missing-maker' } })).status === 400);
    const param = { key: 'projectFlow', label: { ru: 'Проектный расход' }, kind: 'number', min: 10, max: 500, default: 250 };
    for (const [label, value] of [['нечисловое значение', 'не число'], ['значение вне диапазона', 600]] as const) {
      check(`${label} параметра отклоняется сервером`, (await plan({ operation: 'create', document: { ...initial, params: [...initial.params, { ...param, default: value }] } })).status === 400);
    }
    check('неизвестный вариант параметра отклоняется сервером', (await plan({ operation: 'create', document: { ...initial, params: [...initial.params, { ...param, kind: 'choice', default: 'missing', values: [{ code: 'known', label: { ru: 'Известный' } }] }] } })).status === 400);
    const edit = await plan({ operation: 'edit', familyId: id, expectedRevision: (await row(id)).revision, document: { ...initial, code: 'LOCAL-CODE', params: [...initial.params, param] } });
    check('план переопределения создаётся', edit.status === 200 && edit.body.rows[0].differences.length > 0);
    check('переопределение применяется', (await apply(edit.body.id)).status === 200 && (await view()).body.families.find((f: any) => f.id === id).code === 'LOCAL-CODE');
    check('значение параметра переопределено только в проекте', (await view()).body.families.find((f: any) => f.id === id).params.find((p: any) => p.key === param.key)?.default === 250 && !JSON.parse((await db.catalogFamily.findUnique({ where: { id: common.id } })).dataJson).params.some((p: any) => p.key === param.key));
    check('отмена старого создания сохраняет новые правки', (await undo(take.body.id)).status === 409);
    const commonDoc = JSON.parse(common.dataJson); commonDoc.code = 'COMMON-NEW';
    await db.catalogFamily.update({ where: { id: common.id }, data: { code: 'COMMON-NEW', dataJson: JSON.stringify(commonDoc), updatedAt: new Date(common.updatedAt.getTime() + 1000) } });
    check('позиция закреплена при изменении общего каталога', (await view()).body.families.find((f: any) => f.id === id).code === 'LOCAL-CODE' && (await row(id)).updateAvailable);
    const update = await plan({ operation: 'update', familyId: id, expectedRevision: (await row(id)).revision });
    check('обновление показывает конфликт общего и локального изменения', update.status === 200 && update.body.rows[0].conflicts.some((d: any) => d.path.join('.') === 'code'));
    check('обновление сохраняет переопределение', (await apply(update.body.id)).status === 200 && (await view()).body.families.find((f: any) => f.id === id).code === 'LOCAL-CODE');
    const reset = await plan({ operation: 'reset', familyId: id, expectedRevision: (await row(id)).revision });
    check('сброс возвращает закреплённую основу', reset.status === 200 && (await apply(reset.body.id)).status === 200 && (await view()).body.families.find((f: any) => f.id === id).code === 'COMMON-NEW');
    const staleRevision = (await row(id)).revision;
    const stale = await plan({ operation: 'edit', familyId: id, expectedRevision: staleRevision, document: { ...initial, code: 'STALE' } });
    const fresh = await plan({ operation: 'edit', familyId: id, expectedRevision: staleRevision, document: { ...initial, code: 'FRESH' } });
    check('свежий план применяется', (await apply(fresh.body.id)).status === 200);
    check('устаревший план не затирает правку', (await apply(stale.body.id)).status === 409 && (await view()).body.families.find((f: any) => f.id === id).code === 'FRESH');
    check('устаревшая ревизия не создаёт план', (await plan({ operation: 'edit', familyId: id, expectedRevision: staleRevision, document: initial })).status === 409);
    const own = await plan({ operation: 'create', document: { ...initial, code: 'OWN' } });
    check('своя позиция создаётся', own.status === 200 && (await apply(own.body.id)).status === 200);
    const ownId = own.body.rows[0].id;
    await db.appSetting.create({ data: { key: 'equipment_catalog_binding:test', value: JSON.stringify({ modelId: ownId }) } });
    check('используемая позиция не удаляется отменой', (await undo(own.body.id)).status === 409 && !!await db.catalogFamily.findUnique({ where: { id: ownId } }));
    await db.appSetting.deleteMany({ where: { key: 'equipment_catalog_binding:test' } });
    check('неиспользуемая позиция отменяется', (await undo(own.body.id)).status === 200 && !await db.catalogFamily.findUnique({ where: { id: ownId } }));
    const another = await db.catalogFamily.findFirst({ where: { projectId: null, deletedAt: null, id: { not: common.id } } }); assert.ok(another);
    const p1 = await plan({ operation: 'take', familyId: another.id }, 'writer');
    const p2 = await plan({ operation: 'take', familyId: another.id }, 'writer2');
    check('два участника подготовили независимые планы', p1.status === 200 && p2.status === 200);
    const results = await Promise.all([apply(p1.body.id, 'writer'), apply(p2.body.id, 'writer2')]);
    check('одновременное взятие создаёт одну позицию', results.map(r => r.status).sort().join(',') === '200,409' && await db.catalogFamily.count({ where: { projectId: 'a', basedOnFamilyId: another.id } }) === 1);
    const after = await db.catalogFamily.findUnique({ where: { id: common.id } });
    check('проектные действия не меняют общий каталог', after.code === 'COMMON-NEW' && after.dataJson === JSON.stringify(commonDoc) && original.projectId === null);
    console.log(`Каталог проекта: ${passed} проверок прошли`);
  } finally {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await db.$disconnect(); setPrisma(null); rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
